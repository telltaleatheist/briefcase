/**
 * SnapFlagRanker: the flag pipeline on the snap scorer's decide verb. It
 * replaced the NLI (DeBERTa) ranker, deleted in P7.
 *
 *   groups  the transcript in groups of GROUP_SIZE consecutive units, each
 *           group sharing a unit with the next (stride GROUP_STRIDE), so a
 *           sentence is judged with the sentences around it. One `choice` per
 *           group over the enabled categories + "none" ("do these apply?"),
 *           the group's text QUOTED in the question (never an index). The
 *           whole probability vector is kept.
 *   map     each unit's vector is the mean of its groups' vectors: a
 *           per-category probability per sentence, the rating map.
 *   spans   pure, in flag-spans.ts: Viterbi on/off, category-blind merge (a
 *           run of scored sentences becomes ONE section), co-fire strength,
 *           <= 40 s passages, buildWindows, budget.
 *
 * SHAPE. `rankWindows(sentences, categories)` returns FlagWindow[]
 * (SnapFlagWindow adds fields only), indexed by the `assembleSentences`
 * sentences, strongest first, which is what runRankedFlagStage's walk, cache
 * and prompt read. `rank()` returns
 * the full result: windows, over-budget overflow, spans, the rating map, stats.
 *
 * Timestamps: every time is a whisper segment time carried by the sentences.
 * The scorer only picks letters.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AnalysisCancelledError } from '../../analysis/cancellation';
import type { RankedSentence } from '../../analysis/flag-windows';
import type { AnalysisCategory } from '../../analysis/prompts/analysis-prompts';
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
  FlagLayout,
  NonePosition,
  buildGroupQuestion,
  defaultFlagState,
  flagLegendBlock,
  groupQuestionName,
} from './flag-questions';
import {
  DEFAULT_SPAN_PARAMS,
  FlagRatingMap,
  FlagSpan,
  FlagSpanParams,
  FlagGroup,
  RATING_MAP_VERSION,
  SnapFlagWindow,
  rankFromRatingMap,
} from './flag-spans';
import { ChunkOptions, FlagChunk, FlagUnit, UnitOptions, buildFlagUnits, planFlagChunks } from './flag-units';

/** The one scorer call the ranker needs. A ScorerHandle (withScorer) satisfies it; tests pass a fake. */
export interface FlagScorer {
  decide(req: DecideRequest, options?: DecideOptions): Promise<DecideResponse>;
}

export interface FlagRankProgress {
  /** Groups answered so far. */
  done: number;
  total: number;
  /** Units covered by the answered groups, of `unitsTotal` (what the progress line counts). */
  unitsDone: number;
  unitsTotal: number;
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
  /** The scorer to rank with: the caller's lease (SnapAnalysisService's, a test's fake). */
  scorer?: FlagScorer;
}

export interface SnapFlagRankStats {
  sentences: number;
  units: number;
  chunks: number;
  groupQuestions: number;
  hotUnits: number;
  spans: number;
  passages: number;
  windows: number;
  verifyBudget: number;
  verifyCalls: number;
  overflowWindows: number;
  overflowCalls: number;
  /** Units whose groups' answers had floored (missing) letters. */
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
/** Units per group, and the step between groups: consecutive groups share GROUP_SIZE - GROUP_STRIDE units. */
export const GROUP_SIZE = 3;
export const GROUP_STRIDE = 2;
export const DEFAULT_BATCH_SIZE = 64;
export const DEFAULT_N_PROBS = 100;

@Injectable()
export class SnapFlagRanker {
  private readonly logger = new Logger(SnapFlagRanker.name);

  /** The windows alone (the shape the verifier stage reads). */
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
      groupSize: GROUP_SIZE,
      groupStride: GROUP_STRIDE,
      groups: [],
      p1: [],
      labelMass: [],
      missingLabels: [],
    };
    const counters = { groups: 0, scorerMs: 0 };

    if (units.length) {
      const work = (scorer: FlagScorer) => this.score(scorer, map, plan, options, counters);
      if (!options.scorer) throw new Error('SnapFlagRanker: no scorer (pass options.scorer, a lease the caller holds)');
      await work(options.scorer);
    }

    const ranked = rankFromRatingMap(map, sentences, plan, params);
    const stats: SnapFlagRankStats = {
      sentences: sentences.length,
      units: units.length,
      chunks: chunks.length,
      groupQuestions: counters.groups,
      hotUnits: map.p1.filter((row) => 1 - row[plan.length] >= params.shareGate).length,
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
        `layout ${layout}: ${stats.groupQuestions} group questions (${GROUP_SIZE} units, stride ${GROUP_STRIDE}) ` +
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

  /**
   * The groups of one chunk's owned units [from, to): GROUP_SIZE units each,
   * starting every GROUP_STRIDE units, the last one ending exactly at `to`
   * (never past the chunk: its state is that chunk's transcript).
   */
  static groupsOf(from: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let a = from; a < to; a += GROUP_STRIDE) {
      const b = Math.min(a + GROUP_SIZE, to);
      out.push([a, b - 1]);
      if (b === to) break;
    }
    return out;
  }

  private async score(
    scorer: FlagScorer,
    map: FlagRatingMap,
    plan: FlagOptionPlan[],
    options: SnapFlagRankOptions,
    counters: { groups: number; scorerMs: number },
  ): Promise<void> {
    const units = map.units;
    const legend = map.layout === 'prefix' ? flagLegendBlock(plan) : null;
    const buildState = options.stateBuilder ?? ((texts: string[], lg: string | null) => defaultFlagState(texts, lg));
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const nProbs = options.nProbs ?? DEFAULT_N_PROBS;
    const signal = options.signal;
    const catIndex = new Map(map.categories.map((c, j) => [c, j]));
    const width = plan.length + 1;
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

    // Every chunk's groups, planned up front so progress has a total.
    const perChunk = map.chunks.map((chunk) => SnapFlagRanker.groupsOf(chunk.coreFrom, chunk.coreTo));
    const total = perChunk.reduce((n, g) => n + g.length, 0);
    const unitsTotal = units.length;
    let unitsDone = 0;
    options.onProgress?.({ done: 0, total, unitsDone: 0, unitsTotal });

    // Per-unit sums, averaged at the end.
    const sum = units.map(() => new Array<number>(width).fill(0));
    const massSum = units.map(() => 0);
    const seen = units.map(() => 0);
    const missing = units.map(() => 0);

    for (let c = 0; c < map.chunks.length; c++) {
      const groups = perChunk[c];
      for (let k = 0; k < groups.length; k += batchSize) {
        const batch = groups.slice(k, k + batchSize);
        const firstIndex = map.groups.length;
        const questions = batch.map(([a, b], n) =>
          buildGroupQuestion(firstIndex + n, units.slice(a, b + 1).map((u) => u.text), plan, map.layout, map.nonePosition),
        );
        const res = await ask(states[c], questions, `flag groups ${counters.groups + 1}-${counters.groups + batch.length}/${total}`);
        batch.forEach(([a, b], n) => {
          const answer = res.answers[groupQuestionName(firstIndex + n)] as ChoiceAnswer;
          const row = new Array<number>(width).fill(0);
          for (const [name, p] of Object.entries(answer.probabilities)) {
            if (name === NONE_KEY) row[plan.length] = p;
            else row[catIndex.get(name) as number] = p;
          }
          const group: FlagGroup = { unitFrom: a, unitTo: b, p: row };
          map.groups.push(group);
          for (let i = a; i <= b; i++) {
            for (let j = 0; j < width; j++) sum[i][j] += row[j];
            massSum[i] += answer.labelMass;
            seen[i] += 1;
            missing[i] = Math.max(missing[i], answer.missingLabels?.length ?? 0);
          }
          unitsDone = Math.max(unitsDone, b + 1);
        });
        counters.groups += batch.length;
        options.onProgress?.({ done: counters.groups, total, unitsDone, unitsTotal });
      }
    }

    for (let i = 0; i < units.length; i++) {
      // Every unit is in at least one group (groupsOf covers [from, to) whole).
      map.p1[i] = sum[i].map((v) => v / Math.max(1, seen[i]));
      map.labelMass[i] = massSum[i] / Math.max(1, seen[i]);
      map.missingLabels[i] = missing[i];
    }
  }
}
