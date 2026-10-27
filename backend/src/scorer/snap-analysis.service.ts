/**
 * SnapAnalysisService: the scorer stage of an AI analysis on the snap engine.
 *
 * ONE scorer lease per video (plan §3.2, §3.4):
 *
 *   prepare   assembleUnits + one chunk plan (/tokenize)
 *   chapters  outline -> assign -> Viterbi -> ad confirmation (SnapChapterService's pipeline)
 *   refine    sub-outlines inside long chapters (chapter-tree.ts). A video
 *             with no long span never runs it.
 *
 * (The flag pass, the decide ranking of flag candidates, went with the
 * verifier on 2026-10-26: flags are marked by the flags model now,
 * analysis/flag-highlights.ts.) Every scorer stage of the video finishes
 * here, before ai-analysis starts any LLM stage (chapter summaries, flags,
 * metadata), so the scorer and the LLM are never both working.
 *
 * THE TRANSPORT (P6). The scorer is Crucible's decision door
 * (CrucibleScorerService), the only one since P7.
 *
 * FAILURE. THERE IS NO FALLBACK (the user's rule, 2026-09-23: if Crucible is
 * down, Briefcase's AI is down): a stage that fails throws
 * {@link SnapEngineError} naming why, and a busy or silent server PARKS the
 * task (CrucibleParkedError, P4). Cancellation (the job's AbortSignal)
 * propagates as AnalysisCancelledError, so a cancelled run never falls into
 * more work. The one designed partial outcome: refining a long chapter into
 * sub-chapters may fail after the top-level chapters stand; they are kept and
 * the job says sub-chapters were skipped (`chapterTreeError`).
 */

import { Injectable, Logger } from '@nestjs/common';
import { AnalysisCancelledError, isCancellation } from '../analysis/cancellation';
import { OutlineError } from './chapters/segmenter';
import { ChapterTreeResult, RefineOptions, flatChapterTree, mayRefine, refineChapters } from './chapters/chapter-tree';
import { BuildChaptersOptions, BuildChaptersResult, ChapterScorer, runSnapChapters } from './chapters/snap-chapter.service';
import { TranscriptSegment } from './chapters/units';
import { isParked } from '../crucible/llm/errors';
import { CrucibleScorerService } from './crucible-scorer.service';
import type { ScorerHandle } from './scorer-handle';
import { isScorerError } from './scorer.types';
import { SnapTranscript, buildSnapTranscript } from './snap-transcript';
import type { TimeWindows } from './windows';

export type SnapStage = 'start' | 'prepare' | 'chapters' | 'refine' | 'done';

export interface SnapStageProgress {
  stage: SnapStage;
  /** 0..1 over the whole scorer stage. */
  fraction: number;
  message: string;
}

export interface SnapStageRequest {
  segments: TranscriptSegment[];
  signal?: AbortSignal;
  onProgress?: (p: SnapStageProgress) => void;
  chapterOptions?: Omit<BuildChaptersOptions, 'signal' | 'onProgress' | 'chunkPlan' | 'totalSeconds'>;
  /** Outline refinement of long chapters (chapter-tree.ts defaults when absent); false turns it off. */
  refineOptions?: Omit<RefineOptions, 'signal' | 'onProgress'> | false;
  /**
   * Ask chapters and refinement per time window instead of per
   * sentence (windows.ts). Absent or null: per sentence.
   */
  windows?: TimeWindows | null;
}

export interface SnapStageResult {
  transcript: SnapTranscript | null;
  chapters: BuildChaptersResult | null;
  /**
   * The chapter outline: `chapters` refined inside its long sections. Null
   * when chapters failed or refinement was off; a flat one-level tree when no
   * section was long.
   */
  chapterTree?: ChapterTreeResult | null;
  /** Why refinement stopped (the flat level-0 chapters still stand). */
  chapterTreeError?: string;
  /** The scorer's model name as the engine reports it. */
  model: string | null;
  /**
   * Answers read as no evidence under the label-mass gate (label_mass < 0.01,
   * flattened to uniform), per pass and in all: counted so the run can say so.
   */
  labelMassGated: { chapters: number; refine: number; total: number };
  timings: { startMs: number; prepareMs: number; chaptersMs: number; refineMs?: number; totalMs: number };
}

/** Share of the progress bar refinement takes when the video is long enough to need it. */
const REFINE_SHARE = 0.4;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The snap engine could not produce a stage on Crucible, by name. Thrown, never
 * turned into a fallback: the analysis fails with this sentence.
 */
export class SnapEngineError extends Error {
  constructor(readonly stage: 'chapters' | 'start', reason: string) {
    super(`The analysis engine on Crucible could not ${stage === 'start' ? 'start' : `make the ${stage}`}: ${reason}`);
    this.name = 'SnapEngineError';
  }
}

@Injectable()
export class SnapAnalysisService {
  private readonly logger = new Logger(SnapAnalysisService.name);

  constructor(private readonly crucibleScorer: CrucibleScorerService) {}

  /**
   * Run the chapter pass (and refinement) in one scorer lease. Throws {@link SnapEngineError}
   * when a stage cannot be made, CrucibleParkedError when the server is busy or
   * silent inside a queue run, and AnalysisCancelledError on a cancel.
   */
  async run(req: SnapStageRequest): Promise<SnapStageResult> {
    const t0 = Date.now();
    const timings = { startMs: 0, prepareMs: 0, chaptersMs: 0, refineMs: 0, totalMs: 0 };
    const gated = { chapters: 0, refine: 0, total: 0 };
    const result: SnapStageResult = { transcript: null, chapters: null, chapterTree: null, model: null, timings, labelMassGated: gated };
    /** Which pass the decides being counted belong to. */
    let pass: 'chapters' | 'refine' = 'chapters';
    const signal = req.signal;
    const report = (stage: SnapStage, fraction: number, message: string) =>
      req.onProgress?.({ stage, fraction: Math.max(0, Math.min(1, fraction)), message });
    const cancelled = (what: string) => new AnalysisCancelledError(`Analysis cancelled during ${what}`);
    const guard = (what: string) => {
      if (signal?.aborted) throw cancelled(what);
    };

    guard('the scorer stage');
    /** A failed stage is thrown out of the lease, by name (a park goes out as it is). */
    const stageFailed = (stage: 'chapters', reason: string, err: unknown): never => {
      throw isParked(err) ? err : new SnapEngineError(stage, reason);
    };
    report('start', 0, 'Starting the analysis engine...');

    const leased = async (lease: ScorerHandle) => {
      timings.startMs = Date.now() - t0;
      result.model = lease.model;
      // Every decide of the run goes through here, so the label-mass gate's
      // flattened answers are counted per pass.
      const handle: ScorerHandle = {
        model: lease.model,
        generate: (messages, o) => lease.generate(messages, o),
        countTokens: (text, sig) => lease.countTokens(text, sig),
        decide: async (r, o) => {
          const res = await lease.decide(r, o);
          for (const answer of Object.values(res.answers)) {
            if (answer.gated) {
              gated[pass]++;
              gated.total++;
            }
          }
          return res;
        },
      };

      // ---- prepare: one unit list and one chunk plan.
      let t = Date.now();
      guard('transcript preparation');
      report('prepare', 0, 'Preparing the transcript for the analysis engine...');
      const transcript = await buildSnapTranscript(req.segments, {
        countTokens: (text, sig) => handle.countTokens(text, sig),
        signal,
      });
      result.transcript = transcript;
      timings.prepareMs = Date.now() - t;
      this.logger.log(`[Snap] ${transcript.units.length} units in ${transcript.chunks.length} chunk(s) on ${handle.model}`);

      // Bands: [chapters][refine]. Refinement reserves a band only when the
      // video is long enough for a section to need it.
      const refineOpts = req.refineOptions === false ? null : (req.refineOptions ?? {});
      const refineShare = refineOpts && mayRefine(transcript.units.length, transcript.totalSeconds, refineOpts) ? REFINE_SHARE : 0;
      const scanShare = 1 - refineShare;
      const chapterShare = scanShare;
      const scorer: ChapterScorer = {
        decide: (r, o) => handle.decide(r, o),
        generate: (messages, o) => handle.generate(messages, o),
      };

      // ---- chapters
      {
        pass = 'chapters';
        t = Date.now();
        const span = chapterShare;
        try {
          result.chapters = await runSnapChapters(
            scorer,
            transcript.units,
            {
              ...(req.chapterOptions ?? {}),
              ...(req.windows ? { windows: req.windows } : {}),
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
          if (isParked(err)) throw err;
          if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('snap chaptering');
          const reason = err instanceof OutlineError ? `the outline was unusable: ${messageOf(err)}` : `snap chaptering failed: ${messageOf(err)}`;
          this.logger.warn(`[Snap] ${reason}`);
          stageFailed('chapters', reason, err);
        }
        timings.chaptersMs = Date.now() - t;
      }

      // ---- refine: sub-outlines inside long chapters
      if (result.chapters) {
        if (!refineShare) {
          result.chapterTree = flatChapterTree(result.chapters.chapters);
          return;
        }
        pass = 'refine';
        t = Date.now();
        guard('chapter refinement');
        try {
          result.chapterTree = await refineChapters(
            scorer,
            transcript.units,
            result.chapters,
            {
              ...refineOpts!,
              ...(req.windows ? { windows: req.windows } : {}),
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
          if (isParked(err)) throw err;
          if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('chapter refinement');
          result.chapterTreeError = `chapter refinement failed: ${messageOf(err)}`;
          this.logger.warn(`[Snap] ${result.chapterTreeError} (keeping the ${result.chapters.chapters.length} top-level chapters)`);
          result.chapterTree = flatChapterTree(result.chapters.chapters);
        }
        timings.refineMs = Date.now() - t;
      }
    };

    try {
      await this.crucibleScorer.withScorer(leased, signal);
    } catch (err) {
      // A park (a busy or silent Crucible inside a queue run) is not a failure: the queue re-runs the task.
      if (isParked(err)) throw err;
      if (isCancellation(err) || isScorerError(err, 'cancelled') || signal?.aborted) throw cancelled('the scorer stage');
      if (err instanceof SnapEngineError) throw err;
      this.logger.warn(`[Snap] the analysis engine on Crucible could not start: ${messageOf(err)}`);
      throw new SnapEngineError('start', messageOf(err));
    }

    timings.totalMs = Date.now() - t0;
    if (gated.total > 0) {
      this.logger.warn(
        `[Snap] ${gated.total} answer(s) under the label-mass gate read as no evidence ` +
          `(chapters ${gated.chapters}, refinement ${gated.refine})`,
      );
    }
    report('done', 1, 'Analysis engine finished');
    return result;
  }
}
