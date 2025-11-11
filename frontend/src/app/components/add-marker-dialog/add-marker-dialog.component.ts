import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';

@Component({
  selector: 'app-add-marker-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule
  ],
  template: `
    <div class="add-marker-dialog">
      <h2 mat-dialog-title>
        <mat-icon>bookmark_add</mat-icon>
        Add Custom Marker
      </h2>

      <mat-dialog-content>
        <p class="video-title">{{ data.videoTitle }}</p>
        <p class="time-range">
          <mat-icon>schedule</mat-icon>
          {{ formatTime(data.startTime) }} - {{ formatTime(data.endTime) }}
          <span class="duration">({{ formatDuration(data.endTime - data.startTime) }})</span>
        </p>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Notes</mat-label>
          <textarea matInput
                    [(ngModel)]="notes"
                    rows="5"
                    placeholder="Add your notes about this section..."
                    required></textarea>
          <mat-hint>Describe what's happening, why it's important, or any other notes</mat-hint>
        </mat-form-field>
      </mat-dialog-content>

      <mat-dialog-actions align="end">
        <button mat-button (click)="onCancel()">
          <mat-icon>close</mat-icon>
          Cancel
        </button>
        <button mat-raised-button
                color="primary"
                (click)="onSave()"
                [disabled]="!notes.trim() || isSaving">
          <mat-icon>{{ isSaving ? 'hourglass_empty' : 'bookmark_add' }}</mat-icon>
          {{ isSaving ? 'Saving...' : 'Add Marker' }}
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .add-marker-dialog {
      min-width: 500px;

      h2 {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--primary-orange);
        margin: 0;

        mat-icon {
          color: var(--primary-orange);
        }
      }
    }

    mat-dialog-content {
      padding: 1.5rem 0;
      min-height: 200px;
    }

    .video-title {
      font-size: 1.1rem;
      font-weight: 500;
      color: var(--text-primary);
      margin: 0 0 1rem 0;
    }

    .time-range {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.95rem;
      color: var(--text-secondary);
      margin: 0 0 1.5rem 0;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border-radius: 6px;

      mat-icon {
        font-size: 20px;
        width: 20px;
        height: 20px;
        color: var(--primary-orange);
      }

      .duration {
        margin-left: 0.5rem;
        font-style: italic;
      }
    }

    .full-width {
      width: 100%;
      margin-bottom: 1rem;
    }

    mat-dialog-actions {
      padding: 1rem 0 0 0;
      margin: 0;

      button {
        mat-icon {
          margin-right: 0.25rem;
        }
      }
    }
  `]
})
export class AddMarkerDialogComponent {
  title = '';
  notes = '';
  isSaving = false;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: {
      videoId: string;
      videoTitle: string;
      startTime: number;
      endTime: number;
    },
    private dialogRef: MatDialogRef<AddMarkerDialogComponent>,
    private http: HttpClient,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService
  ) {}

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${Math.floor(seconds)}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  }

  onCancel(): void {
    this.dialogRef.close({ created: false });
  }

  async onSave(): Promise<void> {
    if (!this.notes.trim()) {
      this.notificationService.toastOnly('warning', 'Notes Required', 'Please add some notes for this marker');
      return;
    }

    this.isSaving = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/analysis-sections');
      const result = await firstValueFrom(
        this.http.post<{ success: boolean; sectionId?: string; error?: string }>(url, {
          videoId: this.data.videoId,
          startSeconds: this.data.startTime,
          endSeconds: this.data.endTime,
          title: this.title.trim() || null,
          description: this.notes.trim(),
          category: 'custom',
          source: 'user'
        })
      );

      if (result.success) {
        this.dialogRef.close({ created: true, sectionId: result.sectionId });
      } else {
        this.notificationService.error('Failed to Save Marker', result.error || 'Unknown error');
        this.isSaving = false;
      }
    } catch (error: any) {
      console.error('Error saving marker:', error);
      this.notificationService.error('Failed to Save Marker', error.message || 'An error occurred');
      this.isSaving = false;
    }
  }
}
