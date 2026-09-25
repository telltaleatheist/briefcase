// backend/src/media/whisper.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MediaEventService } from './media-event.service';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CrucibleTranscriptionService } from '../crucible/asr/crucible-transcription.service';
import { isAsrUnavailable } from '../crucible/asr/crucible-asr-job';
import { buildAsrContext, titleFromFilename } from '../crucible/asr/asr-context';
import { isParked } from '../crucible/llm/errors';

/**
 * THE ONE TRANSCRIPTION SEAM. Transcription is Crucible's `asr` job and
 * nothing else (P5, and since P7 the only transcriber: the bundled whisper.cpp
 * and its `translate` option are gone). The class keeps its name because every
 * caller knows it by it, and because what Crucible runs is whisper.
 *
 * Where it runs is the queue's placement (a GPU lane on the server the venue
 * rule chose), or, for a caller with no queue, the same venue rule asked here.
 * When no server can take it, that is a typed error the caller surfaces
 * (a queued task parks on it instead); it is never done some other way.
 */
export interface WhisperRoute {
  kind: 'crucible';
  server: string;
  model: string;
  signal?: AbortSignal;
}

export interface TranscriptionOutcome {
  srtPath: string;
  /** The plain text of the same cues, one per line (what transcript search reads). */
  txtPath: string;
  /** The Crucible asr model that transcribed. */
  model: string;
  /** The language the engine detected. */
  language: string | null;
}

/** No Crucible server can transcribe right now; the sentence says why. The queue parks on it. */
export class TranscriptionUnavailableError extends Error {
  readonly code = 'transcription_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionUnavailableError';
  }
}

export function isTranscriptionUnavailable(error: unknown): error is TranscriptionUnavailableError {
  return error instanceof TranscriptionUnavailableError;
}

/**
 * A reason to try again later, not a failure: a busy card, a server that
 * stopped answering or lost the stream, no server offering asr right now.
 * Misconfiguration (a refused token, a server too old) is NOT here: it fails.
 */
export function isTranscriptionRetryable(error: unknown): boolean {
  if (isParked(error) || isTranscriptionUnavailable(error)) return true;
  return isAsrUnavailable(error) && (error.code === 'crucible_unreachable' || error.code === 'crucible_stream_lost');
}

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);
  /** Crucible transcriptions keyed by jobId: a cancel aborts the job's signal, which DELETEs it. */
  private activeCrucible: Map<string, AbortController> = new Map();

  constructor(
    private readonly eventService: MediaEventService,
    private readonly crucibleAsr: CrucibleTranscriptionService,
  ) {}

  /** Abort the transcription for a cancelled job. Idempotent; a no-op for an id not running here. */
  @OnEvent('job.cancel-requested')
  handleJobCancelRequested(payload: { jobId?: string }): void {
    const jobId = payload?.jobId;
    if (!jobId) return;
    const crucible = this.activeCrucible.get(jobId);
    if (crucible) {
      this.logger.log(`Cancelling Crucible transcription for job ${jobId}`);
      crucible.abort();
    }
  }

  /**
   * Transcribe on the server `route` names, or where the venue rule puts it
   * now when there is no route (a caller with no queue). Throws on failure,
   * with the reason; {@link TranscriptionUnavailableError} when no server can.
   */
  async transcribe(
    videoFile: string,
    /** `context`: what is known about the video (asr-context.ts). Absent: its file name is all that is. */
    options: { jobId?: string; route?: WhisperRoute; context?: string | null } = {},
  ): Promise<TranscriptionOutcome> {
    const { jobId } = options;
    let route = options.route;
    if (route === undefined) {
      const decided = await this.crucibleAsr.route();
      if (decided.kind === 'none') throw new TranscriptionUnavailableError(decided.reason);
      route = { kind: 'crucible', server: decided.server, model: decided.model };
    }
    const context = options.context !== undefined ? options.context : buildAsrContext({ title: titleFromFilename(path.basename(videoFile)) });
    return this.transcribeOnCrucible(videoFile, jobId, route, context);
  }

  /** Crucible's asr job on the video itself: SRT and TXT land in the temp dir, as standalone files. */
  private async transcribeOnCrucible(videoFile: string, jobId: string | undefined, route: WhisperRoute, context: string | null): Promise<TranscriptionOutcome> {
    if (!fs.existsSync(videoFile)) {
      throw new Error(`Video file not found: ${videoFile}`);
    }
    const key = jobId || 'standalone';
    const outputDir = path.join(os.tmpdir(), `transcribe-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Our own cancel (job.cancel-requested), joined with the caller's signal.
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    if (route.signal?.aborted) controller.abort();
    route.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (jobId) this.activeCrucible.set(jobId, controller);

    const started = Date.now();
    try {
      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 2, `Transcribing on Crucible (${route.server})...`);
      this.eventService.emitTranscriptionStarted(videoFile, jobId);
      const outcome = await this.crucibleAsr.transcribe({
        server: route.server,
        model: route.model,
        videoFile,
        outputDir,
        baseName: `${key}_audio`,
        localId: key,
        context,
        signal: controller.signal,
        onProgress: (percent, message) => {
          const elapsedMs = Date.now() - started;
          const eta = percent > 15 && percent < 95
            ? Math.round((elapsedMs * ((95 - percent) / (percent - 15))) / 1000)
            : undefined;
          this.eventService.emitTranscriptionProgress(percent, message, jobId);
          if (jobId) this.eventService.emitTaskProgress(jobId, 'transcribe', percent, message, { eta, elapsedMs });
        },
      });
      this.eventService.emitTranscriptionCompleted(outcome.srtFile, jobId);
      // Standalone temp files, the job dir removed: the caller consumes and unlinks them.
      const stem = path.join(os.tmpdir(), path.basename(outputDir));
      const srtPath = `${stem}.srt`;
      const txtPath = `${stem}.txt`;
      fs.copyFileSync(outcome.srtFile, srtPath);
      fs.copyFileSync(outcome.txtFile, txtPath);
      fs.rmSync(outputDir, { recursive: true, force: true });
      return { srtPath, txtPath, model: outcome.model, language: outcome.language };
    } catch (error) {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch {
        // A temp dir left behind is not worth masking the real error for.
      }
      if (!isTranscriptionRetryable(error)) {
        this.eventService.emitTranscriptionFailed(videoFile, error instanceof Error ? error.message : String(error), jobId);
      }
      throw error;
    } finally {
      route.signal?.removeEventListener('abort', onCallerAbort);
      if (jobId) this.activeCrucible.delete(jobId);
    }
  }
}
