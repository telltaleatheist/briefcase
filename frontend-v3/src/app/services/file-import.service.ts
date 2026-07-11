import { Injectable, inject } from '@angular/core';
import { NotificationService } from './notification.service';
import { ErrorSurface } from '../core/error-surface.service';

@Injectable({
  providedIn: 'root'
})
export class FileImportService {
  private notificationService = inject(NotificationService);
  private errorSurface = inject(ErrorSurface);

  /**
   * Open Electron file dialog and return selected file paths.
   * Returns null for user-cancel; IPC failure is surfaced (the Import
   * button must never silently do nothing — fallback-audit critical #5).
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
      this.errorSurface.surfaceError("Couldn't open the file picker", error);
      return null;
    }
  }

  /**
   * Validate a file path resolved by webUtils.getPathForFile().
   *
   * For certain File objects (clipboard paste, drag from a webpage, some
   * Finder operations) webUtils.getPathForFile() returns a transient
   * Chromium temp path (e.g. .org.chromium.Chromium.XXXXXX) instead of a
   * real on-disk path. These files disappear shortly after the drop, so
   * any import that stores them will later surface as an ENOENT error.
   * Reject them here so we can show the user a friendly warning.
   */
  private isValidFilePath(p: string): boolean {
    if (!p) return false;
    if (/\.org\.chromium\.Chromium\./.test(p)) return false;
    if (/[\\/](Caches|Temporary Items)[\\/]/.test(p)) return false;
    return true;
  }

  /**
   * Get file paths from File objects using Electron's webUtils.
   * Rejects transient Chromium temp paths and warns the user about
   * unsupported sources.
   */
  async getFilePathsFromFiles(files: File[]): Promise<string[]> {
    const filePaths: string[] = [];
    let rejected = 0;

    try {
      for (const file of files) {
        const path = (window as any).electron?.getFilePathFromFile(file);
        if (!path) continue;

        if (!this.isValidFilePath(path)) {
          console.warn('Rejecting transient file path:', path);
          rejected++;
          continue;
        }

        filePaths.push(path);
        console.log('Got file path:', path);
      }

      if (rejected > 0) {
        this.notificationService.warning(
          'Unsupported source',
          'This file cannot be imported directly. Please drag it from a Finder window.'
        );
      }

      if (filePaths.length === 0 && rejected === 0 && files.length > 0) {
        // Not transient-source rejection, not an exception — the resolver
        // just produced nothing. Surface it; the drop must not silently no-op.
        this.notificationService.error(
          'Import failed',
          "Couldn't resolve file paths for the dropped items.",
          true
        );
      }

      return filePaths;
    } catch (error) {
      this.errorSurface.surfaceError("Couldn't read the dropped files", error);
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

      const results: { filePath: string; success: boolean; error?: string }[] =
        response?.results ?? [];
      const failures = results.filter(r => !r.success);
      const successCount = results.filter(r => r.success).length;

      if (response?.success && failures.length === 0) {
        onSuccess?.();
        console.log(`✓ Successfully imported ${successCount} of ${filePaths.length} file(s)`);
        return;
      }

      // Partial or total failure: the user dragged files in — tell them
      // exactly which ones didn't make it (fallback-audit critical #5).
      if (successCount > 0) {
        onSuccess?.(); // some files did land; refresh for those
      }
      const failureList = failures
        .map(f => `${basename(f.filePath)}: ${f.error ?? 'unknown error'}`)
        .join('\n');
      this.notificationService.error(
        failures.length > 0
          ? `${failures.length} of ${filePaths.length} file(s) failed to import`
          : 'Import failed',
        failureList || 'The import request failed — see the log for details.',
        true
      );
      console.error('Import failures:', response);
    } catch (error) {
      this.errorSurface.surfaceError('Import failed', error);
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
      }
      // Empty result: getFilePathsFromFiles has already notified for every
      // failure mode (transient-source warning, resolver-empty error, or a
      // surfaced exception) — nothing silent left to cover here.
    } catch (error) {
      this.errorSurface.surfaceError('Import failed', error);
    }
  }
}

/** Last path segment for readable per-file failure lists. */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}
