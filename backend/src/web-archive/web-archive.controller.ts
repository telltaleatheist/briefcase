import { Controller, Get, Post, Delete, Param, Query, Body, Res, Logger } from '@nestjs/common';
import { WebArchiveService } from './web-archive.service';
import { DatabaseService } from '../database/database.service';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

@Controller('web-archives')
export class WebArchiveController {
  private readonly logger = new Logger(WebArchiveController.name);

  constructor(
    private readonly webArchiveService: WebArchiveService,
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * Import a captured/existing MHTML file
   */
  @Post('import')
  async importArchive(
    @Body() body: {
      videoId: string;
      filePath: string;
      filename: string;
      originalUrl?: string;
      pageTitle?: string;
      captureMethod?: string;
    },
  ) {
    try {
      const result = await this.webArchiveService.importWebArchive(body);
      return { success: true, ...result };
    } catch (error: any) {
      this.logger.error(`Import failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * List all archives, optionally filtered by domain
   */
  @Get()
  getArchives(@Query('domain') domain?: string) {
    try {
      const archives = this.databaseService.getAllWebArchives(domain);
      return { success: true, archives };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get domain list with counts
   */
  @Get('domains')
  getDomains() {
    try {
      const domains = this.webArchiveService.getDomains();
      return { success: true, domains };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get a single archive's details
   */
  @Get(':id')
  getArchive(@Param('id') id: string) {
    try {
      const archive = this.databaseService.getWebArchive(id);
      if (!archive) {
        return { success: false, error: 'Archive not found' };
      }
      return { success: true, archive };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Serve a cached favicon image
   */
  @Get('favicon/:domain')
  async getFavicon(@Param('domain') domain: string, @Res() res: Response) {
    try {
      // Look up favicon path from any archive with this domain
      const domains = this.databaseService.getWebArchiveDomains();
      const domainInfo = domains.find(d => d.domain === domain);

      if (domainInfo?.favicon_path && fs.existsSync(domainInfo.favicon_path)) {
        res.sendFile(domainInfo.favicon_path);
      } else {
        res.status(404).json({ error: 'Favicon not found' });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Delete an archive
   */
  @Delete(':id')
  deleteArchive(@Param('id') id: string) {
    try {
      this.databaseService.deleteWebArchive(id);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Backfill metadata for existing MHTML files in the library
   */
  @Post('backfill')
  async backfill() {
    try {
      const allVideos = this.databaseService.getAllVideos();
      const webpages = allVideos.filter(v => v.media_type === 'webpage');
      let backfilled = 0;

      for (const video of webpages) {
        const existing = this.databaseService.getWebArchive(video.id);
        if (!existing) {
          try {
            await this.webArchiveService.backfillSingleArchive(
              video.id,
              video.current_path,
              video.filename,
            );
            backfilled++;
          } catch (error: any) {
            this.logger.warn(`Backfill failed for ${video.filename}: ${error.message}`);
          }
        }
      }

      return { success: true, backfilled, total: webpages.length };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}
