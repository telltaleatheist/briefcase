import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

interface DuplicateVideoDialogData {
  jobId: string;
  videoId: string;
  filename: string;
}

@Component({
  selector: 'app-duplicate-video-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  template: `
    <div class="duplicate-dialog">
      <div class="icon-container">
        <mat-icon class="warning-icon">warning</mat-icon>
      </div>

      <h2 mat-dialog-title>Video Already Exists</h2>

      <mat-dialog-content>
        <p class="message">
          The video <strong>{{ data.filename }}</strong> already exists in your library.
        </p>
        <p class="submessage">
          Would you like to replace the existing video and its data (transcripts and analysis), or cancel the download?
        </p>
      </mat-dialog-content>

      <mat-dialog-actions align="end">
        <button mat-button (click)="onCancel()" class="cancel-button">
          <mat-icon>close</mat-icon>
          Cancel
        </button>
        <button mat-raised-button color="warn" (click)="onReplace()" class="replace-button">
          <mat-icon>refresh</mat-icon>
          Replace Existing
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .duplicate-dialog {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px;
    }

    .icon-container {
      display: flex;
      justify-content: center;
      margin-bottom: 16px;
    }

    .warning-icon {
      font-size: 64px;
      width: 64px;
      height: 64px;
      color: #ff9800;
    }

    h2 {
      text-align: center;
      margin: 0 0 16px 0;
      font-size: 24px;
      font-weight: 600;
    }

    mat-dialog-content {
      text-align: center;
      padding: 0 24px;
    }

    .message {
      font-size: 16px;
      line-height: 1.5;
      margin: 0 0 12px 0;
      color: var(--text-primary);
    }

    .submessage {
      font-size: 14px;
      line-height: 1.4;
      margin: 0;
      color: var(--text-secondary);
    }

    strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    mat-dialog-actions {
      padding: 24px;
      gap: 12px;
      justify-content: center;

      button {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 140px;
        font-size: 14px;
        font-weight: 500;
      }
    }

    .cancel-button {
      color: var(--text-secondary);
    }

    .replace-button {
      background-color: #ff5722;
      color: white;

      &:hover {
        background-color: #f4511e;
      }
    }
  `]
})
export class DuplicateVideoDialogComponent {
  constructor(
    private dialogRef: MatDialogRef<DuplicateVideoDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: DuplicateVideoDialogData
  ) {}

  onCancel() {
    this.dialogRef.close({ action: 'cancel' });
  }

  onReplace() {
    this.dialogRef.close({ action: 'replace' });
  }
}
