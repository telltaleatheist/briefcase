// clippy/backend/src/media/media-processing.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { MediaEventService } from './media-event.service';
import * as fs from 'fs';
import * as path from 'path';

export interface ProcessingOptions {
  fixAspectRatio?: boolean;
  createThumbnail?: boolean;
  extractAudio?: boolean;
  qualityPreset?: 'low' | 'medium' | 'high';
  customOptions?: Record<string, any>;
  normalizeAudio?: boolean;
  audioNormalizationMethod?: 'ebur128' | 'rms' | 'peak';
}

export interface ProcessingResult {
  success: boolean;
  error?: string;
  outputFile?: string;
  thumbnailFile?: string;
  audioFile?: string;
}

/**
 * Service for handling media processing tasks
 */
@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);
  
  constructor(
    private readonly ffmpegService: FfmpegService,
    private readonly eventService: MediaEventService
  ) {}
  
  /**
   * Process a media file with the specified options
   */
  async processMedia(
    inputFile: string, 
    options: ProcessingOptions,
    jobId?: string
  ): Promise<ProcessingResult> {
    if (!fs.existsSync(inputFile)) {
      const error = `Input file does not exist: ${inputFile}`;
      this.logger.error(error);
      return { success: false, error };
    }
    
    try {
      this.logger.log(`Processing media: ${inputFile} with options: ${JSON.stringify(options)}`);
      
      // Emit processing started event
      this.eventService.emitProcessingStarted(inputFile, options, jobId);
      
      // Initialize result
      const result: ProcessingResult = { 
        success: true,
        outputFile: inputFile // Default to input file if no processing occurs
      };
      
      if (options.fixAspectRatio) {
        try {
          this.logger.log(`Processing media with audio normalization: ${inputFile}`);
          
          const outputFile = await this.ffmpegService.reencodeVideo(inputFile, jobId, {
            normalizeAudio: options.normalizeAudio,
            method: options.audioNormalizationMethod
          });
          
          if (outputFile && fs.existsSync(outputFile)) {
            this.logger.log(`Media processed: ${outputFile}`);
            result.outputFile = outputFile;
          } else {
            this.logger.warn(`Failed to process media, using original file: ${inputFile}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error processing media: ${errorMessage}`);
          
          // Don't fail the entire process for processing errors
          this.eventService.emitProcessingProgress(50, `Warning: Couldn't process media. Continuing with original file.`, jobId);
        }
      }
            
      // Create thumbnail if requested
      if (options.createThumbnail) {
        try {
          this.logger.log(`Creating thumbnail for: ${result.outputFile || inputFile}`);
          
          const thumbnailFile = await this.ffmpegService.createThumbnail(result.outputFile || inputFile);
          
          if (thumbnailFile && fs.existsSync(thumbnailFile)) {
            this.logger.log(`Thumbnail created: ${thumbnailFile}`);
            result.thumbnailFile = thumbnailFile;
          } else {
            this.logger.warn(`Failed to create thumbnail`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(`Error creating thumbnail: ${errorMessage}`);
          
          // Don't fail the entire process for thumbnail errors
        }
      }
      
      // Extract audio if requested (would be implemented here)
      
      // Emit processing completed event
      this.eventService.emitProcessingCompleted(
        result.outputFile || inputFile,
        jobId,
        result.thumbnailFile,
        result.audioFile
      );
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error processing media: ${errorMessage}`);
      
      // Emit processing failed event
      this.eventService.emitProcessingFailed(inputFile, errorMessage, jobId);
      
      return { 
        success: false, 
        error: errorMessage
      };
    }
  }
  
  /**
   * Extract metadata from a media file
   */
  async getMediaMetadata(filePath: string): Promise<any> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      
      const metadata = await this.ffmpegService.getVideoMetadata(filePath);
      return metadata;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting media metadata: ${errorMessage}`);
      throw error;
    }
  }
  
  /**
   * Check if a file is a video
   */
  isVideoFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    
    const extension = path.extname(filePath).toLowerCase();
    const videoExtensions = [
      '.mp4', '.mov', '.avi', '.wmv', '.mkv', '.webm', '.flv', '.m4v', '.mpg', '.mpeg'
    ];
    
    return videoExtensions.includes(extension);
  }
  
  /**
   * Check if a file is an image
   */
  isImageFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    
    const extension = path.extname(filePath).toLowerCase();
    const imageExtensions = [
      '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'
    ];
    
    return imageExtensions.includes(extension);
  }
}