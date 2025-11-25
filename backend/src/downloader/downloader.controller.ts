// ClipChimp/backend/src/downloader/downloader.controller.ts
import { Controller, Get, Param, Delete, Res, Query } from '@nestjs/common';
import { Response } from 'express';
import { DownloaderService } from './downloader.service';
import * as fs from 'fs';

@Controller('downloader')
export class DownloaderController {
  constructor(
    private readonly downloaderService: DownloaderService
  ) {}

  @Get('info')
  async getVideoInfo(@Query('url') url: string) {
    if (!url) {
      return { error: 'URL is required' };
    }
    
    try {
      const result = await this.downloaderService.getVideoInfo(url);
      return result;
    } catch (error) {
      return { 
        error: error instanceof Error ? (error as Error).message : 'Failed to get video info',
        title: 'Unknown Title'
      };
    }
  }

  // Existing endpoints remain unchanged...
  @Get('history')
  async getDownloadHistory() {
    return this.downloaderService.getDownloadHistory();
  }

  @Delete('history/:id')
  async removeFromHistory(@Param('id') id: string) {
    return this.downloaderService.removeFromHistory(id);
  }

  @Delete('history')
  async clearHistory() {
    return this.downloaderService.clearHistory();
  }

  @Get('file/:id')
  async getFile(@Param('id') id: string, @Res() res: Response) {
    const file = await this.downloaderService.getFileById(id);
    
    if (!file || !fs.existsSync(file.filePath)) {
      return res.status(404).json({ message: 'File not found' });
    }
    
    return res.download(file.filePath);
  }

  @Get('stream/:id')
  async streamFile(@Param('id') id: string, @Res() res: Response) {
    const file = await this.downloaderService.getFileById(id);
    
    if (!file || !fs.existsSync(file.filePath)) {
      return res.status(404).json({ message: 'File not found' });
    }
    
    // Get file stats
    const stat = fs.statSync(file.filePath);
    const fileSize = stat.size;
    const range = res.req.headers.range;
    
    if (range) {
      // Parse range
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      
      const fileStream = fs.createReadStream(file.filePath, { start, end });
      
      // Set headers
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });

      // Stream the video
      fileStream.pipe(res);
    } else {
      // No range requested, send entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      
      fs.createReadStream(file.filePath).pipe(res);
    }
  }

  @Get('check')
  async checkUrl(@Query('url') url: string) {
    if (!url) {
      return { valid: false, message: 'URL is required' };
    }
    
    return this.downloaderService.checkUrl(url);
  }
}