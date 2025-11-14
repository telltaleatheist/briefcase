// clippy/backend/src/saved-links/saved-links.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { SavedLinksService, SavedLink } from './saved-links.service';

@Controller('saved-links')
export class SavedLinksController {
  private readonly logger = new Logger(SavedLinksController.name);

  constructor(private readonly savedLinksService: SavedLinksService) {}

  /**
   * Add a new link
   * POST /api/saved-links
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async addLink(
    @Body() body: { url: string; title?: string; libraryId?: string; shouldDownload?: boolean }
  ): Promise<SavedLink> {
    this.logger.log(`Adding new link: ${body.url} (library: ${body.libraryId || 'default'}, download: ${body.shouldDownload !== false})`);
    return await this.savedLinksService.addLink(body.url, body.title, body.libraryId, body.shouldDownload);
  }

  /**
   * Get all saved links
   * GET /api/saved-links
   */
  @Get()
  getAllLinks(@Query('status') status?: string): SavedLink[] {
    this.logger.log(`Getting all saved links${status ? ` with status: ${status}` : ''}`);
    return this.savedLinksService.getAllLinks(status);
  }

  /**
   * Get a specific saved link
   * GET /api/saved-links/:id
   */
  @Get(':id')
  getLinkById(@Param('id') id: string): SavedLink | null {
    this.logger.log(`Getting saved link: ${id}`);
    return this.savedLinksService.getLinkById(id);
  }

  /**
   * Update a saved link's title
   * PATCH /api/saved-links/:id
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  updateLink(
    @Param('id') id: string,
    @Body() body: { title: string }
  ): SavedLink {
    this.logger.log(`Updating saved link title: ${id}`);
    return this.savedLinksService.updateLinkTitle(id, body.title);
  }

  /**
   * Delete a saved link
   * DELETE /api/saved-links/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteLink(@Param('id') id: string): void {
    this.logger.log(`Deleting saved link: ${id}`);
    this.savedLinksService.deleteLink(id);
  }

  /**
   * Retry a failed link
   * POST /api/saved-links/:id/retry
   */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  retryLink(@Param('id') id: string): { message: string } {
    this.logger.log(`Retrying saved link: ${id}`);
    this.savedLinksService.retryLink(id);
    return { message: 'Download restarted' };
  }

  /**
   * Get count of saved links
   * GET /api/saved-links/count
   */
  @Get('stats/count')
  getCount(@Query('status') status?: string): { count: number } {
    const count = this.savedLinksService.getCount(status);
    return { count };
  }

  /**
   * Get count of active (pending/downloading) links
   * GET /api/saved-links/stats/active
   */
  @Get('stats/active')
  getActiveCount(): { count: number } {
    const count = this.savedLinksService.getActiveCoun();
    return { count };
  }
}
