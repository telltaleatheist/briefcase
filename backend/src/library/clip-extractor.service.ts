import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { SharedConfigService } from '../config/shared-config.service';

export interface ClipExtractionRequest {
  videoPath: string;
  startTime: number | null; // seconds (null = start of video)
  endTime: number | null; // seconds (null = end of video)
  outputPath: string;
  reEncode?: boolean; // Whether to re-encode for frame accuracy (default: false)
  scale?: number; // Video scale factor (1.0 = no scaling, 2.0 = 2x scale, etc.)
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
  private ffmpegPath: string;
  private ffprobePath: string;

  constructor(private readonly configService: SharedConfigService) {
    this.ffmpegPath = this.configService.getFfmpegPath();
    this.ffprobePath = this.configService.getFfprobePath();
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

      // Ensure output directory exists
      const outputDir = path.dirname(request.outputPath);
      await fs.mkdir(outputDir, { recursive: true });

      // Extract clip using FFmpeg
      await this.runFFmpegExtraction(
        request.videoPath,
        startTime,
        duration,
        request.outputPath,
        request.reEncode || false,
        request.scale,
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
    scale?: number,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-y'];

      // If scale is specified and not 1.0, we must re-encode
      const needsReEncode = reEncode || (scale && scale !== 1.0);

      if (needsReEncode) {
        // Re-encode mode: Frame-accurate extraction with optional scaling
        this.logger.log('Using re-encoding mode for frame-accurate extraction');
        if (scale && scale !== 1.0) {
          this.logger.log(`Applying scale: ${scale}x`);
        }

        const seekBuffer = Math.max(0, startTime - 10);
        if (seekBuffer > 0) {
          args.push('-ss', seekBuffer.toString());
        }

        args.push('-i', inputPath);

        const adjustedStart = startTime - seekBuffer;
        args.push(
          '-ss', adjustedStart.toString(),
          '-t', duration.toString(),
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-preset', 'medium',
          '-crf', '18'
        );

        // Add scale filter if needed
        if (scale && scale !== 1.0) {
          // Scale video using ffmpeg's scale filter
          // iw and ih are input width and height
          // This scales both dimensions by the scale factor
          args.push('-vf', `scale=iw*${scale}:ih*${scale}:flags=lanczos`);
        }

        args.push(
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-avoid_negative_ts', 'make_zero',
          '-async', '1',
          '-vsync', 'cfr',
          outputPath
        );
      } else {
        // Stream copy mode: Fast extraction (no scaling)
        this.logger.log('Using stream copy mode for fast extraction');

        args.push(
          '-ss', startTime.toString(),
          '-i', inputPath,
          '-t', duration.toString(),
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-async', '1',
          outputPath
        );
      }

      this.logger.log(`FFmpeg command: ${this.ffmpegPath} ${args.join(' ')}`);

      const proc = spawn(this.ffmpegPath, args);
      let stderrBuffer = '';

      proc.stderr.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();

        if (onProgress && duration > 0) {
          const lines = stderrBuffer.split('\r');
          stderrBuffer = lines.pop() || '';

          for (const line of lines) {
            const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
            if (timeMatch) {
              const timeStr = timeMatch[1];
              const timeParts = timeStr.split(/[:.]/);
              if (timeParts.length >= 3) {
                const hours = parseInt(timeParts[0]);
                const minutes = parseInt(timeParts[1]);
                const seconds = parseInt(timeParts[2]);
                const currentTime = hours * 3600 + minutes * 60 + seconds;
                const percent = Math.min(100, Math.round((currentTime / duration) * 100));
                this.logger.log(`Progress: ${percent}%`);
                onProgress(percent);
              }
            }
          }
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          this.logger.log('FFmpeg extraction completed');
          if (onProgress) onProgress(100);
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        this.logger.error('FFmpeg error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Get video duration using FFprobe
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        videoPath
      ];

      const proc = spawn(this.ffprobePath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const metadata = JSON.parse(stdout);
          const duration = metadata.format?.duration;
          if (duration) {
            resolve(parseFloat(duration));
          } else {
            reject(new Error('Could not determine video duration'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
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
