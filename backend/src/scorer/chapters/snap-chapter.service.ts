/**
 * Snap chapters — chapters from the snap scorer, a port of ContentStudio's
 * segment.py (docs/snap-analysis-plan.md §4):
 *
 *   1. outline  the scorer model writes the video's sections in order
 *               (generation, thinking off, temperature 0, <= 25 items, deduped);
 *   2. assign   one snap choice per sentence unit: which section is it part of?
 *               Options are the outline items plus the fixed ad/plug item;
 *               64 questions per decide (each decide primes the transcript once);
 *   3. segment  Viterbi over log P with a flat switch cost (20: the measured best);
 *   4. plugs    each stretch assigned to the ad item is confirmed by a yes/no;
 *               a rejected stretch is re-segmented without the ad option.
 *
 * Transcripts over ~16k tokens are chunked with overlap and stitched
 * (chunks.ts). In the analysis pipeline this runs through SnapAnalysisService
 * (one scorer lease with the flag pass, on a shared unit list and chunk plan),
 * on Crucible's decision door.
 */

import { Logger } from '@nestjs/common';
import { ChoiceAnswer, ChoiceQuestion, DecideOptions, DecideRequest, DecideResponse, GenerateOptions, GenerateResult, ScorerError, YesNoAnswer } from '../scorer.types';
import { viterbi } from '../scorer-viterbi';
import { Chunk, ChunkPath, ChunkPlanOptions, Seam, planChunks, stitchChunks } from './chunks';
import { BATCH, OUTLINE_MAX_TOKENS, PLUG, START_OF_VIDEO, assignWindowInstructions, outlinePrompt, plugStatement } from './snap-prompts';
import { TimeWindows, timeWindows, unitMeans } from '../windows';
import {
  PlugVerdict,
  SnapChapter,
  assignOptions,
  assignQuestions,
  confirmPlugs,
  logRow,
  parseOutline,
  piecesToChapters,
} from './segmenter';
import { SentenceUnit, SnapUnit, TranscriptSegment, assembleUnits } from './units';

/** What the pipeline needs from the scorer (a ScorerHandle satisfies it; tests pass a fake). */
export interface ChapterScorer {
  decide(req: DecideRequest, options?: DecideOptions): Promise<DecideResponse>;
  generate(messages: string, options: GenerateOptions): Promise<GenerateResult>;
  /** Token count of `text` on the scorer's model. Absent: ~4 characters per token. */
  countTokens?(text: string, signal?: AbortSignal): Promise<number>;
}

export type ChapterPhase = 'outline' | 'assign' | 'ads' | 'done';

export interface ChapterProgress {
  phase: ChapterPhase;
  /** 0-based chunk being worked on, of `chunks`. */
  chunk: number;
  chunks: number;
  /** Units assigned so far, over all chunks (overlap units count once per chunk). */
  unitsDone: number;
  unitsTotal: number;
  /** 0..1 over the whole run. */
  fraction: number;
}

export interface BuildChaptersOptions {
  /** Viterbi cost per switch, in nats. 20 was best on YTSeg (segment.py / bench_snap.py). */
  switchCost?: number;
  /** Include the ad/plug item and confirm its stretches (segment.py run(plugs=True)). Default true. */
  detectAds?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: ChapterProgress) => void;
  /** End of the last chapter, in seconds (the media duration). Default: the last unit's end. */
  totalSeconds?: number;
  /** Chunk sizes (tokens); defaults 16k single / 12k core / 2k overlap. */
  chunking?: ChunkPlanOptions;
  /**
   * A chunk plan made once per video and shared with the flag pass (plan §3.2):
   * both passes then build byte-identical chunk states. Absent: planned here.
   */
  chunkPlan?: Chunk[];
  /**
   * Who writes the outline. Default: the scorer model (the measured setup).
   * Plan §4.1 may route it to the user's chapter model when the scorer is small.
   */
  writeOutline?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /**
   * The previous-sentence stand-in for the first unit. Default "(start of the
   * video)" (segment.py:65). Refinement (chapter-tree.ts) passes the real unit
   * before the section, as chunks after the first already do.
   */
  prevBefore?: string;
  /**
   * Ask one assign question per time window of the transcript instead of one
   * per sentence (windows.ts); each unit's row is then the mean of its
   * windows' answers. Absent or null: per sentence (the measured setup).
   */
  windows?: TimeWindows | null;
  /** Chunks chaptered at once. Default {@link CHUNKS_IN_FLIGHT}; 1 is strictly one after another. */
  chunksInFlight?: number;
  /** Assign questions per decide request. Default {@link BATCH}. */
  batch?: number;
}

export interface ChunkResult {
  start: number;
  end: number;
  coreStart: number;
  coreEnd: number;
  /** Outline items, the plug last when ads are on. */
  items: string[];
  /** log P(item | unit), floored at log 1e-12, BEFORE plug rejection. */
  logProbs: number[][];
  /** Final item per unit of the chunk. */
  path: number[];
  plugVerdicts: PlugVerdict[];
  /** Units whose answer had a label floored (missing from the engine's top-n). */
  flooredUnits: number;
}

export interface BuildChaptersResult {
  chapters: SnapChapter[];
  /** Outline items over all chunks in order, de-duplicated case-insensitively (no plug). */
  outline: string[];
  chunks: ChunkResult[];
  seams: Seam[];
  timings: { outlineMs: number; assignMs: number; adsMs: number; totalMs: number };
}

const DEFAULT_SWITCH_COST = 20;
/** Chunks chaptered at once (their decides and outlines overlap; see runSnapChapters). */
export const CHUNKS_IN_FLIGHT = 3;

/** Run `tasks` with at most `limit` at once; results in task order. The first failure rejects (the rest are not started). */
export async function inFlight<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const i = next++;
      try {
        out[i] = await tasks[i]();
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return out;
}
/** Share of a chunk's progress per phase. */
const W_OUTLINE = 0.1;
const W_ASSIGN = 0.85;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScorerError('cancelled', 'chaptering was cancelled');
}

/**
 * The whole pipeline over a scorer. Pure orchestration: every model call goes
 * through `scorer`, so a fake drives it in tests.
 */
export async function runSnapChapters(
  scorer: ChapterScorer,
  units: SentenceUnit[],
  opts: BuildChaptersOptions = {},
  logger?: Pick<Logger, 'log' | 'warn'>,
): Promise<BuildChaptersResult> {
  const t0 = Date.now();
  const switchCost = opts.switchCost ?? DEFAULT_SWITCH_COST;
  const detectAds = opts.detectAds ?? true;
  const batch = Math.max(1, opts.batch ?? BATCH);
  const signal = opts.signal;
  const timings = { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 };
  if (units.length === 0) return { chapters: [], outline: [], chunks: [], seams: [], timings };
  throwIfAborted(signal);

  const texts = units.map((u) => u.text);
  const chunks = opts.chunkPlan ?? planChunks(await unitTokens(scorer, texts, signal), opts.chunking);
  const unitsTotal = chunks.reduce((n, c) => n + (c.end - c.start), 0);
  let unitsDone = 0;
  // Each chunk's share done (0..1): chunks run side by side, so the fraction
  // is the sum of every chunk's own, and never goes back.
  const within = chunks.map(() => 0);
  const report = (phase: ChapterPhase, chunk: number, at: number) => {
    within[chunk] = Math.max(within[chunk], at);
    const fraction = phase === 'done' ? 1
      : Math.min(1, chunks.reduce((sum, c, i) => sum + ((c.end - c.start) / unitsTotal) * within[i], 0));
    opts.onProgress?.({ phase, chunk, chunks: chunks.length, unitsDone, unitsTotal, fraction });
  };

  const writeOutline =
    opts.writeOutline ??
    (async (prompt: string, sig?: AbortSignal) =>
      (await scorer.generate(prompt, { maxTokens: OUTLINE_MAX_TOKENS, signal: sig })).text);

  // The chunks are independent until they are stitched (each has its own
  // outline, assignment and ad check), so CHUNKS_IN_FLIGHT of them run at
  // once: on the Mac the engine still computes one call after another, but the
  // gaps between calls (our prep, the network, the server's per-call work)
  // overlap; on vLLM the calls are batched together (crucible-pc-1,
  // 2026-10-01). Results are kept in chunk order.
  const chunkPass = async (k: number): Promise<{ result: ChunkResult; path: ChunkPath }> => {
    const chunk = chunks[k];
    const sents = texts.slice(chunk.start, chunk.end);
    const text = sents.join('\n');

    // 1. outline
    throwIfAborted(signal);
    report('outline', k, 0);
    let t = Date.now();
    let items = parseOutline(await writeOutline(outlinePrompt(text), signal));
    timings.outlineMs += Date.now() - t;

    // A single-topic chunk (a one-item outline): there is nothing to choose
    // between, so no assignment and no ad pass. The chunk is one run of that
    // item: ONE chapter spanning it, titled from the outline.
    if (items.length === 1) {
      logger?.log(`[snap-chapters] chunk ${k}: one-item outline ("${items[0]}"): one chapter spanning it`);
      const path = sents.map(() => 0);
      unitsDone += sents.length;
      within[k] = 1;
      return {
        result: { ...chunk, items, logProbs: sents.map(() => [0]), path, plugVerdicts: [], flooredUnits: 0 },
        path: { chunk, path, items, plug: -1 },
      };
    }

    if (detectAds) items = [...items, PLUG];
    const plug = detectAds ? items.length - 1 : -1;

    // 2. assign
    t = Date.now();
    const options = assignOptions(items);
    const prevBefore = chunk.start > 0 ? texts[chunk.start - 1] : (opts.prevBefore ?? START_OF_VIDEO);
    const L: number[][] = [];
    let floored = 0;
    report('assign', k, W_OUTLINE);
    if (opts.windows) {
      // One question per window; every unit's row is the mean of its windows'.
      const spans = timeWindows(units, chunk.start, chunk.end, opts.windows);
      const probs: number[][] = [];
      for (let b = 0; b < spans.length; b += batch) {
        throwIfAborted(signal);
        const end = Math.min(spans.length, b + batch);
        const questions: ChoiceQuestion[] = [];
        for (let w = b; w < end; w++) {
          const [first, last] = spans[w];
          questions.push({ type: 'choice', name: `w${w}`, instructions: assignWindowInstructions(texts.slice(first, last + 1)), options });
        }
        const resp = await scorer.decide({ state: text, questions, missingLabels: 'floor' }, { signal });
        for (let w = b; w < end; w++) {
          const ans = resp.answers[`w${w}`] as ChoiceAnswer | undefined;
          if (!ans) throw new ScorerError('engine_error', `decide returned no answer for w${w}`);
          if (ans.missingLabels?.length) floored++;
          probs.push(ans.logProbs.map((lp) => Math.exp(lp)));
        }
        unitsDone += spans[end - 1][1] + 1 - (b === 0 ? chunk.start : spans[b - 1][1] + 1);
        report('assign', k, W_OUTLINE + W_ASSIGN * (end / spans.length));
      }
      for (const row of unitMeans(chunk.start, chunk.end, spans, probs)) L.push(logRow(row.map((p) => Math.log(p))));
      logger?.log(`[snap-chapters] chunk ${k}: ${spans.length} window questions for ${sents.length} sentences`);
    } else {
      for (let b = 0; b < sents.length; b += batch) {
        throwIfAborted(signal);
        const end = Math.min(sents.length, b + batch);
        const questions = assignQuestions(sents, b, end, options, prevBefore);
        const resp = await scorer.decide({ state: text, questions, missingLabels: 'floor' }, { signal });
        for (let i = b; i < end; i++) {
          const ans = resp.answers[`s${i}`] as ChoiceAnswer | undefined;
          if (!ans) throw new ScorerError('engine_error', `decide returned no answer for s${i}`);
          if (ans.missingLabels?.length) floored++;
          L.push(logRow(ans.logProbs));
        }
        unitsDone += end - b;
        report('assign', k, W_OUTLINE + W_ASSIGN * (end / sents.length));
      }
    }
    timings.assignMs += Date.now() - t;
    if (floored) logger?.warn(`[snap-chapters] chunk ${k}: ${floored}/${sents.length} answers had a floored label`);

    // 3 + 4. Viterbi, with ad confirmation
    throwIfAborted(signal);
    t = Date.now();
    let path: number[];
    let verdicts: PlugVerdict[] = [];
    if (detectAds) {
      report('ads', k, W_OUTLINE + W_ASSIGN);
      const ask = async (a: number, b: number) => {
        throwIfAborted(signal);
        const resp = await scorer.decide(
          { state: text, questions: [{ type: 'yesno', name: 'q', instructions: plugStatement(sents.slice(a, b)) }], missingLabels: 'floor' },
          { signal },
        );
        return (resp.answers.q as YesNoAnswer).p;
      };
      ({ path, verdicts } = await confirmPlugs(L, plug, switchCost, ask));
      if (verdicts.length) {
        logger?.log(
          `[snap-chapters] chunk ${k}: ad verdicts ${verdicts.map((v) => `${v.start}-${v.end}:${v.p.toFixed(2)}`).join(' ')}`,
        );
      }
    } else {
      path = viterbi(L, switchCost);
    }
    timings.adsMs += Date.now() - t;
    within[k] = 1;

    return {
      result: { ...chunk, items, logProbs: L, path, plugVerdicts: verdicts, flooredUnits: floored },
      path: { chunk, path, items, plug },
    };
  };
  const passes = await inFlight(chunks.map((_, k) => () => chunkPass(k)), opts.chunksInFlight ?? CHUNKS_IN_FLIGHT);
  const results: ChunkResult[] = passes.map((p) => p.result);
  const paths: ChunkPath[] = passes.map((p) => p.path);

  const { pieces, seams } = stitchChunks(paths);
  const chapters = piecesToChapters(pieces, units, opts.totalSeconds);
  const outline: string[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const item of r.items) {
      if (item === PLUG || seen.has(item.toLowerCase())) continue;
      seen.add(item.toLowerCase());
      outline.push(item);
    }
  }
  timings.totalMs = Date.now() - t0;
  opts.onProgress?.({ phase: 'done', chunk: chunks.length - 1, chunks: chunks.length, unitsDone, unitsTotal, fraction: 1 });
  return { chapters, outline, chunks: results, seams, timings };
}

/**
 * Per-unit token counts for chunk planning. One /tokenize call on the whole
 * state text, shared out over the units by character length (a per-unit call
 * would be thousands of requests). Without a tokenizer: ~4 characters per token.
 */
export async function unitTokens(
  scorer: Pick<ChapterScorer, 'countTokens'>,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[]> {
  const chars = texts.map((s) => s.length + 1);
  const totalChars = chars.reduce((a, b) => a + b, 0);
  const total = scorer.countTokens ? await scorer.countTokens(texts.join('\n'), signal) : totalChars / 4;
  return chars.map((c) => (c / totalChars) * total);
}
