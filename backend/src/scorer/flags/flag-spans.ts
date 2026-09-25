/**
 * From the rating map to ranked verification windows. Pure: no scorer, no I/O.
 *
 *   rating map  (group vectors, averaged per unit)        -> each category's
 *               rise above ITS OWN level in this video    -> evidence, hotness per unit
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
} from '../../analysis/flag-windows';
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
  /**
   * Where a category's baseline sits in this video's own distribution of it (0.5
   * = the median). Evidence is the rise above the baseline, so a category the
   * model leans toward all video long (a group of three sentences almost always
   * "does" something a little) reads as zero, and only its peaks read as hot.
   */
  baselineQuantile: number;
  /**
   * ...never above this. A category the model gives better than even odds all
   * video long IS there (a half-hour rant is flagged, as sections of about a
   * minute); one that only hums below it (0.45 everywhere) reads as its peaks.
   */
  baselineMax: number;
  /** Category-blind post-merge: spans separated by <= this many units... */
  mergeGapUnits: number;
  /** ...or <= this many seconds join (nli-ranker WINDOW_MERGE_GAP_*). */
  mergeGapSeconds: number;
  /**
   * A span keeps the categories whose evidence reaches this share of its top
   * category's, and always its top one. A third: a group holding two things
   * splits its mass between them (one softmax), so the second is often well
   * under the first.
   */
  categoryFloor: number;
  /**
   * A span longer than this is cut into sections at its quietest points (the
   * user: "id rather have 10 1-minute sections than one 30-minute section")...
   */
  maxSectionSeconds: number;
  /** ...never into a piece shorter than this. */
  minSectionSeconds: number;
  /** Verify budget: max(minVerifyCalls, verifyCallsPerHour x hours). Cache hits are the caller's concern. */
  minVerifyCalls: number;
  verifyCallsPerHour: number;
}

/**
 * An isolated hot unit between cold ones pays the switch cost TWICE (on, then
 * off), so it opens a span only when logit(hot) - τ > 2λ. The defaults, on
 * hotness = the rise above the video's own baseline (0..1 of the headroom):
 *   - an isolated unit opens a span at hot > 0.5:     logit(h) > 2λ + τ = 0
 *   - a span edge extends to a neighbour at h > 0.27: logit(h) > τ = -1
 *   - one cold unit breaks a run only at h < 0.12:    logit(h) < τ - 2λ = -2
 * The category-blind post-merge (<= 1 unit or <= 5 s) coalesces what the chain
 * leaves apart, and a span over maxSectionSeconds is cut at its quietest points
 * into sections of about a minute: paragraphs, not a picket fence and not one
 * half-hour block. All are parameters, tuned offline from saved rating maps.
 */
export const DEFAULT_SPAN_PARAMS: FlagSpanParams = {
  switchCost: 0.5,
  tau: -1,
  baselineQuantile: 0.5,
  baselineMax: 0.5,
  mergeGapUnits: 1,
  mergeGapSeconds: 5,
  categoryFloor: 0.34,
  maxSectionSeconds: 90,
  minSectionSeconds: 20,
  minVerifyCalls: 20,
  verifyCallsPerHour: 60,
};

// --------------------------------------------------------------------------- rating map

/** 2: group questions (3 units, overlapping by 1) replaced per-unit pass 1 + pass 2. */
export const RATING_MAP_VERSION = 2;

/** One judged group: consecutive units [unitFrom, unitTo], and its vector [...categories, none]. */
export interface FlagGroup {
  unitFrom: number;
  unitTo: number;
  p: number[];
}

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
  /** Units per group, and how far each group moves on (size 3, stride 2: consecutive groups share one unit). */
  groupSize: number;
  groupStride: number;
  /** Every group asked, in transcript order, with the model's whole vector. */
  groups: FlagGroup[];
  /** Per unit: the mean of the vectors of the groups that contain it, [...categories, none]. */
  p1: number[][];
  /** Per unit: the mean label mass of its groups (how much of the model's mass was on any letter). */
  labelMass: number[];
  /** Per unit: the most letters floored (outside the engine's top-n) in any of its groups. */
  missingLabels: number[];
}

export function noneIndex(map: Pick<FlagRatingMap, 'categories'>): number {
  return map.categories.length;
}

/** The value at quantile q of `values` (linear between order statistics). */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(Math.max(q, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

const evidenceCache = new WeakMap<number[][], { key: string; e: number[][] }>();

/**
 * e_i(c): how far unit i's P(c) rises above category c's baseline in this video
 * (its `baselineQuantile`, capped at `baselineMax`), as a share of the headroom
 * left above it:
 * max(0, P_i(c) - b_c) / (1 - b_c). 0 = at or below the video's usual level for
 * c; 1 = certain. Cached per map.
 */
export function evidence(
  map: Pick<FlagRatingMap, 'categories' | 'p1'>,
  params: Pick<FlagSpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): number[][] {
  const key = `${params.baselineQuantile}/${params.baselineMax}`;
  const cached = evidenceCache.get(map.p1);
  if (cached && cached.key === key) return cached.e;
  const k = map.categories.length;
  const baseline = Array.from({ length: k }, (_, j) =>
    Math.min(params.baselineMax, quantile(map.p1.map((row) => row[j]), params.baselineQuantile)));
  const e = map.p1.map((row) =>
    baseline.map((b, j) => clamp01(Math.max(0, row[j] - b) / Math.max(1 - b, 1e-6))),
  );
  evidenceCache.set(map.p1, { key, e });
  return e;
}

/** hot_i: the unit's strongest category evidence (its rise above the video's baseline). */
export function hotness(
  map: Pick<FlagRatingMap, 'categories' | 'p1'>,
  params: Pick<FlagSpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): number[] {
  return evidence(map, params).map((row) => row.reduce((m, x) => Math.max(m, x), 0));
}

/** Per-unit evidence for category c: its rise above the video's baseline for c (see evidence). */
export function unitCategoryScore(
  map: Pick<FlagRatingMap, 'categories' | 'p1'>,
  unit: number,
  catIndex: number,
  params: Pick<FlagSpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): number {
  return evidence(map, params)[unit][catIndex];
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
  map: Pick<FlagRatingMap, 'categories' | 'p1'>,
  from: number,
  to: number,
  params: Pick<FlagSpanParams, 'baselineQuantile' | 'baselineMax'> = DEFAULT_SPAN_PARAMS,
): SpanCategory[] {
  const out: SpanCategory[] = [];
  for (let j = 0; j < map.categories.length; j++) {
    let best = -1;
    let bestUnit = from;
    for (let i = from; i <= to; i++) {
      const s = unitCategoryScore(map, i, j, params);
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

/** The categories reaching `floor` x the top one's evidence; always the top one (all is strongest first). */
function keepCategories(all: SpanCategory[], floor: number): SpanCategory[] {
  const top = all[0]?.score ?? 0;
  const kept = all.filter((c) => c.score > 0 && c.score >= floor * top);
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
  const hot = hotness(map, params);
  const path = onOffPath(hot, params);
  const ranges = mergedRuns(path, map.units, params);
  const spans = ranges.map(([a, b], id) =>
    makeSpan(id, a, b, keepCategories(scoreRange(map, a, b, params), params.categoryFloor), map.units, hot),
  );
  return spans.sort(compareSpans);
}

/**
 * Where to cut [from, to] into pieces of at most `maxSectionSeconds`, each at
 * least `minSectionSeconds`: at the quietest boundary (the lowest hotness on
 * either side of it), nearest the middle on a tie, then each half again.
 * A boundary is only between units that do not share a sentence. A stretch no
 * boundary can split (one very long unit) is left whole.
 */
export function valleyCuts(
  from: number,
  to: number,
  units: FlagUnit[],
  hot: number[],
  params: Pick<FlagSpanParams, 'maxSectionSeconds' | 'minSectionSeconds'>,
): Array<[number, number]> {
  if (units[to].end - units[from].start <= params.maxSectionSeconds) return [[from, to]];
  const mid = (units[from].start + units[to].end) / 2;
  let best = -1;
  let bestQuiet = Infinity;
  let bestOff = Infinity;
  for (let k = from + 1; k <= to; k++) {
    if (units[k].sentenceFrom <= units[k - 1].sentenceTo) continue;
    if (units[k - 1].end - units[from].start < params.minSectionSeconds) continue;
    if (units[to].end - units[k].start < params.minSectionSeconds) continue;
    const quiet = hot[k - 1] + hot[k];
    const off = Math.abs(units[k].start - mid);
    if (quiet < bestQuiet - 1e-9 || (Math.abs(quiet - bestQuiet) <= 1e-9 && off < bestOff)) {
      best = k;
      bestQuiet = quiet;
      bestOff = off;
    }
  }
  if (best < 0) return [[from, to]];
  return [...valleyCuts(from, best - 1, units, hot, params), ...valleyCuts(best, to, units, hot, params)];
}

/**
 * A span longer than maxSectionSeconds becomes sections of about a minute,
 * cut at its quietest points (valleyCuts). A piece keeps each of the span's
 * categories it carries evidence for (at least `categoryFloor` of what the
 * span had for it); a piece with none (a lull inside a long span) is dropped.
 * Pieces keep the parent's `id`.
 */
export function splitSpan(
  span: FlagSpan,
  map: FlagRatingMap,
  hot: number[],
  params: FlagSpanParams = DEFAULT_SPAN_PARAMS,
): FlagSpan[] {
  const pieces = valleyCuts(span.unitFrom, span.unitTo, map.units, hot, params);
  if (pieces.length === 1) return [span];
  const wanted = new Map(span.categories.map((c) => [c.category, params.categoryFloor * c.score]));
  const out: FlagSpan[] = [];
  for (const [a, b] of pieces) {
    const cats = scoreRange(map, a, b, params).filter(
      (c) => wanted.has(c.category) && c.score > 0 && c.score >= (wanted.get(c.category) as number),
    );
    if (cats.length) out.push(makeSpan(span.id, a, b, cats, map.units, hot));
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
  const hot = hotness(map, params);
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
