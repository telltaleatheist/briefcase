import { Controller, Get, Post, Delete, Patch, Logger, Body, Param, HttpException, HttpStatus } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * TabsController - REST API endpoints for video tabs management
 *
 * Provides:
 * - Get all tabs
 * - Create/update/delete tabs
 * - Add/remove videos from tabs
 * - Get videos in a tab
 */
@Controller('tabs')
export class TabsController {
  private readonly logger = new Logger(TabsController.name);

  constructor(
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * GET /api/tabs
   * Get all video tabs with video counts
   */
  @Get()
  getAllTabs() {
    try {
      return this.databaseService.getAllTabs();
    } catch (error: any) {
      this.logger.error(`Failed to get tabs: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get tabs',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/tabs/:id
   * Get a single tab by ID
   */
  @Get(':id')
  getTabById(@Param('id') id: string) {
    try {
      const tab = this.databaseService.getTabById(id);
      if (!tab) {
        throw new HttpException('Tab not found', HttpStatus.NOT_FOUND);
      }
      return tab;
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to get tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * POST /api/tabs
   * Create a new tab
   * Body: { name: string }
   */
  @Post()
  createTab(@Body() body: { name: string }) {
    try {
      if (!body.name || body.name.trim() === '') {
        throw new HttpException('Tab name is required', HttpStatus.BAD_REQUEST);
      }
      const id = this.databaseService.createTab(body.name.trim());
      return { id, name: body.name.trim() };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to create tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to create tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * PATCH /api/tabs/:id
   * Update a tab's name
   * Body: { name: string }
   */
  @Patch(':id')
  updateTab(@Param('id') id: string, @Body() body: { name: string }) {
    try {
      if (!body.name || body.name.trim() === '') {
        throw new HttpException('Tab name is required', HttpStatus.BAD_REQUEST);
      }
      this.databaseService.updateTab(id, body.name.trim());
      return { success: true };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to update tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to update tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * DELETE /api/tabs/:id
   * Delete a tab (and all its video associations)
   */
  @Delete(':id')
  deleteTab(@Param('id') id: string) {
    try {
      this.databaseService.deleteTab(id);
      return { success: true };
    } catch (error: any) {
      this.logger.error(`Failed to delete tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to delete tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/tabs/:id/videos
   * Get all videos in a tab (legacy - for backwards compatibility)
   */
  @Get(':id/videos')
  getTabVideos(@Param('id') id: string) {
    try {
      return this.databaseService.getTabVideos(id);
    } catch (error: any) {
      this.logger.error(`Failed to get tab videos: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get tab videos',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/tabs/:id/items
   * Get all items in a tab (videos, links, etc.)
   */
  @Get(':id/items')
  getTabItems(@Param('id') id: string) {
    try {
      return this.databaseService.getTabItems(id);
    } catch (error: any) {
      this.logger.error(`Failed to get tab items: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get tab items',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * POST /api/tabs/:id/videos
   * Add one or more videos to a tab
   * Body: { videoId: string | string[] }
   */
  @Post(':id/videos')
  addVideoToTab(@Param('id') tabId: string, @Body() body: { videoId: string | string[] }) {
    try {
      if (!body.videoId) {
        throw new HttpException('Video ID is required', HttpStatus.BAD_REQUEST);
      }

      const videoIds = Array.isArray(body.videoId) ? body.videoId : [body.videoId];
      const results: { videoId: string; success: boolean; itemId?: string; error?: string }[] = [];

      for (const videoId of videoIds) {
        try {
          const itemId = this.databaseService.addVideoToTab(tabId, videoId);
          results.push({ videoId, success: true, itemId });
        } catch (error: any) {
          if (error?.message?.includes('already in this tab')) {
            results.push({ videoId, success: false, error: 'Already in tab' });
          } else {
            results.push({ videoId, success: false, error: error.message || 'Unknown error' });
          }
        }
      }

      const successCount = results.filter(r => r.success).length;
      return {
        success: successCount > 0,
        results,
        addedCount: successCount,
        totalCount: videoIds.length
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to add video to tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to add video to tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * POST /api/tabs/:id/links
   * Add one or more saved links to a tab
   * Body: { savedLinkId: string | string[], title?: string }
   */
  @Post(':id/links')
  addSavedLinkToTab(@Param('id') tabId: string, @Body() body: { savedLinkId: string | string[], title?: string }) {
    try {
      if (!body.savedLinkId) {
        throw new HttpException('Saved link ID is required', HttpStatus.BAD_REQUEST);
      }

      const linkIds = Array.isArray(body.savedLinkId) ? body.savedLinkId : [body.savedLinkId];
      const results: { savedLinkId: string; success: boolean; itemId?: string; error?: string }[] = [];

      for (const savedLinkId of linkIds) {
        try {
          const itemId = this.databaseService.addSavedLinkToTab(tabId, savedLinkId, body.title);
          results.push({ savedLinkId, success: true, itemId });
        } catch (error: any) {
          if (error?.message?.includes('already in this tab')) {
            results.push({ savedLinkId, success: false, error: 'Already in tab' });
          } else {
            results.push({ savedLinkId, success: false, error: error.message || 'Unknown error' });
          }
        }
      }

      const successCount = results.filter(r => r.success).length;
      return {
        success: successCount > 0,
        results,
        addedCount: successCount,
        totalCount: linkIds.length
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to add saved link to tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to add saved link to tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * DELETE /api/tabs/:id/videos/:videoId
   * Remove a video from a tab
   */
  @Delete(':id/videos/:videoId')
  removeVideoFromTab(@Param('id') tabId: string, @Param('videoId') videoId: string) {
    try {
      this.databaseService.removeVideoFromTab(tabId, videoId);
      return { success: true };
    } catch (error: any) {
      this.logger.error(`Failed to remove video from tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to remove video from tab',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/tabs/video/:videoId
   * Get all tabs that contain a specific video
   */
  @Get('video/:videoId')
  getTabsForVideo(@Param('videoId') videoId: string) {
    try {
      return this.databaseService.getTabsForVideo(videoId);
    } catch (error: any) {
      this.logger.error(`Failed to get tabs for video: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to get tabs for video',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
