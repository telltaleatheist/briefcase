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
            
      // Check if any processing is needed
      if (options.fixAspectRatio || options.normalizeAudio) {
        // Attempt to reencode video
        const outputFile = await this.ffmpegService.reencodeVideo(inputFile, jobId, {
          fixAspectRatio: options.fixAspectRatio,
          normalizeAudio: options.normalizeAudio,
          audioNormalizationMethod: options.audioNormalizationMethod
        });
        
        if (outputFile && fs.existsSync(outputFile)) {
          this.logger.log(`Media processed successfully: ${outputFile}`);
          result.outputFile = outputFile;
          result.success = true;
        } else {
          this.logger.warn(`Failed to process media, using original file: ${inputFile}`);
          result.success = false;
          result.error = 'Video reencoding failed';
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
        } catch (thumbnailError) {
          const errorMessage = thumbnailError instanceof Error 
            ? thumbnailError.message 
            : String(thumbnailError);
          
          this.logger.error(`Error creating thumbnail: ${errorMessage}`);
        }
      }
      
      // Emit processing completed or failed event
      if (result.success) {
        this.eventService.emitProcessingCompleted(
          result.outputFile || inputFile,
          jobId,
          result.thumbnailFile,
          result.audioFile
        );
      } else {
        this.eventService.emitProcessingFailed(
          inputFile, 
          result.error || 'Unknown processing error', 
          jobId
        );
      }
      
      return result;
  
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.logger.error(`Error processing media: ${errorMessage}`);
      
      // Emit processing failed event
      this.eventService.emitProcessingFailed(inputFile, errorMessage, jobId);
      
      return { 
        success: false, 
        error: errorMessage,
        outputFile: inputFile // Fallback to original file
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