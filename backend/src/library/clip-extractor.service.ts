import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  FfmpegBridge,
  FfprobeBridge,
  getRuntimePaths,
  verifyBinary,
  type FfmpegProgress,
} from '../bridges';

export interface MuteSectionInput {
  startSeconds: number;
  endSeconds: number;
}

export type ExportQuality = 'high' | 'medium' | 'low';

export interface ClipExtractionRequest {
  videoPath: string;
  startTime: number | null; // seconds (null = start of video)
  endTime: number | null; // seconds (null = end of video)
  outputPath: string;
  reEncode?: boolean; // Whether to re-encode for frame accuracy (default: false)
  quality?: ExportQuality; // Export quality preset (default: 'medium')
  scale?: number; // Video scale factor (1.0 = no scaling, 2.0 = 2x scale, etc.)
  cropAspectRatio?: string; // Target crop aspect ratio (e.g. '16:9', '4:3', '9:16')
  muteSections?: MuteSectionInput[]; // Audio sections to mute
  outputSuffix?: string; // Suffix to add to filename (e.g., " (censored)")
  metadata?: {
    title?: string;
    description?: string;
    category?: string;
  };
  onProgress?: (progress: number) => void;
}

export interface ClipExtractionResult {
  success: boolean;
  outputPath?: string;
  duration?: number;
  fileSize?: number;
  error?: string;
}

@Injectable()
export class ClipExtractorService {
  private readonly logger = new Logger(ClipExtractorService.name);
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;

  constructor() {
    // ALWAYS use bundled binaries from getRuntimePaths() - NEVER use system binaries
    const runtimePaths = getRuntimePaths();
    const ffmpegPath = runtimePaths.ffmpeg;
    const ffprobePath = runtimePaths.ffprobe;

    verifyBinary(ffmpegPath, 'FFmpeg');
    verifyBinary(ffprobePath, 'FFprobe');

    this.ffmpeg = new FfmpegBridge(ffmpegPath);
    this.ffprobe = new FfprobeBridge(ffprobePath);

    this.logger.log(`ClipExtractorService initialized`);
    this.logger.log(`  FFmpeg: ${ffmpegPath}`);
    this.logger.log(`  FFprobe: ${ffprobePath}`);
  }

  /**
   * Extract a clip from a video file
   */
  async extractClip(request: ClipExtractionRequest): Promise<ClipExtractionResult> {
    try {
      this.logger.log(`Extracting clip from ${request.videoPath}`);

      // Get video duration if processing full video (null times)
      let videoDuration: number | null = null;
      if (request.startTime === null || request.endTime === null) {
        videoDuration = await this.getVideoDuration(request.videoPath);
      }

      const startTime = request.startTime ?? 0;
      const endTime = request.endTime ?? videoDuration ?? 0;

      this.logger.log(`Time range: ${startTime}s - ${endTime}s`);

      // Validate input
      if (startTime < 0) {
        throw new Error('Start time cannot be negative');
      }

      if (endTime <= startTime) {
        throw new Error('End time must be greater than start time');
      }

      const duration = endTime - startTime;

      // Handle output suffix (e.g., " (censored)")
      let outputPath = request.outputPath;
      if (request.outputSuffix) {
        const ext = path.extname(outputPath);
        const basename = path.basename(outputPath, ext);
        const dirname = path.dirname(outputPath);
        outputPath = path.join(dirname, `${basename}${request.outputSuffix}${ext}`);
      }

      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });

      // Log mute sections if present
      if (request.muteSections && request.muteSections.length > 0) {
        this.logger.log(`Applying ${request.muteSections.length} mute sections`);
        request.muteSections.forEach((ms, i) => {
          this.logger.log(`  Mute ${i + 1}: ${ms.startSeconds}s - ${ms.endSeconds}s`);
        });
      }

      // Extract clip using FFmpeg
      await this.runFFmpegExtraction(
        request.videoPath,
        startTime,
        duration,
        outputPath,
        request.reEncode || false,
        request.scale,
        request.muteSections,
        request.onProgress,
        request.quality || 'medium',
        request.cropAspectRatio,
      );

      // Get file stats
      const stats = await fs.stat(outputPath);

      this.logger.log(`Clip extracted successfully: ${outputPath}`);
      this.logger.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      return {
        success: true,
        outputPath: outputPath,
        duration,
        fileSize: stats.size,
      };

    } catch (error) {
      this.logger.error('Clip extraction failed:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Build the audio mute filter expression for FFmpeg
   * Creates a volume filter with enable expression to mute specified time ranges
   */
  private buildMuteFilter(muteSections: MuteSectionInput[], clipStartTime: number = 0): string | null {
    if (!muteSections || muteSections.length === 0) {
      return null;
    }

    // Adjust mute section times relative to clip start time
    // If clip starts at 30s and mute is at 35-40s, adjusted is 5-10s
    const adjustedSections = muteSections
      .map(ms => ({
        start: ms.startSeconds - clipStartTime,
        end: ms.endSeconds - clipStartTime
      }))
      .filter(ms => ms.end > 0); // Only include sections that are after clip start

    if (adjustedSections.length === 0) {
      return null;
    }

    // Build the enable expression: between(t,start1,end1)+between(t,start2,end2)
    const betweenExpressions = adjustedSections.map(
      ms => `between(t,${Math.max(0, ms.start).toFixed(3)},${ms.end.toFixed(3)})`
    );

    const enableExpr = betweenExpressions.join('+');
    return `volume=enable='${enableExpr}':volume=0`;
  }

  /**
   * Run FFmpeg extraction using the bridge
   */
  private async runFFmpegExtraction(
    inputPath: string,
    startTime: number,
    duration: number,
    outputPath: string,
    reEncode: boolean = false,
    scale?: number,
    muteSections?: MuteSectionInput[],
    onProgress?: (progress: number) => void,
    quality: ExportQuality = 'medium',
    cropAspectRatio?: string,
  ): Promise<void> {
    const args: string[] = ['-y'];

    // Build mute filter if mute sections are provided
    const muteFilter = this.buildMuteFilter(muteSections || [], startTime);
    const hasMutes = muteFilter !== null;

    // If scale is specified and not 1.0, or if we have mutes, we must re-encode
    const needsReEncode = reEncode || (scale && scale !== 1.0) || hasMutes;

    if (needsReEncode) {
      // Re-encode mode: Frame-accurate extraction with optional scaling and muting
      this.logger.log('Using re-encoding mode for frame-accurate extraction');
      if (scale && scale !== 1.0) {
        this.logger.log(`Applying scale: ${scale}x`);
      }
      if (hasMutes) {
        this.logger.log(`Applying audio mute filter: ${muteFilter}`);
      }

      const seekBuffer = Math.max(0, startTime - 10);
      if (seekBuffer > 0) {
        args.push('-ss', seekBuffer.toString());
      }

      args.push('-i', inputPath);

      const adjustedStart = startTime - seekBuffer;
      args.push(
        '-ss', adjustedStart.toString(),
        '-t', duration.toString()
      );

      // Build filter_complex if we have both scale and mute, or just mute
      // Scale = "zoom into center": scale up the video, then crop to target aspect ratio.
      // This matches the CSS transform: scale(N) + border overlay behavior in the video player.
      const parseAspectRatio = (ratio: string): number | null => {
        const parts = ratio.split(':').map(Number);
        if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) return parts[0] / parts[1];
        return null;
      };

      const targetRatio = cropAspectRatio ? parseAspectRatio(cropAspectRatio) : null;

      let scaleFilter: string | null = null;
      if (scale && scale !== 1.0) {
        if (targetRatio) {
          // Crop to target aspect ratio from the zoomed video
          // 1. Scale up: iw*scale x ih*scale
          // 2. Crop to target ratio, centered (FFmpeg default)
          this.logger.log(`Applying crop to ${cropAspectRatio} aspect ratio (${targetRatio.toFixed(4)})`);
          // Use \, to escape commas inside min() so FFmpeg doesn't treat them as filter separators
          scaleFilter = `scale=iw*${scale}:ih*${scale}:flags=lanczos,crop=min(iw\\,ih*${targetRatio}):min(ih\\,iw/${targetRatio})`;
        } else {
          // No aspect ratio specified: crop back to original dimensions
          scaleFilter = `scale=iw*${scale}:ih*${scale}:flags=lanczos,crop=iw/${scale}:ih/${scale}`;
        }
      }

      if (hasMutes && scaleFilter) {
        // Both video scaling and audio muting
        args.push(
          '-filter_complex',
          `[0:v]${scaleFilter}[vout];[0:a]${muteFilter}[aout]`,
          '-map', '[vout]',
          '-map', '[aout]'
        );
      } else if (hasMutes) {
        // Only audio muting
        args.push('-af', muteFilter);
      } else if (scaleFilter) {
        // Only video scaling
        args.push('-vf', scaleFilter);
      }

      // Quality presets: CRF values (lower = better quality, bigger file)
      const crfMap: Record<ExportQuality, string> = {
        'high': '18',
        'medium': '23',
        'low': '28',
      };
      const crf = crfMap[quality] || '23';
      this.logger.log(`Quality preset: ${quality} (CRF ${crf})`);

      args.push(
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-preset', 'medium',
        '-crf', crf,
        '-pix_fmt', 'yuv420p',
        '-avoid_negative_ts', 'make_zero',
        outputPath
      );
    } else {
      // Stream copy mode: Fast extraction (no scaling, no muting)
      this.logger.log('Using stream copy mode for fast extraction');

      args.push(
        '-ss', startTime.toString(),
        '-i', inputPath,
        '-t', duration.toString(),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        outputPath
      );
    }

    this.logger.log(`FFmpeg command: ${this.ffmpeg.path} ${args.join(' ')}`);

    const processId = `clip-extract-${Date.now()}`;

    // Set up progress listener if callback provided
    let progressHandler: ((progress: FfmpegProgress) => void) | null = null;

    if (onProgress && duration > 0) {
      progressHandler = (progress: FfmpegProgress) => {
        if (progress.processId !== processId) return;
        this.logger.log(`Progress: ${progress.percent}%`);
        onProgress(progress.percent);
      };
      this.ffmpeg.on('progress', progressHandler);
    }

    try {
      const result = await this.ffmpeg.run(args, { duration, processId });

      if (!result.success) {
        throw new Error(result.error || `FFmpeg exited with code ${result.exitCode}`);
      }

      this.logger.log('FFmpeg extraction completed');
      if (onProgress) onProgress(100);
    } finally {
      if (progressHandler) {
        this.ffmpeg.off('progress', progressHandler);
      }
    }
  }

  /**
   * Get video duration using FFprobe bridge
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return this.ffprobe.getDuration(videoPath);
  }

  /**
   * Format seconds to HH:MM:SS
   */
  formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Generate a clip filename based on metadata
   */
  generateClipFilename(
    originalFilename: string,
    startTime: number | null,
    endTime: number | null,
    category?: string,
    title?: string,
    uploadDate?: string
  ): string {
    const ext = path.extname(originalFilename);

    if (title && title.trim()) {
      const safeTitle = title
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (uploadDate) {
        return `${uploadDate} ${safeTitle}${ext}`;
      }
      return `${safeTitle}${ext}`;
    }

    // If times are null (full video), use original basename with optional category
    if (startTime === null || endTime === null) {
      const basename = path.basename(originalFilename, ext);
      if (category) {
        const safeCategory = category.replace(/[^a-zA-Z0-9]/g, '_');
        return `${basename}_${safeCategory}${ext}`;
      }
      return `${basename}_scaled${ext}`;
    }

    const basename = path.basename(originalFilename, ext);
    const startStr = this.formatTimestamp(startTime).replace(/:/g, '-');
    const endStr = this.formatTimestamp(endTime).replace(/:/g, '-');

    let filename = `${basename}_${startStr}_${endStr}`;

    if (category) {
      const safeCategory = category.replace(/[^a-zA-Z0-9]/g, '_');
      filename = `${basename}_${safeCategory}_${startStr}_${endStr}`;
    }

    return filename + ext;
  }
}
