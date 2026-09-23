/**
 * From the rating map to ranked verification windows. Pure: no scorer, no I/O.
 *
 *   rating map  (pass 1 vectors + pass 2 fits)            -> hotness per unit
 *   hotness     -> 2-state Viterbi (plan §5.3)            -> on/off runs
 *   runs        -> category-blind merge                   -> paragraph spans
 *   spans       -> per-category span scores s_c           -> co-fire strength
 *   spans       -> <= 40 s sub-passages -> FlagCandidate  -> buildWindows (NLI's, unchanged)
 *   windows     -> strength order -> verify budget        -> windows / overflow
 */

import {
  FlagCandidate,
  FlagWindow,
  RankedSentence,
  buildWindows,
} from '../../analysis/nli-ranker.service';
import { viterbi, runsOf } from '../scorer-viterbi';
import type { FlagOptionPlan } from './flag-options';
import type { FlagChunk, FlagUnit } from './flag-units';
import type { FlagLayout, NonePosition } from './flag-questions';

// --------------------------------------------------------------------------- params

export interface FlagSpanParams {
  /**
   * λ: cost (nats) of each none <-> flag switch. cat <-> cat is free because
   * every category state shares one pooled emission, so the chain decides
   * on/off only (plan §5.3) and is run as the equivalent 2-state Viterbi.
   */
  switchCost: number;
  /**
   * τ: subtracted from the pooled flag emission, log(hot) - τ. Negative makes
   * spans easier to open. See DEFAULT_SPAN_PARAMS for the arithmetic.
   */
  tau: number;
  /** Pass-2 gate: units with hot >= this get the per-category two-option check. */
  pass2HotGate: number;
  /** ...for every category with P_i(c) >= this... */
  pass2MinCategoryP: number;
  /** ...at most this many per unit (strongest first). */
  pass2MaxCategories: number;
  /** Category-blind post-merge: spans separated by <= this many units... */
  mergeGapUnits: number;
  /** ...or <= this many seconds join (nli-ranker WINDOW_MERGE_GAP_*). */
  mergeGapSeconds: number;
  /** A span keeps categories with s_c >= this, and always its top one. */
  categoryFloor: number;
  /** Spans longer than this are verified as sub-passages (WINDOW_MAX_MERGED_SECONDS). */
  maxPassageSeconds: number;
  /** Verify budget: max(minVerifyCalls, verifyCallsPerHour x hours). Cache hits are the caller's concern. */
  minVerifyCalls: number;
  verifyCallsPerHour: number;
}

/**
 * DEVIATION from the plan's starting values (λ = 3, τ = 0; §5.3). An isolated
 * hot unit between cold ones pays the switch cost TWICE (on, then off), so it
 * opens a span only when logit(hot) - τ > 2λ. At λ = 3, τ = 0 that is
 * hot > 0.9975: the plan's "one unit at hot ≈ 0.95 can open a span" does not
 * hold (logit 0.95 = 2.94 < 6), and single-sentence flags, the common case,
 * would be lost before the verifier ever saw them.
 *
 * These defaults are solved from the behaviour the plan asks for instead:
 *   - an isolated unit opens a span at hot > 0.5:    logit(h) > 2λ + τ = 0
 *   - a span edge extends to a neighbour at h > 0.27: logit(h) > τ = -1
 *   - one cold unit breaks a run only at h < 0.12:    logit(h) < τ - 2λ = -2
 * and the category-blind post-merge (<= 1 unit or <= 5 s) coalesces what the
 * chain leaves apart, so the output is paragraph spans, never a picket fence.
 * Both are parameters; §6.1 tunes them offline from the saved rating map.
 */
export const DEFAULT_SPAN_PARAMS: FlagSpanParams = {
  switchCost: 0.5,
  tau: -1,
  pass2HotGate: 0.2,
  pass2MinCategoryP: 0.05,
  pass2MaxCategories: 3,
  mergeGapUnits: 1,
  mergeGapSeconds: 5,
  categoryFloor: 0.5,
  maxPassageSeconds: 40,
  minVerifyCalls: 20,
  verifyCallsPerHour: 60,
};

// --------------------------------------------------------------------------- rating map

export const RATING_MAP_VERSION = 1;

/**
 * Everything the scorer said, kept whole (never argmaxed), so spans can be
 * re-derived offline with different params, drawn as a heat map, or evaluated.
 * JSON-serialisable.
 */
export interface FlagRatingMap {
  version: typeof RATING_MAP_VERSION;
  ranker: 'snap-v1';
  model: string | null;
  layout: FlagLayout;
  nonePosition: NonePosition;
  /** Category keys in plan order. p1 columns are these, then 'none' LAST, regardless of question order. */
  categories: string[];
  units: FlagUnit[];
  chunks: FlagChunk[];
  /** Pass-1 probability vector per unit: [...categories, none]. */
  p1: number[][];
  /** Pass-1 label mass per unit (how much of the model's mass was on any letter). */
  labelMass: number[];
  /** Pass-1 letters floored because they were outside the engine's top-n, per unit. */
  missingLabels: number[];
  /** Pass-2 q_{i,c} = P(Fits), per unit, only for the categories that were asked. */
  p2: Array<Record<string, number>>;
}

export function noneIndex(map: Pick<FlagRatingMap, 'categories'>): number {
  return map.categories.length;
}

/** hot_i = 1 - P_i(none). */
export function hotness(map: Pick<FlagRatingMap, 'categories' | 'p1'>): number[] {
  const k = noneIndex(map);
  return map.p1.map((row) => clamp01(1 - row[k]));
}

/**
 * Pass-2 gating for one unit (plan §5.2): nothing unless hot >= gate; then the
 * categories with P(c) >= minP, strongest first, at most maxN.
 */
export function selectPass2Categories(
  p1Row: number[],
  categories: string[],
  params: Pick<FlagSpanParams, 'pass2HotGate' | 'pass2MinCategoryP' | 'pass2MaxCategories'>,
): string[] {
  const hot = 1 - p1Row[categories.length];
  if (!(hot >= params.pass2HotGate)) return [];
  return categories
    .map((c, j) => ({ c, p: p1Row[j] }))
    .filter((x) => x.p >= params.pass2MinCategoryP)
    .sort((a, b) => b.p - a.p)
    .slice(0, params.pass2MaxCategories)
    .map((x) => x.c);
}

/**
 * Per-unit evidence for category c:
 *   - pass 2's q_{i,c} where it was asked (independent, no competition);
 *   - else, on a unit that cleared the pass-2 gate, P_i(c)/hot_i (its share of
 *     the hot mass; c was not asked because P_i(c) < minP or it was outside
 *     the top pass2MaxCategories);
 *   - else, on a cold unit, the raw P_i(c).
 * DEVIATION: the plan says "no pass-2 value -> P_i(c)/hot_i" without the
 * cold-unit case. On a cold unit (hot 0.1, P(c) 0.09) the ratio is 0.9, which
 * would let a lukewarm context sentence outrank the sentence that fired.
 */
export function unitCategoryScore(
  map: Pick<FlagRatingMap, 'categories' | 'p1' | 'p2'>,
  hot: number[],
  unit: number,
  catIndex: number,
  params: Pick<FlagSpanParams, 'pass2HotGate'>,
): number {
  const c = map.categories[catIndex];
  const q = map.p2[unit]?.[c];
  if (q !== undefined) return q;
  const p = map.p1[unit][catIndex];
  if (hot[unit] >= params.pass2HotGate && hot[unit] > 0) return clamp01(p / hot[unit]);
  return p;
}

// --------------------------------------------------------------------------- spans

export interface SpanCategory {
  category: string;
  /** s_c: the best unit evidence inside the span. */
  score: number;
  /** The unit that scored it. */
  unit: number;
}

export interface FlagSpan {
  id: number;
  /** Inclusive unit range. */
  unitFrom: number;
  unitTo: number;
  /** Inclusive sentence range (what windows and sections index). */
  sentenceFrom: number;
  sentenceTo: number;
  start: number;
  end: number;
  /** Kept categories, strongest first. */
  categories: SpanCategory[];
  /** Σ_c log(1 - s_c) over kept categories: noisy-OR complement in log space. More negative = stronger. */
  strength: number;
  /** Σ hot_i over the span: first tie-break. */
  heat: number;
  /** Hottest unit in the span. */
  peakUnit: number;
}

const LOG_FLOOR = 1e-12;

/**
 * The on/off path: 2-state Viterbi over [log P(none), log(hot) - τ], switch
 * cost λ. Equivalent to the plan's (k+1)-state chain with free cat<->cat
 * moves, because every category state carries the same pooled emission.
 */
export function onOffPath(hot: number[], params: Pick<FlagSpanParams, 'switchCost' | 'tau'>): number[] {
  const rows = hot.map((h) => [Math.log(Math.max(1 - h, LOG_FLOOR)), Math.log(Math.max(h, LOG_FLOOR)) - params.tau]);
  return viterbi(rows, params.switchCost);
}

/** Runs of the on-state, then the category-blind merge. Inclusive unit ranges. */
export function mergedRuns(
  path: number[],
  units: FlagUnit[],
  params: Pick<FlagSpanParams, 'mergeGapUnits' | 'mergeGapSeconds'>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, bEx] of runsOf(path, 1)) {
    const b = bEx - 1;
    const prev = out[out.length - 1];
    if (prev) {
      const gapUnits = a - prev[1] - 1;
      const gapSeconds = units[a].start - units[prev[1]].end;
      if (gapUnits <= params.mergeGapUnits || gapSeconds <= params.mergeGapSeconds) {
        prev[1] = b;
        continue;
      }
    }
    out.push([a, b]);
  }
  return out;
}

/** s_c for every category over units [from, to], strongest first. */
export function scoreRange(
  map: Pick<FlagRatingMap, 'categories' | 'p1' | 'p2'>,
  hot: number[],
  from: number,
  to: number,
  params: Pick<FlagSpanParams, 'pass2HotGate'>,
): SpanCategory[] {
  const out: SpanCategory[] = [];
  for (let j = 0; j < map.categories.length; j++) {
    let best = -1;
    let bestUnit = from;
    for (let i = from; i <= to; i++) {
      const s = unitCategoryScore(map, hot, i, j, params);
      if (s > best) {
        best = s;
        bestUnit = i;
      }
    }
    out.push({ category: map.categories[j], score: Math.max(best, 0), unit: bestUnit });
  }
  return out.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
}

/** Plan §5.4: Σ_c log(1 - s_c). Two categories at 0.9 (-4.6) beat one at 0.97 (-3.5). */
export function coFireStrength(scores: number[]): number {
  return scores.reduce((sum, s) => sum + Math.log(Math.max(1 - s, Number.MIN_VALUE)), 0);
}

/** Noisy-OR of the same scores (what FlagWindow.score carries). */
export function noisyOr(scores: number[]): number {
  return 1 - scores.reduce((p, s) => p * (1 - s), 1);
}

/** Strength order: strength ascending, then heat descending, then time. */
export function compareSpans(a: FlagSpan, b: FlagSpan): number {
  return a.strength - b.strength || b.heat - a.heat || a.start - b.start;
}

function keepCategories(all: SpanCategory[], floor: number): SpanCategory[] {
  const kept = all.filter((c) => c.score >= floor);
  return kept.length ? kept : all.slice(0, 1);
}

function makeSpan(
  id: number,
  from: number,
  to: number,
  categories: SpanCategory[],
  units: FlagUnit[],
  hot: number[],
): FlagSpan {
  let heat = 0;
  let peak = from;
  for (let i = from; i <= to; i++) {
    heat += hot[i];
    if (hot[i] > hot[peak]) peak = i;
  }
  return {
    id,
    unitFrom: from,
    unitTo: to,
    sentenceFrom: units[from].sentenceFrom,
    sentenceTo: units[to].sentenceTo,
    start: units[from].start,
    end: units[to].end,
    categories,
    strength: coFireStrength(categories.map((c) => c.score)),
    heat,
    peakUnit: peak,
  };
}

/** Viterbi -> merge -> per-span categories -> strength order. */
export function buildSpans(map: FlagRatingMap, params: FlagSpanParams = DEFAULT_SPAN_PARAMS): FlagSpan[] {
  if (map.units.length === 0 || map.categories.length === 0) return [];
  const hot = hotness(map);
  const path = onOffPath(hot, params);
  const ranges = mergedRuns(path, map.units, params);
  const spans = ranges.map(([a, b], id) =>
    makeSpan(id, a, b, keepCategories(scoreRange(map, hot, a, b, params), params.categoryFloor), map.units, hot),
  );
  return spans.sort(compareSpans);
}

/**
 * Split a span longer than maxPassageSeconds into consecutive sub-passages of
 * at most that length (plan §5.5 "Long spans"), cutting only between units
 * that do not share a sentence. A sub-passage keeps each of the span's
 * categories it carries evidence for (s ≥ min(floor, span s_c)); one with none
 * is context only and is dropped. Sub-passages keep the parent's `id`.
 */
export function splitSpan(
  span: FlagSpan,
  map: FlagRatingMap,
  hot: number[],
  params: FlagSpanParams = DEFAULT_SPAN_PARAMS,
): FlagSpan[] {
  if (span.end - span.start <= params.maxPassageSeconds) return [span];
  const units = map.units;
  const pieces: Array<[number, number]> = [];
  let from = span.unitFrom;
  for (let i = span.unitFrom + 1; i <= span.unitTo; i++) {
    const cuttable = units[i].sentenceFrom > units[i - 1].sentenceTo;
    if (cuttable && units[i].end - units[from].start > params.maxPassageSeconds) {
      pieces.push([from, i - 1]);
      from = i;
    }
  }
  pieces.push([from, span.unitTo]);
  if (pieces.length === 1) return [span];

  const wanted = new Map(span.categories.map((c) => [c.category, Math.min(params.categoryFloor, c.score)]));
  const out: FlagSpan[] = [];
  for (const [a, b] of pieces) {
    const cats = scoreRange(map, hot, a, b, params).filter(
      (c) => wanted.has(c.category) && c.score >= (wanted.get(c.category) as number),
    );
    if (cats.length) out.push(makeSpan(span.id, a, b, cats, units, hot));
  }
  return out.length ? out : [span];
}

// --------------------------------------------------------------------------- windows

/** A verification window with the snap span metadata attached. Assignable to FlagWindow. */
export interface SnapFlagWindow extends FlagWindow {
  /** Parent span ids (sub-passages of one long span share an id: store adjacent flags as one section). */
  spanIds: number[];
  /** Σ log(1 - s_c) over the window's categories (the sort key). */
  strength: number;
  heat: number;
}

/**
 * The adapter to the verifier stage: every (passage, kept category) becomes a
 * FlagCandidate and goes through the NLI ranker's own buildWindows, so the
 * ±2-sentence context, the 25 s context cap, the merge rules and the noisy-OR
 * window score are unchanged (plan §5.5). Returned in strength order, which is
 * also descending `score` order, as runRankedFlagStage asserts.
 */
export function spansToWindows(
  spans: FlagSpan[],
  sentences: RankedSentence[],
  units: FlagUnit[],
  plan: FlagOptionPlan[],
): SnapFlagWindow[] {
  const proposition = new Map(plan.map((p) => [p.category, p.proposition]));
  const passages = [...spans].sort((a, b) => a.sentenceFrom - b.sentenceFrom || a.sentenceTo - b.sentenceTo);
  const candidates: FlagCandidate[] = [];
  for (const p of passages) {
    for (const c of p.categories) {
      // The representative sentence is the one holding the unit that scored it.
      const s = Math.min(Math.max(units[c.unit].sentenceFrom, p.sentenceFrom), p.sentenceTo);
      candidates.push({
        sentenceIndex: s,
        spanFrom: p.sentenceFrom,
        spanTo: p.sentenceTo,
        start: p.start,
        end: p.end,
        text: sentences[s]?.text ?? '',
        category: c.category,
        score: c.score,
        proposition: proposition.get(c.category) ?? c.category,
        source: 'sentence',
        rescued: false,
      });
    }
  }

  const windows = buildWindows(sentences, candidates);
  return windows
    .map((w) => {
      const inside = passages.filter((p) => p.sentenceFrom >= w.firedFrom && p.sentenceTo <= w.firedTo);
      return {
        ...w,
        spanIds: [...new Set(inside.map((p) => p.id))].sort((x, y) => x - y),
        strength: coFireStrength(w.categories.map((c) => c.score)),
        heat: inside.reduce((sum, p) => sum + p.heat, 0),
      };
    })
    .sort((a, b) => a.strength - b.strength || b.heat - a.heat || a.contextFrom - b.contextFrom);
}

// --------------------------------------------------------------------------- budget

/** Plan §5.5: max(20, 60 x hours) verifier calls. */
export function verifyBudget(durationSeconds: number, params: Pick<FlagSpanParams, 'minVerifyCalls' | 'verifyCallsPerHour'>): number {
  return Math.max(params.minVerifyCalls, Math.ceil((params.verifyCallsPerHour * Math.max(durationSeconds, 0)) / 3600));
}

/**
 * Walk windows in strength order and keep whole windows while the running
 * (window, category) call count stays within the budget. The rest is overflow:
 * stored as unverified 'candidate' rows at integration (plan §5.6). The first
 * window is always kept even if it alone exceeds the budget.
 */
export function applyVerifyBudget<W extends FlagWindow>(windows: W[], budget: number): { verify: W[]; overflow: W[] } {
  const verify: W[] = [];
  const overflow: W[] = [];
  let calls = 0;
  for (const w of windows) {
    const n = w.categories.length;
    if (overflow.length === 0 && (verify.length === 0 || calls + n <= budget)) {
      verify.push(w);
      calls += n;
    } else {
      overflow.push(w);
    }
  }
  return { verify, overflow };
}

/** Section pairs closer than `seconds` (plan §6.1 picket-fence count; must be 0). */
export function picketFenceCount(ranges: Array<{ start: number; end: number }>, seconds = 5): number {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let n = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].start - sorted[i - 1].end;
    if (gap >= 0 && gap < seconds) n++;
  }
  return n;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// --------------------------------------------------------------------------- whole pipeline

export interface RankFromMapResult {
  /** Merged spans, strength order (before long-span splitting). */
  spans: FlagSpan[];
  /** What the verifier reads: spans split into <= maxPassageSeconds sub-passages, strength order. */
  passages: FlagSpan[];
  /** Windows within the verify budget, strength order. */
  windows: SnapFlagWindow[];
  /** Windows beyond it (unverified candidates). */
  overflow: SnapFlagWindow[];
  budget: number;
  verifyCalls: number;
  overflowCalls: number;
}

/**
 * Everything after the scorer, from a (live or saved) rating map. This is what
 * offline tuning re-runs with different params without touching the GPU.
 */
export function rankFromRatingMap(
  map: FlagRatingMap,
  sentences: RankedSentence[],
  plan: FlagOptionPlan[],
  params: FlagSpanParams = DEFAULT_SPAN_PARAMS,
): RankFromMapResult {
  const spans = buildSpans(map, params);
  const hot = hotness(map);
  const passages = spans.flatMap((sp) => splitSpan(sp, map, hot, params)).sort(compareSpans);
  const all = spansToWindows(passages, sentences, map.units, plan);
  const duration = sentences.length ? sentences[sentences.length - 1].end : 0;
  const budget = verifyBudget(duration, params);
  const { verify, overflow } = applyVerifyBudget(all, budget);
  const calls = (ws: FlagWindow[]) => ws.reduce((n, w) => n + w.categories.length, 0);
  return {
    spans,
    passages,
    windows: verify,
    overflow,
    budget,
    verifyCalls: calls(verify),
    overflowCalls: calls(overflow),
  };
}
