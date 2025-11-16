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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';

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
      const aspectRatio = await this.getAspectRatio(filePath);
      this.logger.log(`Video ${videoId} has aspect ratio: ${aspectRatio}`);

      // If already 16:9, skip processing
      if (aspectRatio === '16:9' || aspectRatio === '1.778' || aspectRatio === '1.777778') {
        this.logger.log(`Video ${videoId} already has 16:9 aspect ratio, skipping`);
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
        '-show_entries', 'stream=display_aspect_ratio',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
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

      // Emit completion event via WebSocket
      this.mediaEventService.emitProcessingProgress(100, 'Audio normalization completed', jobId);
    } catch (error: any) {
      this.logger.error(`Normalization failed for video ${videoId}:`, error);
      throw error;
    }
  }
}
