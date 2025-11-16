import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, from, throwError, firstValueFrom } from 'rxjs';
import { map, catchError, tap } from 'rxjs/operators';
import { DatabaseLibraryService, DatabaseVideo, BatchProgress } from './database-library.service';
import { NotificationService } from './notification.service';
import { BackendUrlService } from './backend-url.service';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';

export interface RenameOperation {
  videoId: string;
  oldFilename: string;
  newFilename: string;
}

export interface DeleteOperation {
  videoIds: string[];
  fileOnly?: boolean;
}

export interface AnalyzeOperation {
  videoIds: string[];
  transcribeOnly?: boolean;
  analyzeOnly?: boolean;
}

export interface MoveOperation {
  videoIds: string[];
  targetLibraryId: string;
}

export interface DeleteResult {
  success: boolean;
  deletedCount: number;
  errors?: any[];
}

/**
 * VideoOperationsService
 *
 * Handles all video operations:
 * - Analyze (transcribe + AI analysis)
 * - Delete (single and batch)
 * - Rename
 * - Move to library
 * - Copy operations (filename, path)
 * - Open file location
 * - Batch operations (start, pause, resume, stop)
 *
 * Wraps DatabaseLibraryService and provides higher-level operations
 * with notifications and error handling.
 */
@Injectable({
  providedIn: 'root'
})
export class VideoOperationsService {
  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private notificationService: NotificationService,
    private dialog: MatDialog,
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {}

  // ==================== Analyze Operations ====================

  /**
   * Open analyze dialog for multiple videos
   */
  async analyzeVideos(videos: DatabaseVideo[]): Promise<void> {
    if (!videos || videos.length === 0) {
      this.notificationService.toastOnly('info', 'No Videos Selected', 'Please select videos to analyze');
      return;
    }

    // Lazy load the analyze dialog component
    const { VideoAnalysisDialogComponent } = await import('../components/video-analysis-dialog/video-analysis-dialog.component');

    const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'video-analysis-dialog-panel',
      data: {
        selectedVideos: videos
      },
      disableClose: false
    });

    // Dialog now handles job creation internally via VideoProcessingQueueService
    await firstValueFrom(dialogRef.afterClosed());
  }

  /**
   * Open analyze dialog for a single video
   */
  async analyzeVideo(video: DatabaseVideo): Promise<void> {
    await this.analyzeVideos([video]);
  }

  /**
   * Open download from URL dialog
   */
  async downloadFromUrl(): Promise<void> {
    const { VideoAnalysisDialogComponent } = await import('../components/video-analysis-dialog/video-analysis-dialog.component');

    const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'video-analysis-dialog-panel',
      data: {
        mode: 'download'
      },
      disableClose: false
    });

    // Dialog now handles job creation internally via VideoProcessingQueueService
    await firstValueFrom(dialogRef.afterClosed());
  }

  // ==================== Delete Operations ====================

  /**
   * Delete a single video with confirmation dialog
   */
  async deleteVideo(video: DatabaseVideo, onSuccess?: () => Promise<void>): Promise<boolean> {
    // Lazy load delete confirmation dialog
    const { DeleteConfirmationDialog } = await import('../components/library/library.component');

    const dialogRef = this.dialog.open(DeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: 1,
        videoName: video.filename
      }
    });

    const result = await firstValueFrom(dialogRef.afterClosed());

    if (!result || result.action === 'cancel') {
      return false;
    }

    const deleteFiles = result.action === 'delete-all';

    try {
      await this.databaseLibraryService.deleteVideo(video.id, deleteFiles);

      this.notificationService.toastOnly(
        'success',
        deleteFiles ? 'Video Deleted' : 'Video Removed',
        deleteFiles
          ? `${video.filename} has been permanently deleted`
          : `${video.filename} has been removed from the library`
      );

      // Call success callback if provided
      if (onSuccess) {
        await onSuccess();
      }

      return true;
    } catch (error: any) {
      console.error('Failed to delete video:', error);
      this.notificationService.toastOnly(
        'error',
        'Delete Failed',
        error.error?.message || 'Failed to delete video'
      );
      return false;
    }
  }

  /**
   * Delete multiple videos in batch with confirmation dialog
   */
  async deleteVideoBatch(
    videoIds: string[],
    videos: DatabaseVideo[],
    onSuccess?: () => Promise<void>
  ): Promise<DeleteResult> {
    if (videoIds.length === 0) {
      return { success: false, deletedCount: 0 };
    }

    // Lazy load delete confirmation dialog
    const { DeleteConfirmationDialog } = await import('../components/library/library.component');

    const dialogRef = this.dialog.open(DeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: videoIds.length,
        videoName: videoIds.length === 1 ? videos.find(v => videoIds.includes(v.id))?.filename : null
      }
    });

    const result = await firstValueFrom(dialogRef.afterClosed());

    if (!result) {
      return { success: false, deletedCount: 0 };
    }

    const deleteFiles = result === 'everything';

    try {
      const response = await this.databaseLibraryService.deleteVideoBatch(videoIds, deleteFiles);

      // Show result notification
      if (response.successCount > 0) {
        this.notificationService.toastOnly(
          response.errorCount > 0 ? 'warning' : 'success',
          deleteFiles ? 'Delete Complete' : 'Removed from Library',
          response.message
        );
      } else {
        this.notificationService.toastOnly(
          'error',
          'Delete Failed',
          response.message
        );
      }

      // Log any errors for debugging
      if (response.errors && response.errors.length > 0) {
        console.error('Some videos failed to delete:', response.errors);
      }

      // Call success callback if provided
      if (onSuccess && response.successCount > 0) {
        await onSuccess();
      }

      return {
        success: response.successCount > 0,
        deletedCount: response.successCount,
        errors: response.errors
      };
    } catch (error: any) {
      console.error('Delete operation failed:', error);
      this.notificationService.toastOnly(
        'error',
        'Delete Failed',
        error.error?.message || 'Failed to delete videos'
      );
      return { success: false, deletedCount: 0 };
    }
  }

  // ==================== Batch Operations ====================

  /**
   * Start batch analysis
   */
  async startBatchAnalysis(limit?: number): Promise<void> {
    try {
      const options = limit ? { limit } : undefined;
      await this.databaseLibraryService.startBatchAnalysis(options);
      // No notification - progress bar will be visible
    } catch (error: any) {
      console.error('Failed to start batch:', error);
      this.notificationService.toastOnly(
        'error',
        'Error',
        error.error?.message || 'Failed to start batch analysis'
      );
      throw error;
    }
  }

  /**
   * Pause batch analysis
   */
  async pauseBatch(): Promise<BatchProgress> {
    try {
      await this.databaseLibraryService.pauseBatch();
      return await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to pause:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to pause batch');
      throw error;
    }
  }

  /**
   * Resume batch analysis
   */
  async resumeBatch(): Promise<BatchProgress> {
    try {
      await this.databaseLibraryService.resumeBatch();
      return await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to resume:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to resume batch');
      throw error;
    }
  }

  /**
   * Stop batch analysis
   */
  async stopBatch(): Promise<BatchProgress> {
    try {
      await this.databaseLibraryService.stopBatch();
      this.notificationService.toastOnly('info', 'Batch Stopped', 'Analysis has been stopped');
      return await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to stop:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to stop batch');
      throw error;
    }
  }

  /**
   * Get batch progress
   */
  async getBatchProgress(): Promise<BatchProgress> {
    return await this.databaseLibraryService.getBatchProgress();
  }

  // ==================== Copy Operations ====================

  /**
   * Copy filename to clipboard
   */
  copyFilename(filename: string): void {
    this.copyToClipboard(filename, 'Filename');
  }

  /**
   * Copy file path to clipboard
   */
  copyFilePath(filePath: string): void {
    this.copyToClipboard(filePath, 'File path');
  }

  /**
   * Copy video URL to clipboard
   */
  copyVideoUrl(url: string): void {
    this.copyToClipboard(url, 'Video URL');
  }

  /**
   * Generic clipboard copy with notification
   */
  private copyToClipboard(text: string, label: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          this.notificationService.toastOnly('success', `${label} Copied`, `${label} copied to clipboard`);
        })
        .catch(err => {
          this.notificationService.toastOnly('error', 'Copy Failed', `Failed to copy ${label.toLowerCase()}`);
          console.error('Clipboard error:', err);
        });
    } else {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();

      try {
        document.execCommand('copy');
        this.notificationService.toastOnly('success', `${label} Copied`, `${label} copied to clipboard`);
      } catch (err) {
        this.notificationService.toastOnly('error', 'Copy Failed', `Failed to copy ${label.toLowerCase()}`);
        console.error('Clipboard fallback error:', err);
      }

      document.body.removeChild(textArea);
    }
  }

  // ==================== File System Operations ====================

  /**
   * Open file location in system file manager
   */
  async openFileLocation(filePath: string): Promise<void> {
    try {
      const url = await this.backendUrlService.getApiUrl('/path/open-file-location');
      await firstValueFrom(this.http.post(url, { filePath }));
      this.notificationService.toastOnly('success', 'File Location Opened', 'File location opened in file manager');
    } catch (error: any) {
      console.error('Failed to open file location:', error);
      this.notificationService.toastOnly(
        'error',
        'Failed to Open Location',
        error.error?.message || 'Could not open file location'
      );
    }
  }

  // ==================== Utility Methods ====================

  /**
   * Format duration in seconds to human-readable string
   */
  formatDuration(seconds: number): string {
    if (!seconds || seconds < 0) return '--:--';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Format file size to human-readable string
   */
  formatFileSize(bytes: number): string {
    if (!bytes || bytes < 0) return '--';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Check if video has transcript
   */
  hasTranscript(video: DatabaseVideo): boolean {
    return !!video.has_transcript;
  }

  /**
   * Check if video has analysis
   */
  hasAnalysis(video: DatabaseVideo): boolean {
    return !!video.has_analysis;
  }

  /**
   * Get video completion status
   */
  getVideoStatus(video: DatabaseVideo): 'complete' | 'partial' | 'none' {
    const hasTranscript = this.hasTranscript(video);
    const hasAnalysis = this.hasAnalysis(video);

    if (hasTranscript && hasAnalysis) return 'complete';
    if (hasTranscript || hasAnalysis) return 'partial';
    return 'none';
  }
}
