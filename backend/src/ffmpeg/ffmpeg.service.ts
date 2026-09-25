// Briefcase/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs';
import { VideoMetadata } from '../common/interfaces/download.interface';
import { MediaEventService } from '../media/media-event.service';
import { SharedConfigService } from '../config/shared-config.service';
import { ThumbnailService } from '../database/thumbnail.service';
import {
  FfmpegBridge,
  FfprobeBridge,
  getRuntimePaths,
  verifyBinary,
  FfmpegAbortedError,
  type FfmpegProgress,
  type LoudnessMeasurement,
  type ProbeResult,
} from '../bridges';
import {
  copyToTemp,
  copyFromTemp,
  cleanupTempFiles,
  isFileAccessible,
} from '../common/utils/temp-file.util';

/**
 * Default integrated-loudness target, in LUFS. -14 is the level streaming
 * platforms normalize to, so clips land where the rest of the world sits
 * instead of a broadcast-quiet -16 or lower.
 */
export const DEFAULT_LOUDNESS_TARGET = -14;

/** True-peak ceiling in dBTP. -1.0 is the streaming-platform spec. */
const LOUDNESS_TRUE_PEAK = -1.0;

/** Target loudness range in LU. */
const LOUDNESS_RANGE = 11;

/**
 * How far from the target a file may already sit and still count as normalized,
 * in LU. Loudnorm itself only lands within a few tenths of a LU, and nobody
 * hears half a LU, so re-encoding for less than this is pure wear on the file.
 */
export const LOUDNESS_TOLERANCE_LU = 1.0;

/**
 * Is this file already at the target, so normalizing it would change nothing
 * worth hearing?
 *
 * Integrated loudness decides this on its own. True peak deliberately does not
 * get a vote: loudnorm limits peaks before the AAC encoder, and AAC overshoots
 * by up to about a dB on the way back out, so a freshly normalized file
 * measures above the ceiling every time. Testing it would mean re-encoding the
 * same file on every run and never converging, which is the opposite of the
 * point. The cost is that a file already at target loudness but clipping is
 * left alone.
 */
export function isAlreadyNormalized(
  measurement: LoudnessMeasurement,
  target: number
): boolean {
  return Math.abs(measurement.inputI - target) <= LOUDNESS_TOLERANCE_LU;
}

/**
 * Build the loudnorm filter string.
 *
 * With a measurement from the analysis pass, loudnorm works out one constant
 * gain that lands on the target and keeps the source's dynamics. Without one
 * it falls back to the one-pass dynamic mode, which is a guess that also
 * flattens speech.
 */
export function buildLoudnormFilter(
  target: number,
  measurement?: LoudnessMeasurement | null
): string {
  const base = `loudnorm=I=${target}:TP=${LOUDNESS_TRUE_PEAK}:LRA=${LOUDNESS_RANGE}`;
  if (!measurement) return base;

  return (
    `${base}` +
    `:measured_I=${measurement.inputI}` +
    `:measured_TP=${measurement.inputTP}` +
    `:measured_LRA=${measurement.inputLRA}` +
    `:measured_thresh=${measurement.inputThresh}` +
    `:offset=${measurement.targetOffset}` +
    `:linear=true`
  );
}

@Injectable()
export class FfmpegService {
  private lastReportedProgress: Map<string, number> = new Map();
  /** Active encode processIds keyed by jobId, so a cancelled job aborts its child. */
  private activeJobProcesses: Map<string, string> = new Map();
  private readonly logger = new Logger(FfmpegService.name);
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;
  /** Resolved ffmpeg path the current bridges were built for; gates lazy rebuild. */
  private ffmpegBinaryPath?: string;

  constructor(
    private readonly eventService: MediaEventService,
    private readonly configService: SharedConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly thumbnailService: ThumbnailService
  ) {
    // Resolve the bundled/downloaded binary paths but DEFER verification to use
    // time (ensureFfmpegReady). Verifying here would throw whenever ffmpeg hasn't
    // been downloaded yet and take the entire Nest bootstrap down with it — which
    // would stop the backend from ever serving the first-run setup wizard that
    // installs ffmpeg. Construction must stay non-fatal; a missing binary instead
    // surfaces as an honest error when a media operation actually runs.
    const { ffmpeg, ffprobe } = getRuntimePaths();
    if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe)) {
      this.ffmpeg = new FfmpegBridge(ffmpeg);
      this.ffprobe = new FfprobeBridge(ffprobe);
      this.ffmpegBinaryPath = ffmpeg;
      this.logger.log(`FFmpeg path: ${ffmpeg}`);
      this.logger.log(`FFprobe path: ${ffprobe}`);
    } else {
      this.logger.warn(
        `FFmpeg/FFprobe not installed yet (expected at ${ffmpeg}). ` +
        `Deferring until first-run setup installs the ffmpeg-tools component.`
      );
    }
  }

  /**
   * Resolve + verify the ffmpeg/ffprobe binaries at USE time (never at boot).
   *
   * getRuntimePaths() re-reads the downloaded-component state on every call, so a
   * binary installed by first-run setup is picked up here WITHOUT restarting the
   * backend: when the resolved path changes (or the bridges were never built
   * because the binary was absent at boot) we rebuild the bridges against the
   * current path. Throws an honest, user-facing error while ffmpeg is missing.
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
    this.logger.log(`FFmpeg path: ${ffmpeg}`);
    this.logger.log(`FFprobe path: ${ffprobe}`);
  }

  /**
   * Abort the encode for a cancelled/abandoned job. Idempotent and safe if no
   * encode is running for this jobId (the bridge no-ops on an unknown process).
   */
  @OnEvent('job.cancel-requested')
  handleJobCancelRequested(payload: { jobId?: string }): void {
    const jobId = payload?.jobId;
    if (!jobId) return;
    const processId = this.activeJobProcesses.get(jobId);
    if (processId && this.ffmpeg) {
      this.logger.log(`Aborting ffmpeg process ${processId} for cancelled job ${jobId}`);
      this.ffmpeg.abort(processId);
    }
  }

  async getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    try {
      this.ensureFfmpegReady();
      const metadata = await this.ffprobe.probe(videoPath);

      const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video');
      const audioStream = metadata.streams?.find((stream) => stream.codec_type === 'audio');

      if (!videoStream && !audioStream) {
        throw new Error('No video or audio stream found');
      }

      const primaryStream = videoStream || audioStream!;

      let fileDuration = 0;
      if (primaryStream.duration) {
        fileDuration = parseFloat(primaryStream.duration);
      }
      if (!fileDuration && metadata.format?.duration) {
        fileDuration = typeof metadata.format.duration === 'string'
          ? parseFloat(metadata.format.duration)
          : metadata.format.duration;
      }

      let fps: number | undefined;
      if (videoStream?.r_frame_rate) {
        const [numerator, denominator] = videoStream.r_frame_rate.split('/').map(Number);
        if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
          fps = numerator / denominator;
        }
      }

      let aspectRatio: string | undefined;
      if (videoStream?.width && videoStream?.height) {
        const gcd = this.calculateGCD(videoStream.width, videoStream.height);
        aspectRatio = `${videoStream.width / gcd}:${videoStream.height / gcd}`;
      }

      return {
        width: videoStream?.width,
        height: videoStream?.height,
        duration: fileDuration,
        codecName: primaryStream.codec_name,
        bitrate: primaryStream.bit_rate ? parseInt(primaryStream.bit_rate) : undefined,
        fps,
        aspectRatio,
      };
    } catch (err: any) {
      this.logger.error(`Error probing video: ${err.message}`);
      throw err;
    }
  }

  async reencodeVideo(
    videoFile: string,
    jobId?: string,
    options?: {
      fixAspectRatio?: boolean,
      normalizeAudio?: boolean,
      normalizeLoudness?: boolean,
      loudnessTarget?: number,
      useCompression?: boolean,
      compressionLevel?: number
    },
    taskType?: string
  ): Promise<string | null> {
    this.logger.log('Received reencoding options:', JSON.stringify({
      fixAspectRatio: options?.fixAspectRatio,
      normalizeAudio: options?.normalizeAudio,
      normalizeLoudness: options?.normalizeLoudness,
      loudnessTarget: options?.loudnessTarget
    }, null, 2));

    const fileName = path.basename(videoFile);
    let tempInputFile: string | undefined;
    let tempOutputFile: string | undefined;
    let progressKey = '';

    try {
      this.ensureFfmpegReady();
      const selectedEncoder = 'libx264';
      const processId = `reencode-${Date.now()}`;

      // STEP 1: Copy source file to temp directory to avoid file locks (Syncthing, etc.)
      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 2, 'Preparing file for processing...');
      }

      const copyResult = await copyToTemp(videoFile, {
        maxRetries: 5,
        retryDelayMs: 1000,
        onProgress: (msg) => {
          this.logger.log(`[CopyToTemp] ${msg}`);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, 3, msg);
          }
        }
      });

      if (!copyResult.success || !copyResult.tempPath) {
        this.logger.error(`Failed to copy file to temp: ${copyResult.error}`);
        if (taskType && jobId) {
          this.eventService.emitTaskProgress(jobId, taskType, -1, `File access error: ${copyResult.error}`);
        }
        return null;
      }

      tempInputFile = copyResult.tempPath;
      this.logger.log(`Copied source to temp: ${tempInputFile}`);

      // STEP 2: Probe the temp file for metadata
      const metadata = await this.ffprobe.probe(tempInputFile);
      const hasAudio = !!metadata.streams?.some((s) => s.codec_type === 'audio');
      const videoAnalysis = this.analyzeVideoMetadata(metadata);

      if (!videoAnalysis.isValid) {
        this.safeDeleteFile(tempInputFile);
        return null;
      }

      const duration = videoAnalysis.duration || 0;
      if (duration <= 0) {
        // Progress percentages can't be computed without a duration; the
        // encode itself still runs (and may repair the broken container).
        this.logger.warn(`ffprobe returned no duration for ${fileName} — progress will be indeterminate for this re-encode`);
      }
      const needsAspectRatioFix = videoAnalysis.needsAspectRatioFix ?? false;

      // Create output path in temp directory
      const fileBase = path.parse(fileName).name;
      tempOutputFile = `${tempInputFile}_reencoded.mov`;
      progressKey = tempOutputFile;

      this.lastReportedProgress.set(progressKey, 0);

      this.logger.log(`ASPECT RATIO FIX: requested=${options?.fixAspectRatio}, videoNeeds=${needsAspectRatioFix}, will apply=${options?.fixAspectRatio}`);

      // Measure loudness first when normalizing, so the encode applies one
      // constant gain onto the target instead of one-pass loudnorm's guess.
      let loudnessMeasurement: LoudnessMeasurement | null = null;
      let normalizeLoudness = options?.normalizeLoudness ?? false;
      if (normalizeLoudness && hasAudio) {
        if (taskType && jobId) {
          this.eventService.emitTaskProgress(jobId, taskType, 4, 'Measuring loudness...');
        }
        const measureProcessId = `${processId}-measure`;
        if (jobId) {
          this.activeJobProcesses.set(jobId, measureProcessId);
        }
        try {
          loudnessMeasurement = await this.ffmpeg.measureLoudness(
            tempInputFile,
            options?.loudnessTarget ?? DEFAULT_LOUDNESS_TARGET,
            LOUDNESS_TRUE_PEAK,
            LOUDNESS_RANGE,
            measureProcessId
          );
        } catch (measureError: any) {
          if (measureError instanceof FfmpegAbortedError) {
            // The job was cancelled mid-measurement. Starting the encode now
            // would burn minutes of CPU on work nobody is waiting for.
            this.logger.log(`Re-encode cancelled during loudness measurement: ${fileName}`);
            this.safeDeleteFile(tempInputFile);
            if (taskType && jobId) {
              this.eventService.emitTaskProgress(jobId, taskType, -1, 'Processing cancelled');
            }
            return null;
          }
          this.logger.warn(`Loudness measurement failed, falling back to one-pass: ${measureError.message}`);
        } finally {
          if (jobId) {
            this.activeJobProcesses.delete(jobId);
          }
        }

        // The video still has to be re-encoded for the aspect fix, but audio
        // that is already on target should pass through untouched by loudnorm.
        if (
          loudnessMeasurement &&
          isAlreadyNormalized(loudnessMeasurement, options?.loudnessTarget ?? DEFAULT_LOUDNESS_TARGET)
        ) {
          this.logger.log(`Audio already at ${loudnessMeasurement.inputI} LUFS — re-encoding video only (${fileName})`);
          normalizeLoudness = false;
          loudnessMeasurement = null;
        }
      }

      // Build args using temp files
      const args = this.buildFfmpegArgs(
        tempInputFile,
        tempOutputFile,
        needsAspectRatioFix,
        selectedEncoder,
        { ...options, normalizeLoudness, loudnessMeasurement },
        hasAudio
      );

      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 5, 'Starting video re-encoding...');
      }

      this.logger.log(`FFmpeg re-encoding command: ${this.ffmpeg.path} ${args.join(' ')}`);

      // Track start time for ETA calculation
      const processingStartTime = Date.now();

      // Set up progress listener
      const progressHandler = (progress: FfmpegProgress) => {
        if (progress.processId !== processId) return;

        const lastProgress = this.lastReportedProgress.get(progressKey) || 0;
        // Reserve 5-85% for FFmpeg processing, 85-100% for verification and copy-back
        const boundedPercent = Math.max(5, Math.min(Math.round(progress.percent * 0.8) + 5, 85));

        if (boundedPercent > lastProgress) {
          this.lastReportedProgress.set(progressKey, boundedPercent);
          const message = `Re-encoding video ${progress.speed ? `(Speed: ${progress.speed}x)` : ''}`;

          // Calculate ETA based on elapsed time and progress
          const elapsedMs = Date.now() - processingStartTime;
          let eta: number | undefined;
          if (progress.percent > 0 && progress.percent < 100) {
            eta = Math.round((elapsedMs * ((100 - progress.percent) / progress.percent)) / 1000);
          }

          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, boundedPercent, message, {
              eta,
              elapsedMs,
            });
          }
        }
      };

      this.ffmpeg.on('progress', progressHandler);
      if (jobId) {
        this.activeJobProcesses.set(jobId, processId);
      }

      try {
        const result = await this.ffmpeg.run(args, { duration, processId });

        if (!result.success) {
          this.logger.error(`Re-encoding failed: ${result.error}`);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, -1, `Re-encoding failed: ${result.error}`);
          }
          return null;
        }
      } finally {
        this.ffmpeg.off('progress', progressHandler);
      }

      this.logger.log(`FFmpeg completed, verifying output: ${tempOutputFile}`);

      // STEP 3: Verify the output file
      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 88, 'Verifying processed video...');
      }

      const verification = await this.verifyProcessedVideo(tempOutputFile, duration);
      if (!verification.valid) {
        this.logger.error(`VERIFICATION FAILED: ${verification.error}`);
        this.safeDeleteFile(tempOutputFile);
        if (taskType && jobId) {
          this.eventService.emitTaskProgress(jobId, taskType, -1, `Verification failed: ${verification.error}`);
        }
        return null;
      }

      this.logger.log(`Verification passed, copying back to original location`);

      // STEP 4: Copy processed file back to original location with retry logic
      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 92, 'Saving processed video...');
      }

      const copyBackResult = await copyFromTemp(tempOutputFile, videoFile, {
        maxRetries: 5,
        retryDelayMs: 1500,
        preserveTimestamps: true,
        deleteTemp: true,
        onProgress: (msg) => {
          this.logger.log(`[CopyFromTemp] ${msg}`);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, 95, msg);
          }
        }
      });

      if (!copyBackResult.success) {
        this.logger.error(`Failed to copy processed file back: ${copyBackResult.error}`);
        if (taskType && jobId) {
          this.eventService.emitTaskProgress(jobId, taskType, -1, `Failed to save: ${copyBackResult.error}`);
        }
        return null;
      }

      // Clean up temp input file
      this.safeDeleteFile(tempInputFile);

      this.lastReportedProgress.set(progressKey, 100);
      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 100, 'Video re-encoding completed');
      }
      return videoFile;
    } catch (error: any) {
      this.logger.error('CRITICAL: Unexpected error in re-encoding:', error);
      // Clean up temp files on error
      if (tempInputFile) this.safeDeleteFile(tempInputFile);
      if (tempOutputFile) this.safeDeleteFile(tempOutputFile);
      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, -1, `Unexpected error: ${error.message}`);
      }
      return null;
    } finally {
      if (jobId) {
        this.activeJobProcesses.delete(jobId);
      }
      if (progressKey) {
        this.lastReportedProgress.delete(progressKey);
      }
    }
  }

  /**
   * Does this file actually need an aspect-ratio fix?
   *
   * Decided by geometry, the same way the queue's skip check decides it, and
   * rotation-aware. Returns null when the file can't be probed: the caller
   * should then do the work rather than skip on a guess.
   */
  async needsAspectRatioFix(filePath: string): Promise<boolean | null> {
    try {
      this.ensureFfmpegReady();
      const metadata = await this.ffprobe.probe(filePath);
      const analysis = this.analyzeVideoMetadata(metadata);
      if (!analysis.isValid) return null;
      return analysis.needsAspectRatioFix ?? null;
    } catch (error: any) {
      this.logger.warn(`Could not probe ${path.basename(filePath)} for aspect ratio: ${error.message}`);
      return null;
    }
  }

  private analyzeVideoMetadata(metadata: ProbeResult): {
    isValid: boolean,
    dimensions?: { width: number, height: number },
    duration?: number,
    isVertical?: boolean,
    needsAspectRatioFix?: boolean
  } {
    const stream = metadata.streams?.find((s) => s.codec_type === 'video');
    if (!stream) {
      this.logger.error('CRITICAL: No video stream found');
      return { isValid: false };
    }

    let width = stream.width;
    let height = stream.height;
    let totalDuration = parseFloat(stream.duration || metadata.format?.duration || '0');

    if (!width || !height) {
      this.logger.error('Could not determine video dimensions');
      return { isValid: false };
    }

    const tags = stream.tags || {};
    const rotation = stream.rotation || tags.rotate || 0;

    if (rotation === '90' || rotation === '270' || rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }

    const aspectRatio = width / height;
    const targetAspectRatio = 16 / 9;
    const aspectRatioTolerance = 0.01;
    const needsAspectRatioFix = Math.abs(aspectRatio - targetAspectRatio) > aspectRatioTolerance;
    const isVertical = aspectRatio <= 1.0;

    this.logger.log(`REENCODING ANALYSIS: ${width}x${height}, AR: ${aspectRatio.toFixed(4)}, Vertical: ${isVertical}, NeedsFix: ${needsAspectRatioFix}`);

    return {
      isValid: true,
      dimensions: { width, height },
      duration: totalDuration,
      isVertical,
      needsAspectRatioFix
    };
  }

  private buildFfmpegArgs(
    videoFile: string,
    outputFile: string,
    needsAspectRatioFix: boolean,
    encoder: string,
    options?: {
      fixAspectRatio?: boolean,
      normalizeLoudness?: boolean,
      loudnessTarget?: number,
      loudnessMeasurement?: LoudnessMeasurement | null,
      useCompression?: boolean,
      compressionLevel?: number
    },
    hasAudio: boolean = true
  ): string[] {
    let filterComplex = '';

    // Apply aspect ratio fix if user requested it - don't second-guess the user
    if (options?.fixAspectRatio) {
      filterComplex = "[0:v]scale=1920:1920:force_original_aspect_ratio=increase,gblur=sigma=50,crop=1920:1080[bg];" +
                       "[0:v]scale='if(gte(a,16/9),1920,-1)':'if(gte(a,16/9),-1,1080)'[fg];" +
                       "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]";
    } else {
      filterComplex = "[0:v]format=yuv420p[v]";
    }

    const mapOptions = ['-map', '[v]'];

    // Only build the audio filtergraph when the source actually has an audio
    // stream — referencing [0:a] on a video with no audio aborts ffmpeg at
    // filtergraph configuration. With no audio we fall through to the optional
    // `-map 0:a?` below, which is a no-op when absent.
    if ((options?.normalizeLoudness || options?.useCompression) && hasAudio) {
      let audioFilter = '';

      if (options?.normalizeLoudness) {
        // Loudness normalization is a target to hit, not a gain to apply. This
        // used to be `volume=<target>dB`, which read the -14 LUFS target as a
        // 14 dB cut and buried the audio.
        const target = options.loudnessTarget ?? DEFAULT_LOUDNESS_TARGET;
        audioFilter = `[0:a]${buildLoudnormFilter(target, options.loudnessMeasurement)}`;
        audioFilter += options?.useCompression ? '[a1];[a1]' : '[aout]';
      } else {
        audioFilter = '[0:a]';
      }

      if (options?.useCompression) {
        const level = options.compressionLevel ?? 5;
        audioFilter += `compand=attacks=0.3:decays=0.3:points=-90/-900|-45/-900|-30/-15|0/-6|15/0:gain=${level}[aout]`;
      }

      filterComplex += `;${audioFilter}`;
      mapOptions.push('-map', '[aout]?');
    } else {
      mapOptions.push('-map', '0:a?');
    }

    return [
      '-y',
      '-i', videoFile,
      '-filter_complex', filterComplex,
      ...mapOptions,
      '-pix_fmt', 'yuv420p',
      '-c:v', encoder,
      '-b:v', '3M',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputFile
    ];
  }

  private safeDeleteFile(filePath: string): boolean {
    if (!filePath) return false;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`Error deleting file ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Verify a processed video file is valid by checking:
   * - File exists
   * - File has non-zero size
   * - Duration is within tolerance of expected duration
   */
  private async verifyProcessedVideo(
    outputFile: string,
    expectedDuration: number,
    toleranceSeconds: number = 2
  ): Promise<{ valid: boolean; error?: string; actualDuration?: number }> {
    // Check file exists
    if (!fs.existsSync(outputFile)) {
      return { valid: false, error: 'Output file does not exist' };
    }

    // Check file has content
    const stats = fs.statSync(outputFile);
    if (stats.size === 0) {
      return { valid: false, error: 'Output file is empty (0 bytes)' };
    }

    // Minimum reasonable size - 10KB per second of video
    const minExpectedSize = expectedDuration * 10000;
    if (stats.size < minExpectedSize && expectedDuration > 1) {
      return {
        valid: false,
        error: `Output file suspiciously small: ${stats.size} bytes for ${expectedDuration}s video`
      };
    }

    // Verify duration matches within tolerance
    try {
      const metadata = await this.ffprobe.probe(outputFile);
      const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
      const actualDuration = parseFloat(
        videoStream?.duration || metadata.format?.duration || '0'
      );

      if (actualDuration === 0) {
        return { valid: false, error: 'Could not determine output video duration' };
      }

      const durationDiff = Math.abs(actualDuration - expectedDuration);
      if (durationDiff > toleranceSeconds) {
        return {
          valid: false,
          error: `Duration mismatch: expected ${expectedDuration.toFixed(1)}s, got ${actualDuration.toFixed(1)}s (diff: ${durationDiff.toFixed(1)}s)`,
          actualDuration
        };
      }

      this.logger.log(`Video verification passed: ${stats.size} bytes, ${actualDuration.toFixed(1)}s duration`);
      return { valid: true, actualDuration };
    } catch (error: any) {
      return { valid: false, error: `Failed to probe output file: ${error.message}` };
    }
  }

  /**
   * Atomically replace original file with new file.
   * Uses backup strategy to ensure original is never lost if replacement fails.
   */
  private async atomicFileReplace(
    originalFile: string,
    newFile: string,
    preserveTimestamps: boolean = true
  ): Promise<{ success: boolean; error?: string }> {
    const backupFile = `${originalFile}.backup`;

    try {
      // Get original timestamps if needed
      let originalAtime: Date | undefined;
      let originalMtime: Date | undefined;
      if (preserveTimestamps && fs.existsSync(originalFile)) {
        const stats = fs.statSync(originalFile);
        originalAtime = stats.atime;
        originalMtime = stats.mtime;
      }

      // Step 1: Rename original to backup (not delete!)
      if (fs.existsSync(originalFile)) {
        fs.renameSync(originalFile, backupFile);
        this.logger.log(`Backed up original: ${originalFile} -> ${backupFile}`);
      }

      // Step 2: Rename new file to original name
      try {
        fs.renameSync(newFile, originalFile);
        this.logger.log(`Renamed new file: ${newFile} -> ${originalFile}`);
      } catch (renameError: any) {
        // CRITICAL: Restore backup if rename fails
        this.logger.error(`Failed to rename new file, restoring backup: ${renameError.message}`);
        if (fs.existsSync(backupFile)) {
          fs.renameSync(backupFile, originalFile);
          this.logger.log(`Restored original from backup`);
        }
        return { success: false, error: `Rename failed: ${renameError.message}` };
      }

      // Step 3: Restore timestamps
      if (preserveTimestamps && originalAtime && originalMtime) {
        try {
          fs.utimesSync(originalFile, originalAtime, originalMtime);
        } catch (timeError) {
          this.logger.warn(`Could not preserve timestamps: ${timeError}`);
        }
      }

      // Step 4: Delete backup only after successful replacement
      if (fs.existsSync(backupFile)) {
        fs.unlinkSync(backupFile);
        this.logger.log(`Deleted backup file`);
      }

      return { success: true };
    } catch (error: any) {
      // Try to restore from backup if anything went wrong
      if (fs.existsSync(backupFile) && !fs.existsSync(originalFile)) {
        try {
          fs.renameSync(backupFile, originalFile);
          this.logger.log(`Restored original from backup after error`);
        } catch (restoreError) {
          this.logger.error(`CRITICAL: Could not restore backup: ${restoreError}`);
        }
      }
      return { success: false, error: error.message };
    }
  }

  async createThumbnail(videoPath: string, outputPath?: string, videoId?: string): Promise<string | null> {
    if (!fs.existsSync(videoPath)) {
      this.logger.error(`Video file doesn't exist: ${videoPath}`);
      return null;
    }

    try {
      this.ensureFfmpegReady();
      if (!outputPath) {
        if (videoId) {
          try {
            outputPath = this.thumbnailService.getThumbnailPath(videoId);
          } catch (thumbnailError) {
            this.logger.warn(`ThumbnailService not ready, using fallback path`);
            const fileDir = path.dirname(videoPath);
            const fileBase = path.parse(videoPath).name;
            outputPath = path.join(fileDir, `${fileBase}_thumbnail.jpg`);
          }
        } else {
          const fileDir = path.dirname(videoPath);
          const fileBase = path.parse(videoPath).name;
          outputPath = path.join(fileDir, `${fileBase}_thumbnail.jpg`);
        }
      }

      if (!outputPath) {
        this.logger.error('Failed to determine thumbnail output path');
        return null;
      }

      const outputFolder = path.dirname(outputPath);
      if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
      }

      const metadata = await this.getVideoMetadata(videoPath);
      const duration = metadata?.duration || 0;
      if (duration <= 0) {
        this.logger.warn(`No duration available for ${videoPath} — thumbnail will be taken at the 2s mark`);
      }
      // Seek to 25% of duration to avoid black intro frames
      const thumbnailTime = Math.max(2, duration * 0.25);

      const args = [
        '-y',
        '-ss', thumbnailTime.toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
        outputPath
      ];

      this.logger.log(`Creating thumbnail: ${this.ffmpeg.path} ${args.join(' ')}`);

      const result = await this.ffmpeg.run(args);

      if (!result.success) {
        this.logger.error(`Thumbnail creation failed: ${result.error}`);
        return null;
      }

      this.logger.log(`Thumbnail created at: ${outputPath}`);
      return outputPath;
    } catch (error: any) {
      this.logger.error('Error creating thumbnail:', error);
      return null;
    }
  }

  private calculateGCD(a: number, b: number): number {
    return b === 0 ? a : this.calculateGCD(b, a % b);
  }

  async normalizeAudio(filePath: string, targetVolume: number = DEFAULT_LOUDNESS_TARGET, jobId?: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) {
      this.logger.error(`File doesn't exist: ${filePath}`);
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, 'File not found');
      }
      return null;
    }

    const fileName = path.basename(filePath);
    const fileExt = path.extname(fileName);
    let tempInputFile: string | undefined;
    let tempOutputFile: string | undefined;

    try {
      this.ensureFfmpegReady();
      const processId = `normalize-${Date.now()}`;

      // A file with no audio stream has nothing to normalize. ffmpeg tolerates
      // it (the filter simply finds no audio), but it would still cost a copy
      // to temp, an encode and a verify to produce an identical file.
      try {
        const probe = await this.ffprobe.probe(filePath);
        const hasAudio = !!probe.streams?.some((stream) => stream.codec_type === 'audio');
        if (!hasAudio) {
          this.logger.log(`Skipping normalization — ${fileName} has no audio stream`);
          if (jobId) {
            this.eventService.emitTaskProgress(jobId, 'normalize-audio', 100, 'No audio track — nothing to normalize');
          }
          return filePath;
        }
      } catch (probeError: any) {
        // Can't tell: carry on and let the encode decide.
        this.logger.warn(`Could not probe ${fileName} for audio streams: ${probeError.message}`);
      }

      // STEP 1: Measure the source before touching it. This decides two things
      // at once: whether the file needs normalizing at all, and (if it does)
      // the constant gain the encode pass should apply. Measuring the original
      // rather than a temp copy means an already-normalized file costs one
      // read and no copy.
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 2, 'Measuring loudness...');
      }

      let measurement: LoudnessMeasurement | null = null;
      const measureProcessId = `${processId}-measure`;
      // Register the measurement pass too, so cancelling the job kills it
      // rather than leaving it chewing through the file.
      if (jobId) {
        this.activeJobProcesses.set(jobId, measureProcessId);
      }
      try {
        measurement = await this.ffmpeg.measureLoudness(
          filePath,
          targetVolume,
          LOUDNESS_TRUE_PEAK,
          LOUDNESS_RANGE,
          measureProcessId
        );
      } catch (measureError: any) {
        if (measureError instanceof FfmpegAbortedError) {
          // The job was cancelled mid-measurement. Starting the encode now
          // would burn minutes of CPU on work nobody is waiting for.
          this.logger.log(`Normalization cancelled during loudness measurement: ${fileName}`);
          if (jobId) {
            this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, 'Normalization cancelled');
          }
          return null;
        }
        // Anything else is survivable: fall through to the one-pass filter.
        this.logger.warn(`Loudness measurement failed, falling back to one-pass: ${measureError.message}`);
      } finally {
        if (jobId) {
          this.activeJobProcesses.delete(jobId);
        }
      }

      // Already on target: hand back the untouched file. Re-encoding it would
      // cost an AAC generation for no audible gain.
      if (measurement && isAlreadyNormalized(measurement, targetVolume)) {
        this.logger.log(
          `Skipping normalization — ${fileName} is already ${measurement.inputI} LUFS ` +
          `(target ${targetVolume}, peak ${measurement.inputTP} dBTP)`
        );
        if (jobId) {
          this.eventService.emitTaskProgress(
            jobId,
            'normalize-audio',
            100,
            `Already at ${measurement.inputI} LUFS — no change needed`
          );
        }
        return filePath;
      }

      if (!measurement) {
        this.logger.warn(`No loudness measurement for ${fileName} — using one-pass normalization`);
      } else {
        this.logger.log(`Normalizing ${measurement.inputI} LUFS -> ${targetVolume} LUFS (${fileName})`);
      }

      // STEP 2: Copy source file to temp directory to avoid file locks (Syncthing, etc.)
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 3, 'Preparing file for processing...');
      }

      const copyResult = await copyToTemp(filePath, {
        maxRetries: 5,
        retryDelayMs: 1000,
        onProgress: (msg) => {
          this.logger.log(`[CopyToTemp] ${msg}`);
          if (jobId) {
            this.eventService.emitTaskProgress(jobId, 'normalize-audio', 4, msg);
          }
        }
      });

      if (!copyResult.success || !copyResult.tempPath) {
        this.logger.error(`Failed to copy file to temp: ${copyResult.error}`);
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, `File access error: ${copyResult.error}`);
        }
        return null;
      }

      tempInputFile = copyResult.tempPath;
      this.logger.log(`Copied source to temp: ${tempInputFile}`);

      // STEP 3: Get duration for progress tracking
      const metadata = await this.getVideoMetadata(tempInputFile);
      const duration = metadata?.duration || 0;
      if (duration <= 0) {
        this.logger.warn(`No duration available for ${tempInputFile} — normalization progress will be indeterminate`);
      }

      // Create output path in temp directory
      tempOutputFile = `${tempInputFile}_normalized${fileExt}`;

      const args = [
        '-y',
        '-i', tempInputFile,
        '-af', buildLoudnormFilter(targetVolume, measurement),
        '-c:v', 'copy',  // Copy video stream without re-encoding
        '-c:a', 'aac',
        '-b:a', '192k',
        tempOutputFile
      ];

      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 5, 'Starting audio normalization...');
      }

      this.logger.log(`Audio normalization: ${this.ffmpeg.path} ${args.join(' ')}`);

      // Track start time for ETA calculation
      const normalizationStartTime = Date.now();

      // Set up progress listener
      const progressHandler = (progress: FfmpegProgress) => {
        if (progress.processId !== processId) return;
        // Reserve 5-85% for FFmpeg processing, 85-100% for verification and copy-back
        const boundedPercent = Math.max(5, Math.min(Math.round(progress.percent * 0.8) + 5, 85));

        // Calculate ETA based on elapsed time and progress
        const elapsedMs = Date.now() - normalizationStartTime;
        let eta: number | undefined;
        if (progress.percent > 0 && progress.percent < 100) {
          eta = Math.round((elapsedMs * ((100 - progress.percent) / progress.percent)) / 1000);
        }

        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'normalize-audio', boundedPercent, `Normalizing audio: ${progress.percent}%`, {
            eta,
            elapsedMs,
          });
        }
      };

      this.ffmpeg.on('progress', progressHandler);
      if (jobId) {
        this.activeJobProcesses.set(jobId, processId);
      }

      try {
        const result = await this.ffmpeg.run(args, { duration, processId });

        if (!result.success) {
          this.logger.error(`Audio normalization failed: ${result.error}`);
          if (jobId) {
            this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, `Normalization failed: ${result.error}`);
          }
          return null;
        }
      } finally {
        this.ffmpeg.off('progress', progressHandler);
        if (jobId) {
          this.activeJobProcesses.delete(jobId);
        }
      }

      this.logger.log(`FFmpeg completed, verifying output: ${tempOutputFile}`);

      // STEP 4: Verify the output file
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 88, 'Verifying normalized audio...');
      }

      const verification = await this.verifyProcessedVideo(tempOutputFile, duration);
      if (!verification.valid) {
        this.logger.error(`VERIFICATION FAILED: ${verification.error}`);
        this.safeDeleteFile(tempOutputFile);
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, `Verification failed: ${verification.error}`);
        }
        return null;
      }

      this.logger.log(`Verification passed, copying back to original location`);

      // STEP 5: Copy processed file back to original location with retry logic
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 92, 'Saving normalized audio...');
      }

      const copyBackResult = await copyFromTemp(tempOutputFile, filePath, {
        maxRetries: 5,
        retryDelayMs: 1500,
        preserveTimestamps: true,
        deleteTemp: true,
        onProgress: (msg) => {
          this.logger.log(`[CopyFromTemp] ${msg}`);
          if (jobId) {
            this.eventService.emitTaskProgress(jobId, 'normalize-audio', 95, msg);
          }
        }
      });

      if (!copyBackResult.success) {
        this.logger.error(`Failed to copy processed file back: ${copyBackResult.error}`);
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, `Failed to save: ${copyBackResult.error}`);
        }
        return null;
      }

      // Clean up temp input file
      this.safeDeleteFile(tempInputFile);

      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 100, 'Audio normalization complete');
      }
      return filePath;
    } catch (error: any) {
      this.logger.error('Error in normalizeAudio:', error);
      // Clean up temp files on error
      if (tempInputFile) this.safeDeleteFile(tempInputFile);
      if (tempOutputFile) this.safeDeleteFile(tempOutputFile);
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', -1, `Unexpected error: ${error.message}`);
      }
      return null;
    }
  }

  async listMediaFiles(dirPath: string): Promise<string[]> {
    const mediaExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.aac', '.flac', '.m4a', '.webm'];

    if (!fs.existsSync(dirPath)) {
      this.logger.error(`Directory doesn't exist: ${dirPath}`);
      return [];
    }

    try {
      const files = fs.readdirSync(dirPath);
      const mediaFiles: string[] = [];

      for (const file of files) {
        if (file.startsWith('._') || file.startsWith('.')) continue;

        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            const ext = path.extname(file).toLowerCase();
            if (mediaExtensions.includes(ext)) {
              mediaFiles.push(filePath);
            }
          }
        } catch {
          continue;
        }
      }

      this.logger.log(`Found ${mediaFiles.length} media files in ${dirPath}`);
      return mediaFiles;
    } catch (error) {
      this.logger.error(`Error listing media files: ${error}`);
      return [];
    }
  }

  async generateWaveform(filePath: string, samplesCount: number = 500): Promise<{ samples: number[], duration: number }> {
    this.ensureFfmpegReady();
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    this.logger.log(`Generating waveform for: ${filePath} (${samplesCount} samples)`);

    const metadata = await this.getVideoMetadata(filePath);
    const duration = metadata.duration || 0;

    if (duration <= 0) {
      // An empty waveform would be persisted and rendered as if it were the
      // real audio shape (fallback audit #9). Fail instead.
      throw new Error(
        `Cannot generate waveform for ${filePath}: ffprobe reported no duration. ` +
        `The file may be corrupt or still downloading.`,
      );
    }

    const chunks: Buffer[] = [];

    const args = [
      '-i', filePath,
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      '-'
    ];

    try {
      const result = await this.ffmpeg.runWithPipe(args, (chunk) => {
        chunks.push(chunk);
      });

      if (!result.success) {
        throw new Error(result.error || 'Waveform extraction failed');
      }

      const audioBuffer = Buffer.concat(chunks);
      const int16Array = new Int16Array(
        audioBuffer.buffer,
        audioBuffer.byteOffset,
        Math.floor(audioBuffer.length / 2)
      );

      const samples: number[] = [];
      const samplesPerChunk = Math.max(1, Math.floor(int16Array.length / samplesCount));

      for (let i = 0; i < samplesCount; i++) {
        const start = i * samplesPerChunk;
        const end = Math.min(start + samplesPerChunk, int16Array.length);

        if (start >= int16Array.length) {
          samples.push(0);
          continue;
        }

        let sumSquares = 0;
        for (let j = start; j < end; j++) {
          sumSquares += int16Array[j] * int16Array[j];
        }
        const rms = Math.sqrt(sumSquares / (end - start));
        const normalized = Math.min(1, (rms / 32767) * 4);
        samples.push(normalized);
      }

      this.logger.log(`Generated ${samples.length} waveform samples for ${duration}s video`);
      return { samples, duration };
    } catch (error) {
      // NO SILENT FALLBACK: a fabricated flat waveform is indistinguishable from
      // real audio data and silently hides extraction failures. Surface the error.
      this.logger.error(`Waveform extraction error: ${error}`);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
