// backend/src/media/whisper.service.ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MediaEventService } from './media-event.service';
import * as path from 'path';
import * as fs from 'fs';
import { WhisperManager } from './whisper-manager';
import {
  FfmpegBridge,
  FfprobeBridge,
  getRuntimePaths,
  verifyBinary,
  type FfmpegProgress,
} from '../bridges';
import { CrucibleTranscriptionService } from '../crucible/asr/crucible-transcription.service';
import { CrucibleAsrUnavailable, isAsrUnavailable } from '../crucible/asr/crucible-asr-job';
import type { TranscriptionRoute } from '../crucible/asr/transcription-venue';
import { isParked } from '../crucible/llm/errors';

/**
 * Which engine one transcription uses (P5). `cli` carries the warning to put
 * on the task when it is whisper-cli only because Crucible couldn't be used.
 */
export type WhisperRoute =
  | { kind: 'cli'; warning?: string | null }
  | { kind: 'crucible'; server: string; model: string; fallback: 'inline' | 'defer'; signal?: AbortSignal };

export interface TranscriptionOutcome {
  srtPath: string;
  engine: 'whisper-cli' | 'crucible';
  /** The model that transcribed: the Crucible asr id, or the whisper model asked for. */
  model: string | null;
  /** The language the engine detected, when it said. */
  language: string | null;
  /** Non-fatal: e.g. transcribed with whisper-cli because Crucible couldn't be used. */
  warnings: string[];
}

/** Crucible couldn't take the job for an infrastructure reason, or its card is busy: whisper-cli may stand in. */
export function isCrucibleFallbackCause(error: unknown): boolean {
  return isAsrUnavailable(error) || isParked(error);
}

function crucibleFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.replace(/[.\s]+$/, '');
  return `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}.`;
}

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;
  /** Resolved ffmpeg path the current bridges were built for; gates lazy rebuild. */
  private ffmpegBinaryPath?: string;
  /** Active transcriptions keyed by jobId, so a cancelled job aborts its child. */
  private activeTranscriptions: Map<string, WhisperManager> = new Map();
  /** Crucible transcriptions keyed by jobId: a cancel aborts the job's signal, which DELETEs it. */
  private activeCrucible: Map<string, AbortController> = new Map();

  constructor(
    private readonly eventService: MediaEventService,
    /** P5. Absent (a spec, or a build without Crucible): whisper-cli only, as before. */
    @Optional() private readonly crucibleAsr?: CrucibleTranscriptionService,
  ) {
    // Resolve the binary paths but DEFER verification to use time
    // (ensureFfmpegReady). Verifying (and throwing) here would take the whole Nest
    // bootstrap down whenever ffmpeg hasn't been downloaded yet, preventing the
    // backend from serving the first-run setup wizard. Construction stays
    // non-fatal; a missing binary surfaces honestly when transcription runs.
    const { ffmpeg, ffprobe } = getRuntimePaths();
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) {
      this.ffmpeg = new FfmpegBridge(ffmpeg);
      this.ffprobe = new FfprobeBridge(ffprobe);
      this.ffmpegBinaryPath = ffmpeg;
      this.logger.log(`WhisperService initialized with FFmpeg: ${ffmpeg}`);
    } else {
      this.logger.warn(
        `WhisperService: FFmpeg not installed yet (expected at ${ffmpeg}). ` +
        `Deferring until first-run setup installs the ffmpeg-tools component.`
      );
    }
  }

  /**
   * Resolve + verify ffmpeg/ffprobe at USE time (never at boot). getRuntimePaths()
   * re-reads downloaded-component state on every call, so a binary installed by
   * first-run setup is picked up here WITHOUT a backend restart. Throws an honest,
   * user-facing error while ffmpeg is missing.
   */
  private ensureFfmpegReady(): void {
    const { ffmpeg, ffprobe } = getRuntimePaths();
    if (this.ffmpegBinaryPath === ffmpeg && fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) {
      return;
    }
    if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
      throw new Error(
        'FFmpeg is not installed — complete first-run setup or install it in Settings → Components.'
      );
    }
    verifyBinary(ffmpeg, 'FFmpeg');
    verifyBinary(ffprobe, 'FFprobe');
    this.ffmpeg = new FfmpegBridge(ffmpeg);
    this.ffprobe = new FfprobeBridge(ffprobe);
    this.ffmpegBinaryPath = ffmpeg;
  }

  /**
   * Abort the transcription for a cancelled/abandoned job. Idempotent and safe
   * if nothing is running for this jobId (aborts the WhisperManager and the
   * audio-extraction ffmpeg step, which runs before the manager exists).
   */
  @OnEvent('job.cancel-requested')
  handleJobCancelRequested(payload: { jobId?: string }): void {
    const jobId = payload?.jobId;
    if (!jobId) return;

    // A Crucible job: aborting sends DELETE /v1/jobs/{id} (the job is cooperative mid-file).
    const crucible = this.activeCrucible.get(jobId);
    if (crucible) {
      this.logger.log(`Cancelling Crucible transcription for job ${jobId}`);
      crucible.abort();
    }

    const manager = this.activeTranscriptions.get(jobId);
    if (manager) {
      this.logger.log(`Cancelling transcription for job ${jobId}`);
      manager.cancel();
    }

    // The audio-extraction phase AND the pre-extraction volume/silence probes
    // run on the shared ffmpeg bridge before a WhisperManager exists — abort
    // them (all keyed on this jobId) so cancelling during that window kills any
    // running ffmpeg child. abort() is a no-op if the id isn't active.
    if (this.ffmpeg) {
      this.ffmpeg.abort(`audio-extract-${jobId}`);
      this.ffmpeg.abort(`volumedetect-${jobId}`);
      this.ffmpeg.abort(`silencedetect-${jobId}`);
    }
  }

  /**
   * The one transcription seam (callers keep this signature). Picks the engine
   * by the venue rule (Crucible asr, or whisper-cli), falls back to whisper-cli
   * in place when Crucible can't take the job, and resolves with the SRT path,
   * or null when transcription failed, exactly as before P5.
   */
  async transcribeVideo(videoFile: string, jobId?: string, model?: string, translate?: boolean): Promise<string | null> {
    try {
      return (await this.transcribe(videoFile, { jobId, model, translate })).srtPath;
    } catch (error) {
      this.logger.error(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Transcribe with the engine `route` names, or the venue rule's choice when
   * it names none. Throws on failure (the message says why).
   *
   *   route cli                         whisper-cli, unchanged since before P5.
   *   route crucible, fallback 'inline'  Crucible; an infrastructure failure or a
   *                                     busy card falls back to whisper-cli here,
   *                                     with a warning (no queue to park in).
   *   route crucible, fallback 'defer'   Crucible; a busy card throws
   *                                     CrucibleParkedError and an infrastructure
   *                                     failure CrucibleAsrUnavailable, for the
   *                                     queue to park or re-route the task.
   *
   * A cancel never falls back.
   */
  async transcribe(
    videoFile: string,
    options: { jobId?: string; model?: string; translate?: boolean; route?: WhisperRoute } = {},
  ): Promise<TranscriptionOutcome> {
    const { jobId, model, translate } = options;
    let route = options.route;
    if (route === undefined) {
      const decided: TranscriptionRoute = this.crucibleAsr === undefined
        ? { kind: 'cli', reason: 'Crucible transcription is not available in this build.', warning: null }
        : await this.crucibleAsr.route({ translate });
      route = decided.kind === 'crucible'
        ? { kind: 'crucible', server: decided.server, model: decided.model, fallback: 'inline' }
        : { kind: 'cli', warning: decided.warning };
    }

    if (route.kind === 'crucible') {
      try {
        return await this.transcribeOnCrucible(videoFile, jobId, route);
      } catch (error) {
        if (route.fallback === 'defer' || !isCrucibleFallbackCause(error)) throw error;
        const warning = `Transcribed with the offline transcriber (whisper) because ${crucibleFallbackReason(error)}`;
        this.logger.warn(`[${jobId || 'standalone'}] ${warning}`);
        this.eventService.emitTaskProgress(jobId || '', 'transcribe', 1, 'Crucible unavailable, using the offline transcriber...');
        route = { kind: 'cli', warning };
      }
    }

    const srtPath = await this.transcribeWithCli(videoFile, jobId, model, translate);
    if (!srtPath) throw new Error('Transcription failed');
    return {
      srtPath,
      engine: 'whisper-cli',
      model: model ?? null,
      language: null,
      warnings: route.warning ? [route.warning] : [],
    };
  }

  /** Crucible's asr job on the video itself. The SRT lands where the whisper-cli path puts its own. */
  private async transcribeOnCrucible(
    videoFile: string,
    jobId: string | undefined,
    route: Extract<WhisperRoute, { kind: 'crucible' }>,
  ): Promise<TranscriptionOutcome> {
    if (this.crucibleAsr === undefined) {
      throw new CrucibleAsrUnavailable('crucible_asr_unavailable', route.server, 'Crucible transcription is not available in this build.');
    }
    if (!fs.existsSync(videoFile)) {
      throw new Error(`Video file not found: ${videoFile}`);
    }
    const key = jobId || 'standalone';
    const os = require('os');
    const crypto = require('crypto');
    const outputDir = path.join(os.tmpdir(), `whisper-${crypto.randomBytes(8).toString('hex')}`);
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
      // The same relocation as the whisper-cli path: a standalone temp SRT, the job dir removed.
      const standaloneSrt = path.join(os.tmpdir(), `${path.basename(outputDir)}.srt`);
      fs.copyFileSync(outcome.srtFile, standaloneSrt);
      fs.rmSync(outputDir, { recursive: true, force: true });
      return { srtPath: standaloneSrt, engine: 'crucible', model: outcome.model, language: outcome.language, warnings: [] };
    } catch (error) {
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch {
        // A temp dir left behind is not worth masking the real error for.
      }
      if (!isCrucibleFallbackCause(error) && !isParked(error)) {
        this.eventService.emitTranscriptionFailed(videoFile, error instanceof Error ? error.message : String(error), jobId);
      }
      throw error;
    } finally {
      route.signal?.removeEventListener('abort', onCallerAbort);
      if (jobId) this.activeCrucible.delete(jobId);
    }
  }

  /** whisper-cli (whisper.cpp), exactly as it ran before P5. Resolves with the SRT path, or null on failure. */
  private async transcribeWithCli(videoFile: string, jobId?: string, model?: string, translate?: boolean): Promise<string | null> {
    console.log(`[WHISPER SERVICE] Transcription started`);
    console.log(`[WHISPER SERVICE] Video file: ${videoFile}`);
    console.log(`[WHISPER SERVICE] Job ID: ${jobId}`);
    console.log(`[WHISPER SERVICE] Model: ${model || 'default'}`);
    console.log(`[WHISPER SERVICE] Translate to English: ${translate === true}`);

    let outputDir: string | undefined;
    let audioFile: string | undefined;

    try {
      this.ensureFfmpegReady();

      if (!fs.existsSync(videoFile)) {
        throw new Error(`Video file not found: ${videoFile}`);
      }

      // Create a dedicated temp directory for this transcription job
      const os = require('os');
      const crypto = require('crypto');
      const jobHash = crypto.randomBytes(8).toString('hex');
      outputDir = path.join(os.tmpdir(), `whisper-${jobHash}`);

      // Ensure the output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      this.logger.log(`Created dedicated output directory: ${outputDir}`);

      // Quick check: is the first 10 seconds quiet?
      // If very quiet, run silence detection to skip leading silence
      let silenceOffset = 0;

      try {
        this.eventService.emitTaskProgress(jobId || '', 'transcribe', 2, 'Checking audio levels...');
        const startVolume = await this.ffmpeg.getVolumeLevel(videoFile, 0, 10, `volumedetect-${jobId || 'standalone'}`);
        this.logger.log(`First 10s volume: mean=${startVolume.mean.toFixed(1)}dB, max=${startVolume.max.toFixed(1)}dB`);

        // If very quiet (< -40dB), run silence detection to skip leading silence
        if (startVolume.mean < -40) {
          this.eventService.emitTaskProgress(jobId || '', 'transcribe', 3, 'Quiet start detected, scanning for audio...');
          silenceOffset = await this.ffmpeg.detectAudioStart(videoFile, {
            silenceThreshold: -45,
            minSilenceDuration: 2,
            maxSearchDuration: 300, // Only search first 5 minutes (faster)
            processId: `silencedetect-${jobId || 'standalone'}`,
          });
          if (silenceOffset > 5) {
            this.logger.log(`Detected ${silenceOffset.toFixed(1)}s of silence at start, will skip`);
            const skipMinutes = Math.floor(silenceOffset / 60);
            const skipSeconds = Math.floor(silenceOffset % 60);
            this.eventService.emitTaskProgress(jobId || '', 'transcribe', 4, `Skipping ${skipMinutes}m ${skipSeconds}s of silence...`);
          } else {
            silenceOffset = 0;
          }
        }
      } catch (err) {
        this.logger.warn(`Volume/silence detection failed, processing from start: ${err}`);
      }

      // Get video duration for progress tracking during extraction
      let videoDurationSeconds: number | undefined;
      try {
        videoDurationSeconds = await this.ffprobe.getDuration(videoFile);
        this.logger.log(`Video duration: ${videoDurationSeconds} seconds`);
      } catch (err) {
        this.logger.warn(`Could not determine video duration: ${err}`);
      }

      // Extract audio from video first (much more reliable for whisper)
      this.logger.log(`Extracting audio from video...`);
      const extractMessage = 'Extracting audio...';
      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 5, extractMessage);

      // Set up progress tracking for extraction (5% to 12% range).
      // Filter on this job's extraction processId so concurrent transcriptions
      // sharing the singleton FfmpegBridge don't cross-update each other.
      const extractProcessId = `audio-extract-${jobId || 'standalone'}`;
      let lastExtractProgress = 5;
      const extractProgressHandler = (progress: FfmpegProgress) => {
        if (progress.processId !== extractProcessId) return;
        // Map FFmpeg progress (0-100) to our range (5-12)
        const mappedProgress = 5 + Math.round((progress.percent / 100) * 7);
        // Only emit if progress increased (prevent bouncing)
        if (mappedProgress > lastExtractProgress) {
          lastExtractProgress = mappedProgress;
          this.eventService.emitTaskProgress(jobId || '', 'transcribe', mappedProgress, extractMessage);
        }
      };
      this.ffmpeg.on('progress', extractProgressHandler);

      // try/finally so a failed extraction never leaks the listener on the
      // singleton FfmpegBridge (stale-jobId events + MaxListenersExceeded).
      try {
        audioFile = await this.extractAudio(videoFile, outputDir, jobId || 'standalone', silenceOffset, videoDurationSeconds);
      } finally {
        this.ffmpeg.off('progress', extractProgressHandler);
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 12, 'Audio extracted, starting transcription...');
      this.logger.log(`Audio extracted to: ${audioFile}`);

      // Use video duration (adjusted for offset) as audio duration estimate
      const audioDurationSeconds = videoDurationSeconds ? videoDurationSeconds - silenceOffset : undefined;
      if (audioDurationSeconds) {
        this.logger.log(`Audio duration: ${audioDurationSeconds} seconds`);
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 15, 'Starting transcription...');

      const whisperManager = new WhisperManager();
      if (jobId) {
        this.activeTranscriptions.set(jobId, whisperManager);
      }

      // Track start time for ETA calculation
      const transcriptionStartTime = Date.now();
      let lastWhisperProgress = 15;

      // Set up progress tracking
      whisperManager.on('progress', (progress) => {
        // Only emit if progress increased (prevent bouncing)
        if (progress.percent <= lastWhisperProgress) {
          return;
        }
        lastWhisperProgress = progress.percent;

        this.logger.log(`Transcription progress: ${progress.percent}% - ${progress.task}`);

        // Calculate ETA based on elapsed time and progress
        const elapsedMs = Date.now() - transcriptionStartTime;
        let eta: number | undefined;
        if (progress.percent > 0 && progress.percent < 100) {
          // ETA = elapsed * ((100 - progress) / progress)
          eta = Math.round((elapsedMs * ((100 - progress.percent) / progress.percent)) / 1000);
        }

        // Emit old event for backward compatibility
        this.eventService.emitTranscriptionProgress(
          progress.percent,
          progress.task,
          jobId
        );
        // Emit new task-progress event for queue system with ETA
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'transcribe', progress.percent, progress.task, {
            eta,
            elapsedMs,
          });
        }

        console.log(`Progress event: ${JSON.stringify(progress)}, ETA: ${eta}s`);
      });

      this.logger.log(`Starting transcription for ${audioFile}`);
      this.eventService.emitTranscriptionStarted(videoFile, jobId);

      // Start transcription on the extracted audio file
      // Pass audio duration for time-based progress estimation
      const srtFile = await whisperManager.transcribe(audioFile, outputDir, model, audioDurationSeconds, translate);

      if (srtFile && fs.existsSync(srtFile)) {
        // If we skipped silence at the start, offset all timestamps to match original video
        if (silenceOffset > 0) {
          this.logger.log(`Adjusting timestamps by ${silenceOffset.toFixed(1)}s to match original video`);
          this.offsetSrtTimestamps(srtFile, silenceOffset);
        }

        this.logger.log(`Transcription completed: ${srtFile}`);
        this.eventService.emitTranscriptionCompleted(srtFile, jobId);

        // Move the SRT out of the per-job temp dir to a standalone temp file,
        // then remove the whole dir (extracted audio + any leftovers included).
        // The caller consumes and unlinks the returned path, so relocating the
        // SRT lets us delete outputDir here instead of leaking an empty (or
        // SRT-holding) whisper-<hash> directory in os.tmpdir() every run.
        const standaloneSrt = path.join(os.tmpdir(), `${path.basename(outputDir)}.srt`);
        try {
          fs.copyFileSync(srtFile, standaloneSrt);
          fs.rmSync(outputDir, { recursive: true, force: true });
          return standaloneSrt;
        } catch (cleanupError) {
          this.logger.warn(`Failed to relocate SRT / clean up temp directory: ${cleanupError}`);
          // Relocation failed — return the original in-dir SRT so analysis can
          // still proceed (the dir may linger, but correctness wins).
          return srtFile;
        }
      } else {
        throw new Error('Transcription failed - no SRT file generated');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? (error as Error).message : String(error);
      this.logger.error(`Transcription failed: ${errorMessage}`);
      this.eventService.emitTranscriptionFailed(videoFile, errorMessage, jobId);

      // Clean up the temporary directory on error
      try {
        // Delete the extracted audio file
        if (audioFile && fs.existsSync(audioFile)) {
          fs.unlinkSync(audioFile);
          this.logger.log(`Cleaned up audio file: ${audioFile}`);
        }

        // Delete the temp directory and all contents
        if (outputDir && fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          for (const file of files) {
            fs.unlinkSync(path.join(outputDir, file));
          }
          fs.rmdirSync(outputDir);
        }
      } catch (cleanupError) {
        this.logger.warn(`Failed to clean up temp directory: ${cleanupError}`);
      }

      return null;
    } finally {
      if (jobId) {
        this.activeTranscriptions.delete(jobId);
      }
    }
  }

  /**
   * Extract audio from video using FFmpeg bridge
   * Optimized for whisper: 16kHz, mono, WAV format
   */
  private async extractAudio(videoPath: string, outputDir: string, jobId: string, startOffset: number = 0, duration?: number): Promise<string> {
    const audioFilename = `${jobId}_audio.wav`;
    const audioPath = path.join(outputDir, audioFilename);

    this.logger.log(`Extracting audio from: ${videoPath}`);
    this.logger.log(`Audio output: ${audioPath}`);
    if (startOffset > 0) {
      this.logger.log(`Skipping first ${startOffset.toFixed(1)} seconds of silence`);
    }

    const result = await this.ffmpeg.extractAudio(videoPath, audioPath, {
      sampleRate: 16000,
      channels: 1,
      format: 'wav',
      processId: `audio-extract-${jobId}`,
      startOffset: startOffset > 0 ? startOffset : undefined,
      duration: duration,
    });

    if (!result.success) {
      throw new Error(`Failed to extract audio: ${result.error}`);
    }

    this.logger.log(`Audio extraction complete: ${audioPath}`);
    return audioPath;
  }

  /**
   * Offset all timestamps in an SRT file by a given number of seconds
   * This is used when we skip silence at the start of the video
   */
  private offsetSrtTimestamps(srtPath: string, offsetSeconds: number): void {
    if (offsetSeconds <= 0) return;

    const content = fs.readFileSync(srtPath, 'utf-8');
    const lines = content.split('\n');
    const newLines: string[] = [];

    // SRT timestamp format: 00:01:23,456 --> 00:01:25,789
    const timestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/;

    for (const line of lines) {
      const match = line.match(timestampRegex);
      if (match) {
        // Parse start time
        const startH = parseInt(match[1]);
        const startM = parseInt(match[2]);
        const startS = parseInt(match[3]);
        const startMs = parseInt(match[4]);
        const startTotal = startH * 3600 + startM * 60 + startS + startMs / 1000 + offsetSeconds;

        // Parse end time
        const endH = parseInt(match[5]);
        const endM = parseInt(match[6]);
        const endS = parseInt(match[7]);
        const endMs = parseInt(match[8]);
        const endTotal = endH * 3600 + endM * 60 + endS + endMs / 1000 + offsetSeconds;

        // Format new timestamps
        const formatTime = (seconds: number): string => {
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = Math.floor(seconds % 60);
          const ms = Math.round((seconds % 1) * 1000);
          return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
        };

        newLines.push(`${formatTime(startTotal)} --> ${formatTime(endTotal)}`);
      } else {
        newLines.push(line);
      }
    }

    fs.writeFileSync(srtPath, newLines.join('\n'));
    this.logger.log(`Offset SRT timestamps by ${offsetSeconds.toFixed(1)} seconds`);
  }
}
