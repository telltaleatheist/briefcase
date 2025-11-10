import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';
import { NotificationService } from '../../services/notification.service';
import { MatDialog } from '@angular/material/dialog';
import { DatabaseLibraryService } from '../../services/database-library.service';

interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

interface UnimportedVideo {
  filename: string;
  fullPath: string;
  dateFolder?: string;
  hash?: string;
}

@Component({
  selector: 'app-unimported-videos-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatCheckboxModule,
    MatCardModule,
    MatProgressSpinnerModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>folder_open</mat-icon>
      Unimported Videos
    </h2>

    <mat-dialog-content>
      <!-- Header with selection controls and Scan All button -->
      <div class="unimported-header">
        <div class="header-left">
          <button mat-raised-button color="primary" (click)="scanLibrary()" [disabled]="isScanning">
            <mat-icon>sync</mat-icon>
            {{ isScanning ? 'Scanning...' : 'Scan All' }}
          </button>
          <span class="help-text">Scan clips folder for new videos</span>
        </div>
        <div class="header-right">
          <mat-checkbox
            [checked]="isAllSelected"
            (change)="toggleAllSelection()"
            [disabled]="unimportedVideos.length === 0">
            Select All
          </mat-checkbox>
          <span class="selection-count" *ngIf="selectedVideos.size > 0">
            {{ selectedVideos.size }} selected
          </span>
        </div>
      </div>

      <!-- Loading state -->
      <div class="loading-state" *ngIf="isLoading">
        <mat-spinner diameter="50"></mat-spinner>
        <p>{{ loadingMessage }}</p>
      </div>

      <!-- Unimported videos list -->
      <div class="unimported-list" *ngIf="!isLoading && unimportedVideos.length > 0">
        <mat-card *ngFor="let video of unimportedVideos" class="unimported-video-card">
          <div class="unimported-video-content">
            <mat-checkbox
              [checked]="isVideoSelected(video)"
              (change)="toggleVideoSelection(video)">
            </mat-checkbox>
            <div class="video-info">
              <div class="video-filename">
                <mat-icon>movie</mat-icon>
                <span>{{ video.filename }}</span>
              </div>
              <div class="video-details">
                <span *ngIf="video.dateFolder" class="date-folder">
                  <mat-icon>folder</mat-icon>
                  {{ video.dateFolder }}
                </span>
                <span class="file-path">{{ video.fullPath }}</span>
              </div>
            </div>
          </div>
        </mat-card>
      </div>

      <!-- Empty state -->
      <div class="empty-state" *ngIf="!isLoading && unimportedVideos.length === 0">
        <mat-icon>check_circle</mat-icon>
        <h2>All videos are imported</h2>
        <p>No unimported videos found in your clips folder</p>
        <p class="help-text">New videos added to {{ data.activeLibrary?.clipsFolderPath }} will appear here</p>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Close</button>
      <button
        mat-raised-button
        color="primary"
        (click)="importSelected()"
        [disabled]="selectedVideos.size === 0">
        <mat-icon>cloud_upload</mat-icon>
        Import Selected ({{ selectedVideos.size }})
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-height: 400px;
      max-height: 70vh;
      overflow-y: auto;
      padding: 24px !important;
    }

    .unimported-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .help-text {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .selection-count {
      font-size: 14px;
      color: var(--primary-orange);
      font-weight: 600;
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      gap: 20px;

      p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 14px;
      }
    }

    .unimported-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .unimported-video-card {
      padding: 16px;
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      transition: all 0.2s;

      &:hover {
        background-color: var(--bg-tertiary);
        border-color: var(--primary-orange);
      }
    }

    .unimported-video-content {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .video-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .video-filename {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);

      mat-icon {
        font-size: 20px;
        width: 20px;
        height: 20px;
        color: var(--primary-orange);
      }
    }

    .video-details {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .date-folder {
      display: flex;
      align-items: center;
      gap: 4px;

      mat-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
      }
    }

    .file-path {
      font-family: monospace;
      font-size: 11px;
      opacity: 0.7;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      text-align: center;

      mat-icon {
        font-size: 64px;
        width: 64px;
        height: 64px;
        color: var(--success-green);
        margin-bottom: 16px;
      }

      h2 {
        margin: 0 0 8px 0;
        font-size: 18px;
        font-weight: 500;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 4px 0;
        font-size: 14px;
        color: var(--text-secondary);

        &.help-text {
          font-size: 12px;
          opacity: 0.7;
          margin-top: 8px;
        }
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        mat-icon {
          margin-right: 8px;
        }
      }
    }
  `]
})
export class UnimportedVideosDialogComponent implements OnInit {
  unimportedVideos: UnimportedVideo[] = [];
  selectedVideos = new Set<string>();
  isAllSelected = false;
  isLoading = false;
  isScanning = false;
  loadingMessage = 'Loading unimported videos...';

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: {
      activeLibrary: ClipLibrary | null;
      unimportedVideos: UnimportedVideo[];
    },
    private dialogRef: MatDialogRef<UnimportedVideosDialogComponent>,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private notificationService: NotificationService,
    private dialog: MatDialog,
    private databaseLibraryService: DatabaseLibraryService
  ) {
    this.unimportedVideos = data.unimportedVideos || [];
  }

  async ngOnInit() {
    // If no unimported videos were provided, load them
    if (this.unimportedVideos.length === 0) {
      await this.loadUnimportedVideos();
    }
  }

  async loadUnimportedVideos() {
    if (!this.data.activeLibrary) {
      return;
    }

    this.isLoading = true;
    this.loadingMessage = 'Loading unimported videos...';
    try {
      const url = await this.backendUrlService.getApiUrl('/database/unimported');
      const response = await this.http.get<{
        success: boolean;
        count: number;
        videos: UnimportedVideo[];
        error?: string;
      }>(url).toPromise();

      if (response?.success) {
        this.unimportedVideos = response.videos;
      } else {
        console.error('Failed to load unimported videos:', response?.error);
        this.unimportedVideos = [];
      }
    } catch (error) {
      console.error('Failed to load unimported videos:', error);
      this.unimportedVideos = [];
    } finally {
      this.isLoading = false;
    }
  }

  async scanLibrary() {
    this.isScanning = true;
    this.isLoading = true;
    this.loadingMessage = 'Scanning clips folder...';

    try {
      const result = await this.databaseLibraryService.scanLibrary();

      // Clear cache since data changed
      this.databaseLibraryService.clearCache();

      // Show notification
      if (result.newVideos > 0) {
        this.notificationService.toastOnly(
          'success',
          'Scan Complete',
          `Found ${result.newVideos} new videos`
        );
      } else {
        this.notificationService.toastOnly(
          'info',
          'Scan Complete',
          'No new videos found'
        );
      }

      // Reload unimported videos list
      await this.loadUnimportedVideos();

      // Close dialog and signal that videos were imported
      if (result.newVideos > 0) {
        this.dialogRef.close({ videosImported: true });
      }
    } catch (error) {
      console.error('Scan failed:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to scan library');
    } finally {
      this.isScanning = false;
      this.isLoading = false;
    }
  }

  isVideoSelected(video: UnimportedVideo): boolean {
    return this.selectedVideos.has(video.fullPath);
  }

  toggleVideoSelection(video: UnimportedVideo) {
    if (this.selectedVideos.has(video.fullPath)) {
      this.selectedVideos.delete(video.fullPath);
    } else {
      this.selectedVideos.add(video.fullPath);
    }
    this.updateAllSelectedState();
  }

  toggleAllSelection() {
    if (this.isAllSelected) {
      this.selectedVideos.clear();
      this.isAllSelected = false;
    } else {
      this.unimportedVideos.forEach(video => this.selectedVideos.add(video.fullPath));
      this.isAllSelected = true;
    }
  }

  private updateAllSelectedState() {
    if (this.unimportedVideos.length === 0) {
      this.isAllSelected = false;
      return;
    }
    this.isAllSelected = this.unimportedVideos.every(video =>
      this.selectedVideos.has(video.fullPath)
    );
  }

  async importSelected() {
    if (this.selectedVideos.size === 0) {
      return;
    }

    const videoPaths = Array.from(this.selectedVideos);

    // First, show options dialog
    const { ImportOptionsDialogComponent } = await import('./import-options-dialog.component');

    const optionsDialogRef = this.dialog.open(ImportOptionsDialogComponent, {
      width: '500px',
      data: { videoCount: videoPaths.length }
    });

    const importAction = await optionsDialogRef.afterClosed().toPromise();

    if (!importAction) {
      // User cancelled
      return;
    }

    // Open import progress dialog
    const { ImportProgressDialogComponent } = await import('./import-progress-dialog.component');

    const progressDialogRef = this.dialog.open(ImportProgressDialogComponent, {
      width: '500px',
      disableClose: true,
      data: { filePaths: videoPaths }
    });

    const importResult = await progressDialogRef.afterClosed().toPromise();

    if (importResult?.success) {
      // Clear cache since data changed
      this.databaseLibraryService.clearCache();

      this.selectedVideos.clear();
      this.updateAllSelectedState();
      await this.loadUnimportedVideos();

      // Get the imported video IDs
      const importedVideoIds = importResult.imported || [];

      // Start batch analysis if requested
      if (importAction === 'import-and-transcribe' && importedVideoIds.length > 0) {
        try {
          await this.databaseLibraryService.startBatchAnalysis({
            videoIds: importedVideoIds,
            transcribeOnly: true
          });
          this.notificationService.toastOnly(
            'success',
            'Transcription Started',
            `Transcribing ${importedVideoIds.length} video${importedVideoIds.length !== 1 ? 's' : ''}`
          );
        } catch (error: any) {
          console.error('Failed to start transcription:', error);
          this.notificationService.toastOnly(
            'error',
            'Error',
            error.error?.message || 'Failed to start transcription'
          );
        }
      } else if (importAction === 'import-and-analyze' && importedVideoIds.length > 0) {
        try {
          await this.databaseLibraryService.startBatchAnalysis({
            videoIds: importedVideoIds,
            transcribeOnly: false
          });
          this.notificationService.toastOnly(
            'success',
            'Analysis Started',
            `Processing ${importedVideoIds.length} video${importedVideoIds.length !== 1 ? 's' : ''}`
          );
        } catch (error: any) {
          console.error('Failed to start analysis:', error);
          this.notificationService.toastOnly(
            'error',
            'Error',
            error.error?.message || 'Failed to start analysis'
          );
        }
      }

      // Close this dialog and signal that videos were imported
      this.dialogRef.close({ videosImported: true });
    }
  }

  cancel() {
    this.dialogRef.close(null);
  }
}
