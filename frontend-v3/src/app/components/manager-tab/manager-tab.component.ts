import { Component, signal, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CascadeComponent } from '../cascade/cascade.component';
import { IgnoreFileModalComponent } from '../ignore-file-modal/ignore-file-modal.component';
import { VideoWeek, VideoItem } from '../../models/video.model';
import { VideoManagerService, UnimportedVideo, MissingFile, DuplicateEntry } from '../../services/video-manager.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-manager-tab',
  standalone: true,
  imports: [CommonModule, CascadeComponent, IgnoreFileModalComponent],
  templateUrl: './manager-tab.component.html',
  styleUrls: ['./manager-tab.component.scss']
})
export class ManagerTabComponent {
  private videoManagerService = inject(VideoManagerService);
  private notificationService = inject(NotificationService);

  // Input: callback to refresh library after operations
  onLibraryRefresh = input<() => void>();

  // Scanning state
  isScanning = signal(false);
  scanningOperation = signal<'scanning' | 'importing' | 'relinking'>('scanning');
  scanResults = signal<{
    type: 'orphaned-files' | 'orphaned-entries' | 'duplicates';
    data: UnimportedVideo[] | MissingFile[] | DuplicateEntry[];
  } | null>(null);

  // Selection state
  managerSelectedIds = signal<Set<string>>(new Set());

  // Ignore file modal state
  ignoreFileModalOpen = signal(false);

  /**
   * Check if manager has results to display
   */
  hasManagerResults = computed(() => {
    const weeks = this.managerWeeks();
    return weeks.length > 0 && weeks[0].videos.length > 0;
  });

  /**
   * Computed property that converts scan results to VideoWeek format for cascade
   */
  managerWeeks = computed<VideoWeek[]>(() => {
    const results = this.scanResults();
    if (!results) {
      return [];
    }

    const videos: VideoItem[] = [];

    if (results.type === 'orphaned-files') {
      const data = results.data as UnimportedVideo[];
      videos.push(...data.map(file => {
        const isDuplicateContent = (file as any).isDuplicateContent;
        const duplicateOf = (file as any).duplicateOf;

        return {
          id: file.fullPath,
          name: file.filename,
          filePath: file.fullPath,
          tags: isDuplicateContent ? ['orphaned-file', 'duplicate-content'] : ['orphaned-file'],
          isDuplicate: isDuplicateContent,
          suggestedTitle: isDuplicateContent
            ? `⚠️ Duplicate of "${duplicateOf?.filename}" (consider deleting this file)`
            : undefined
        };
      }));
    } else if (results.type === 'orphaned-entries') {
      const data = results.data as MissingFile[];
      videos.push(...data.map(entry => ({
        id: entry.id,
        name: entry.filename,
        filePath: entry.current_path,
        uploadDate: entry.upload_date ? new Date(entry.upload_date) : undefined,
        downloadDate: entry.download_date ? new Date(entry.download_date) : undefined,
        tags: ['orphaned-entry']
      })));
    } else if (results.type === 'duplicates') {
      const data = results.data as any[];
      videos.push(...data.map(entry => ({
        id: entry.id,
        name: entry.filename,
        filePath: entry.current_path,
        uploadDate: entry.upload_date ? new Date(entry.upload_date) : undefined,
        downloadDate: entry.download_date ? new Date(entry.download_date) : undefined,
        tags: ['duplicate'],
        suggestedTitle: `Duplicate (${entry.duplicate_count} total copies of this file)`
      })));
    }

    return [{
      weekLabel: this.getScanTypeLabel(results.type),
      videos
    }];
  });

  /**
   * Get human-readable label for scan type
   */
  private getScanTypeLabel(type: string): string {
    switch (type) {
      case 'orphaned-files': return 'Orphaned Files (Not in Database)';
      case 'orphaned-entries': return 'Orphaned Entries (File Missing)';
      case 'duplicates': return 'Duplicate Entries';
      default: return 'Scan Results';
    }
  }

  /**
   * Get summary text for scan results
   */
  getScanResultSummary(): string {
    const results = this.scanResults();
    if (!results) return '';

    const count = this.managerWeeks()[0]?.videos.length || 0;

    switch (results.type) {
      case 'orphaned-files':
        return `Found ${count} file${count !== 1 ? 's' : ''} not in database`;
      case 'orphaned-entries':
        return `Found ${count} database entr${count !== 1 ? 'ies' : 'y'} with missing files`;
      case 'duplicates':
        return `Found ${count} duplicate entr${count !== 1 ? 'ies' : 'y'}`;
      default:
        return `Found ${count} item${count !== 1 ? 's' : ''}`;
    }
  }

  /**
   * Get loading message based on current operation
   */
  getLoadingMessage(): string {
    switch (this.scanningOperation()) {
      case 'importing':
        return 'Importing files...';
      case 'relinking':
        return 'Relinking entries...';
      default:
        return 'Scanning library...';
    }
  }

  /**
   * Scan for orphaned files (files on disk not in database)
   */
  scanOrphanedFiles() {
    this.scanningOperation.set('scanning');
    this.isScanning.set(true);
    this.videoManagerService.scanOrphanedFiles().subscribe({
      next: (response: any) => {
        if (response.success) {
          const data = response.data || response.videos || [];
          this.scanResults.set({
            type: 'orphaned-files',
            data
          });

          // Show notification about results
          if (data.length === 0) {
            this.notificationService.success('Scan Complete', 'No orphaned files found - all clear!');
          } else {
            this.notificationService.info('Scan Complete', `Found ${data.length} orphaned ${data.length === 1 ? 'file' : 'files'}`);
          }
        } else {
          this.notificationService.error('Scan Failed', response.error || 'Unknown error');
        }
        this.isScanning.set(false);
      },
      error: (error) => {
        this.notificationService.error('Scan Failed', error.error?.error || error.message);
        this.isScanning.set(false);
      }
    });
  }

  /**
   * Scan for orphaned database entries (entries with missing files)
   */
  scanOrphanedEntries() {
    this.scanningOperation.set('scanning');
    this.isScanning.set(true);
    this.videoManagerService.scanOrphanedEntries().subscribe({
      next: (response: any) => {
        if (response.success) {
          const data = response.data || response.videos || [];
          this.scanResults.set({
            type: 'orphaned-entries',
            data
          });

          // Show notification about results
          if (data.length === 0) {
            this.notificationService.success('Scan Complete', 'No orphaned entries found - all clear!');
          } else {
            this.notificationService.info('Scan Complete', `Found ${data.length} orphaned database ${data.length === 1 ? 'entry' : 'entries'}`);
          }
        } else {
          this.notificationService.error('Scan Failed', response.error || 'Unknown error');
        }
        this.isScanning.set(false);
      },
      error: (error) => {
        this.notificationService.error('Scan Failed', error.error?.error || error.message);
        this.isScanning.set(false);
      }
    });
  }

  /**
   * Scan for duplicate database entries
   */
  scanDuplicates() {
    this.scanningOperation.set('scanning');
    this.isScanning.set(true);
    this.videoManagerService.scanDuplicates().subscribe({
      next: (response: any) => {
        if (response.success) {
          const data = response.data || response.duplicateEntries || [];
          this.scanResults.set({
            type: 'duplicates',
            data
          });
        } else {
          console.error('Scan failed - response:', response);
          this.notificationService.error('Scan Failed', response.error || 'Unknown error');
        }
        this.isScanning.set(false);
      },
      error: (error) => {
        console.error('Scan failed - error:', error);
        this.notificationService.error('Scan Failed', error.error?.error || error.message);
        this.isScanning.set(false);
      }
    });
  }

  /**
   * Handle selection changes in manager tab
   */
  onSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.managerSelectedIds.set(event.ids);
  }

  /**
   * Handle actions in manager tab
   */
  onAction(event: { action: string; videos: VideoItem[] }) {
    const { action, videos } = event;
    const results = this.scanResults();
    if (!results) return;

    // Handle delete actions (simple delete or with mode)
    if (action === 'delete' || action.startsWith('delete:')) {
      this.deleteItems(videos, results.type);
      return;
    }

    switch (action) {
      case 'import':
        if (results.type === 'orphaned-files') {
          this.importOrphanedFiles(videos);
        }
        break;

      case 'relink':
        if (results.type === 'orphaned-entries') {
          this.relinkOrphanedEntries(videos);
        }
        break;

      case 'relinkWithFolder':
        if (results.type === 'orphaned-entries') {
          this.relinkOrphanedEntriesWithFolder(videos);
        }
        break;

      default:
        console.warn('Unknown manager action:', action);
    }
  }

  /**
   * Delete items from manager view
   */
  private deleteItems(videos: VideoItem[], scanType: string) {
    if (scanType === 'orphaned-files') {
      const filePaths = videos.map(v => v.filePath).filter(Boolean) as string[];
      this.videoManagerService.deleteUnimportedFiles(filePaths).subscribe({
        next: (response) => {
          if (response.success) {
            // Remove from display
            const currentResults = this.scanResults();
            if (currentResults && currentResults.type === 'orphaned-files') {
              const data = currentResults.data as UnimportedVideo[];
              const pathsToRemove = new Set(filePaths);
              const filtered = data.filter(item => !pathsToRemove.has(item.fullPath));
              this.scanResults.set({ ...currentResults, data: filtered });
            }
            this.notificationService.success('Deleted', `Deleted ${response.deletedCount || videos.length} file(s)`);
          } else {
            this.notificationService.error('Delete Failed', response.error || 'Unknown error');
          }
        },
        error: (error) => {
          console.error('Delete failed:', error);
          this.notificationService.error('Delete Failed', error.error?.error || error.message);
        }
      });
    } else {
      const videoIds = videos.map(v => v.id);
      this.videoManagerService.deleteOrphanedEntries(videoIds).subscribe({
        next: (response) => {
          if (response.success) {
            // Remove from display
            const currentResults = this.scanResults();
            if (currentResults) {
              const idsToRemove = new Set(videoIds);
              if (currentResults.type === 'orphaned-entries') {
                const data = currentResults.data as MissingFile[];
                const filtered = data.filter(item => !idsToRemove.has(item.id));
                this.scanResults.set({ ...currentResults, data: filtered });
              } else if (currentResults.type === 'duplicates') {
                const data = currentResults.data as any[];
                const filtered = data.filter(item => !idsToRemove.has(item.id));
                this.scanResults.set({ ...currentResults, data: filtered });
              }
            }
            this.notificationService.success('Removed', `Removed ${response.deletedCount || videos.length} database entr${videos.length !== 1 ? 'ies' : 'y'}`);
          } else {
            this.notificationService.error('Delete Failed', response.error || 'Unknown error');
          }
        },
        error: (error) => {
          console.error('Delete failed:', error);
          this.notificationService.error('Delete Failed', error.error?.error || error.message);
        }
      });
    }
  }

  /**
   * Import orphaned files into database
   */
  private importOrphanedFiles(videos: VideoItem[]) {
    const filePaths = videos.map(v => v.filePath).filter(Boolean) as string[];

    // Show importing status
    this.scanningOperation.set('importing');
    this.isScanning.set(true);

    this.videoManagerService.importFiles(filePaths).subscribe({
      next: (response) => {
        this.isScanning.set(false);

        if (response.success) {
          // Remove imported items from display
          const currentResults = this.scanResults();
          if (currentResults && currentResults.type === 'orphaned-files') {
            const data = currentResults.data as UnimportedVideo[];
            const pathsToRemove = new Set(filePaths);
            const filtered = data.filter(item => !pathsToRemove.has(item.fullPath));
            this.scanResults.set({ ...currentResults, data: filtered });
          }

          const importedCount = response.results?.filter((r: any) => r.success).length || filePaths.length;
          this.notificationService.success('Import Complete', `Successfully imported ${importedCount} file(s) into database`);

          // Trigger library refresh
          const refreshCallback = this.onLibraryRefresh();
          if (refreshCallback) {
            refreshCallback();
          }
        } else {
          console.error('Import failed - response:', response);
          this.notificationService.error('Import Failed', response.error || response.message || 'Unknown error');
        }
      },
      error: (error) => {
        this.isScanning.set(false);
        console.error('Import failed:', error);

        let errorMsg;
        if (error.status === 404) {
          errorMsg = 'API endpoint not found (404). Check backend logs.';
        } else {
          errorMsg = error.error?.error || error.error?.message || error.message || 'Unknown error';
        }
        this.notificationService.error('Import Failed', errorMsg);
      }
    });
  }

  /**
   * Attempt to relink orphaned database entries (auto-scan in library folders)
   */
  private relinkOrphanedEntries(videos: VideoItem[]) {
    const videoIds = videos.map(v => v.id);

    this.scanningOperation.set('relinking');
    this.isScanning.set(true);

    this.videoManagerService.relinkOrphanedEntries(videoIds, { autoScan: true }).subscribe({
      next: (response) => {
        this.isScanning.set(false);

        if (response.success) {
          // Remove relinked items from display
          const currentResults = this.scanResults();
          if (currentResults && currentResults.type === 'orphaned-entries') {
            const data = currentResults.data as MissingFile[];
            const idsToRemove = new Set(videoIds);
            const filtered = data.filter(item => !idsToRemove.has(item.id));
            this.scanResults.set({ ...currentResults, data: filtered });
          }
          this.notificationService.success('Relink Complete', `Relinked ${response.relinkedCount || 0} of ${videoIds.length} entr${videoIds.length !== 1 ? 'ies' : 'y'}`);

          // Trigger library refresh
          const refreshCallback = this.onLibraryRefresh();
          if (refreshCallback) {
            refreshCallback();
          }
        } else {
          this.notificationService.error('Relink Failed', response.error || 'Unknown error');
        }
      },
      error: (error) => {
        this.isScanning.set(false);
        console.error('Relink failed:', error);
        this.notificationService.error('Relink Failed', error.error?.error || error.message);
      }
    });
  }

  /**
   * Attempt to relink orphaned database entries by browsing for a folder
   */
  private async relinkOrphanedEntriesWithFolder(videos: VideoItem[]) {
    const videoIds = videos.map(v => v.id);

    try {
      // Use Electron's folder dialog
      const result = await (window as any).electron?.openFolder({
        properties: ['openDirectory'],
        title: 'Select folder to search for missing files'
      });

      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return; // User cancelled
      }

      const searchFolder = result.filePaths[0];

      this.scanningOperation.set('relinking');
      this.isScanning.set(true);

      this.videoManagerService.relinkOrphanedEntries(videoIds, { searchFolder }).subscribe({
        next: (response) => {
          this.isScanning.set(false);

          if (response.success) {
            // Remove relinked items from display
            const currentResults = this.scanResults();
            if (currentResults && currentResults.type === 'orphaned-entries') {
              const data = currentResults.data as MissingFile[];
              const idsToRemove = new Set(videoIds);
              const filtered = data.filter(item => !idsToRemove.has(item.id));
              this.scanResults.set({ ...currentResults, data: filtered });
            }
            this.notificationService.success('Relink Complete', `Relinked ${response.relinkedCount || 0} of ${videoIds.length} entr${videoIds.length !== 1 ? 'ies' : 'y'}`);

            // Trigger library refresh
            const refreshCallback = this.onLibraryRefresh();
            if (refreshCallback) {
              refreshCallback();
            }
          } else {
            this.notificationService.error('Relink Failed', response.error || 'Unknown error');
          }
        },
        error: (error) => {
          this.isScanning.set(false);
          console.error('Relink failed:', error);
          this.notificationService.error('Relink Failed', error.error?.error || error.message);
        }
      });
    } catch (error) {
      console.error('Failed to open folder dialog:', error);
      this.notificationService.error('Dialog Error', 'Failed to open folder picker. Make sure Electron IPC is available.');
    }
  }

  /**
   * Open the ignore file modal
   */
  openIgnoreFileModal() {
    this.ignoreFileModalOpen.set(true);
  }

  /**
   * Handle ignore file modal closed
   */
  onIgnoreFileModalClosed() {
    this.ignoreFileModalOpen.set(false);
  }
}
