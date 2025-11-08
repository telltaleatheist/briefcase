import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatListModule } from '@angular/material/list';
import { MatTabsModule } from '@angular/material/tabs';
import { BatchProgress } from '../../services/database-library.service';

interface CompletedVideo {
  filename: string;
  videoId: string;
  completedAt: Date;
  status: 'success' | 'failed' | 'skipped' | 'processing';
  error?: string;
  stage?: 'transcribing' | 'analyzing';
}

@Component({
  selector: 'app-batch-progress-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatListModule,
    MatTabsModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>{{ batchProgress?.status === 'running' ? 'play_circle' : batchProgress?.status === 'paused' ? 'pause_circle' : 'check_circle' }}</mat-icon>
      Batch Analysis Details
    </h2>

    <mat-dialog-content>
      <!-- Progress Summary -->
      <div class="progress-summary">
        <div class="stat">
          <span class="label">Progress:</span>
          <span class="value">{{ batchProgress?.processedVideos || 0 }} / {{ batchProgress?.totalVideos || 0 }}</span>
        </div>
        <div class="stat" *ngIf="batchProgress?.skippedVideos">
          <span class="label">Skipped:</span>
          <span class="value">{{ batchProgress?.skippedVideos }}</span>
        </div>
        <div class="stat" *ngIf="batchProgress?.failedVideos">
          <span class="label">Failed:</span>
          <span class="value failed">{{ batchProgress?.failedVideos }}</span>
        </div>
        <div class="stat" *ngIf="batchProgress?.estimatedTimeRemaining">
          <span class="label">ETA:</span>
          <span class="value">{{ formatTimeRemaining(batchProgress?.estimatedTimeRemaining) }}</span>
        </div>
      </div>

      <mat-progress-bar
        mode="determinate"
        [value]="batchProgress?.progress || 0"
        class="progress-bar">
      </mat-progress-bar>

      <!-- Current Video -->
      <div class="current-video" *ngIf="batchProgress?.currentVideoFilename">
        <mat-icon>movie</mat-icon>
        <div class="current-video-info">
          <span class="label">Currently Processing:</span>
          <span class="filename">{{ batchProgress?.currentVideoFilename }}</span>
          <span class="stage">{{ getCurrentStage() }}</span>
        </div>
      </div>

      <!-- All Videos List -->
      <div class="videos-list" *ngIf="sortedVideos.length > 0">
        <mat-list>
          <mat-list-item *ngFor="let video of sortedVideos">
            <mat-icon matListItemIcon [class]="'status-icon ' + video.status">
              {{ getStatusIcon(video.status) }}
            </mat-icon>
            <div matListItemTitle>{{ video.filename }}</div>
            <div matListItemLine class="video-meta">
              <span class="status-badge" [class.processing]="video.status === 'processing'" [class.success]="video.status === 'success'" [class.failed]="video.status === 'failed'">
                {{ getStatusText(video) }}
              </span>
              <span class="timestamp">{{ video.completedAt | date:'short' }}</span>
            </div>
            <div matListItemLine *ngIf="video.error" class="error-message">{{ video.error }}</div>
          </mat-list-item>
        </mat-list>
      </div>
      <div class="empty-state" *ngIf="sortedVideos.length === 0">
        <mat-icon>info</mat-icon>
        <p>No videos processed yet</p>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    :host {
      display: block;
    }

    h2[mat-dialog-title] {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--primary-orange);
      padding-top: 24px !important;
      margin-top: 0;

      mat-icon {
        color: var(--primary-orange);
        font-size: 28px;
        width: 28px;
        height: 28px;
      }
    }

    mat-dialog-content {
      padding: 16px 24px;
      overflow-y: visible !important;
    }

    .progress-summary {
      display: flex;
      gap: 24px;
      margin-bottom: 16px;
      flex-wrap: wrap;

      .stat {
        display: flex;
        flex-direction: column;
        gap: 4px;

        .label {
          font-size: 12px;
          color: var(--text-secondary);
          font-weight: 500;
        }

        .value {
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary);

          &.failed {
            color: #f44336;
          }
        }
      }
    }

    .progress-bar {
      margin-bottom: 24px;
      height: 8px;
      border-radius: 4px;

      ::ng-deep .mdc-linear-progress__bar-inner {
        border-color: var(--primary-orange) !important;
      }

      ::ng-deep .mdc-linear-progress__buffer-bar {
        background-color: rgba(255, 143, 71, 0.2) !important;
      }
    }

    .current-video {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      background: rgba(255, 143, 71, 0.1);
      border-left: 4px solid var(--primary-orange);
      border-radius: 4px;
      margin-bottom: 24px;

      mat-icon {
        color: var(--primary-orange);
        font-size: 24px;
        width: 24px;
        height: 24px;
      }

      .current-video-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        min-width: 0;

        .label {
          font-size: 12px;
          color: var(--text-secondary);
          font-weight: 500;
        }

        .filename {
          font-size: 14px;
          font-weight: 500;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .stage {
          font-size: 12px;
          color: var(--primary-orange);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
      }
    }

    .videos-list {
      margin-top: 16px;

      mat-list {
        padding: 0;
      }

      mat-list-item {
        border-bottom: 1px solid var(--border-color, #e0e0e0);

        &:last-child {
          border-bottom: none;
        }

        .status-icon {
          &.success {
            color: #4caf50;
          }

          &.failed {
            color: #f44336;
          }

          &.skipped {
            color: #ff9800;
          }

          &.processing {
            color: var(--primary-orange);
          }
        }

        .video-meta {
          display: flex;
          gap: 12px;
          align-items: center;
        }

        .status-badge {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;

          &.processing {
            background: rgba(255, 143, 71, 0.2);
            color: var(--primary-orange);
          }

          &.success {
            background: rgba(76, 175, 80, 0.2);
            color: #4caf50;
          }

          &.failed {
            background: rgba(244, 67, 54, 0.2);
            color: #f44336;
          }
        }

        .timestamp {
          font-size: 12px;
          color: var(--text-secondary);
        }

        .error-message {
          color: #f44336;
          font-size: 12px;
        }
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      color: var(--text-secondary);

      mat-icon {
        font-size: 48px;
        width: 48px;
        height: 48px;
        opacity: 0.5;
        margin-bottom: 16px;
      }

      p {
        margin: 0;
        font-size: 14px;
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;
      border-top: 1px solid var(--border-color, #e0e0e0);
    }
  `]
})
export class BatchProgressDialogComponent {
  batchProgress: BatchProgress | null = null;
  completedVideos: CompletedVideo[] = [];

  constructor(
    public dialogRef: MatDialogRef<BatchProgressDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      batchProgress: BatchProgress | null;
      completedVideos: CompletedVideo[];
    }
  ) {
    this.batchProgress = data.batchProgress;
    this.completedVideos = data.completedVideos || [];
  }

  get successfulVideos(): CompletedVideo[] {
    return this.completedVideos.filter(v => v.status === 'success');
  }

  get failedVideos(): CompletedVideo[] {
    return this.completedVideos.filter(v => v.status === 'failed');
  }

  get sortedVideos(): CompletedVideo[] {
    return [...this.completedVideos].sort((a, b) =>
      b.completedAt.getTime() - a.completedAt.getTime()
    );
  }

  formatTimeRemaining(seconds: number | undefined): string {
    if (!seconds) return 'Calculating...';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `~${hours}h ${minutes}m remaining`;
    } else if (minutes > 0) {
      return `~${minutes}m remaining`;
    } else {
      return `<1m remaining`;
    }
  }

  getCurrentStage(): string {
    // This would be determined by backend data
    // For now, showing a placeholder
    return 'Transcribing...';
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'success':
        return 'check_circle';
      case 'failed':
        return 'error';
      case 'skipped':
        return 'skip_next';
      case 'processing':
        return 'pending';
      default:
        return 'help';
    }
  }

  getStatusText(video: CompletedVideo): string {
    if (video.status === 'processing') {
      return video.stage === 'transcribing' ? 'Transcribing' : 'AI Analysis';
    } else if (video.status === 'success') {
      return 'Completed';
    } else if (video.status === 'failed') {
      return 'Failed';
    } else if (video.status === 'skipped') {
      return 'Skipped';
    }
    return 'Unknown';
  }
}
