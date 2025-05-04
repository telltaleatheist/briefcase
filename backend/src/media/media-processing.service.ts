// clippy/backend/src/media/media-processing.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import * as path from 'path';
import * as fs from 'fs';

export interface ProcessingOptions {
  fixAspectRatio?: boolean;
  createThumbnail?: boolean;
  extractAudio?: boolean;
  qualityPreset?: 'low' | 'medium' | 'high';
  customOptions?: Record<string, any>;
}

export interface ProcessingResult {
  success: boolean;
  outputFile?: string;
  thumbnailFile?: string;
  audioFile?: string;
  error?: string;
  isImage?: boolean;
}

@WebSocketGateway({ cors: true })
@Injectable()
export class MediaProcessingService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MediaProcessingService.name);

  constructor(
    private readonly ffmpegService: FfmpegService,
  ) {}

  /**
   * Process a downloaded media file based on options
   */
  async processMedia(
    mediaFile: string, 
    options: ProcessingOptions, 
    jobId?: string
  ): Promise<ProcessingResult> {
    try {
      this.logger.log(`Processing media: ${mediaFile} with options: ${JSON.stringify(options)}`);
      
      if (!fs.existsSync(mediaFile)) {
        throw new Error(`Media file not found: ${mediaFile}`);
      }
      
      // Determine file type
      const fileExt = path.extname(mediaFile).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(fileExt);
      const isAudio = ['.mp3', '.wav', '.aac', '.ogg', '.flac'].includes(fileExt);
      
      // Handle different media types
      if (isImage) {
        this.logger.log(`File is an image, skipping processing: ${mediaFile}`);
        return { 
          success: true, 
          outputFile: mediaFile,
          isImage: true 
        };
      }
      
      if (isAudio) {
        return await this.processAudio(mediaFile, options, jobId);
      }
      
      // Default: process as video
      return await this.processVideo(mediaFile, options, jobId);
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Error processing media: ${errorObj.message}`, errorObj.stack);
      this.emitEvent('processing-failed', {
        error: errorObj.message,
        jobId
      });
      return {
        success: false,
        error: errorObj.message
      };
    }
  }
  
  /**
   * Process a video file with the given options
   */
  private async processVideo(
    videoFile: string, 
    options: ProcessingOptions, 
    jobId?: string
  ): Promise<ProcessingResult> {
    this.emitEvent('processing-progress', { 
      progress: 0,
      task: 'Starting video processing...',
      jobId
    });
    
    const result: ProcessingResult = {
      success: true,
      outputFile: videoFile
    };
    
    // Process video if needed
    if (options.fixAspectRatio) {
      this.emitEvent('processing-progress', { 
        progress: 10,
        task: 'Fixing aspect ratio...',
        jobId
      });
      
      const processedFile = await this.ffmpegService.reencodeVideo(videoFile, jobId);
      
      if (processedFile) {
        result.outputFile = processedFile;
      } else {
        this.logger.warn(`Aspect ratio processing failed, using original file: ${videoFile}`);
      }
    }
    
    // Create thumbnail if requested
    if (options.createThumbnail) {
      this.emitEvent('processing-progress', { 
        progress: 70,
        task: 'Creating thumbnail...',
        jobId
      });
      
      // Make sure result.outputFile is non-null before passing to createThumbnail
      const outputFile = result.outputFile || videoFile;
      
      const thumbnailFile = await this.ffmpegService.createThumbnail(outputFile);
      
      if (thumbnailFile) {
        result.thumbnailFile = thumbnailFile;
      }
    }
    
    // Extract audio if requested
    if (options.extractAudio) {
      this.emitEvent('processing-progress', { 
        progress: 85,
        task: 'Extracting audio...',
        jobId
      });
      
      // Make sure result.outputFile is non-null before passing to extractAudioFromVideo
      const outputFile = result.outputFile || videoFile;
      
      const audioFile = await this.extractAudioFromVideo(outputFile, jobId);
      
      if (audioFile) {
        result.audioFile = audioFile;
      }
    }
    
    this.emitEvent('processing-progress', { 
      progress: 100,
      task: 'Processing completed',
      jobId
    });
    
    this.emitEvent('processing-completed', {
      outputFile: result.outputFile,
      thumbnailFile: result.thumbnailFile,
      audioFile: result.audioFile,
      jobId
    });
    
    return result;
  }
  
  /**
   * Process an audio file with the given options
   */
  private async processAudio(
    audioFile: string, 
    options: ProcessingOptions, 
    jobId?: string
  ): Promise<ProcessingResult> {
    // Currently just returns the file as-is
    // Can be expanded to include audio processing options
    
    this.emitEvent('processing-progress', { 
      progress: 100,
      task: 'Audio processing completed',
      jobId
    });
    
    return {
      success: true,
      outputFile: audioFile
    };
  }
  
  /**
   * Extract audio from a video file
   */
  private async extractAudioFromVideo(
    videoFile: string, 
    jobId?: string
  ): Promise<string | null> {
    try {
      const fileDir = path.dirname(videoFile);
      const fileName = path.basename(videoFile, path.extname(videoFile));
      const outputFile = path.join(fileDir, `${fileName}_audio.mp3`);
      
      // TODO: Implement this method in ffmpegService
      // const success = await this.ffmpegService.extractAudio(videoFile, outputFile, jobId);
      
      // Placeholder for now
      return null;
    } catch (error: unknown) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Error extracting audio: ${errorObj.message}`);
      return null;
    }
  }
  
  /**
   * Helper method to safely emit events
   */
  private emitEvent(event: string, data: any): void {
    if (this.server) {
      this.server.emit(event, data);
    } else {
      this.logger.warn(`Cannot emit ${event} - WebSocket server not initialized`);
    }
  }
}