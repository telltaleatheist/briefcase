import { Injectable } from '@angular/core';
import { Observable, from, throwError } from 'rxjs';
import { map, catchError, tap } from 'rxjs/operators';
import { DatabaseLibraryService, DatabaseVideo, BatchProgress } from './database-library.service';
import { NotificationService } from './notification.service';
import { MatDialog } from '@angular/material/dialog';

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

/**
 * VideoOperationsService
 *
 * Handles all video operations:
 * - Analyze (transcribe + AI analysis)
 * - Delete
 * - Rename
 * - Move to library
 * - Copy operations (filename, path)
 * - Open file location
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
    private dialog: MatDialog
  ) {}

  // Note: Most video operations are handled directly by DatabaseLibraryService
  // This service provides simplified wrappers for common operations

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
  openFileLocation(filePath: string): void {
    // This will need to use Electron IPC if in Electron, or backend API
    // Component should handle this directly via DatabaseLibraryService
    console.log('Opening file location:', filePath);
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
