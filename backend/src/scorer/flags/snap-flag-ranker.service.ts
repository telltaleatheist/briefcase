/**
 * SnapFlagRanker: stage 1 of the flag pipeline on the snap scorer. It replaces
 * the NLI (DeBERTa) ranker and feeds the SAME verifier stage (plan §5).
 *
 *   pass 1  one `choice` per unit (with the previous unit as context) over the
 *           enabled categories + "none"; the whole probability vector is kept.
 *   pass 2  hot units only (hot = 1 - P(none) >= 0.2): a two-option `choice`
 *           per plausible category, restoring independent per-category
 *           evidence where the pass-1 softmax made categories compete.
 *   spans   pure, in flag-spans.ts: Viterbi on/off, category-blind merge,
 *           co-fire strength, <= 40 s passages, NLI's buildWindows, budget.
 *
 * DROP-IN SHAPE. `rankWindows(sentences, categories)` has the NLI ranker's
 * signature and returns FlagWindow[] (SnapFlagWindow adds fields only), indexed
 * by the SAME `assembleSentences` sentences, strongest first, so
 * runRankedFlagStage's walk, cache and prompt work unchanged. `rank()` returns
 * the full result: windows, over-budget overflow, spans, the rating map, stats.
 *
 * Timestamps: every time is a whisper segment time carried by the sentences.
 * The scorer only picks letters.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { AnalysisCancelledError } from '../../analysis/cancellation';
import type { RankedSentence } from '../../analysis/nli-ranker.service';
import type { AnalysisCategory } from '../../analysis/prompts/analysis-prompts';
import { ScorerServerService } from '../scorer-server.service';
import {
  ChoiceAnswer,
  ChoiceQuestion,
  DecideOptions,
  DecideRequest,
  DecideResponse,
  isScorerError,
} from '../scorer.types';
import { FlagOptionPlan, NONE_KEY, buildFlagPlan } from './flag-options';
import {
  FITS,
  FlagLayout,
  NonePosition,
  START_OF_VIDEO,
  buildPass1Question,
  buildPass2Question,
  defaultFlagState,
  flagLegendBlock,
  pass1QuestionName,
  pass2QuestionName,
} from './flag-questions';
import {
  DEFAULT_SPAN_PARAMS,
  FlagRatingMap,
  FlagSpan,
  FlagSpanParams,
  RATING_MAP_VERSION,
  SnapFlagWindow,
  rankFromRatingMap,
  selectPass2Categories,
} from './flag-spans';
import { ChunkOptions, FlagChunk, FlagUnit, UnitOptions, buildFlagUnits, planFlagChunks } from './flag-units';

/** The one scorer call the ranker needs. A ScorerHandle (withScorer) satisfies it; tests pass a fake. */
export interface FlagScorer {
  decide(req: DecideRequest, options?: DecideOptions): Promise<DecideResponse>;
}

export type FlagRankPhase = 'pass1' | 'pass2';

export interface FlagRankProgress {
  phase: FlagRankPhase;
  /** Questions answered so far in this phase. */
  done: number;
  total: number;
}

export interface SnapFlagRankOptions {
  /** Question layout (flag-questions.ts). Default 'prefix'. A/B it against 'inline'. */
  layout?: FlagLayout;
  /** Where "none" sits among the letters (plan §6.2 bias probe). Default 'last'. */
  nonePosition?: NonePosition;
  /** Eval arm: rank misinformation too (plan §5.7). Default false. */
  includeMisinformation?: boolean;
  params?: Partial<FlagSpanParams>;
  units?: UnitOptions;
  chunks?: ChunkOptions;
  /**
   * The unit list to score, built ONCE per video by assembleUnits(segments) and
   * shared with the chapter pass (plan §3.2). Its sentence ranges must index
   * `sentences`. Absent: built here from `sentences` (buildFlagUnits).
   */
  unitList?: FlagUnit[];
  /**
   * The chunk plan to score against, shared with the chapter pass
   * (flagChunksFromPlan). Absent: planned here (planFlagChunks, estimated tokens).
   */
  chunkPlan?: FlagChunk[];
  /** Questions per decide() call (each call primes once, a cache hit after the first). Default 64. */
  batchSize?: number;
  /** Engine top-n. Default 100 (plan §3.4); missing letters are floored, never refused. */
  nProbs?: number;
  /**
   * Build a chunk's state. Default: its units one per line, plus the category
   * legend in the prefix layout. Chapters and flags share one primed checkpoint
   * only if they build the identical state, so integration passes a builder
   * that also appends the chapter legend.
   */
  stateBuilder?: (unitTexts: string[], flagLegend: string | null, chunk: FlagChunk) => string;
  signal?: AbortSignal;
  onProgress?: (progress: FlagRankProgress) => void;
  /** Use this scorer instead of leasing the ScorerServerService (tests, or a caller already holding a lease). */
  scorer?: FlagScorer;
}

export interface SnapFlagRankStats {
  sentences: number;
  units: number;
  chunks: number;
  pass1Questions: number;
  pass2Questions: number;
  hotUnits: number;
  spans: number;
  passages: number;
  windows: number;
  verifyBudget: number;
  verifyCalls: number;
  overflowWindows: number;
  overflowCalls: number;
  /** Units whose pass-1 answer had floored (missing) letters. */
  unitsWithMissingLabels: number;
  /** Sum of the scorer's own per-request totals (ms). */
  scorerMs: number;
  /** Wall time of the whole rank() (ms). */
  wallMs: number;
}

export interface SnapFlagRankResult {
  /** Verification windows within the budget, strongest first. Drop-in for NliRankerService.rankWindows. */
  windows: SnapFlagWindow[];
  /** Windows beyond the verify budget: stored as unverified candidates at integration. */
  overflow: SnapFlagWindow[];
  /** Merged spans (before long-span splitting), strength order. */
  spans: FlagSpan[];
  /** The raw scorer output, for the debug dump, heat-map UI and eval. */
  ratingMap: FlagRatingMap;
  plan: FlagOptionPlan[];
  notes: string[];
  stats: SnapFlagRankStats;
}

export const DEFAULT_LAYOUT: FlagLayout = 'prefix';
export const DEFAULT_BATCH_SIZE = 64;
export const DEFAULT_N_PROBS = 100;

@Injectable()
export class SnapFlagRanker {
  private readonly logger = new Logger(SnapFlagRanker.name);

  constructor(@Optional() private readonly scorerServer?: ScorerServerService) {}

  /** Drop-in for NliRankerService.rankWindows. */
  async rankWindows(
    sentences: RankedSentence[],
    categories: AnalysisCategory[],
    options: SnapFlagRankOptions = {},
  ): Promise<SnapFlagWindow[]> {
    return (await this.rank(sentences, categories, options)).windows;
  }

  async rank(
    sentences: RankedSentence[],
    categories: AnalysisCategory[],
    options: SnapFlagRankOptions = {},
  ): Promise<SnapFlagRankResult> {
    const t0 = Date.now();
    const layout = options.layout ?? DEFAULT_LAYOUT;
    const nonePosition = options.nonePosition ?? 'last';
    const params: FlagSpanParams = { ...DEFAULT_SPAN_PARAMS, ...(options.params ?? {}) };
    const { plan, notes } = buildFlagPlan(categories, { includeMisinformation: options.includeMisinformation });
    for (const note of notes) this.logger.log(`[SnapFlags] ${note}`);

    const units = !plan.length || !sentences.length ? [] : (options.unitList ?? buildFlagUnits(sentences, options.units));
    const chunks = !units.length ? [] : (options.chunkPlan ?? planFlagChunks(units, options.chunks));
    const map: FlagRatingMap = {
      version: RATING_MAP_VERSION,
      ranker: 'snap-v1',
      model: null,
      layout,
      nonePosition,
      categories: plan.map((p) => p.category),
      units,
      chunks,
      p1: [],
      labelMass: [],
      missingLabels: [],
      p2: units.map(() => ({})),
    };
    const counters = { pass1: 0, pass2: 0, scorerMs: 0 };

    if (units.length) {
      const work = (scorer: FlagScorer) => this.score(scorer, map, plan, params, options, counters);
      if (options.scorer) await work(options.scorer);
      else if (this.scorerServer) await this.scorerServer.withScorer((handle) => work(handle));
      else throw new Error('SnapFlagRanker: no scorer (inject ScorerServerService or pass options.scorer)');
    }

    const ranked = rankFromRatingMap(map, sentences, plan, params);
    const stats: SnapFlagRankStats = {
      sentences: sentences.length,
      units: units.length,
      chunks: chunks.length,
      pass1Questions: counters.pass1,
      pass2Questions: counters.pass2,
      hotUnits: map.p1.filter((row) => 1 - row[plan.length] >= params.pass2HotGate).length,
      spans: ranked.spans.length,
      passages: ranked.passages.length,
      windows: ranked.windows.length,
      verifyBudget: ranked.budget,
      verifyCalls: ranked.verifyCalls,
      overflowWindows: ranked.overflow.length,
      overflowCalls: ranked.overflowCalls,
      unitsWithMissingLabels: map.missingLabels.filter((n) => n > 0).length,
      scorerMs: Math.round(counters.scorerMs),
      wallMs: Date.now() - t0,
    };
    this.logger.log(
      `[SnapFlags] ${stats.sentences} sentences -> ${stats.units} units in ${stats.chunks} chunk(s), ` +
        `layout ${layout}: ${stats.pass1Questions} pass-1 + ${stats.pass2Questions} pass-2 questions ` +
        `(${stats.hotUnits} hot units) -> ${stats.spans} spans / ${stats.passages} passages -> ` +
        `${stats.windows} windows, ${stats.verifyCalls} verify calls (budget ${stats.verifyBudget}; ` +
        `${stats.overflowWindows} windows / ${stats.overflowCalls} calls over it) in ${(stats.wallMs / 1000).toFixed(1)}s` +
        (stats.unitsWithMissingLabels ? `; ${stats.unitsWithMissingLabels} units had floored letters` : ''),
    );

    return {
      windows: ranked.windows,
      overflow: ranked.overflow,
      spans: ranked.spans,
      ratingMap: map,
      plan,
      notes,
      stats,
    };
  }

  // ------------------------------------------------------------------ scoring (I/O)

  private async score(
    scorer: FlagScorer,
    map: FlagRatingMap,
    plan: FlagOptionPlan[],
    params: FlagSpanParams,
    options: SnapFlagRankOptions,
    counters: { pass1: number; pass2: number; scorerMs: number },
  ): Promise<void> {
    const units = map.units;
    const legend = map.layout === 'prefix' ? flagLegendBlock(plan) : null;
    const buildState = options.stateBuilder ?? ((texts: string[], lg: string | null) => defaultFlagState(texts, lg));
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const nProbs = options.nProbs ?? DEFAULT_N_PROBS;
    const signal = options.signal;
    const catIndex = new Map(map.categories.map((c, j) => [c, j]));
    const prevOf = (i: number) => (i === 0 ? START_OF_VIDEO : units[i - 1].text);
    const states = map.chunks.map((chunk) =>
      buildState(
        units.slice(chunk.contextFrom, chunk.contextTo).map((u) => u.text),
        legend,
        chunk,
      ),
    );

    const ask = async (state: string, questions: ChoiceQuestion[], what: string): Promise<DecideResponse> => {
      if (signal?.aborted) throw new AnalysisCancelledError(`Analysis cancelled before ${what}`);
      try {
        const res = await scorer.decide({ state, questions, missingLabels: 'floor', nProbs }, { signal });
        counters.scorerMs += res.timingMs?.total ?? 0;
        if (!map.model) map.model = res.model;
        return res;
      } catch (err) {
        if (isScorerError(err, 'cancelled') || signal?.aborted) {
          throw new AnalysisCancelledError(`Analysis cancelled during ${what}`);
        }
        throw err;
      }
    };

    // ---- pass 1: every owned unit, per chunk, in batches.
    const p1Total = units.length;
    options.onProgress?.({ phase: 'pass1', done: 0, total: p1Total });
    for (let c = 0; c < map.chunks.length; c++) {
      const chunk = map.chunks[c];
      for (let from = chunk.coreFrom; from < chunk.coreTo; from += batchSize) {
        const to = Math.min(from + batchSize, chunk.coreTo);
        const questions: ChoiceQuestion[] = [];
        for (let i = from; i < to; i++) {
          questions.push(buildPass1Question(i, units[i].text, prevOf(i), plan, map.layout, map.nonePosition));
        }
        const res = await ask(states[c], questions, `flag pass 1 (units ${from + 1}-${to}/${p1Total})`);
        for (let i = from; i < to; i++) {
          const answer = res.answers[pass1QuestionName(i)] as ChoiceAnswer;
          const row = new Array<number>(plan.length + 1).fill(0);
          for (const [name, p] of Object.entries(answer.probabilities)) {
            if (name === NONE_KEY) row[plan.length] = p;
            else row[catIndex.get(name) as number] = p;
          }
          map.p1[i] = row;
          map.labelMass[i] = answer.labelMass;
          map.missingLabels[i] = answer.missingLabels?.length ?? 0;
        }
        counters.pass1 += to - from;
        options.onProgress?.({ phase: 'pass1', done: counters.pass1, total: p1Total });
      }
    }

    // ---- pass 2: hot units x plausible categories.
    const byChunk = map.chunks.map((chunk) => {
      const qs: Array<{ q: ChoiceQuestion; unit: number; cat: string }> = [];
      for (let i = chunk.coreFrom; i < chunk.coreTo; i++) {
        for (const cat of selectPass2Categories(map.p1[i], map.categories, params)) {
          qs.push({ q: buildPass2Question(i, units[i].text, prevOf(i), plan[catIndex.get(cat) as number]), unit: i, cat });
        }
      }
      return qs;
    });
    const p2Total = byChunk.reduce((n, qs) => n + qs.length, 0);
    options.onProgress?.({ phase: 'pass2', done: 0, total: p2Total });
    for (let c = 0; c < map.chunks.length; c++) {
      const qs = byChunk[c];
      for (let k = 0; k < qs.length; k += batchSize) {
        const batch = qs.slice(k, k + batchSize);
        const res = await ask(
          states[c],
          batch.map((b) => b.q),
          `flag pass 2 (${counters.pass2 + 1}/${p2Total})`,
        );
        for (const { unit, cat } of batch) {
          const answer = res.answers[pass2QuestionName(unit, cat)] as ChoiceAnswer;
          map.p2[unit][cat] = answer.probabilities[FITS];
        }
        counters.pass2 += batch.length;
        options.onProgress?.({ phase: 'pass2', done: counters.pass2, total: p2Total });
      }
    }
  }
}
