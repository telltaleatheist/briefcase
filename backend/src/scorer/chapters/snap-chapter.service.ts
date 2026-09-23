/**
 * SnapChapterService — chapters from the snap scorer, a port of
 * ContentStudio's segment.py (docs/snap-analysis-plan.md §4):
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
 * (chunks.ts). Not wired into ai-analysis yet: `toAnalysisChapters` gives the
 * existing `Chapter` shape for the integration phase.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ScorerServerService } from '../scorer-server.service';
import { ChoiceAnswer, DecideOptions, DecideRequest, DecideResponse, GenerateOptions, GenerateResult, ScorerError, YesNoAnswer } from '../scorer.types';
import { viterbi } from '../scorer-viterbi';
import { Chunk, ChunkPath, ChunkPlanOptions, Seam, planChunks, stitchChunks } from './chunks';
import { BATCH, OUTLINE_MAX_TOKENS, PLUG, START_OF_VIDEO, outlinePrompt, plugStatement } from './snap-prompts';
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
  /** Token count of `text` (llama-server /tokenize). Absent: ~4 characters per token. */
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
  const signal = opts.signal;
  const timings = { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 };
  if (units.length === 0) return { chapters: [], outline: [], chunks: [], seams: [], timings };
  throwIfAborted(signal);

  const texts = units.map((u) => u.text);
  const chunks = opts.chunkPlan ?? planChunks(await unitTokens(scorer, texts, signal), opts.chunking);
  const unitsTotal = chunks.reduce((n, c) => n + (c.end - c.start), 0);
  let unitsDone = 0;
  let doneWeight = 0;
  const report = (phase: ChapterPhase, chunk: number, within: number) => {
    const w = (chunks[chunk].end - chunks[chunk].start) / unitsTotal;
    const fraction = phase === 'done' ? 1 : Math.min(1, doneWeight + w * within);
    opts.onProgress?.({ phase, chunk, chunks: chunks.length, unitsDone, unitsTotal, fraction });
  };

  const writeOutline =
    opts.writeOutline ??
    (async (prompt: string, sig?: AbortSignal) =>
      (await scorer.generate(prompt, { maxTokens: OUTLINE_MAX_TOKENS, signal: sig })).text);

  const results: ChunkResult[] = [];
  const paths: ChunkPath[] = [];
  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    const sents = texts.slice(chunk.start, chunk.end);
    const text = sents.join('\n');

    // 1. outline
    throwIfAborted(signal);
    report('outline', k, 0);
    let t = Date.now();
    let items = parseOutline(await writeOutline(outlinePrompt(text), signal));
    timings.outlineMs += Date.now() - t;
    if (detectAds) items = [...items, PLUG];
    const plug = detectAds ? items.length - 1 : -1;

    // 2. assign
    t = Date.now();
    const options = assignOptions(items);
    const prevBefore = chunk.start > 0 ? texts[chunk.start - 1] : START_OF_VIDEO;
    const L: number[][] = [];
    let floored = 0;
    report('assign', k, W_OUTLINE);
    for (let b = 0; b < sents.length; b += BATCH) {
      throwIfAborted(signal);
      const end = Math.min(sents.length, b + BATCH);
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
    doneWeight += (chunk.end - chunk.start) / unitsTotal;

    results.push({ ...chunk, items, logProbs: L, path, plugVerdicts: verdicts, flooredUnits: floored });
    paths.push({ chunk, path, items, plug });
  }

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

@Injectable()
export class SnapChapterService {
  private readonly logger = new Logger(SnapChapterService.name);

  constructor(private readonly scorer: ScorerServerService) {}

  /** Whisper segments -> sentence units (assembleSentences + fold + run-on cap); the same list flags use. */
  unitsFromSegments(segments: TranscriptSegment[]): SnapUnit[] {
    return assembleUnits(segments);
  }

  /**
   * Chapters for one transcript. Holds the scorer for the whole run so the idle
   * timer cannot stop it between calls. Throws OutlineError when the outline
   * has fewer than 2 items (the caller falls back), ScorerError('cancelled')
   * when `signal` fires, and any other ScorerError from the engine.
   */
  buildChapters(units: SentenceUnit[], opts: BuildChaptersOptions = {}): Promise<BuildChaptersResult> {
    if (units.length === 0) return runSnapChapters({} as ChapterScorer, units, opts);
    return this.scorer.withScorer(async (handle) => {
      const scorer: ChapterScorer = {
        decide: (req, o) => handle.decide(req, o),
        generate: (messages, o) => handle.generate(messages, o),
        countTokens: async (text, signal) => (await (await handle.decider()).engine.tokenize(text, signal)).length,
      };
      return runSnapChapters(scorer, units, opts, this.logger);
    });
  }
}
