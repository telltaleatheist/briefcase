// ClipChimp/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
  type FfmpegProgress,
  type ProbeResult,
} from '../bridges';
import {
  copyToTemp,
  copyFromTemp,
  cleanupTempFiles,
  isFileAccessible,
} from '../common/utils/temp-file.util';

@Injectable()
export class FfmpegService {
  private lastReportedProgress: Map<string, number> = new Map();
  private readonly logger = new Logger(FfmpegService.name);
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;

  constructor(
    private readonly eventService: MediaEventService,
    private readonly configService: SharedConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly thumbnailService: ThumbnailService
  ) {
    try {
      // ALWAYS use bundled binaries from getRuntimePaths() - NEVER use system binaries
      // This ensures consistent behavior across all platforms and prevents using
      // user's system-installed binaries which may be incompatible versions
      const paths = getRuntimePaths();
      const ffmpegPath = paths.ffmpeg;
      const ffprobePath = paths.ffprobe;

      // Verify binaries exist and have correct architecture
      verifyBinary(ffmpegPath, 'FFmpeg');
      verifyBinary(ffprobePath, 'FFprobe');

      // Initialize bridges
      this.ffmpeg = new FfmpegBridge(ffmpegPath);
      this.ffprobe = new FfprobeBridge(ffprobePath);

      this.logger.log(`FFmpeg path: ${ffmpegPath}`);
      this.logger.log(`FFprobe path: ${ffprobePath}`);
    } catch (error) {
      this.logger.error('Failed to initialize FFmpeg/FFprobe bridges', error);
      throw error;
    }
  }

  async getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    try {
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
      audioNormalizationMethod?: 'rms' | 'peak',
      useRmsNormalization?: boolean,
      rmsNormalizationLevel?: number,
      useCompression?: boolean,
      compressionLevel?: number
    },
    taskType?: string
  ): Promise<string | null> {
    this.logger.log('Received reencoding options:', JSON.stringify({
      fixAspectRatio: options?.fixAspectRatio,
      normalizeAudio: options?.normalizeAudio,
      audioNormalizationMethod: options?.audioNormalizationMethod
    }, null, 2));

    const fileName = path.basename(videoFile);
    let tempInputFile: string | undefined;
    let tempOutputFile: string | undefined;

    try {
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
      const videoAnalysis = this.analyzeVideoMetadata(metadata);

      if (!videoAnalysis.isValid) {
        this.safeDeleteFile(tempInputFile);
        return null;
      }

      const duration = videoAnalysis.duration || 0;
      const needsAspectRatioFix = videoAnalysis.needsAspectRatioFix ?? false;

      // Create output path in temp directory
      const fileBase = path.parse(fileName).name;
      tempOutputFile = `${tempInputFile}_reencoded.mov`;
      const progressKey = tempOutputFile;

      this.lastReportedProgress.set(progressKey, 0);

      this.logger.log(`ASPECT RATIO FIX: requested=${options?.fixAspectRatio}, videoNeeds=${needsAspectRatioFix}, will apply=${options?.fixAspectRatio}`);

      // Build args using temp files
      const args = this.buildFfmpegArgs(tempInputFile, tempOutputFile, needsAspectRatioFix, selectedEncoder, options);

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
      useRmsNormalization?: boolean,
      rmsNormalizationLevel?: number,
      useCompression?: boolean,
      compressionLevel?: number
    }
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

    if (options?.useRmsNormalization || options?.useCompression) {
      let audioFilter = '';

      if (options?.useRmsNormalization) {
        const level = options.rmsNormalizationLevel ?? 0;
        audioFilter = `[0:a]volume=${level}dB`;
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
      const thumbnailTime = Math.max(1, duration * 0.1);

      const args = [
        '-y',
        '-ss', thumbnailTime.toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=-1:360',
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

  async normalizeAudio(filePath: string, targetVolume: number = -20, jobId?: string): Promise<string | null> {
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
      const processId = `normalize-${Date.now()}`;

      // STEP 1: Copy source file to temp directory to avoid file locks (Syncthing, etc.)
      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 2, 'Preparing file for processing...');
      }

      const copyResult = await copyToTemp(filePath, {
        maxRetries: 5,
        retryDelayMs: 1000,
        onProgress: (msg) => {
          this.logger.log(`[CopyToTemp] ${msg}`);
          if (jobId) {
            this.eventService.emitTaskProgress(jobId, 'normalize-audio', 3, msg);
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

      // STEP 2: Get duration for progress tracking
      const metadata = await this.getVideoMetadata(tempInputFile);
      const duration = metadata?.duration || 0;

      // Create output path in temp directory
      tempOutputFile = `${tempInputFile}_normalized${fileExt}`;

      const args = [
        '-y',
        '-i', tempInputFile,
        '-af', `loudnorm=I=${targetVolume}:TP=-1.5:LRA=11`,
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
      }

      this.logger.log(`FFmpeg completed, verifying output: ${tempOutputFile}`);

      // STEP 3: Verify the output file
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

      // STEP 4: Copy processed file back to original location with retry logic
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
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    this.logger.log(`Generating waveform for: ${filePath} (${samplesCount} samples)`);

    const metadata = await this.getVideoMetadata(filePath);
    const duration = metadata.duration || 0;

    if (duration <= 0) {
      return { samples: [], duration: 0 };
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
      this.logger.error(`Waveform extraction error: ${error}`);
      return {
        samples: new Array(samplesCount).fill(0.3),
        duration
      };
    }
  }
}
