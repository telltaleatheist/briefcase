import { Component, OnInit, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { DatabaseLibraryService, DatabaseVideo } from '../../services/database-library.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { VideoOperationsService } from '../../services/video-operations.service';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import { ListItem, ItemDisplayConfig, ContextMenuAction } from '../../libs/cascade/src/lib/types/cascade.types';

export interface UnimportedVideo {
  filename: string;
  fullPath: string;
  fileSize: number;
  fileType: string;
  created: string;
  modified: string;
  isDuplicateContent?: boolean;
  duplicateOf?: {
    id: string;
    filename: string;
    current_path: string;
    file_exists: boolean;
  };
}

/**
 * LibraryManagementComponent
 *
 * Manages orphaned files and database entries:
 * - Orphaned Files: Files in clips folder not in database
 * - Orphaned Database Entries: Database entries with missing files
 */
@Component({
  selector: 'app-library-management',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatMenuModule,
    MatDialogModule,
    MatSnackBarModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    CascadeListComponent
  ],
  templateUrl: './library-management.component.html',
  styleUrls: ['./library-management.component.scss']
})
export class LibraryManagementComponent implements OnInit {
  managementMode: 'unimported' | 'orphaned' | 'scan' = 'orphaned';

  // Unimported videos
  unimportedVideos: UnimportedVideo[] = [];
  loadingUnimported = false;
  selectedUnimportedVideos = new Set<string>(); // Set of file paths
  isAllUnimportedSelected = false;
  highlightedUnimportedVideo: UnimportedVideo | null = null;
  unimportedMatchesFound = 0;
  unimportedFilter: 'all' | 'duplicates' | 'new' = 'all';

  // Ignore file
  ignoreFileContent = '';
  ignoreFilePath = '';
  loadingIgnoreFile = false;
  scanningIgnored = false;

  // Duplicate entries
  duplicateEntries: DatabaseVideo[] = [];
  loadingDuplicates = false;
  selectedDuplicateEntries = new Set<string>(); // Set of video IDs to delete
  isAllDuplicatesSelected = false;
  highlightedDuplicateEntry: DatabaseVideo | null = null;

  // Orphaned videos
  orphanedVideos: DatabaseVideo[] = [];
  loadingOrphaned = false;
  selectedOrphanedVideos = new Set<string>(); // Set of video IDs
  isAllOrphanedSelected = false;
  highlightedOrphanedVideo: DatabaseVideo | null = null;
  orphanedMatchesFound = 0;

  // Context menu
  managementContextMenuPosition = { x: 0, y: 0 };

  // Unimported videos display config
  unimportedVideosDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'fullPath',
    metadataField: 'fileSize',
    iconField: 'fileType'
  };

  unimportedVideosContextMenuActions: ContextMenuAction[] = [
    { id: 'import', label: 'Import to Database', icon: 'add_to_photos' },
    { id: 'force-import', label: 'Force Import (Even if Duplicate)', icon: 'add_circle' },
    { id: 'show-duplicate', label: 'Show Duplicate Info', icon: 'info' },
    { id: 'ignore', label: 'Add to Ignore List', icon: 'block' },
    { id: 'open-location', label: 'Open File Location', icon: 'folder_open' },
    { id: 'delete', label: 'Delete File', icon: 'delete' }
  ];

  // Orphaned videos display config
  orphanedVideosDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'current_path',
    metadataField: 'duration_seconds',
    iconField: 'media_type'
  };

  orphanedVideosContextMenuActions: ContextMenuAction[] = [
    { id: 'relink', label: 'Relink to File', icon: 'link' },
    { id: 'open-location', label: 'Open File Location', icon: 'folder_open' },
    { id: 'delete', label: 'Delete from Database', icon: 'delete' }
  ];

  // Duplicate entries display config
  duplicateEntriesDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'current_path',
    metadataField: 'duration_seconds',
    iconField: 'media_type'
  };

  duplicateEntriesContextMenuActions: ContextMenuAction[] = [
    { id: 'open-location', label: 'Open File Location', icon: 'folder_open' },
    { id: 'delete', label: 'Delete from Database', icon: 'delete' }
  ];

  constructor(
    private router: Router,
    private databaseLibraryService: DatabaseLibraryService,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    public videoOperationsService: VideoOperationsService,
    private dialog: MatDialog,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit() {
    // Load orphaned videos by default
    this.loadOrphanedVideos();

    // Load ignore file
    this.loadIgnoreFile();
  }

  /**
   * Handle tab change
   */
  onManagementTabChange(event: any) {
    // Tab 0: Orphaned Files, Tab 1: Orphaned Database Entries
    if (event.index === 0) {
      this.managementMode = 'unimported';
      this.loadUnimportedVideos();
    } else {
      this.managementMode = 'orphaned';
      this.loadOrphanedVideos();
    }
  }

  // ==================== Orphaned Videos Methods ====================

  /**
   * Load orphaned videos (files that don't exist)
   */
  async loadOrphanedVideos() {
    this.loadingOrphaned = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/missing-files');
      const response = await fetch(url);
      const data: {
        success: boolean;
        count: number;
        videos: DatabaseVideo[];
        matchesFound?: number;
      } = await response.json();

      if (data.success) {
        this.orphanedVideos = data.videos;
        this.orphanedMatchesFound = data.matchesFound || 0;
        console.log(`Found ${data.count} missing files (${this.orphanedMatchesFound} have potential matches)`);
        console.log('Sample missing file:', this.orphanedVideos[0]);
      } else {
        console.error('Failed to load missing files:', data);
        this.orphanedVideos = [];
        this.orphanedMatchesFound = 0;
      }
      this.selectedOrphanedVideos.clear();
    } catch (error) {
      console.error('Failed to load orphaned videos:', error);
      this.snackBar.open('Failed to load orphaned videos', 'Close', { duration: 3000 });
      this.orphanedVideos = [];
    } finally {
      this.loadingOrphaned = false;
    }
  }

  /**
   * Toggle selection of an orphaned video
   */
  toggleOrphanedVideo(videoId: string) {
    if (this.selectedOrphanedVideos.has(videoId)) {
      this.selectedOrphanedVideos.delete(videoId);
    } else {
      this.selectedOrphanedVideos.add(videoId);
    }
    this.updateOrphanedSelectionState();
  }

  /**
   * Toggle all orphaned videos selection
   */
  toggleAllOrphanedSelection() {
    if (this.isAllOrphanedSelected) {
      this.selectedOrphanedVideos.clear();
    } else {
      this.orphanedVideos.forEach(v => this.selectedOrphanedVideos.add(v.id));
    }
    this.updateOrphanedSelectionState();
  }

  /**
   * Update orphaned selection state
   */
  private updateOrphanedSelectionState() {
    this.isAllOrphanedSelected = this.orphanedVideos.length > 0 &&
      this.orphanedVideos.every(v => this.selectedOrphanedVideos.has(v.id));
  }

  /**
   * Relink selected orphaned videos
   */
  async relinkSelectedOrphanedVideos() {
    await this.relinkOrphanedVideos();
  }

  /**
   * Automatically relink all orphaned videos that have matches
   */
  async relinkMatchedOrphanedVideos() {
    const matchedVideos = this.orphanedVideos.filter((v: any) => v.has_match);

    if (matchedVideos.length === 0) {
      this.notificationService.toastOnly('info', 'No Matches', 'No videos with automatic matches found');
      return;
    }

    const confirmed = confirm(
      `Found ${matchedVideos.length} video${matchedVideos.length !== 1 ? 's' : ''} with matching files in the library folder.\n\n` +
      'Would you like to automatically relink them?'
    );

    if (!confirmed) return;

    try {
      const videoIds = matchedVideos.map((v: any) => v.id);

      // Get the library info to get the clips folder path
      const libraryInfoUrl = await this.backendUrlService.getApiUrl('/database/libraries/active');
      const libraryInfoResponse = await fetch(libraryInfoUrl);
      const libraryInfo = await libraryInfoResponse.json();

      if (!libraryInfo.library?.clipsFolderPath) {
        this.notificationService.toastOnly('error', 'Error', 'Could not determine library folder path');
        return;
      }

      const url = await this.backendUrlService.getApiUrl('/database/relink');

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoIds,
          searchFolder: libraryInfo.library.clipsFolderPath
        })
      });

      const result = await response.json();

      if (result.success) {
        this.notificationService.toastOnly(
          'success',
          'Relink Complete',
          `${result.relinkedCount} video(s) relinked successfully`
        );

        await this.loadOrphanedVideos();
      } else {
        this.notificationService.toastOnly('error', 'Relink Failed', result.message || 'Failed to relink videos');
      }
    } catch (error) {
      console.error('Failed to relink matched videos:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to relink matched videos');
    }
  }

  /**
   * Relink orphaned videos
   */
  async relinkOrphanedVideos() {
    if (this.selectedOrphanedVideos.size === 0) {
      this.notificationService.toastOnly('info', 'No Selection', 'Please select videos to relink');
      return;
    }

    try {
      const selectedIds = Array.from(this.selectedOrphanedVideos);

      // Get the library info to get the clips folder path
      const libraryInfoUrl = await this.backendUrlService.getApiUrl('/database/libraries/active');
      const libraryInfoResponse = await fetch(libraryInfoUrl);
      const libraryInfo = await libraryInfoResponse.json();

      if (!libraryInfo.library?.clipsFolderPath) {
        this.notificationService.toastOnly('error', 'Error', 'Could not determine library folder path');
        return;
      }

      const url = await this.backendUrlService.getApiUrl('/database/relink');

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoIds: selectedIds,
          searchFolder: libraryInfo.library.clipsFolderPath
        })
      });

      const result = await response.json();

      if (result.success) {
        this.notificationService.toastOnly(
          'success',
          'Relink Complete',
          `${result.relinkedCount} video(s) relinked successfully`
        );

        this.selectedOrphanedVideos.clear();
        await this.loadOrphanedVideos();
      } else {
        this.notificationService.toastOnly('error', 'Relink Failed', result.message || 'Failed to relink videos');
      }
    } catch (error) {
      console.error('Failed to relink videos:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to relink videos');
    }
  }

  /**
   * Delete selected orphaned videos
   */
  async deleteSelectedOrphanedVideos() {
    if (this.selectedOrphanedVideos.size === 0) return;

    const entryCount = this.selectedOrphanedVideos.size;

    // Show confirmation dialog
    const dialogRef = this.dialog.open(OrphanedDeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: entryCount,
        videoName: entryCount === 1 ? this.orphanedVideos.find(v => this.selectedOrphanedVideos.has(v.id))?.filename : null
      }
    });

    const result = await dialogRef.afterClosed().toPromise();
    if (!result) return;

    const selectedIds = Array.from(this.selectedOrphanedVideos);

    try {
      // Delete from database only (files are already missing)
      await this.databaseLibraryService.deleteVideoBatch(selectedIds, false);

      this.notificationService.toastOnly(
        'success',
        'Entries Deleted',
        `${entryCount} database entr${entryCount !== 1 ? 'ies' : 'y'} removed`
      );

      this.selectedOrphanedVideos.clear();
      await this.loadOrphanedVideos();
    } catch (error) {
      console.error('Failed to delete entries:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to delete database entries');
    }
  }

  /**
   * Prune all orphaned videos
   */
  async pruneAllOrphanedVideos() {
    if (this.orphanedVideos.length === 0) return;

    const confirmed = confirm(
      `Are you sure you want to permanently delete ${this.orphanedVideos.length} orphaned database entr${this.orphanedVideos.length !== 1 ? 'ies' : 'y'}?\n\n` +
      'This action cannot be undone.\n\n' +
      'Database entries will be removed, but no files will be deleted.'
    );

    if (!confirmed) return;

    try {
      await this.databaseLibraryService.pruneOrphanedVideos();

      this.notificationService.toastOnly(
        'success',
        'Prune Complete',
        `${this.orphanedVideos.length} entries removed`
      );

      this.orphanedVideos = [];
      this.selectedOrphanedVideos.clear();
    } catch (error) {
      console.error('Failed to prune orphaned entries:', error);
      this.snackBar.open('Failed to prune orphaned entries', 'Close', { duration: 3000 });
    }
  }

  // ==================== Unimported Videos Methods ====================

  /**
   * Load unimported videos from clips folder
   */
  async loadUnimportedVideos() {
    if (!this.backendUrlService) {
      this.unimportedVideos = [];
      return;
    }

    this.loadingUnimported = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/unimported');
      const response = await fetch(url);
      const data: {
        success: boolean;
        count: number;
        videos: UnimportedVideo[];
        matchesFound?: number;
      } = await response.json();

      if (data.success) {
        this.unimportedVideos = data.videos;
        this.unimportedMatchesFound = data.matchesFound || 0;
        console.log(`Found ${data.count} unimported videos (${this.unimportedMatchesFound} have potential database matches)`);
        console.log('Sample video:', this.unimportedVideos[0]);
        console.log('Unimported videos as list items:', this.unimportedVideosAsListItems.slice(0, 3));
      } else {
        console.error('Failed to load unimported videos:', data);
        this.unimportedVideos = [];
        this.unimportedMatchesFound = 0;
      }
    } catch (error) {
      console.error('Failed to load unimported videos:', error);
      this.unimportedVideos = [];
    } finally {
      this.loadingUnimported = false;
    }
  }

  /**
   * Toggle unimported video selection
   */
  toggleUnimportedVideo(videoPath: string) {
    if (this.selectedUnimportedVideos.has(videoPath)) {
      this.selectedUnimportedVideos.delete(videoPath);
    } else {
      this.selectedUnimportedVideos.add(videoPath);
    }
    this.updateUnimportedSelectionState();
  }

  /**
   * Toggle all unimported selection
   */
  toggleAllUnimportedSelection() {
    if (this.isAllUnimportedSelected) {
      this.selectedUnimportedVideos.clear();
      this.isAllUnimportedSelected = false;
    } else {
      this.unimportedVideos.forEach(video => this.selectedUnimportedVideos.add(video.fullPath));
      this.isAllUnimportedSelected = true;
    }
  }

  /**
   * Update unimported selection state
   */
  private updateUnimportedSelectionState() {
    this.isAllUnimportedSelected = this.unimportedVideos.length > 0 &&
      this.unimportedVideos.every(video => this.selectedUnimportedVideos.has(video.fullPath));
  }

  /**
   * Import selected unimported videos
   */
  async importSelectedUnimportedVideos(forceImport: boolean = false) {
    console.log('[LibraryManagement] importSelectedUnimportedVideos called');
    console.log('[LibraryManagement] Selected videos:', this.selectedUnimportedVideos);
    console.log('[LibraryManagement] Force import:', forceImport);

    if (this.selectedUnimportedVideos.size === 0) {
      this.notificationService.toastOnly('info', 'No Selection', 'Please select files to import');
      return;
    }

    const videoPaths = Array.from(this.selectedUnimportedVideos);
    console.log('[LibraryManagement] Video paths to import:', videoPaths);

    try {
      const url = await this.backendUrlService.getApiUrl('/database/import');
      console.log('[LibraryManagement] Import URL:', url);

      // Build duplicate handling map if force importing
      const duplicateHandling: { [key: string]: 'skip' | 'replace' | 'keep-both' } = {};
      if (forceImport) {
        videoPaths.forEach(path => {
          duplicateHandling[path] = 'keep-both';
        });
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPaths,
          ...(forceImport ? { duplicateHandling } : {})
        })
      });

      console.log('[LibraryManagement] Response status:', response.status);

      const result = await response.json();
      console.log('[LibraryManagement] Import result:', result);

      if (result.success) {
        const message = `Imported ${result.importedCount} video(s)` +
          (result.skippedCount > 0 ? `, skipped ${result.skippedCount}` : '') +
          (result.errorCount > 0 ? `, ${result.errorCount} error(s)` : '');

        this.notificationService.toastOnly('success', 'Import Complete', message);

        // Log details if there were errors
        if (result.errors && result.errors.length > 0) {
          console.error('Import errors:', result.errors);
        }

        this.selectedUnimportedVideos.clear();
        this.updateUnimportedSelectionState();
        await this.loadUnimportedVideos();
      } else {
        this.notificationService.toastOnly('error', 'Import Failed', result.error || 'Failed to import videos');
      }
    } catch (error) {
      console.error('[LibraryManagement] Failed to import videos:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to import videos');
    }
  }

  /**
   * Delete selected unimported videos
   */
  async deleteSelectedUnimportedVideos() {
    if (this.selectedUnimportedVideos.size === 0) return;

    const fileCount = this.selectedUnimportedVideos.size;
    const confirmed = confirm(
      `Are you sure you want to delete ${fileCount} file${fileCount !== 1 ? 's' : ''}?\n\n` +
      'This action cannot be undone.\n\n' +
      'Files will be permanently deleted from disk.'
    );

    if (!confirmed) return;

    try {
      const filePaths = Array.from(this.selectedUnimportedVideos);
      const deleteUrl = await this.backendUrlService.getApiUrl('/database/delete-unimported-files');

      const response = await fetch(deleteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths })
      });

      const result = await response.json();

      if (result.success) {
        this.notificationService.toastOnly('success', 'Files Deleted', result.message);

        this.selectedUnimportedVideos.clear();
        this.updateUnimportedSelectionState();

        // Reload the unimported videos list
        await this.loadUnimportedVideos();
      } else {
        this.notificationService.toastOnly('error', 'Delete Failed', result.message || 'Failed to delete files');
      }
    } catch (error) {
      console.error('Failed to delete files:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to delete files');
    }
  }

  // ==================== List Item Conversions ====================

  /**
   * Get filtered unimported videos based on current filter
   */
  get filteredUnimportedVideos(): UnimportedVideo[] {
    switch (this.unimportedFilter) {
      case 'duplicates':
        return this.unimportedVideos.filter(v => v.isDuplicateContent);
      case 'new':
        return this.unimportedVideos.filter(v => !v.isDuplicateContent);
      default:
        return this.unimportedVideos;
    }
  }

  /**
   * Get count of duplicate and new files
   */
  get unimportedDuplicateCount(): number {
    return this.unimportedVideos.filter(v => v.isDuplicateContent).length;
  }

  get unimportedNewCount(): number {
    return this.unimportedVideos.filter(v => !v.isDuplicateContent).length;
  }

  /**
   * Convert unimported videos to ListItem format for cascade-list
   */
  get unimportedVideosAsListItems(): (UnimportedVideo & ListItem)[] {
    return this.filteredUnimportedVideos.map(video => ({
      ...video,
      id: video.fullPath,
      customClass: video.isDuplicateContent ? 'duplicate-content' : undefined,
      badge: video.isDuplicateContent ? 'DUPLICATE' : undefined,
      badgeColor: video.isDuplicateContent ? '#f44336' : undefined
    })) as (UnimportedVideo & ListItem)[];
  }

  /**
   * Set unimported filter
   */
  setUnimportedFilter(filter: 'all' | 'duplicates' | 'new') {
    this.unimportedFilter = filter;
    this.selectedUnimportedVideos.clear();
    this.updateUnimportedSelectionState();
  }

  /**
   * Convert orphaned videos to ListItem format for cascade-list
   */
  get orphanedVideosAsListItems(): (DatabaseVideo & ListItem)[] {
    // Orphaned videos already have an 'id' property from DatabaseVideo
    return this.orphanedVideos as (DatabaseVideo & ListItem)[];
  }

  /**
   * Selected unimported videos as Set for cascade-list
   */
  get selectedUnimportedVideosSet(): Set<string> {
    return this.selectedUnimportedVideos;
  }

  /**
   * Selected orphaned videos as Set for cascade-list
   */
  get selectedOrphanedVideosSet(): Set<string> {
    return this.selectedOrphanedVideos;
  }

  // ==================== Event Handlers ====================

  /**
   * Handle unimported videos selection
   */
  onUnimportedVideosSelected(videos: UnimportedVideo[]) {
    videos.forEach(v => this.selectedUnimportedVideos.add(v.fullPath));
    this.updateUnimportedSelectionState();
  }

  /**
   * Handle unimported videos deselection
   */
  onUnimportedVideosDeselected(videos: UnimportedVideo[]) {
    videos.forEach(v => {
      this.selectedUnimportedVideos.delete(v.fullPath);
      // Clear highlighted if deselected
      if (this.highlightedUnimportedVideo?.fullPath === v.fullPath) {
        this.highlightedUnimportedVideo = null;
      }
    });
    this.updateUnimportedSelectionState();
  }

  /**
   * Handle unimported videos context menu actions
   */
  onUnimportedContextMenuAction(event: { action: string; items: UnimportedVideo[] }) {
    console.log('Unimported context menu action:', event.action, event.items);

    // Update selection to match clicked items
    if (event.action === 'import' || event.action === 'force-import' || event.action === 'delete' || event.action === 'ignore') {
      if (event.items.length === 1 && !this.selectedUnimportedVideos.has(event.items[0].fullPath)) {
        this.selectedUnimportedVideos.clear();
        this.selectedUnimportedVideos.add(event.items[0].fullPath);
        this.updateUnimportedSelectionState();
      } else {
        // Multiple items or items already selected
        this.selectedUnimportedVideos.clear();
        event.items.forEach(item => this.selectedUnimportedVideos.add(item.fullPath));
        this.updateUnimportedSelectionState();
      }
    }

    switch (event.action) {
      case 'import':
        this.importSelectedUnimportedVideos(false);
        break;
      case 'force-import':
        this.importSelectedUnimportedVideos(true);
        break;
      case 'show-duplicate':
        if (event.items.length > 0) {
          this.showDuplicateInfo(event.items[0]);
        }
        break;
      case 'ignore':
        // Add selected files to ignore list
        if (event.items.length > 0) {
          event.items.forEach(item => {
            this.addToIgnoreList(item.filename);
          });
        }
        break;
      case 'open-location':
        // Open file location for the first selected item
        if (event.items.length > 0) {
          this.videoOperationsService.openFileLocation(event.items[0].fullPath);
        }
        break;
      case 'delete':
        this.deleteSelectedUnimportedVideos();
        break;
    }
  }

  /**
   * Show duplicate information for an unimported video
   */
  async showDuplicateInfo(video: UnimportedVideo) {
    if (!video.isDuplicateContent || !video.duplicateOf) {
      this.snackBar.open('This file is not a duplicate', 'Close', { duration: 2000 });
      return;
    }

    const duplicate = video.duplicateOf;
    const isSamePath = duplicate.current_path === video.fullPath;

    let message = `This file is flagged as a duplicate of a database entry:\n\n` +
      `Database Entry ID: ${duplicate.id}\n` +
      `Filename: ${duplicate.filename}\n` +
      `Path: ${duplicate.current_path}\n` +
      `File exists: ${duplicate.file_exists ? 'Yes' : 'No'}\n\n`;

    if (isSamePath) {
      message += `⚠️ WARNING: The database entry points to this same file!\n` +
        `This means there's a "phantom" database entry that's not visible in your library.\n\n` +
        `Would you like to delete this phantom database entry?\n` +
        `(This will NOT delete the file, only the hidden database entry)`;

      const deletePhantom = confirm(message);
      if (deletePhantom) {
        await this.deletePhantomEntry(duplicate.id);
      }
    } else {
      message += `Both files have identical content.`;
      alert(message);
    }
  }

  /**
   * Delete a phantom database entry
   */
  async deletePhantomEntry(videoId: string) {
    try {
      await this.databaseLibraryService.deleteVideoBatch([videoId], false);
      this.notificationService.toastOnly('success', 'Phantom Entry Deleted', 'The hidden database entry has been removed');

      // Reload orphaned files
      await this.loadUnimportedVideos();
    } catch (error) {
      console.error('Failed to delete phantom entry:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to delete phantom entry');
    }
  }

  /**
   * Handle orphaned videos selection
   */
  onOrphanedVideosSelected(videos: DatabaseVideo[]) {
    videos.forEach(v => this.selectedOrphanedVideos.add(v.id));
    this.updateOrphanedSelectionState();
  }

  /**
   * Handle orphaned videos deselection
   */
  onOrphanedVideosDeselected(videos: DatabaseVideo[]) {
    videos.forEach(v => {
      this.selectedOrphanedVideos.delete(v.id);
      // Clear highlighted if deselected
      if (this.highlightedOrphanedVideo?.id === v.id) {
        this.highlightedOrphanedVideo = null;
      }
    });
    this.updateOrphanedSelectionState();
  }

  /**
   * Handle orphaned videos context menu actions
   */
  onOrphanedContextMenuAction(event: { action: string; items: DatabaseVideo[] }) {
    console.log('Orphaned context menu action:', event.action, event.items);

    // Update selection to match clicked items
    if (event.action === 'relink' || event.action === 'delete') {
      if (event.items.length === 1 && !this.selectedOrphanedVideos.has(event.items[0].id)) {
        this.selectedOrphanedVideos.clear();
        this.selectedOrphanedVideos.add(event.items[0].id);
        this.updateOrphanedSelectionState();
      } else {
        // Multiple items or items already selected
        this.selectedOrphanedVideos.clear();
        event.items.forEach(item => this.selectedOrphanedVideos.add(item.id));
        this.updateOrphanedSelectionState();
      }
    }

    switch (event.action) {
      case 'relink':
        this.relinkOrphanedVideos();
        break;
      case 'open-location':
        // Open file location for the first selected item
        if (event.items.length > 0 && event.items[0].current_path) {
          this.videoOperationsService.openFileLocation(event.items[0].current_path);
        }
        break;
      case 'delete':
        this.deleteSelectedOrphanedVideos();
        break;
    }
  }

  /**
   * Handle unimported video click
   */
  onUnimportedItemClick(video: UnimportedVideo) {
    this.highlightedUnimportedVideo = video;
  }

  /**
   * Handle unimported video double click
   */
  onUnimportedItemDoubleClick(video: UnimportedVideo) {
    // Open import dialog for this file
    this.selectedUnimportedVideos.clear();
    this.selectedUnimportedVideos.add(video.fullPath);
    this.importSelectedUnimportedVideos();
  }

  /**
   * Handle unimported video highlighted
   */
  onUnimportedItemHighlighted(video: UnimportedVideo | null) {
    this.highlightedUnimportedVideo = video;
  }

  /**
   * Handle unimported delete action
   */
  onUnimportedDeleteAction(videos: UnimportedVideo[]) {
    // Triggered by delete key
    console.log('Delete unimported videos:', videos);
  }

  /**
   * Handle orphaned video click
   */
  onOrphanedItemClick(video: DatabaseVideo) {
    this.highlightedOrphanedVideo = video;
  }

  /**
   * Handle orphaned video double click
   */
  onOrphanedItemDoubleClick(video: DatabaseVideo) {
    // Could open video details or relink dialog
    console.log('Double clicked orphaned video:', video);
  }

  /**
   * Handle orphaned video highlighted
   */
  onOrphanedItemHighlighted(video: DatabaseVideo | null) {
    this.highlightedOrphanedVideo = video;
  }

  /**
   * Handle orphaned delete action
   */
  onOrphanedDeleteAction(videos: DatabaseVideo[]) {
    // Triggered by delete key
    console.log('Delete orphaned videos:', videos);
  }

  /**
   * Handle management view click
   */
  onManagementViewClick(event: MouseEvent) {
    // Could clear selection or handle other click events
  }

  /**
   * Handle management view right click
   */
  onManagementViewRightClick(event: MouseEvent) {
    event.preventDefault();
    // Could show context menu
  }

  /**
   * Load the .clippyignore file
   */
  async loadIgnoreFile() {
    this.loadingIgnoreFile = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/ignore');
      const response = await fetch(url);
      const data = await response.json();

      if (data.success) {
        this.ignoreFileContent = data.content || '';
        this.ignoreFilePath = data.filePath || '';
        console.log('Loaded .clippyignore file');
      } else {
        console.error('Failed to load ignore file:', data.error);
        this.snackBar.open('Failed to load ignore file', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to load ignore file:', error);
      this.snackBar.open('Failed to load ignore file', 'Close', { duration: 3000 });
    } finally {
      this.loadingIgnoreFile = false;
    }
  }

  /**
   * Save the .clippyignore file
   */
  async saveIgnoreFile() {
    this.loadingIgnoreFile = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/ignore');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: this.ignoreFileContent })
      });

      const data = await response.json();

      if (data.success) {
        this.snackBar.open('Ignore file saved successfully', 'Close', { duration: 2000 });
        console.log('Saved .clippyignore file');
      } else {
        console.error('Failed to save ignore file:', data.error);
        this.snackBar.open('Failed to save ignore file', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to save ignore file:', error);
      this.snackBar.open('Failed to save ignore file', 'Close', { duration: 3000 });
    } finally {
      this.loadingIgnoreFile = false;
    }
  }

  /**
   * Add filename to ignore list
   */
  async addToIgnoreList(filename: string) {
    try {
      const url = await this.backendUrlService.getApiUrl('/database/ignore/add');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: filename })
      });

      const data = await response.json();

      if (data.success) {
        this.snackBar.open(`Added "${filename}" to ignore list`, 'Close', { duration: 2000 });
        console.log('Added pattern to .clippyignore:', filename);

        // Reload ignore file content to update the Ignore File tab
        await this.loadIgnoreFile();

        // Reload unimported videos to reflect changes
        await this.loadUnimportedVideos();
      } else {
        console.error('Failed to add pattern:', data.error);
        this.snackBar.open('Failed to add to ignore list', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to add to ignore list:', error);
      this.snackBar.open('Failed to add to ignore list', 'Close', { duration: 3000 });
    }
  }

  /**
   * Scan and remove files from database that match ignore patterns
   */
  async scanAndRemoveIgnored() {
    const confirmed = confirm(
      'This will scan the database for entries matching ignore patterns and remove them.\n\n' +
      'Are you sure you want to continue?'
    );

    if (!confirmed) return;

    this.scanningIgnored = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/scan-ignored');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();

      if (data.success) {
        this.snackBar.open(data.message, 'Close', { duration: 3000 });
        console.log('Scan ignored result:', data);
      } else {
        console.error('Failed to scan ignored:', data.error);
        this.snackBar.open('Failed to scan ignored files', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to scan ignored:', error);
      this.snackBar.open('Failed to scan ignored files', 'Close', { duration: 3000 });
    } finally {
      this.scanningIgnored = false;
    }
  }

  /**
   * Scan for duplicate database entries
   */
  async scanDuplicateEntries() {
    this.loadingDuplicates = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/duplicate-entries');
      const response = await fetch(url);
      const data = await response.json();

      if (data.success) {
        this.duplicateEntries = data.duplicateEntries;
        console.log(`Found ${data.pathsWithDuplicates} paths with duplicates (${data.totalDuplicates} duplicate entries)`);

        if (data.totalDuplicates === 0) {
          this.snackBar.open('No duplicate entries found', 'Close', { duration: 2000 });
        } else {
          this.snackBar.open(
            `Found ${data.totalDuplicates} duplicate entr${data.totalDuplicates !== 1 ? 'ies' : 'y'} across ${data.pathsWithDuplicates} file${data.pathsWithDuplicates !== 1 ? 's' : ''}`,
            'Close',
            { duration: 3000 }
          );
        }
      } else {
        console.error('Failed to scan duplicates:', data.error);
        this.snackBar.open('Failed to scan for duplicates', 'Close', { duration: 3000 });
        this.duplicateEntries = [];
      }
    } catch (error) {
      console.error('Failed to scan duplicates:', error);
      this.snackBar.open('Failed to scan for duplicates', 'Close', { duration: 3000 });
      this.duplicateEntries = [];
    } finally {
      this.loadingDuplicates = false;
      this.selectedDuplicateEntries.clear();
      this.updateDuplicateSelectionState();
    }
  }

  /**
   * Toggle duplicate entry selection
   */
  toggleDuplicateEntry(videoId: string) {
    if (this.selectedDuplicateEntries.has(videoId)) {
      this.selectedDuplicateEntries.delete(videoId);
    } else {
      this.selectedDuplicateEntries.add(videoId);
    }
    this.updateDuplicateSelectionState();
  }

  /**
   * Toggle all duplicate entries selection
   */
  toggleAllDuplicateSelection() {
    if (this.isAllDuplicatesSelected) {
      this.selectedDuplicateEntries.clear();
    } else {
      this.duplicateEntries.forEach(v => this.selectedDuplicateEntries.add(v.id));
    }
    this.updateDuplicateSelectionState();
  }

  /**
   * Update duplicate selection state
   */
  private updateDuplicateSelectionState() {
    this.isAllDuplicatesSelected = this.duplicateEntries.length > 0 &&
      this.duplicateEntries.every(v => this.selectedDuplicateEntries.has(v.id));
  }

  /**
   * Delete selected duplicate entries
   */
  async deleteSelectedDuplicates() {
    if (this.selectedDuplicateEntries.size === 0) {
      this.notificationService.toastOnly('info', 'No Selection', 'Please select entries to delete');
      return;
    }

    const entryCount = this.selectedDuplicateEntries.size;
    const confirmed = confirm(
      `Are you sure you want to delete ${entryCount} duplicate entr${entryCount !== 1 ? 'ies' : 'y'} from the database?\n\n` +
      'This action cannot be undone.\n\n' +
      'Database entries will be removed, but no files will be deleted.'
    );

    if (!confirmed) return;

    try {
      const videoIds = Array.from(this.selectedDuplicateEntries);
      await this.databaseLibraryService.deleteVideoBatch(videoIds, false);

      this.notificationService.toastOnly(
        'success',
        'Duplicates Deleted',
        `${entryCount} database entr${entryCount !== 1 ? 'ies' : 'y'} removed`
      );

      this.selectedDuplicateEntries.clear();
      await this.scanDuplicateEntries();
    } catch (error) {
      console.error('Failed to delete duplicates:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to delete duplicate entries');
    }
  }

  /**
   * Delete all duplicate entries (keep one per file path)
   */
  async deleteAllDuplicates() {
    if (this.duplicateEntries.length === 0) {
      this.notificationService.toastOnly('info', 'No Duplicates', 'No duplicate entries found');
      return;
    }

    const entryCount = this.duplicateEntries.length;
    const confirmed = confirm(
      `Are you sure you want to delete all ${entryCount} duplicate entr${entryCount !== 1 ? 'ies' : 'y'}?\n\n` +
      'This will keep one database entry per file and remove all duplicates.\n\n' +
      'This action cannot be undone.\n\n' +
      'Database entries will be removed, but no files will be deleted.'
    );

    if (!confirmed) return;

    try {
      const videoIds = this.duplicateEntries.map(v => v.id);
      await this.databaseLibraryService.deleteVideoBatch(videoIds, false);

      this.notificationService.toastOnly(
        'success',
        'Duplicates Deleted',
        `${entryCount} duplicate entr${entryCount !== 1 ? 'ies' : 'y'} removed`
      );

      this.selectedDuplicateEntries.clear();
      await this.scanDuplicateEntries();
    } catch (error) {
      console.error('Failed to delete duplicates:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to delete duplicate entries');
    }
  }

  /**
   * Convert duplicate entries to ListItem format for cascade-list
   */
  get duplicateEntriesAsListItems(): (DatabaseVideo & ListItem)[] {
    return this.duplicateEntries as (DatabaseVideo & ListItem)[];
  }

  /**
   * Selected duplicate entries as Set for cascade-list
   */
  get selectedDuplicateEntriesSet(): Set<string> {
    return this.selectedDuplicateEntries;
  }

  /**
   * Handle duplicate entries selection
   */
  onDuplicateEntriesSelected(videos: DatabaseVideo[]) {
    videos.forEach(v => this.selectedDuplicateEntries.add(v.id));
    this.updateDuplicateSelectionState();
  }

  /**
   * Handle duplicate entries deselection
   */
  onDuplicateEntriesDeselected(videos: DatabaseVideo[]) {
    videos.forEach(v => {
      this.selectedDuplicateEntries.delete(v.id);
      if (this.highlightedDuplicateEntry?.id === v.id) {
        this.highlightedDuplicateEntry = null;
      }
    });
    this.updateDuplicateSelectionState();
  }

  /**
   * Handle duplicate entries context menu actions
   */
  onDuplicateContextMenuAction(event: { action: string; items: DatabaseVideo[] }) {
    console.log('Duplicate context menu action:', event.action, event.items);

    if (event.action === 'delete') {
      if (event.items.length === 1 && !this.selectedDuplicateEntries.has(event.items[0].id)) {
        this.selectedDuplicateEntries.clear();
        this.selectedDuplicateEntries.add(event.items[0].id);
        this.updateDuplicateSelectionState();
      } else {
        this.selectedDuplicateEntries.clear();
        event.items.forEach(item => this.selectedDuplicateEntries.add(item.id));
        this.updateDuplicateSelectionState();
      }
    }

    switch (event.action) {
      case 'open-location':
        if (event.items.length > 0 && event.items[0].current_path) {
          this.videoOperationsService.openFileLocation(event.items[0].current_path);
        }
        break;
      case 'delete':
        this.deleteSelectedDuplicates();
        break;
    }
  }

  /**
   * Handle duplicate entry click
   */
  onDuplicateItemClick(video: DatabaseVideo) {
    this.highlightedDuplicateEntry = video;
  }

  /**
   * Handle duplicate entry double click
   */
  onDuplicateItemDoubleClick(video: DatabaseVideo) {
    console.log('Double clicked duplicate entry:', video);
  }

  /**
   * Handle duplicate entry highlighted
   */
  onDuplicateItemHighlighted(video: DatabaseVideo | null) {
    this.highlightedDuplicateEntry = video;
  }

  /**
   * Handle duplicate delete action
   */
  onDuplicateDeleteAction(videos: DatabaseVideo[]) {
    console.log('Delete duplicate entries:', videos);
  }
}

/**
 * Orphaned Delete Confirmation Dialog Component
 * Simpler dialog for deleting orphaned database entries (no file deletion option)
 */
@Component({
  selector: 'orphaned-delete-confirmation-dialog',
  template: `
    <h2 mat-dialog-title>Delete {{ data.count > 1 ? data.count + ' Orphaned Entries' : 'Orphaned Entry' }}</h2>
    <mat-dialog-content>
      <p *ngIf="data.videoName">Are you sure you want to delete <strong>{{ data.videoName }}</strong> from the database?</p>
      <p *ngIf="!data.videoName">Are you sure you want to delete {{ data.count }} orphaned database entries?</p>

      <p class="warning">This will remove the database entries only. No files will be deleted (they're already missing).</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="warn" (click)="onConfirm()">Delete from Database</button>
    </mat-dialog-actions>
  `,
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule]
})
export class OrphanedDeleteConfirmationDialog {
  constructor(
    public dialogRef: MatDialogRef<OrphanedDeleteConfirmationDialog>,
    @Inject(MAT_DIALOG_DATA) public data: { count: number; videoName: string | null }
  ) {}

  onCancel(): void {
    this.dialogRef.close(null);
  }

  onConfirm(): void {
    this.dialogRef.close('delete');
  }
}
