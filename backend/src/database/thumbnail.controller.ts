import { Controller, Get, Post, Param, Query, Res, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { DatabaseService } from './database.service';
import { ThumbnailService } from './thumbnail.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';

@Controller('database')
export class ThumbnailController {
  private readonly logger = new Logger(ThumbnailController.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly thumbnailService: ThumbnailService,
    private readonly ffmpegService: FfmpegService,
  ) {
    console.log('[ThumbnailController] Controller instantiated');
  }

  @Get('thumbnail-test')
  thumbnailTest() {
    return { ok: true, message: 'ThumbnailController is loaded' };
  }

  @Get('thumbnail')
  async getVideoThumbnail(
    @Query('id') id: string,
    @Res() res: Response
  ) {
    try {
      const video = this.databaseService.getVideoById(id);

      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      if (!video.current_path || typeof video.current_path !== 'string') {
        throw new HttpException('Video path not available', HttpStatus.NOT_FOUND);
      }

      const videoPath = video.current_path as string;

      if (!fs.existsSync(videoPath)) {
        throw new HttpException('Video file not found', HttpStatus.NOT_FOUND);
      }

      // Get thumbnail path from ThumbnailService
      const thumbnailPath = this.thumbnailService.getThumbnailPath(id);

      // If thumbnail doesn't exist, generate it
      if (!this.thumbnailService.thumbnailExists(id)) {
        this.logger.log(`Generating thumbnail for video ${id}: ${video.filename}`);
        const generatedPath = await this.ffmpegService.createThumbnail(videoPath, undefined, id);

        if (!generatedPath || !fs.existsSync(generatedPath)) {
          throw new HttpException(
            'Failed to generate thumbnail',
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }
      }

      // Send the thumbnail file (dotfiles: 'allow' needed for .thumbnails directory)
      res.sendFile(thumbnailPath, { dotfiles: 'allow' }, (err: Error | null) => {
        if (err) {
          this.logger.warn(`Failed to send thumbnail for video ${id}: ${err.message}`);
          if (!res.headersSent) {
            res.status(404).json({ statusCode: 404, message: 'Thumbnail not found' });
          }
        }
      });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error getting thumbnail: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to get thumbnail: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('videos/:id/regenerate-thumbnail')
  async regenerateThumbnail(@Param('id') id: string) {
    try {
      const video = this.databaseService.getVideoById(id);
      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      const videoPath = video.current_path as string;
      if (!videoPath || !fs.existsSync(videoPath)) {
        throw new HttpException('Video file not found on disk', HttpStatus.NOT_FOUND);
      }

      // Delete existing thumbnail
      this.thumbnailService.deleteThumbnail(id);

      // Generate new thumbnail
      const generatedPath = await this.ffmpegService.createThumbnail(videoPath, undefined, id);
      if (!generatedPath || !fs.existsSync(generatedPath)) {
        throw new HttpException('Failed to generate thumbnail', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      this.logger.log(`Thumbnail regenerated for video ${id}`);
      return { success: true, message: 'Thumbnail regenerated' };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error regenerating thumbnail: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to regenerate thumbnail: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
