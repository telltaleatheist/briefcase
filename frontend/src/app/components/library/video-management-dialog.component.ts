import { Component, OnInit, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';

interface UnimportedVideo {
  filename: string;
  fullPath: string;
  dateFolder?: string;
  hash?: string;
}

interface OrphanedVideo {
  id: string;
  filename: string;
  current_path: string;
}

@Component({
  selector: 'app-video-management-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatCheckboxModule,
    MatTooltipModule,
    MatSnackBarModule
  ],
  template: `
    <div class="video-management-dialog">
      <h2 mat-dialog-title>
        <mat-icon>manage_search</mat-icon>
        Video Management
      </h2>

      <mat-dialog-content>
        <mat-tab-group [(selectedIndex)]="selectedTabIndex">
          <!-- Scan for Unimported Videos Tab -->
          <mat-tab>
            <ng-template mat-tab-label>
              <mat-icon>video_library</mat-icon>
              <span>Scan for Unimported</span>
              <span class="badge" *ngIf="unimportedVideos.length > 0">{{ unimportedVideos.length }}</span>
            </ng-template>

            <div class="tab-content">
              <div class="tab-header">
                <p>Videos that exist in the clips folder but haven't been imported to the database yet.</p>
                <button mat-raised-button color="primary"
                        (click)="scanForUnimported()"
                        [disabled]="isScanning">
                  <mat-icon>search</mat-icon>
                  {{ isScanning ? 'Scanning...' : 'Scan Clips Folder' }}
                </button>
              </div>

              <!-- Loading state -->
              <div class="loading-container" *ngIf="isScanning">
                <mat-spinner diameter="40"></mat-spinner>
                <p>Scanning clips folder...</p>
              </div>

              <!-- Selection header -->
              <div class="results-header" *ngIf="!isScanning && unimportedVideos.length > 0">
                <div class="results-count">
                  <div class="selection-buttons">
                    <button mat-stroked-button
                            (click)="toggleAllUnimported()"
                            [color]="isAllUnimportedSelected ? 'primary' : undefined">
                      <mat-icon>select_all</mat-icon>
                      All
                    </button>
                  </div>
                  <span class="count-text">
                    {{ selectedUnimported.size > 0 ? selectedUnimported.size + ' selected of ' : '' }}{{ unimportedVideos.length }} video{{ unimportedVideos.length !== 1 ? 's' : '' }}
                  </span>
                </div>
                <button mat-raised-button color="accent"
                        (click)="importSelected()"
                        [disabled]="selectedUnimported.size === 0">
                  <mat-icon>download</mat-icon>
                  Import ({{ selectedUnimported.size }})
                </button>
              </div>

              <!-- Unimported videos list using exact same structure as management view -->
              <div *ngIf="!isScanning && unimportedVideos.length > 0" class="video-list-container">
                <div class="video-item orphaned-item"
                     *ngFor="let video of unimportedVideos"
                     [class.selected]="selectedUnimported.has(video.fullPath)"
                     (click)="toggleUnimported(video)">
                  <div class="video-item-content">
                    <div class="checkbox-wrapper">
                      <mat-checkbox
                        [checked]="selectedUnimported.has(video.fullPath)"
                        (click)="$event.stopPropagation()"
                        (change)="toggleUnimported(video)">
                      </mat-checkbox>
                    </div>
                    <div class="video-info-compact">
                      <span class="video-title">{{ video.filename }}</span>
                      <span class="video-path">{{ video.fullPath }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Empty state -->
              <div class="empty-state" *ngIf="!isScanning && hasScanned && unimportedVideos.length === 0">
                <mat-icon>check_circle</mat-icon>
                <p>No unimported videos found</p>
                <p class="secondary">All videos in your clips folder are already in the database</p>
              </div>

              <!-- Initial state -->
              <div class="empty-state" *ngIf="!isScanning && !hasScanned">
                <mat-icon>video_library</mat-icon>
                <p>Click "Scan Clips Folder" to find new videos</p>
              </div>
            </div>
          </mat-tab>

          <!-- Find Orphaned Entries Tab -->
          <mat-tab>
            <ng-template mat-tab-label>
              <mat-icon>broken_image</mat-icon>
              <span>Find Orphaned Entries</span>
              <span class="badge warning" *ngIf="orphanedVideos.length > 0">{{ orphanedVideos.length }}</span>
            </ng-template>

            <div class="tab-content">
              <div class="tab-header">
                <p>Database entries where the video file no longer exists on disk.</p>
                <button mat-raised-button color="primary"
                        (click)="scanForOrphans()"
                        [disabled]="isScanningOrphans">
                  <mat-icon>search</mat-icon>
                  {{ isScanningOrphans ? 'Scanning...' : 'Scan for Orphans' }}
                </button>
              </div>

              <!-- Loading state -->
              <div class="loading-container" *ngIf="isScanningOrphans">
                <mat-spinner diameter="40"></mat-spinner>
                <p>Scanning for orphaned entries...</p>
              </div>

              <!-- Selection header -->
              <div class="results-header" *ngIf="!isScanningOrphans && orphanedVideos.length > 0">
                <div class="results-count">
                  <div class="selection-buttons">
                    <button mat-stroked-button
                            (click)="toggleAllOrphans()"
                            [color]="isAllOrphansSelected ? 'primary' : undefined">
                      <mat-icon>select_all</mat-icon>
                      All
                    </button>
                  </div>
                  <span class="count-text">
                    {{ selectedOrphans.size > 0 ? selectedOrphans.size + ' selected of ' : '' }}{{ orphanedVideos.length }} entr{{ orphanedVideos.length !== 1 ? 'ies' : 'y' }}
                  </span>
                </div>
                <div class="selection-actions" *ngIf="selectedOrphans.size > 0">
                  <button mat-raised-button
                          (click)="relinkSelected()">
                    <mat-icon>link</mat-icon>
                    Relink ({{ selectedOrphans.size }})
                  </button>
                  <button mat-raised-button color="warn"
                          (click)="deleteSelected()">
                    <mat-icon>delete</mat-icon>
                    Delete ({{ selectedOrphans.size }})
                  </button>
                </div>
              </div>

              <!-- Orphaned videos list using exact same structure as management view -->
              <div *ngIf="!isScanningOrphans && orphanedVideos.length > 0" class="video-list-container">
                <div class="video-item orphaned-item"
                     *ngFor="let video of orphanedVideos"
                     [class.selected]="selectedOrphans.has(video.id)"
                     (click)="toggleOrphan(video)">
                  <div class="video-item-content">
                    <div class="checkbox-wrapper">
                      <mat-checkbox
                        [checked]="selectedOrphans.has(video.id)"
                        (click)="$event.stopPropagation()"
                        (change)="toggleOrphan(video)">
                      </mat-checkbox>
                    </div>
                    <div class="video-info-compact">
                      <span class="video-title">{{ video.filename }}</span>
                      <span class="video-path">{{ video.current_path }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Empty state -->
              <div class="empty-state" *ngIf="!isScanningOrphans && hasScannedOrphans && orphanedVideos.length === 0">
                <mat-icon>check_circle</mat-icon>
                <p>No orphaned entries found</p>
                <p class="secondary">All database entries have valid video files</p>
              </div>

              <!-- Initial state -->
              <div class="empty-state" *ngIf="!isScanningOrphans && !hasScannedOrphans">
                <mat-icon>broken_image</mat-icon>
                <p>Click "Scan for Orphans" to find missing files</p>
              </div>
            </div>
          </mat-tab>
        </mat-tab-group>
      </mat-dialog-content>

      <mat-dialog-actions>
        <button mat-button (click)="close()">Close</button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .video-management-dialog {
      width: 700px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }

    h2[mat-dialog-title] {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border-color, #e0e0e0);

      mat-icon {
        font-size: 24px;
        width: 24px;
        height: 24px;
      }
    }

    mat-dialog-content {
      padding: 0;
      margin: 0;
      overflow: hidden;
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    mat-tab-group {
      flex: 1;
      display: flex;
      flex-direction: column;

      ::ng-deep .mat-mdc-tab-body-wrapper {
        flex: 1;
      }
    }

    .badge {
      margin-left: 8px;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--primary-orange, #ff8f47);
      color: white;
      font-size: 11px;
      font-weight: 600;

      &.warning {
        background: #f44336;
      }
    }

    .tab-content {
      padding: 16px 24px;
      max-height: 500px;
      overflow-y: auto;
    }

    .tab-header {
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-color, #e0e0e0);

      p {
        margin: 0 0 12px 0;
        color: var(--text-secondary, #666);
      }

      button {
        display: flex;
        align-items: center;
        gap: 8px;
      }
    }

    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      gap: 16px;

      p {
        margin: 0;
        color: var(--text-secondary, #666);
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      text-align: center;

      mat-icon {
        font-size: 64px;
        width: 64px;
        height: 64px;
        color: var(--text-secondary, #999);
        margin-bottom: 16px;
      }

      p {
        margin: 0;
        color: var(--text-primary, #333);
        font-size: 16px;

        &.secondary {
          margin-top: 8px;
          color: var(--text-secondary, #666);
          font-size: 14px;
        }
      }
    }

    // Copy exact styles from library component
    .results-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      margin-bottom: 16px;
      background: var(--surface, rgba(0, 0, 0, 0.02));
      border-radius: 8px;

      .results-count {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 14px;
        color: var(--text-secondary);

        .selection-buttons {
          display: flex;
          align-items: center;
          gap: 8px;

          button {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            padding: 4px 12px;

            mat-icon {
              font-size: 18px;
              width: 18px;
              height: 18px;
            }
          }
        }

        .count-text {
          font-size: 14px;
        }
      }

      .selection-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }

      button {
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }
    }

    .video-list-container {
      min-height: 200px;
      max-height: 350px;
      overflow-y: auto;
      overflow-x: hidden;
      margin-top: 0;
    }

    .video-item {
      padding: 12px 16px;
      cursor: pointer;
      user-select: none;
      transition: background-color 0.2s, border-left 0.2s;
      border-bottom: 1px solid var(--border-color, #e0e0e0);
      border-left: 3px solid transparent;

      &:hover {
        background: var(--bg-secondary, #f5f5f5);
      }

      &.selected {
        background-color: rgba(255, 143, 71, 0.1);
        border-left: 3px solid var(--primary-orange, #ff8f47);
      }

      &:last-child {
        border-bottom: none;
      }
    }

    .video-item-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .checkbox-wrapper {
      flex-shrink: 0;
    }

    .video-info-compact {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;

      .video-title {
        font-weight: 500;
        font-size: 14px;
        color: var(--text-primary, #333);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .video-path {
        font-size: 12px;
        color: var(--text-secondary, #999);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    mat-dialog-actions {
      padding: 12px 24px;
      border-top: 1px solid var(--border-color, #e0e0e0);
      justify-content: flex-end;
    }

    // Dark mode support
    :host-context(.dark-theme),
    :host-context(.theme-dark) {
      .video-management-dialog {
        background: #2d2d2d;
        color: #e0e0e0;
      }

      h2[mat-dialog-title] {
        background: #252525;
        border-bottom-color: #444;
        color: #e0e0e0;
      }

      .tab-content {
        background: #2d2d2d;
      }

      .tab-header {
        border-bottom-color: #444;

        p {
          color: #999;
        }
      }

      .empty-state {
        color: #e0e0e0;

        mat-icon {
          color: #666;
        }

        p {
          color: #e0e0e0;

          &.secondary {
            color: #999;
          }
        }
      }

      .results-header {
        background: rgba(255, 255, 255, 0.02);

        .results-count {
          color: #999;
        }
      }

      .video-item {
        border-bottom-color: #444;

        &:hover {
          background: #353535;
        }

        &.selected {
          background-color: rgba(255, 143, 71, 0.15);
        }
      }

      .video-info-compact {
        .video-title {
          color: #e0e0e0;
        }

        .video-path {
          color: #666;
        }
      }

      mat-dialog-actions {
        background: #252525;
        border-top-color: #444;
      }
    }
  `]
})
export class VideoManagementDialogComponent implements OnInit {
  selectedTabIndex = 0;

  // Unimported videos tab
  unimportedVideos: UnimportedVideo[] = [];
  selectedUnimported = new Set<string>();
  isAllUnimportedSelected = false;
  isScanning = false;
  isImporting = false;
  hasScanned = false;

  // Orphaned videos tab
  orphanedVideos: OrphanedVideo[] = [];
  selectedOrphans = new Set<string>();
  isAllOrphansSelected = false;
  isScanningOrphans = false;
  isPruning = false;
  hasScannedOrphans = false;

  constructor(
    private dialogRef: MatDialogRef<VideoManagementDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit() {
    // Auto-scan for unimported videos on open
    this.scanForUnimported();
  }

  async scanForUnimported() {
    this.isScanning = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/unimported');
      const response = await this.http.get<{
        success: boolean;
        count: number;
        videos: UnimportedVideo[];
        error?: string;
      }>(url).toPromise();

      if (response?.success) {
        this.unimportedVideos = response.videos || [];
        this.snackBar.open(
          `Found ${this.unimportedVideos.length} unimported video${this.unimportedVideos.length !== 1 ? 's' : ''}`,
          'Close',
          { duration: 3000 }
        );
      } else {
        this.unimportedVideos = [];
        this.snackBar.open('Failed to scan for unimported videos', 'Close', { duration: 3000 });
      }
      this.selectedUnimported.clear();
      this.updateAllUnimportedSelected();
      this.hasScanned = true;
    } catch (error) {
      console.error('Failed to scan for unimported videos:', error);
      this.unimportedVideos = [];
      this.snackBar.open('Failed to scan for unimported videos', 'Close', { duration: 3000 });
    } finally {
      this.isScanning = false;
    }
  }

  toggleUnimported(video: UnimportedVideo) {
    if (this.selectedUnimported.has(video.fullPath)) {
      this.selectedUnimported.delete(video.fullPath);
    } else {
      this.selectedUnimported.add(video.fullPath);
    }
    this.updateAllUnimportedSelected();
  }

  toggleAllUnimported() {
    if (this.isAllUnimportedSelected) {
      this.selectedUnimported.clear();
    } else {
      this.unimportedVideos.forEach(v => this.selectedUnimported.add(v.fullPath));
    }
    this.updateAllUnimportedSelected();
  }

  private updateAllUnimportedSelected() {
    this.isAllUnimportedSelected = this.unimportedVideos.length > 0 &&
      this.unimportedVideos.every(v => this.selectedUnimported.has(v.fullPath));
  }

  async importSelected() {
    if (this.selectedUnimported.size === 0) return;

    this.isImporting = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/import');
      const videoPaths = Array.from(this.selectedUnimported);

      const response = await this.http.post<{
        success: boolean;
        imported: number;
        errors: number;
      }>(url, { videoPaths }).toPromise();

      if (response?.success) {
        this.snackBar.open(
          `Imported ${response.imported} video${response.imported !== 1 ? 's' : ''}`,
          'Close',
          { duration: 3000 }
        );
        this.selectedUnimported.clear();
        await this.scanForUnimported();
      } else {
        this.snackBar.open('Failed to import videos', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to import videos:', error);
      this.snackBar.open('Failed to import videos', 'Close', { duration: 3000 });
    } finally {
      this.isImporting = false;
    }
  }

  async scanForOrphans() {
    this.isScanningOrphans = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/videos');
      const videosResponse = await this.http.get<{ videos: any[] }>(url).toPromise();

      this.orphanedVideos = videosResponse?.videos
        .filter(v => v.is_linked === 0)
        .map(v => ({
          id: v.id,
          filename: v.filename,
          current_path: v.current_path
        })) || [];

      this.selectedOrphans.clear();
      this.updateAllOrphansSelected();
      this.hasScannedOrphans = true;
      this.snackBar.open(
        `Found ${this.orphanedVideos.length} orphaned entr${this.orphanedVideos.length !== 1 ? 'ies' : 'y'}`,
        'Close',
        { duration: 3000 }
      );
    } catch (error) {
      console.error('Failed to scan for orphans:', error);
      this.orphanedVideos = [];
      this.snackBar.open('Failed to scan for orphaned entries', 'Close', { duration: 3000 });
    } finally {
      this.isScanningOrphans = false;
    }
  }

  toggleOrphan(video: OrphanedVideo) {
    if (this.selectedOrphans.has(video.id)) {
      this.selectedOrphans.delete(video.id);
    } else {
      this.selectedOrphans.add(video.id);
    }
    this.updateAllOrphansSelected();
  }

  toggleAllOrphans() {
    if (this.isAllOrphansSelected) {
      this.selectedOrphans.clear();
    } else {
      this.orphanedVideos.forEach(v => this.selectedOrphans.add(v.id));
    }
    this.updateAllOrphansSelected();
  }

  private updateAllOrphansSelected() {
    this.isAllOrphansSelected = this.orphanedVideos.length > 0 &&
      this.orphanedVideos.every(v => this.selectedOrphans.has(v.id));
  }

  async relinkSelected() {
    if (this.selectedOrphans.size === 0) return;

    const result = await (window as any).electron.openDirectoryPicker();
    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return;
    }

    const newFolder = result.filePaths[0];
    const selectedIds = Array.from(this.selectedOrphans);

    this.isPruning = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/relink');
      const response = await this.http.post<{
        success: boolean;
        relinkedCount: number;
        failedCount: number;
        message: string;
      }>(url, {
        videoIds: selectedIds,
        newFolder: newFolder
      }).toPromise();

      if (response?.success) {
        this.snackBar.open(
          `Relinked ${response.relinkedCount} video${response.relinkedCount !== 1 ? 's' : ''}`,
          'Close',
          { duration: 3000 }
        );
        this.selectedOrphans.clear();
        await this.scanForOrphans();
      } else {
        this.snackBar.open(response?.message || 'Failed to relink videos', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to relink videos:', error);
      this.snackBar.open('Failed to relink videos', 'Close', { duration: 3000 });
    } finally {
      this.isPruning = false;
    }
  }

  async deleteSelected() {
    if (this.selectedOrphans.size === 0) return;

    const confirmed = confirm(
      `Are you sure you want to permanently delete ${this.selectedOrphans.size} selected orphaned entr${this.selectedOrphans.size !== 1 ? 'ies' : 'y'}?\n\n` +
      'This will remove these entries from the database. This action cannot be undone.'
    );

    if (!confirmed) return;

    const selectedIds = Array.from(this.selectedOrphans);
    this.isPruning = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/prune-selected');
      const response = await this.http.post<{
        success: boolean;
        deletedCount: number;
        message: string;
      }>(url, { videoIds: selectedIds }).toPromise();

      if (response?.success) {
        this.snackBar.open(response.message, 'Close', { duration: 3000 });
        this.selectedOrphans.clear();
        await this.scanForOrphans();
      } else {
        this.snackBar.open('Failed to delete selected entries', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to delete selected entries:', error);
      this.snackBar.open('Failed to delete selected entries', 'Close', { duration: 3000 });
    } finally {
      this.isPruning = false;
    }
  }

  close() {
    this.dialogRef.close({ refreshNeeded: true });
  }
}
