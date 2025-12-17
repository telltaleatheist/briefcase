// ClipChimp/backend/src/saved-links/saved-links.service.ts
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseService } from '../database/database.service';
import { QueueManagerService } from '../queue/queue-manager.service';
import { MediaEventService } from '../media/media-event.service';
import { WebSocketService } from '../common/websocket.service';
import { FileScannerService } from '../database/file-scanner.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { DownloaderService } from '../downloader/downloader.service';
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
    private readonly queueManagerService: QueueManagerService,
    private readonly mediaEventService: MediaEventService,
    private readonly websocketService: WebSocketService,
    private readonly fileScannerService: FileScannerService,
    private readonly libraryManagerService: LibraryManagerService,
    @Inject(forwardRef(() => DownloaderService))
    private readonly downloaderService: DownloaderService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Set up event listeners when module initializes
   */
  onModuleInit() {
    this.logger.log('Setting up saved links event listeners');
    this.setupEventListeners();
    this.recoverStuckDownloads();
  }

  /**
   * Recover downloads that got stuck in 'downloading' or 'pending' state
   * This can happen if the app was closed while downloads were in progress
   */
  private recoverStuckDownloads() {
    try {
      // Check if database is initialized before accessing it
      if (!this.databaseService.isInitialized()) {
        this.logger.log('Database not yet initialized, skipping stuck download recovery (will run when library opens)');
        return;
      }

      const allLinks = this.databaseService.getAllSavedLinks() as unknown as SavedLink[];
      const stuckLinks = allLinks.filter(link =>
        (link.status === 'downloading' || link.status === 'pending') &&
        link.date_added
      );

      if (stuckLinks.length === 0) {
        return;
      }

      // Consider downloads stuck if they've been in progress for more than 1 hour
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      for (const link of stuckLinks) {
        const addedDate = new Date(link.date_added);
        if (addedDate < oneHourAgo) {
          this.logger.warn(`Recovering stuck download: ${link.id} (status: ${link.status}, added: ${link.date_added})`);

          // Mark as failed so user can retry
          this.databaseService.updateSavedLinkStatus(
            link.id,
            'failed',
            'Download was interrupted - please retry'
          );

          // Notify frontend
          const updatedLink = this.databaseService.findSavedLinkById(link.id);
          if (updatedLink) {
            this.websocketService.emitSavedLinkUpdated(updatedLink as any);
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to recover stuck downloads:', error);
    }
  }

  /**
   * Listen for download/processing completion events
   */
  private setupEventListeners() {
    // Listen for job completed events
    this.eventEmitter.on('job.completed', (data: { jobId: string; status: string; downloadedPath?: string }) => {
      this.logger.log(`Received job.completed event: ${JSON.stringify(data)}`);
      this.handleJobEvent(data.jobId, 'completed', data.downloadedPath);
    });

    // Listen for job failed events
    this.eventEmitter.on('task.failed', (data: { jobId: string; error?: { message?: string } }) => {
      this.logger.log(`Received task.failed event: ${JSON.stringify(data)}`);
      this.handleJobEvent(data.jobId, 'failed', undefined, data.error?.message);
    });

  }

  /**
   * Handle job completion/failure events
   */
  private handleJobEvent(jobId: string, status: 'completed' | 'failed', downloadedPath?: string, errorMessage?: string) {
    // Find saved link by job ID in metadata
    const allLinks = this.databaseService.getAllSavedLinks();
    const savedLink = allLinks.find(link => {
      if (link.metadata) {
        // Metadata is already parsed by getAllSavedLinks(), so check if it's an object or string
        let metadata = link.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            return false;
          }
        }
        return metadata.jobId === jobId;
      }
      return false;
    });

    if (savedLink) {
      this.logger.log(`Job ${status} for saved link ${savedLink.id}, downloadedPath: ${downloadedPath || 'undefined'}`);

      if (status === 'completed') {
        this.handleDownloadCompleted(savedLink.id, downloadedPath);
      } else if (status === 'failed') {
        this.handleDownloadFailed(savedLink.id, errorMessage || 'Download failed');
      }
    } else {
      this.logger.warn(`No saved link found with jobId ${jobId} in metadata`);
    }
  }

  /**
   * Handle successful download completion
   * Note: With the new batch downloader implementation using analysis queue,
   * download + import + processing happens automatically. This just marks as completed.
   */
  private async handleDownloadCompleted(savedLinkId: string, downloadedPath?: string) {
    this.logger.log(`Download completed for saved link: ${savedLinkId}, path: ${downloadedPath}`);

    const savedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (!savedLink) {
      this.logger.warn(`Saved link not found: ${savedLinkId}`);
      return;
    }

    // Update status to completed with download path
    this.databaseService.updateSavedLinkStatus(
      savedLinkId,
      'completed',
      undefined,
      downloadedPath,
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
      title: title || null, // Don't use URL as title - let download logic generate hash
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
      // Determine base output directory based on library ID
      let baseDir: string;

      if (libraryId) {
        // Look up the library's clips folder path
        const libraries = this.libraryManagerService.getAllLibraries();
        const targetLibrary = libraries.find(lib => lib.id === libraryId);

        if (targetLibrary) {
          baseDir = targetLibrary.clipsFolderPath;
          this.logger.log(`Using library clips folder: ${baseDir}`);
        } else {
          this.logger.warn(`Library not found: ${libraryId}, using active library instead`);
          const activeLibrary = this.libraryManagerService.getActiveLibrary();
          baseDir = activeLibrary?.clipsFolderPath || 'saved-links';
        }
      } else {
        // No library ID provided, use active library's clips folder
        const activeLibrary = this.libraryManagerService.getActiveLibrary();
        if (activeLibrary) {
          baseDir = activeLibrary.clipsFolderPath;
          this.logger.log(`Using active library clips folder: ${baseDir}`);
        } else {
          // Fallback to saved-links if no active library
          baseDir = 'saved-links';
          this.logger.warn('No active library found, using fallback folder: saved-links');
        }
      }

      // Fetch video info to get title and upload date
      let displayName = savedLink.title;
      let uploadDate: string | undefined;

      if (!displayName) {
        try {
          this.logger.log(`Fetching video info for: ${savedLink.url}`);
          const videoInfo = await this.downloaderService.getVideoInfo(savedLink.url);

          if (videoInfo) {
            // Extract title
            if (videoInfo.title) {
              displayName = videoInfo.title;
              this.logger.log(`Extracted title: ${displayName}`);

              // Update the saved link title in the database immediately
              this.databaseService.updateSavedLinkTitle(savedLinkId, videoInfo.title);

              // Fetch the updated record and emit to frontend
              const updatedLink = this.databaseService.findSavedLinkById(savedLinkId);
              if (updatedLink) {
                this.logger.log(`Emitting updated title to frontend: ${videoInfo.title}`);
                this.websocketService.emitSavedLinkUpdated(updatedLink as unknown as SavedLink);
              }
            }

            // Extract upload date (format: YYYYMMDD or YYYY-MM-DD)
            if (videoInfo.upload_date) {
              const dateStr = videoInfo.upload_date.toString();
              if (dateStr.length === 8) {
                // YYYYMMDD format
                uploadDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
              } else if (dateStr.includes('-')) {
                uploadDate = dateStr;
              }
              this.logger.log(`Extracted upload date: ${uploadDate}`);
            }
          }
        } catch (infoError: any) {
          this.logger.warn(`Failed to fetch video info: ${infoError.message}, will use hash-based name`);
        }
      }

      // If still no title, generate a hash-based name
      if (!displayName) {
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(savedLink.url + Date.now()).digest('hex').substring(0, 12);
        displayName = `download-${hash}`;
        this.logger.warn(`No title available for ${savedLink.url}, using generated name: ${displayName}`);
      }

      // Sanitize filename - remove slashes and other invalid characters
      displayName = displayName
        .replace(/[\/\\:*?"<>|]/g, '-') // Replace invalid chars with dash
        .replace(/\s+/g, ' ')           // Normalize whitespace
        .trim();

      // Prepend upload date if available
      if (uploadDate) {
        displayName = `${uploadDate} ${displayName}`;
      }

      // Add to unified queue using new queue system
      // Note: Downloads will go to the library's clips folder in a date-based subfolder
      // User must manually import to library from the "Ready to Add" section
      const jobId = this.queueManagerService.addJob({
        url: savedLink.url,
        displayName: displayName,
        libraryId: libraryId, // Ensure it downloads to the correct library
        tasks: [
          { type: 'download', options: { quality: '720' } }
        ]
      });

      this.logger.log(`Started download job ${jobId} for saved link ${savedLinkId} (library: ${libraryId || 'default'}, pending: true)`);

      // Store job ID in metadata for tracking
      // Metadata may already be parsed by findSavedLinkById, so handle both cases
      let currentMetadata = {};
      if (savedLink.metadata) {
        if (typeof savedLink.metadata === 'string') {
          try {
            currentMetadata = JSON.parse(savedLink.metadata);
          } catch {
            currentMetadata = {};
          }
        } else {
          currentMetadata = savedLink.metadata;
        }
      }
      const updatedMetadata = { ...currentMetadata, jobId };
      this.databaseService.updateSavedLinkMetadata(savedLinkId, JSON.stringify(updatedMetadata));

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
   * Delete a saved link and its downloaded file
   */
  deleteLink(id: string): void {
    const savedLink = this.databaseService.findSavedLinkById(id) as unknown as SavedLink;

    if (savedLink && savedLink.download_path) {
      // Delete the downloaded file if it exists
      const fs = require('fs');
      try {
        if (fs.existsSync(savedLink.download_path)) {
          fs.unlinkSync(savedLink.download_path);
          this.logger.log(`Deleted file: ${savedLink.download_path}`);
        }
      } catch (error: any) {
        this.logger.error(`Failed to delete file ${savedLink.download_path}: ${error.message}`);
      }
    }

    // Delete the database record
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

  /**
   * Import a downloaded video to the library database
   * The file is already in the clips folder from the download process
   */
  async addToLibrary(savedLinkId: string): Promise<{ success: boolean; videoId?: string; error?: string }> {
    const savedLink = this.databaseService.findSavedLinkById(savedLinkId) as unknown as SavedLink;
    if (!savedLink) {
      throw new Error('Saved link not found');
    }

    if (savedLink.status !== 'completed') {
      throw new Error('Can only add completed downloads to library');
    }

    if (!savedLink.download_path) {
      throw new Error('No download path found for this saved link');
    }

    try {
      const fs = require('fs');
      const filePath = savedLink.download_path;

      this.logger.log(`Adding to library: ${filePath}`);

      // Verify the file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const filename = path.basename(filePath);

      // Import the video to the database using file scanner
      // The file is already in the clips folder from the download process
      const result = await this.fileScannerService.importVideos([filePath]);

      this.logger.log(`Import result: imported=${result.imported.length}, skipped=${result.skipped.length}, errors=${result.errors.length}`);

      // Check if import was successful - find by filename
      const importedVideo = result.imported.length > 0
        ? this.databaseService.findVideoByFilename(filename)
        : null;

      if (!importedVideo && result.skipped.length === 0) {
        // Import failed
        this.logger.warn(`Failed to import ${filePath}`);
        return {
          success: false,
          error: 'Failed to import video to library'
        };
      }

      // Delete the saved link record
      this.databaseService.deleteSavedLink(savedLinkId);
      this.websocketService.emitSavedLinkDeleted(savedLinkId);

      // Emit video-added event if a new video was imported
      if (importedVideo) {
        this.websocketService.emitVideoAdded({
          videoId: importedVideo.id,
          filename: importedVideo.filename,
          filepath: importedVideo.current_path,
          timestamp: new Date().toISOString()
        });
      }

      this.logger.log(`Added saved link ${savedLinkId} to library as video ${importedVideo?.id || 'already existed'}`);

      return {
        success: true,
        videoId: importedVideo?.id
      };

    } catch (error: any) {
      this.logger.error(`Failed to add saved link ${savedLinkId} to library: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}
