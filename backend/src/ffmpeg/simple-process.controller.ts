import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { FfmpegService } from './ffmpeg.service';
import { MediaEventService } from '../media/media-event.service';
import { DatabaseService } from '../database/database.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

interface ProcessRequest {
  videoId: string;
  filePath: string;
  jobId?: string;
}

interface NormalizeRequest {
  videoId: string;
  filePath: string;
  jobId?: string;
}

/**
 * Simple processing endpoints for aspect ratio and normalization
 * Checks if work is already done and skips if so
 */
@Controller('process')
export class SimpleProcessController implements OnModuleInit {
  private readonly logger = new Logger(SimpleProcessController.name);

  constructor(
    private ffmpegService: FfmpegService,
    private mediaEventService: MediaEventService,
    private databaseService: DatabaseService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Initialize event listeners on module initialization
   */
  onModuleInit() {
    // Listen for FFmpeg internal processing progress events and forward to WebSocket
    this.eventEmitter.on('processing-progress', (data: { jobId: string; progress: number; task: string }) => {
      this.logger.log(`[FFmpeg Progress] Job ${data.jobId}: ${data.progress}% - ${data.task}`);
      // Forward to WebSocket clients
      this.mediaEventService.emitProcessingProgress(data.progress, data.task, data.jobId);
    });
  }

  /**
   * Fix aspect ratio - skips if already 16:9
   */
  @Post('fix-aspect-ratio')
  async fixAspectRatio(@Body() body: ProcessRequest) {
    try {
      const { videoId, filePath, jobId } = body;
      const finalJobId = jobId || `process-${videoId}`;

      if (!filePath) {
        throw new HttpException('Missing filePath', HttpStatus.BAD_REQUEST);
      }

      // Check if file exists
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!exists) {
        throw new HttpException('File not found', HttpStatus.NOT_FOUND);
      }

      // Check aspect ratio
      const aspectRatioStr = await this.getAspectRatio(filePath);
      const aspectRatio = parseFloat(aspectRatioStr);
      this.logger.log(`Video ${videoId} has aspect ratio: ${aspectRatio}`);

      // If already 16:9, skip processing
      // 16:9 = 1.7778, allow small tolerance of 0.01
      const targetAspectRatio = 16 / 9; // 1.7778
      const tolerance = 0.01;

      if (Math.abs(aspectRatio - targetAspectRatio) <= tolerance) {
        this.logger.log(`Video ${videoId} already has 16:9 aspect ratio (${aspectRatio}), skipping`);
        return {
          success: true,
          skipped: true,
          message: 'Already 16:9 aspect ratio',
          jobId: finalJobId,
        };
      }

      // Process video
      this.runProcessing(videoId, filePath, finalJobId);

      return {
        success: true,
        jobId: finalJobId,
        message: 'Processing started',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to start processing: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Normalize audio - skips if already normalized
   */
  @Post('normalize-audio')
  async normalizeAudio(@Body() body: NormalizeRequest) {
    try {
      const { videoId, filePath, jobId } = body;
      const finalJobId = jobId || `normalize-${videoId}`;

      if (!filePath) {
        throw new HttpException('Missing filePath', HttpStatus.BAD_REQUEST);
      }

      // Check if file exists
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!exists) {
        throw new HttpException('File not found', HttpStatus.NOT_FOUND);
      }

      // Check if filename indicates already normalized
      if (filePath.includes('_temp_normalized') || filePath.includes('_normalized')) {
        this.logger.log(`Video ${videoId} already normalized (by filename), skipping`);
        return {
          success: true,
          skipped: true,
          message: 'Already normalized',
          jobId: finalJobId,
        };
      }

      // Process video
      this.runNormalization(videoId, filePath, finalJobId);

      return {
        success: true,
        jobId: finalJobId,
        message: 'Normalization started',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to start normalization: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async getAspectRatio(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json',
        filePath,
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          try {
            const data = JSON.parse(output);
            const stream = data.streams[0];
            if (stream && stream.width && stream.height) {
              const width = stream.width;
              const height = stream.height;
              const aspectRatio = width / height;
              // Return as decimal string with 4 decimal places
              resolve(aspectRatio.toFixed(4));
            } else {
              reject(new Error('Could not determine video dimensions'));
            }
          } catch (error) {
            reject(new Error(`Failed to parse ffprobe output: ${error}`));
          }
        } else {
          reject(new Error(`ffprobe exited with code ${code}`));
        }
      });

      ffprobe.on('error', reject);
    });
  }

  private async runProcessing(videoId: string, filePath: string, jobId: string): Promise<void> {
    try {
      this.logger.log(`Starting aspect ratio fix for ${videoId}`);

      const outputFile = await this.ffmpegService.reencodeVideo(filePath, jobId, { fixAspectRatio: true });

      if (!outputFile) {
        throw new Error('Processing failed - no output file');
      }

      this.logger.log(`Processing completed for video ${videoId}`);

      // Update the database with the new file path if it changed
      if (outputFile !== filePath) {
        const newFilename = path.basename(outputFile);
        this.databaseService.updateVideoPath(videoId, outputFile);
        this.databaseService.updateVideoFilename(videoId, newFilename);
        this.logger.log(`Updated database path for ${videoId}: ${outputFile}`);

        // Emit event so frontend knows the video was updated
        this.mediaEventService.emitVideoPathUpdated(videoId, outputFile, filePath);
      }

      // Emit completion event via WebSocket
      this.mediaEventService.emitProcessingProgress(100, 'Video processing completed', jobId);
    } catch (error: any) {
      this.logger.error(`Processing failed for video ${videoId}:`, error);
      throw error;
    }
  }

  private async runNormalization(videoId: string, filePath: string, jobId: string): Promise<void> {
    try {
      this.logger.log(`Starting audio normalization for ${videoId}`);

      const outputFile = await this.ffmpegService.normalizeAudio(filePath, -20, jobId);

      if (!outputFile) {
        throw new Error('Normalization failed - no output file');
      }

      this.logger.log(`Normalization completed for video ${videoId}`);

      // Update the database with the new file path if it changed
      if (outputFile !== filePath) {
        const newFilename = path.basename(outputFile);
        this.databaseService.updateVideoPath(videoId, outputFile);
        this.databaseService.updateVideoFilename(videoId, newFilename);
        this.logger.log(`Updated database path for ${videoId}: ${outputFile}`);

        // Emit event so frontend knows the video was updated
        this.mediaEventService.emitVideoPathUpdated(videoId, outputFile, filePath);
      }

      // Emit completion event via WebSocket
      this.mediaEventService.emitProcessingProgress(100, 'Audio normalization completed', jobId);
    } catch (error: any) {
      this.logger.error(`Normalization failed for video ${videoId}:`, error);
      throw error;
    }
  }
}
