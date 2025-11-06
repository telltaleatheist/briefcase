import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';

export interface ClipExtractionRequest {
  videoPath: string;
  startTime: number; // seconds
  endTime: number; // seconds
  outputPath: string;
  metadata?: {
    title?: string;
    description?: string;
    category?: string;
  };
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
        request.outputPath
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
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        // Seek to start time BEFORE reading input (more accurate)
        .inputOptions([`-ss ${startTime}`])
        .setDuration(duration)
        // Use copy codec for fast extraction without re-encoding
        // Use accurate seeking and avoid negative timestamps
        .outputOptions([
          '-c copy',
          '-avoid_negative_ts make_zero',
          '-copyts',  // Copy timestamps to maintain accuracy
          '-start_at_zero',  // Start at zero timestamp
        ])
        .output(outputPath)
        .on('start', (commandLine) => {
          this.logger.log('FFmpeg command: ' + commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            this.logger.log(`Progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => {
          this.logger.log('FFmpeg extraction completed');
          resolve();
        })
        .on('error', (error, stdout, stderr) => {
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
   */
  generateClipFilename(
    originalFilename: string,
    startTime: number,
    endTime: number,
    category?: string
  ): string {
    const ext = path.extname(originalFilename);
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
