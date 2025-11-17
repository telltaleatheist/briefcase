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
   * Get all videos in a tab
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
   * POST /api/tabs/:id/videos
   * Add a video to a tab
   * Body: { videoId: string }
   */
  @Post(':id/videos')
  addVideoToTab(@Param('id') tabId: string, @Body() body: { videoId: string }) {
    try {
      if (!body.videoId) {
        throw new HttpException('Video ID is required', HttpStatus.BAD_REQUEST);
      }
      const itemId = this.databaseService.addVideoToTab(tabId, body.videoId);
      return { success: true, itemId };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (error?.message?.includes('already in this tab')) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      this.logger.error(`Failed to add video to tab: ${error?.message}`);
      throw new HttpException(
        error?.message || 'Failed to add video to tab',
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
