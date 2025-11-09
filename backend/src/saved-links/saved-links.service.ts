// clippy/backend/src/saved-links/saved-links.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { BatchDownloaderService } from '../downloader/batch-downloader.service';
import { SavedLinksGateway } from './saved-links.gateway';
import { v4 as uuidv4 } from 'uuid';

export interface SavedLink {
  id: string;
  url: string;
  title?: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  date_added: string;
  date_completed?: string;
  download_path?: string;
  thumbnail_path?: string;
  video_id?: string;
  error_message?: string;
  metadata?: any;
}

@Injectable()
export class SavedLinksService {
  private readonly logger = new Logger(SavedLinksService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly batchDownloaderService: BatchDownloaderService,
    private readonly savedLinksGateway: SavedLinksGateway,
  ) {}

  /**
   * Add a new link to be saved for later
   */
  async addLink(url: string, title?: string): Promise<SavedLink> {
    // Check if URL already exists
    const existing = this.databaseService.findSavedLinkByUrl(url);
    if (existing) {
      this.logger.log(`Link already exists: ${url}`);
      return existing as unknown as SavedLink;
    }

    // Create new saved link
    const id = uuidv4();
    const savedLink = {
      id,
      url,
      title: title || url,
      status: 'pending' as const,
    };

    // Insert into database
    this.databaseService.insertSavedLink(savedLink);
    this.logger.log(`Added new saved link: ${url}`);

    // Get the full record
    const fullRecord = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;

    // Emit update to websocket clients
    this.savedLinksGateway.emitLinkAdded(fullRecord);

    // Start download immediately
    this.startDownload(id);

    return fullRecord;
  }

  /**
   * Start downloading a saved link
   */
  private async startDownload(savedLinkId: string): Promise<void> {
    const savedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (!savedLink) {
      this.logger.warn(`Saved link not found: ${savedLinkId}`);
      return;
    }

    // Update status to downloading
    this.databaseService.updateSavedLinkStatus(savedLinkId, 'downloading');
    this.savedLinksGateway.emitLinkUpdated({
      ...savedLink,
      status: 'downloading',
    });

    try {
      // Add to batch downloader
      const jobId = this.batchDownloaderService.addToBatchQueue({
        url: savedLink.url,
        displayName: savedLink.title || savedLink.url,
        outputDir: 'saved-links', // Use a special folder for saved links
        quality: '720p',
      }, `saved-link-${savedLinkId}`);

      this.logger.log(`Started download job ${jobId} for saved link ${savedLinkId}`);

      // TODO: Listen for job completion events and update saved link status
      // This will be handled by listening to MediaEventService events

    } catch (error: any) {
      this.logger.error(`Failed to start download for saved link ${savedLinkId}: ${error.message}`);
      this.databaseService.updateSavedLinkStatus(
        savedLinkId,
        'failed',
        error.message || 'Download failed',
      );
      this.savedLinksGateway.emitLinkUpdated({
        ...savedLink,
        status: 'failed',
        error_message: error.message,
      });
    }
  }

  /**
   * Get all saved links
   */
  getAllLinks(status?: string): SavedLink[] {
    return this.databaseService.getAllSavedLinks(status) as unknown as SavedLink[];
  }

  /**
   * Get a saved link by ID
   */
  getLinkById(id: string): SavedLink | null {
    return this.databaseService.findSavedLinkById(id) as unknown as SavedLink;
  }

  /**
   * Delete a saved link
   */
  deleteLink(id: string): void {
    this.databaseService.deleteSavedLink(id);
    this.logger.log(`Deleted saved link: ${id}`);
    this.savedLinksGateway.emitLinkDeleted(id);
  }

  /**
   * Get count of links by status
   */
  getCount(status?: string): number {
    return this.databaseService.countSavedLinksByStatus(status);
  }

  /**
   * Get count of pending/downloading links (for tray badge)
   */
  getActiveCoun(): number {
    const pending = this.databaseService.countSavedLinksByStatus('pending');
    const downloading = this.databaseService.countSavedLinksByStatus('downloading');
    return pending + downloading;
  }

  /**
   * Update link status (called by download completion handlers)
   */
  updateLinkStatus(
    id: string,
    status: 'pending' | 'downloading' | 'completed' | 'failed',
    options?: {
      errorMessage?: string;
      downloadPath?: string;
      thumbnailPath?: string;
      videoId?: string;
    }
  ): void {
    this.databaseService.updateSavedLinkStatus(
      id,
      status,
      options?.errorMessage,
      options?.downloadPath,
      options?.thumbnailPath,
    );

    if (options?.videoId) {
      this.databaseService.linkSavedLinkToVideo(id, options.videoId);
    }

    const updatedLink = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;
    if (updatedLink) {
      this.savedLinksGateway.emitLinkUpdated(updatedLink);
    }
  }

  /**
   * Retry downloading a failed link
   */
  retryLink(id: string): void {
    const savedLink = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;
    if (!savedLink) {
      throw new Error('Saved link not found');
    }

    if (savedLink.status !== 'failed') {
      throw new Error('Can only retry failed links');
    }

    // Reset status to pending
    this.databaseService.updateSavedLinkStatus(id, 'pending');

    // Start download
    this.startDownload(id);
  }

  /**
   * Resume pending downloads on app startup
   */
  async resumePendingDownloads(): Promise<void> {
    const pendingLinks = this.getAllLinks('pending');
    this.logger.log(`Resuming ${pendingLinks.length} pending downloads`);

    for (const link of pendingLinks) {
      await this.startDownload(link.id);
    }
  }
}
