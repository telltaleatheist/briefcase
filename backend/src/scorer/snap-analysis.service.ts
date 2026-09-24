/**
 * SnapAnalysisService: the scorer stage of an AI analysis on the snap engine.
 *
 * ONE scorer lease per video, both passes inside it (plan §3.2, §3.4):
 *
 *   prepare   assembleSentences + assembleUnits + one chunk plan (/tokenize)
 *   chapters  outline -> assign -> Viterbi -> ad confirmation (SnapChapterService's pipeline)
 *   flags     pass 1 -> pass 2 -> spans -> windows + verify budget (SnapFlagRanker)
 *   refine    sub-outlines inside long chapters (chapter-tree.ts), AFTER the
 *             flag pass: each refinement primes its own section, so running it
 *             between chapters and flags would evict the transcript the flag
 *             pass re-uses. A video with no long span never runs it.
 *
 * Both passes get the same units and chunk plan, so their states are
 * byte-identical up to the flag legend and the flag pass re-uses the transcript
 * the chapter pass primed. Every scorer stage of the video finishes here,
 * before ai-analysis starts any LLM stage (chapter summaries, verification,
 * metadata), so the scorer and the LLM are never both working.
 *
 * FAILURE IS PER STAGE AND NEVER THROWN, except cancellation. A scorer that
 * cannot start, an outline with < 2 items, or an engine error mid-pass comes
 * back as `chaptersError` / `flagsError`, and the caller runs that stage's
 * classic path with a job warning. Cancellation (the job's AbortSignal) is the
 * one thing that propagates, as AnalysisCancelledError, so a cancelled run
 * never falls back into more work.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { AnalysisCancelledError, isCancellation } from '../analysis/cancellation';
import type { AnalysisCategory } from '../analysis/prompts/analysis-prompts';
import { OutlineError } from './chapters/segmenter';
import { ChapterTreeResult, RefineOptions, flatChapterTree, mayRefine, refineChapters } from './chapters/chapter-tree';
import { BuildChaptersOptions, BuildChaptersResult, ChapterScorer, runSnapChapters } from './chapters/snap-chapter.service';
import { TranscriptSegment } from './chapters/units';
import { SnapFlagRankOptions, SnapFlagRankResult, SnapFlagRanker } from './flags/snap-flag-ranker.service';
import { ScorerHandle, ScorerServerService } from './scorer-server.service';
import { isScorerError } from './scorer.types';
import { SnapTranscript, buildSnapTranscript } from './snap-transcript';

export type SnapStage = 'start' | 'prepare' | 'chapters' | 'flags' | 'refine' | 'done';

export interface SnapStageProgress {
  stage: SnapStage;
  /** 0..1 over the whole scorer stage (both passes). */
  fraction: number;
  message: string;
}

export interface SnapStageRequest {
  segments: TranscriptSegment[];
  categories: AnalysisCategory[];
  /** Run the chapter pass. */
  chapters: boolean;
  /** Run the flag pass. */
  flags: boolean;
  signal?: AbortSignal;
  onProgress?: (p: SnapStageProgress) => void;
  chapterOptions?: Omit<BuildChaptersOptions, 'signal' | 'onProgress' | 'chunkPlan' | 'totalSeconds'>;
  flagOptions?: Omit<SnapFlagRankOptions, 'signal' | 'onProgress' | 'scorer' | 'unitList' | 'chunkPlan'>;
  /** Outline refinement of long chapters (chapter-tree.ts defaults when absent); false turns it off. */
  refineOptions?: Omit<RefineOptions, 'signal' | 'onProgress'> | false;
}

export interface SnapStageResult {
  transcript: SnapTranscript | null;
  chapters: BuildChaptersResult | null;
  /** Why the chapter pass produced nothing (the caller falls back to classic chapters). */
  chaptersError?: string;
  /**
   * The chapter outline: `chapters` refined inside its long sections. Null
   * when chapters failed or refinement was off; a flat one-level tree when no
   * section was long.
   */
  chapterTree?: ChapterTreeResult | null;
  /** Why refinement stopped (the flat level-0 chapters still stand). */
  chapterTreeError?: string;
  flags: SnapFlagRankResult | null;
  /** Why the flag pass produced nothing (the caller falls back to NLI, then discovery). */
  flagsError?: string;
  /** The scorer's model name as the engine reports it. */
  model: string | null;
  timings: { startMs: number; prepareMs: number; chaptersMs: number; flagsMs: number; refineMs?: number; totalMs: number };
}

/** Share of the stage's progress bar the chapter pass takes when both passes run. */
const CHAPTER_SHARE = 0.55;
/** Share refinement takes when the video is long enough to need it (with flags / chapters only). */
const REFINE_SHARE_WITH_FLAGS = 0.25;
const REFINE_SHARE_ALONE = 0.4;
/** Within the flag pass: pass 1 vs pass 2. */
const PASS1_SHARE = 0.85;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An engine that is gone (start failed, died, timed out) will not serve the next pass either. */
function engineDown(err: unknown): boolean {
  return isScorerError(err, 'engine_unreachable') || isScorerError(err, 'engine_timeout');
}

@Injectable()
export class SnapAnalysisService {
  private readonly logger = new Logger(SnapAnalysisService.name);

  constructor(
    private readonly scorerServer: ScorerServerService,
    @Optional() private readonly flagRanker: SnapFlagRanker = new SnapFlagRanker(),
  ) {}

  /** Can the scorer run at all (model file + a llama-server binary)? Starts nothing. */
  availability(): { available: true } | { available: false; reason: string } {
    const a = this.scorerServer.availability();
    return a.available ? { available: true } : a;
  }

  /**
   * Unload the scorer now instead of at its idle timeout, so a LOCAL model the
   * next stage loads (Ollama, or the app's own llama-server) does not share
   * memory with 18 GB of idle scorer. Never throws; skipped while another
   * caller holds the scorer.
   */
  async releaseScorer(): Promise<void> {
    try {
      const stopped = await this.scorerServer.stopIfIdle();
      this.logger.log(stopped ? '[Snap] Scorer unloaded ahead of a local model' : '[Snap] Scorer still in use; left running');
    } catch (err) {
      this.logger.warn(`[Snap] Could not unload the scorer: ${messageOf(err)}`);
    }
  }

  /** Run the requested passes in one scorer lease. Throws only AnalysisCancelledError. */
  async run(req: SnapStageRequest): Promise<SnapStageResult> {
    const t0 = Date.now();
    const timings = { startMs: 0, prepareMs: 0, chaptersMs: 0, flagsMs: 0, refineMs: 0, totalMs: 0 };
    const result: SnapStageResult = { transcript: null, chapters: null, chapterTree: null, flags: null, model: null, timings };
    const signal = req.signal;
    const both = req.chapters && req.flags;
    const report = (stage: SnapStage, fraction: number, message: string) =>
      req.onProgress?.({ stage, fraction: Math.max(0, Math.min(1, fraction)), message });
    const cancelled = (what: string) => new AnalysisCancelledError(`Analysis cancelled during ${what}`);
    const guard = (what: string) => {
      if (signal?.aborted) throw cancelled(what);
    };

    if (!req.chapters && !req.flags) return result;
    guard('the scorer stage');
    report('start', 0, 'Starting the analysis engine...');

    const leased = async (handle: ScorerHandle) => {
      timings.startMs = Date.now() - t0;
      const decider = await handle.decider();
      result.model = decider.model;

      // ---- prepare: one unit list and one chunk plan for both passes.
      let t = Date.now();
      guard('transcript preparation');
      report('prepare', 0, 'Preparing the transcript for the analysis engine...');
      const transcript = await buildSnapTranscript(req.segments, {
        countTokens: async (text, sig) => (await decider.engine.tokenize(text, sig)).length,
        signal,
      });
      result.transcript = transcript;
      timings.prepareMs = Date.now() - t;
      this.logger.log(
        `[Snap] ${transcript.sentences.length} sentences -> ${transcript.units.length} units in ` +
          `${transcript.chunks.length} chunk(s) on ${decider.model}` +
          ` (chapters: ${req.chapters ? 'yes' : 'no'}, flags: ${req.flags ? 'yes' : 'no'})`,
      );

      // Bands: [chapters][flags][refine]. Refinement reserves a band only when
      // the video is long enough for a section to need it, so a short video's
      // progress is exactly what it was.
      const refineOpts = req.refineOptions === false ? null : (req.refineOptions ?? {});
      const refineShare =
        req.chapters && refineOpts && mayRefine(transcript.units.length, transcript.totalSeconds, refineOpts)
          ? both
            ? REFINE_SHARE_WITH_FLAGS
            : REFINE_SHARE_ALONE
          : 0;
      const scanShare = 1 - refineShare;
      const chapterShare = req.chapters ? (both ? CHAPTER_SHARE : 1) * scanShare : 0;
      const scorer: ChapterScorer = {
        decide: (r, o) => handle.decide(r, o),
        generate: (messages, o) => handle.generate(messages, o),
      };

      // ---- chapters
      let down: string | null = null;
      if (req.chapters) {
        t = Date.now();
        const span = chapterShare;
        try {
          result.chapters = await runSnapChapters(
            scorer,
            transcript.units,
            {
              ...(req.chapterOptions ?? {}),
              chunkPlan: transcript.chunks,
              totalSeconds: transcript.totalSeconds,
              signal,
              onProgress: (p) =>
                report(
                  'chapters',
                  p.fraction * span,
                  p.phase === 'outline'
                    ? `Outlining the video${p.chunks > 1 ? ` (part ${p.chunk + 1}/${p.chunks})` : ''}...`
                    : p.phase === 'assign'
                      ? `Finding chapters: ${p.unitsDone}/${p.unitsTotal} sentences...`
                      : p.phase === 'ads'
                        ? 'Checking sponsor and self-promotion stretches...'
                        : 'Chapters found',
                ),
            },
            this.logger,
          );
          this.logger.log(
            `[Snap] ${result.chapters.chapters.length} chapters from a ${result.chapters.outline.length}-item outline ` +
              `(outline ${(result.chapters.timings.outlineMs / 1000).toFixed(1)}s, assign ` +
              `${(result.chapters.timings.assignMs / 1000).toFixed(1)}s, ads ${(result.chapters.timings.adsMs / 1000).toFixed(1)}s)`,
          );
        } catch (err) {
          if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('snap chaptering');
          result.chaptersError =
            err instanceof OutlineError ? `the outline was unusable: ${messageOf(err)}` : `snap chaptering failed: ${messageOf(err)}`;
          this.logger.warn(`[Snap] ${result.chaptersError}`);
          if (engineDown(err)) down = messageOf(err);
        }
        timings.chaptersMs = Date.now() - t;
      }

      // ---- flags (same units, same chunk plan: the chapter pass's primed transcript is reused)
      if (req.flags) {
        if (down) {
          result.flagsError = `the scorer stopped answering during chaptering: ${down}`;
          return;
        }
        t = Date.now();
        const base = chapterShare;
        const span = scanShare - base;
        guard('snap flag ranking');
        try {
          result.flags = await this.flagRanker.rank(transcript.sentences, req.categories, {
            ...(req.flagOptions ?? {}),
            scorer: handle,
            unitList: transcript.units,
            chunkPlan: transcript.flagChunks,
            signal,
            onProgress: (p) => {
              const within = p.total ? p.done / p.total : 1;
              const f = p.phase === 'pass1' ? within * PASS1_SHARE : PASS1_SHARE + within * (1 - PASS1_SHARE);
              report(
                'flags',
                base + f * span,
                p.phase === 'pass1'
                  ? `Scanning for flag candidates: ${p.done}/${p.total} sentences...`
                  : `Checking flag candidates: ${p.done}/${p.total}...`,
              );
            },
          });
        } catch (err) {
          if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('snap flag ranking');
          result.flagsError = `snap flag ranking failed: ${messageOf(err)}`;
          this.logger.warn(`[Snap] ${result.flagsError}`);
          if (engineDown(err)) down = messageOf(err);
        }
        timings.flagsMs = Date.now() - t;
      }

      // ---- refine: sub-outlines inside long chapters (after flags; see the header)
      if (result.chapters) {
        if (!refineShare || down) {
          if (down && refineShare) result.chapterTreeError = `the scorer stopped answering: ${down}`;
          result.chapterTree = flatChapterTree(result.chapters.chapters);
          return;
        }
        t = Date.now();
        guard('chapter refinement');
        try {
          result.chapterTree = await refineChapters(
            scorer,
            transcript.units,
            result.chapters,
            {
              ...refineOpts!,
              signal,
              onProgress: (p) =>
                report(
                  'refine',
                  scanShare + p.fraction * refineShare,
                  p.phase === 'done'
                    ? 'Chapter outline finished'
                    : p.phase === 'outline'
                      ? `Outlining inside chapter ${p.section}/${p.sections} (level ${p.level + 1})...`
                      : `Finding sub-chapters: ${p.unitsDone}/${p.unitsTotal} sentences (level ${p.level + 1})...`,
                ),
            },
            this.logger,
          );
          this.logger.log(
            `[Snap] outline: ${result.chapterTree.flat.length} chapters over ${result.chapterTree.depth} level(s), ` +
              `${result.chapterTree.refined} section(s) refined in ${(result.chapterTree.timings.refineMs / 1000).toFixed(1)}s`,
          );
        } catch (err) {
          if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('chapter refinement');
          result.chapterTreeError = `chapter refinement failed: ${messageOf(err)}`;
          this.logger.warn(`[Snap] ${result.chapterTreeError} (keeping the ${result.chapters.chapters.length} top-level chapters)`);
          result.chapterTree = flatChapterTree(result.chapters.chapters);
        }
        timings.refineMs = Date.now() - t;
      }
    };

    try {
      await this.scorerServer.withScorer(leased, signal);
    } catch (err) {
      if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('the scorer stage');
      // The lease itself failed: the server would not start (or its template/labels
      // failed their proof). Neither pass ran.
      const reason = `the scorer could not start: ${messageOf(err)}`;
      this.logger.warn(`[Snap] ${reason}`);
      if (req.chapters && !result.chapters && !result.chaptersError) result.chaptersError = reason;
      if (req.flags && !result.flags && !result.flagsError) result.flagsError = reason;
    }

    timings.totalMs = Date.now() - t0;
    report('done', 1, 'Analysis engine finished');
    return result;
  }
}
