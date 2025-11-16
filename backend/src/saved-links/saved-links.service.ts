// clippy/backend/src/saved-links/saved-links.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { BatchDownloaderService } from '../downloader/batch-downloader.service';
import { MediaEventService } from '../media/media-event.service';
import { WebSocketService } from '../common/websocket.service';
import { FileScannerService } from '../database/file-scanner.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';

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
export class SavedLinksService implements OnModuleInit {
  private readonly logger = new Logger(SavedLinksService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly batchDownloaderService: BatchDownloaderService,
    private readonly mediaEventService: MediaEventService,
    private readonly websocketService: WebSocketService,
    private readonly fileScannerService: FileScannerService,
    private readonly libraryManagerService: LibraryManagerService,
  ) {}

  /**
   * Set up event listeners when module initializes
   */
  onModuleInit() {
    this.logger.log('Setting up saved links event listeners');
    this.setupEventListeners();
  }

  /**
   * Listen for download/processing completion events
   */
  private setupEventListeners() {
    // Listen for job status updates
    this.mediaEventService.server?.on('job-status-updated', (data: { jobId: string; status: string; task: string }) => {
      // Check if this is a saved-link job
      if (data.jobId.startsWith('saved-link-')) {
        const savedLinkId = data.jobId.replace('saved-link-', '');
        this.logger.log(`Job status update for saved link ${savedLinkId}: ${data.status}`);

        // Update status based on job status
        if (data.status === 'completed') {
          this.handleDownloadCompleted(savedLinkId);
        } else if (data.status === 'failed') {
          this.handleDownloadFailed(savedLinkId, data.task);
        }
      }
    });
  }

  /**
   * Handle successful download completion
   * Note: With the new batch downloader implementation using analysis queue,
   * download + import + processing happens automatically. This just marks as completed.
   */
  private async handleDownloadCompleted(savedLinkId: string) {
    this.logger.log(`Download completed for saved link: ${savedLinkId}`);

    const savedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (!savedLink) {
      this.logger.warn(`Saved link not found: ${savedLinkId}`);
      return;
    }

    // Update status to completed
    // Note: The analysis queue handles download + import + processing automatically
    this.databaseService.updateSavedLinkStatus(
      savedLinkId,
      'completed',
      undefined,
      undefined, // Output file path handled by analysis queue
    );

    this.logger.log(`Marked saved link ${savedLinkId} as completed`);

    // Emit update
    const updatedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (updatedLink) {
      this.websocketService.emitSavedLinkUpdated(updatedLink);
    }
  }

  /**
   * Handle failed download
   */
  private handleDownloadFailed(savedLinkId: string, errorMessage: string) {
    this.logger.log(`Download failed for saved link: ${savedLinkId}`);

    this.databaseService.updateSavedLinkStatus(
      savedLinkId,
      'failed',
      errorMessage || 'Download failed',
    );

    const updatedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (updatedLink) {
      this.websocketService.emitSavedLinkUpdated(updatedLink);
    }
  }

  /**
   * Add a new link to be saved for later
   */
  async addLink(url: string, title?: string, libraryId?: string, shouldDownload?: boolean): Promise<SavedLink> {
    // Check if URL already exists
    const existing = this.databaseService.findSavedLinkByUrl(url);
    if (existing) {
      this.logger.log(`Link already exists: ${url}`);
      return existing as unknown as SavedLink;
    }

    // Default to download if not specified
    const doDownload = shouldDownload !== false;

    // Create new saved link
    const id = uuidv4();
    const savedLink: any = {
      id,
      url,
      title: title || url,
      status: doDownload ? 'pending' as const : 'completed' as const,
    };

    // Add library_id if provided
    if (libraryId) {
      savedLink.library_id = libraryId;
    }

    // Insert into database
    this.databaseService.insertSavedLink(savedLink);
    this.logger.log(`Added new saved link: ${url} (library: ${libraryId || 'default'}, download: ${doDownload})`);

    // Get the full record
    const fullRecord = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;

    // Emit update to websocket clients
    this.websocketService.emitSavedLinkAdded(fullRecord);

    // Start download immediately with library ID (only if shouldDownload is true)
    if (doDownload) {
      this.startDownload(id, libraryId);
    }

    return fullRecord;
  }

  /**
   * Start downloading a saved link
   */
  private async startDownload(savedLinkId: string, libraryId?: string): Promise<void> {
    const savedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (!savedLink) {
      this.logger.warn(`Saved link not found: ${savedLinkId}`);
      return;
    }

    // Update status to downloading
    this.databaseService.updateSavedLinkStatus(savedLinkId, 'downloading');
    this.websocketService.emitSavedLinkUpdated({
      ...savedLink,
      status: 'downloading',
    });

    try {
      // Determine output directory based on library ID
      let outputDir: string;

      if (libraryId) {
        // Look up the library's clips folder path
        const libraries = this.libraryManagerService.getAllLibraries();
        const targetLibrary = libraries.find(lib => lib.id === libraryId);

        if (targetLibrary) {
          outputDir = targetLibrary.clipsFolderPath;
          this.logger.log(`Using library clips folder: ${outputDir}`);
        } else {
          this.logger.warn(`Library not found: ${libraryId}, using active library instead`);
          const activeLibrary = this.libraryManagerService.getActiveLibrary();
          outputDir = activeLibrary?.clipsFolderPath || 'saved-links';
        }
      } else {
        // No library ID provided, use active library's clips folder
        const activeLibrary = this.libraryManagerService.getActiveLibrary();
        if (activeLibrary) {
          outputDir = activeLibrary.clipsFolderPath;
          this.logger.log(`Using active library clips folder: ${outputDir}`);
        } else {
          // Fallback to saved-links if no active library
          outputDir = 'saved-links';
          this.logger.warn('No active library found, using fallback folder: saved-links');
        }
      }

      // Add to batch downloader with skipProcessing flag
      const jobId = this.batchDownloaderService.addToBatchQueue({
        url: savedLink.url,
        displayName: savedLink.title || savedLink.url,
        outputDir,
        quality: '720p',
        skipProcessing: true, // Skip processing - just download and import
        shouldImport: true, // Auto-import to library
      }, `saved-link-${savedLinkId}`);

      this.logger.log(`Started download job ${jobId} for saved link ${savedLinkId} (library: ${libraryId || 'default'})`);

      // TODO: Listen for job completion events and update saved link status
      // This will be handled by listening to MediaEventService events

    } catch (error: any) {
      this.logger.error(`Failed to start download for saved link ${savedLinkId}: ${error.message}`);
      this.databaseService.updateSavedLinkStatus(
        savedLinkId,
        'failed',
        error.message || 'Download failed',
      );
      this.websocketService.emitSavedLinkUpdated({
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
    this.websocketService.emitSavedLinkDeleted(id);
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
      this.websocketService.emitSavedLinkUpdated(updatedLink);
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

  /**
   * Update the title of a saved link
   */
  updateLinkTitle(id: string, title: string): SavedLink {
    const savedLink = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;
    if (!savedLink) {
      throw new Error('Saved link not found');
    }

    this.databaseService.updateSavedLinkTitle(id, title);
    this.logger.log(`Updated title for saved link ${id}: ${title}`);

    const updatedLink = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;
    if (updatedLink) {
      this.websocketService.emitSavedLinkUpdated(updatedLink);
    }

    return updatedLink;
  }
}
