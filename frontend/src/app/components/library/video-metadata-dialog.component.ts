import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatNativeDateModule } from '@angular/material/core';
import { HttpClient } from '@angular/common/http';
import { DatabaseVideo } from '../../services/database-library.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { NotificationService } from '../../services/notification.service';

interface VideoMetadataDialogData {
  video: DatabaseVideo;
}

@Component({
  selector: 'app-video-metadata-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatDatepickerModule,
    MatNativeDateModule,
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>info</mat-icon>
      Video Info & Metadata
    </h2>

    <mat-dialog-content>
      <div class="metadata-form">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Filename</mat-label>
          <input matInput [(ngModel)]="filename" readonly>
          <mat-icon matSuffix>movie</mat-icon>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Current Path</mat-label>
          <input matInput [value]="video.current_path" readonly>
          <mat-icon matSuffix>folder</mat-icon>
        </mat-form-field>

        <!-- AI Description Section -->
        <div class="info-section ai-description" *ngIf="video.ai_description">
          <h3><mat-icon>smart_toy</mat-icon> AI-Generated Description</h3>
          <p class="description-text">{{ video.ai_description }}</p>
        </div>

        <!-- Tags Section -->
        <div class="info-section tags-section" *ngIf="videoTags && (videoTags.people.length > 0 || videoTags.topics.length > 0)">
          <h3><mat-icon>label</mat-icon> Tags</h3>

          <div class="tags-container" *ngIf="videoTags.people.length > 0">
            <div class="tag-category-label">People:</div>
            <div class="tags-chips">
              <span class="tag-chip people-tag" *ngFor="let person of videoTags.people">{{ person }}</span>
            </div>
          </div>

          <div class="tags-container" *ngIf="videoTags.topics.length > 0">
            <div class="tag-category-label">Topics:</div>
            <div class="tags-chips">
              <span class="tag-chip topic-tag" *ngFor="let topic of videoTags.topics">{{ topic }}</span>
            </div>
          </div>
        </div>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Week Folder (YYYY-MM-DD)</mat-label>
          <input matInput [(ngModel)]="weekFolder" placeholder="2025-11-03">
          <mat-icon matSuffix>calendar_today</mat-icon>
          <mat-hint>Format: YYYY-MM-DD (Sunday of the week)</mat-hint>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Added Date</mat-label>
          <input matInput [matDatepicker]="addedDatePicker" [(ngModel)]="addedDate">
          <mat-datepicker-toggle matSuffix [for]="addedDatePicker"></mat-datepicker-toggle>
          <mat-datepicker #addedDatePicker></mat-datepicker>
          <mat-hint>When this video was added to the library</mat-hint>
        </mat-form-field>

        <div class="info-section">
          <h3>Technical Information</h3>
          <div class="info-row">
            <span class="label">File Hash:</span>
            <span class="value">{{ video.file_hash }}</span>
          </div>
          <div class="info-row">
            <span class="label">Duration:</span>
            <span class="value">{{ formatDuration(video.duration_seconds) }}</span>
          </div>
          <div class="info-row">
            <span class="label">File Size:</span>
            <span class="value">{{ formatFileSize(video.file_size_bytes) }}</span>
          </div>
          <div class="info-row">
            <span class="label">Created:</span>
            <span class="value">{{ formatDate(video.created_at) }}</span>
          </div>
          <div class="info-row">
            <span class="label">Last Verified:</span>
            <span class="value">{{ formatDate(video.last_verified) }}</span>
          </div>
        </div>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">Close</button>
      <button
        mat-raised-button
        color="primary"
        (click)="save()"
        [disabled]="saving || !hasChanges()">
        <mat-icon>save</mat-icon>
        {{ saving ? 'Saving...' : 'Save Changes' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 500px;
      max-width: 600px;
      padding: 24px;
      padding-top: 20px;
    }

    .metadata-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-top: 8px;
    }

    .full-width {
      width: 100%;
    }

    .info-section {
      margin-top: 24px;
      padding: 16px;
      background: var(--bg-secondary);
      border-radius: 4px;

      h3 {
        margin: 0 0 12px 0;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        gap: 8px;

        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
        }
      }

      .info-row {
        display: flex;
        justify-content: space-between;
        padding: 8px 0;
        border-bottom: 1px solid var(--border-color);

        &:last-child {
          border-bottom: none;
        }

        .label {
          font-weight: 500;
          color: var(--text-secondary);
        }

        .value {
          font-family: monospace;
          font-size: 12px;
          color: var(--text-primary);
        }
      }

      &.ai-description {
        background: rgba(33, 150, 243, 0.05);
        border-left: 3px solid #2196f3;

        .description-text {
          margin: 0;
          line-height: 1.6;
          color: var(--text-primary);
        }
      }

      &.tags-section {
        background: rgba(255, 152, 0, 0.05);
        border-left: 3px solid #ff9800;

        .tags-container {
          margin-bottom: 16px;

          &:last-child {
            margin-bottom: 0;
          }

          .tag-category-label {
            font-weight: 500;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
            text-transform: uppercase;
          }

          .tags-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;

            .tag-chip {
              display: inline-block;
              padding: 4px 12px;
              border-radius: 16px;
              font-size: 13px;
              font-weight: 500;

              &.people-tag {
                background-color: #e3f2fd;
                color: #1565c0;
              }

              &.topic-tag {
                background-color: #fff3e0;
                color: #e65100;
              }
            }
          }
        }
      }
    }

    h2 {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        margin-left: 8px;
      }
    }
  `],
})
export class VideoMetadataDialogComponent implements OnInit {
  video: DatabaseVideo;
  filename: string;
  weekFolder: string | null;
  addedDate: Date;
  saving = false;
  videoTags: { people: string[]; topics: string[] } = { people: [], topics: [] };

  // Store original values for change detection
  private originalWeekFolder: string | null;
  private originalAddedDate: Date;

  constructor(
    private dialogRef: MatDialogRef<VideoMetadataDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: VideoMetadataDialogData,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private notificationService: NotificationService
  ) {
    this.video = data.video;
    this.filename = data.video.filename;
    this.weekFolder = data.video.date_folder;
    this.addedDate = new Date(data.video.added_at);

    // Store originals
    this.originalWeekFolder = this.weekFolder;
    this.originalAddedDate = new Date(this.addedDate);
  }

  async ngOnInit() {
    // Load tags for this video
    try {
      const url = await this.backendUrlService.getApiUrl(`/database/videos/${this.video.id}/tags`);
      const response = await this.http.get<any>(url).toPromise();

      if (response && response.tags) {
        // Group tags by type
        const people = response.tags.filter((t: any) => t.tag_type === 'person').map((t: any) => t.tag_name);
        const topics = response.tags.filter((t: any) => t.tag_type === 'topic').map((t: any) => t.tag_name);
        this.videoTags = { people, topics };
      }
    } catch (error) {
      console.error('Error loading tags:', error);
      // Non-critical, just continue without tags
    }
  }

  hasChanges(): boolean {
    const weekFolderChanged = this.weekFolder !== this.originalWeekFolder;
    const addedDateChanged = this.addedDate.getTime() !== this.originalAddedDate.getTime();
    return weekFolderChanged || addedDateChanged;
  }

  async save() {
    if (!this.hasChanges()) {
      return;
    }

    this.saving = true;

    try {
      const url = await this.backendUrlService.getApiUrl(`/database/videos/${this.video.id}/metadata`);
      const response = await this.http
        .patch<any>(url, {
          dateFolder: this.weekFolder,
          addedAt: this.addedDate.toISOString(),
        })
        .toPromise();

      if (response.success) {
        this.notificationService.success('Success', 'Video metadata updated');
        this.dialogRef.close(true); // true = refresh needed
      } else {
        this.notificationService.error('Update Failed', response.error || 'Unknown error');
      }
    } catch (error: any) {
      console.error('Error updating video metadata:', error);
      this.notificationService.error('Update Failed', error.error?.message || 'Could not update metadata');
    } finally {
      this.saving = false;
    }
  }

  close() {
    this.dialogRef.close(false);
  }

  formatDuration(seconds: number | null): string {
    if (!seconds) return 'Unknown';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  formatFileSize(bytes: number | null): string {
    if (!bytes) return 'Unknown';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) {
      return `${mb.toFixed(2)} MB`;
    }
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }

  formatDate(dateString: string): string {
    return new Date(dateString).toLocaleString();
  }
}
