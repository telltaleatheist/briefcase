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
import { DatabaseLibraryService, DatabaseVideo } from '../../services/database-library.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import { ListItem, ItemDisplayConfig, ContextMenuAction } from '../../libs/cascade/src/lib/types/cascade.types';

export interface UnimportedVideo {
  filename: string;
  fullPath: string;
  fileSize: number;
  fileType: string;
  created: string;
  modified: string;
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

  // Orphaned videos
  orphanedVideos: DatabaseVideo[] = [];
  loadingOrphaned = false;
  selectedOrphanedVideos = new Set<string>(); // Set of video IDs
  isAllOrphanedSelected = false;
  highlightedOrphanedVideo: DatabaseVideo | null = null;

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
    { id: 'delete', label: 'Delete from Database', icon: 'delete' }
  ];

  constructor(
    private router: Router,
    private databaseLibraryService: DatabaseLibraryService,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private dialog: MatDialog,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit() {
    // Load orphaned videos by default
    this.loadOrphanedVideos();
  }

  /**
   * Navigate back to library
   */
  backToLibrary() {
    this.router.navigate(['/library']);
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
   * Load orphaned videos
   */
  async loadOrphanedVideos() {
    this.loadingOrphaned = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/videos?limit=10000');
      const response = await fetch(url);
      const data = await response.json();

      // Get the actual orphaned video details (is_linked = 0)
      this.orphanedVideos = data?.videos.filter((v: DatabaseVideo) => v.is_linked === 0) || [];
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
   * Relink orphaned videos
   */
  async relinkOrphanedVideos() {
    if (this.selectedOrphanedVideos.size === 0) {
      this.notificationService.toastOnly('info', 'No Selection', 'Please select videos to relink');
      return;
    }

    try {
      const selectedIds = Array.from(this.selectedOrphanedVideos);
      const url = await this.backendUrlService.getApiUrl('/database/relink-videos');

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoIds: selectedIds })
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
      } = await response.json();

      if (data.success) {
        this.unimportedVideos = data.videos;
        console.log(`Found ${data.count} unimported videos`);
      } else {
        console.error('Failed to load unimported videos:', data);
        this.unimportedVideos = [];
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
  async importSelectedUnimportedVideos() {
    if (this.selectedUnimportedVideos.size === 0) {
      this.notificationService.toastOnly('info', 'No Selection', 'Please select files to import');
      return;
    }

    const videoPaths = Array.from(this.selectedUnimportedVideos);

    // TODO: Open import dialog with selected files
    // For now, just show a message
    this.notificationService.toastOnly('info', 'Import', `Ready to import ${videoPaths.length} file(s)`);

    this.selectedUnimportedVideos.clear();
    this.updateUnimportedSelectionState();
    await this.loadUnimportedVideos();
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
   * Convert unimported videos to ListItem format for cascade-list
   */
  get unimportedVideosAsListItems(): (UnimportedVideo & ListItem)[] {
    return this.unimportedVideos.map(video => ({
      ...video,
      id: video.fullPath
    })) as (UnimportedVideo & ListItem)[];
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
    if (event.action === 'import' || event.action === 'delete') {
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
        this.importSelectedUnimportedVideos();
        break;
      case 'delete':
        this.deleteSelectedUnimportedVideos();
        break;
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
