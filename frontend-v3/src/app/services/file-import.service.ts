import { Injectable } from '@angular/core';
import { NotificationService } from './notification.service';

@Injectable({
  providedIn: 'root'
})
export class FileImportService {
  constructor(private notificationService: NotificationService) {}

  /**
   * Open Electron file dialog and return selected file paths
   */
  async openFileDialog(): Promise<string[] | null> {
    try {
      // Use Electron's file dialog which gives us file paths
      const result = await (window as any).electron?.openFiles({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Media Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'm4a', 'wav'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return null;
      }

      console.log('Selected files:', result.filePaths);
      return result.filePaths;
    } catch (error) {
      console.error('Failed to open file dialog:', error);
      console.error('Make sure Electron IPC is available');
      return null;
    }
  }

  /**
   * Get file paths from File objects using Electron's webUtils
   */
  async getFilePathsFromFiles(files: File[]): Promise<string[]> {
    const filePaths: string[] = [];

    try {
      for (const file of files) {
        const path = (window as any).electron?.getFilePathFromFile(file);
        if (path) {
          filePaths.push(path);
          console.log('Got file path:', path);
        }
      }

      if (filePaths.length === 0) {
        console.error('Could not get file paths from files');
      }

      return filePaths;
    } catch (error) {
      console.error('Error getting file paths:', error);
      return [];
    }
  }

  /**
   * Filter files to only include media files
   */
  filterMediaFiles(files: File[]): File[] {
    return files.filter(file =>
      file.type.startsWith('video/') || file.type.startsWith('audio/')
    );
  }

  /**
   * Import files by file path using Electron IPC
   * @param filePaths - Array of file paths to import
   * @param onSuccess - Callback to execute on successful import (e.g., refresh library)
   */
  async importFilesByPath(filePaths: string[], onSuccess?: () => void): Promise<void> {
    try {
      console.log('Importing files:', filePaths);

      // Use Electron IPC to import files
      const response = await (window as any).electron?.importFiles(filePaths);

      console.log('Import response:', response);

      if (response?.success) {
        // Execute success callback (e.g., reload library)
        if (onSuccess) {
          onSuccess();
        }

        const successCount = response.results?.filter((r: any) => r.success).length || 0;
        console.log(`✓ Successfully imported ${successCount} of ${filePaths.length} file(s)`);
      } else {
        console.error('Import failed:', response);
        if (response?.results) {
          response.results.forEach((r: any) => {
            if (!r.success) {
              console.error(`Failed to import ${r.filePath}: ${r.error}`);
            }
          });
        }
      }
    } catch (error: any) {
      console.error('Import error:', error);
    }
  }

  /**
   * Import files to library - copy to clips folder and scan into database
   */
  async importFilesToLibrary(files: File[], onSuccess?: () => void): Promise<void> {
    try {
      // Filter for media files
      const mediaFiles = this.filterMediaFiles(files);

      if (mediaFiles.length === 0) {
        this.notificationService.warning('No Media Files', 'No valid video or audio files found. Please select media files.');
        return;
      }

      if (mediaFiles.length !== files.length) {
        this.notificationService.info('Files Filtered', `Selected ${mediaFiles.length} media file(s) out of ${files.length} total files.`);
      }

      console.log('Importing files:', mediaFiles.map(f => f.name));

      // Get file paths from File objects using Electron's webUtils
      const filePaths = await this.getFilePathsFromFiles(mediaFiles);

      if (filePaths.length > 0) {
        await this.importFilesByPath(filePaths, onSuccess);
      } else {
        console.error('Could not get file paths from File objects');
      }
    } catch (error) {
      console.error('Import error:', error);
    }
  }
}
