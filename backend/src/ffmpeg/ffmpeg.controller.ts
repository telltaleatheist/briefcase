// clippy/backend/src/ffmpeg/ffmpeg.controller.ts
import { 
  Body,
  Controller, 
  Get, 
  Param, 
  Post, 
  UploadedFile, 
  UseInterceptors 
} from '@nestjs/common';
import { Multer } from 'multer';
import { FileInterceptor } from '@nestjs/platform-express';
import { FfmpegService } from './ffmpeg.service';
import * as path from 'path';
import * as fs from 'fs';

@Controller('ffmpeg')
export class FfmpegController {
  constructor(private readonly ffmpegService: FfmpegService) {}

  @Get('metadata/:filename')
  async getVideoMetadata(@Param('filename') filename: string) {
    try {
      // Construct full path to the video file in downloads directory
      const downloadsDir = path.join(process.cwd(), 'downloads');
      const videoPath = path.join(downloadsDir, filename);

      // Check if file exists
      if (!fs.existsSync(videoPath)) {
        return { 
          success: false, 
          message: 'File not found' 
        };
      }

      // Get metadata
      const metadata = await this.ffmpegService.getVideoMetadata(videoPath);
      
      return {
        success: true,
        metadata
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Error extracting metadata'
      };
    }
  }

  @Post('thumbnail')
  @UseInterceptors(FileInterceptor('video'))
  async createThumbnail(@UploadedFile() video: Express.Multer.File) {
    try {
      if (!video) {
        return { 
          success: false, 
          message: 'No video file uploaded' 
        };
      }

      // Ensure downloads directory exists
      const downloadsDir = path.join(process.cwd(), 'downloads');
      if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
      }

      // Create thumbnail
      const thumbnailPath = await this.ffmpegService.createThumbnail(video.path);
      
      if (!thumbnailPath) {
        return {
          success: false,
          message: 'Failed to create thumbnail'
        };
      }

      return {
        success: true,
        thumbnailPath: path.basename(thumbnailPath)
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Error creating thumbnail'
      };
    }
  }

  @Post('fix-aspect-ratio')
  @UseInterceptors(FileInterceptor('video'))
  async fixAspectRatio(
    @UploadedFile() video: Express.Multer.File,
    @Body('jobId') jobId?: string // Add this parameter to accept jobId from request body
  ) {
    try {
      if (!video) {
        return { 
          success: false, 
          message: 'No video file uploaded' 
        };
      }
  
      // Pass the jobId to the ffmpeg service
      const processedVideoPath = await this.ffmpegService.reencodeVideo(video.path, jobId);
      
      if (!processedVideoPath) {
        return {
          success: false,
          message: 'Failed to process video aspect ratio'
        };
      }
  
      return {
        success: true,
        outputFile: path.basename(processedVideoPath)
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Error fixing aspect ratio'
      };
    }
  }
}