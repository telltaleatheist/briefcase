import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';

export interface ClipExtractionRequest {
  videoPath: string;
  startTime: number; // seconds
  endTime: number; // seconds
  outputPath: string;
  reEncode?: boolean; // Whether to re-encode for frame accuracy (default: false)
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

  /**
   * Extract a clip from a video file
   */
  async extractClip(request: ClipExtractionRequest): Promise<ClipExtractionResult> {
    try {
      this.logger.log(`Extracting clip from ${request.videoPath}`);
      this.logger.log(`Time range: ${request.startTime}s - ${request.endTime}s`);

      // Validate input
      if (request.startTime < 0) {
        throw new Error('Start time cannot be negative');
      }

      if (request.endTime <= request.startTime) {
        throw new Error('End time must be greater than start time');
      }

      const duration = request.endTime - request.startTime;

      // Ensure output directory exists
      const outputDir = path.dirname(request.outputPath);
      await fs.mkdir(outputDir, { recursive: true });

      // Extract clip using FFmpeg
      await this.runFFmpegExtraction(
        request.videoPath,
        request.startTime,
        duration,
        request.outputPath,
        request.reEncode || false,
        request.onProgress
      );

      // Get file stats
      const stats = await fs.stat(request.outputPath);

      this.logger.log(`Clip extracted successfully: ${request.outputPath}`);
      this.logger.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      return {
        success: true,
        outputPath: request.outputPath,
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
   * Run FFmpeg extraction
   */
  private runFFmpegExtraction(
    inputPath: string,
    startTime: number,
    duration: number,
    outputPath: string,
    reEncode: boolean = false,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath);

      if (reEncode) {
        // Re-encode mode: Frame-accurate extraction with no black frames
        // Use two-pass seeking for best accuracy with reasonable performance
        this.logger.log('Using re-encoding mode for frame-accurate extraction');

        // First, input seek to nearest keyframe before startTime for speed
        // Then use output seeking for frame-accurate trim
        const seekBuffer = Math.max(0, startTime - 10); // Seek to 10 seconds before
        if (seekBuffer > 0) {
          command.inputOptions([`-ss ${seekBuffer}`]);
        }

        // Calculate adjusted start time after input seek
        const adjustedStart = startTime - seekBuffer;

        command
          .outputOptions([`-ss ${adjustedStart}`])  // Precise output seeking
          .videoCodec('libx264')  // Use H.264 encoder
          .audioCodec('aac')      // Use AAC audio encoder
          .outputOptions([
            '-preset medium',        // Better quality preset (good balance)
            '-crf 18',               // High quality (lower = better, 18 is visually lossless)
            '-pix_fmt yuv420p',      // Ensure broad compatibility
            '-movflags +faststart',  // Enable fast start for web playback
            '-avoid_negative_ts make_zero',  // Fix timestamp issues
            '-async 1',              // Audio sync fix
            '-vsync cfr',            // Constant frame rate for stability
          ]);
      } else {
        // Stream copy mode: Fast extraction using input seeking
        this.logger.log('Using stream copy mode for fast extraction');

        // Input seeking (before decoding) for speed
        command.inputOptions([`-ss ${startTime}`]);

        command.outputOptions([
          '-c copy',  // Copy streams without re-encoding
          '-avoid_negative_ts make_zero',  // Fix timestamp issues
          '-async 1', // Audio sync fix
        ]);
      }

      command
        .setDuration(duration)
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.log('FFmpeg command: ' + commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            this.logger.log(`Progress: ${progress.percent.toFixed(1)}%`);
            if (onProgress) {
              onProgress(progress.percent);
            }
          }
        })
        .on('end', () => {
          this.logger.log('FFmpeg extraction completed');
          if (onProgress) {
            onProgress(100);
          }
          resolve();
        })
        .on('error', (error, _stdout, stderr) => {
          this.logger.error('FFmpeg error:', error.message);
          this.logger.error('FFmpeg stderr:', stderr);
          reject(error);
        })
        .run();
    });
  }

  /**
   * Get video duration using FFmpeg
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }

        const duration = metadata.format.duration;
        if (duration) {
          resolve(duration);
        } else {
          reject(new Error('Could not determine video duration'));
        }
      });
    });
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
   *
   * If title (marker text) is provided:
   *   - With upload date: "{uploadDate} {title}.ext"
   *   - Without upload date: "{title}.ext"
   *
   * If no title:
   *   - Fall back to: "{basename}_{category}_{startTime}_{endTime}.ext"
   */
  generateClipFilename(
    originalFilename: string,
    startTime: number,
    endTime: number,
    category?: string,
    title?: string,
    uploadDate?: string
  ): string {
    const ext = path.extname(originalFilename);

    // If title (marker text) is provided, use it as the filename
    if (title && title.trim()) {
      // Sanitize the title to be filesystem-safe
      const safeTitle = title
        .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filesystem characters
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();

      // Prepend upload date if available
      if (uploadDate) {
        return `${uploadDate} ${safeTitle}${ext}`;
      }
      return `${safeTitle}${ext}`;
    }

    // Fall back to timestamp-based naming if no title
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
