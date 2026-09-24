// Media Controller - Atomic operations for media processing

import { Controller, Post, Get, Body, Query, HttpException, HttpStatus } from '@nestjs/common';
import { MediaOperationsService } from './media-operations.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { isPathInsideRoots } from '../common/utils/path-security.util';

@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaOps: MediaOperationsService,
    private readonly libraryManager: LibraryManagerService,
  ) {}

  /**
   * Roots a download is allowed to write into. Every library's clips folder is
   * a valid destination. Used to validate a client-supplied outputDir (A3) so a
   * LAN client cannot force a write to an arbitrary location on disk.
   */
  private getAllowedDownloadRoots(): string[] {
    return this.libraryManager
      .getAllLibraries()
      .map((lib) => lib.clipsFolderPath)
      .filter((p): p is string => !!p);
  }

  /**
   * Get video metadata without downloading
   * GET /media/info?url=https://...
   */
  @Get('info')
  async getInfo(@Query('url') url: string) {
    if (!url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.mediaOps.getVideoInfo(url);

    if (!result.success) {
      throw new HttpException(
        result.error || 'Failed to get video info',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Download video only (no processing)
   * POST /media/download
   * Body: { url, quality?, displayName?, outputDir? }
   */
  @Post('download')
  async download(
    @Body()
    body: {
      url: string;
      quality?: string;
      convertToMp4?: boolean;
      useCookies?: boolean;
      browser?: string;
      displayName?: string;
      outputDir?: string;
    },
  ) {
    if (!body.url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    // SECURITY (A3): if the client supplies an explicit outputDir, it must be
    // contained within a known library clips folder. Reject arbitrary write
    // destinations. When omitted, the service derives a safe destination.
    if (body.outputDir && !isPathInsideRoots(body.outputDir, this.getAllowedDownloadRoots())) {
      throw new HttpException(
        'outputDir is not inside an allowed library folder',
        HttpStatus.FORBIDDEN,
      );
    }

    const result = await this.mediaOps.downloadVideo(body.url, body);

    if (!result.success) {
      throw new HttpException(
        result.error || 'Download failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Import video to library
   * POST /media/import
   * Body: { videoPath, duplicateHandling? }
   */
  @Post('import')
  async import(
    @Body()
    body: {
      videoPath: string;
      duplicateHandling?: 'skip' | 'replace' | 'keep-both';
    },
  ) {
    if (!body.videoPath) {
      throw new HttpException('Video path is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.mediaOps.importToLibrary(body.videoPath, {
      duplicateHandling: body.duplicateHandling,
    });

    if (!result.success) {
      throw new HttpException(
        result.error || 'Import failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Fix aspect ratio for vertical videos
   * POST /media/fix-aspect-ratio
   * Body: { videoId } or { videoPath }
   */
  @Post('fix-aspect-ratio')
  async fixAspectRatio(
    @Body()
    body: {
      videoId?: string;
      videoPath?: string;
    },
  ) {
    if (!body.videoId && !body.videoPath) {
      throw new HttpException(
        'Either videoId or videoPath is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.mediaOps.fixAspectRatio(
      body.videoId || body.videoPath!,
    );

    if (!result.success) {
      throw new HttpException(
        result.error || 'Fix aspect ratio failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Normalize audio levels
   * POST /media/normalize-audio
   * Body: { videoId } or { videoPath }, level?, method?
   */
  @Post('normalize-audio')
  async normalizeAudio(
    @Body()
    body: {
      videoId?: string;
      videoPath?: string;
      level?: number;
      method?: 'rms' | 'ebu-r128';
    },
  ) {
    if (!body.videoId && !body.videoPath) {
      throw new HttpException(
        'Either videoId or videoPath is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.mediaOps.normalizeAudio(
      body.videoId || body.videoPath!,
      {
        level: body.level,
        method: body.method,
      },
    );

    if (!result.success) {
      throw new HttpException(
        result.error || 'Normalize audio failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }
}
