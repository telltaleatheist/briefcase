// clippy/frontend/src/app/components/error-dialog/error-dialog.component.ts
import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface ErrorDialogData {
  title: string;
  message: string;
  fullError?: string;
}

@Component({
  selector: 'app-error-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon class="error-icon">error</mat-icon>
      {{ data.title }}
    </h2>
    <mat-dialog-content>
      <p class="error-message">{{ data.message }}</p>
      <div class="error-details" *ngIf="data.fullError">
        <h3>Details:</h3>
        <pre class="error-log">{{ data.fullError }}</pre>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">Close</button>
      <button mat-raised-button color="primary" (click)="copyError()" *ngIf="data.fullError">
        <mat-icon>content_copy</mat-icon>
        Copy Error
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .error-icon {
      color: #f44336;
      vertical-align: middle;
      margin-right: 8px;
    }

    .error-message {
      font-size: 14px;
      margin-bottom: 16px;
      color: rgba(0, 0, 0, 0.87);
    }

    .error-details {
      margin-top: 16px;
    }

    .error-details h3 {
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 8px;
      color: rgba(0, 0, 0, 0.6);
    }

    .error-log {
      background-color: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 12px;
      max-height: 300px;
      overflow-y: auto;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-wrap: break-word;
      color: #333;
    }

    mat-dialog-actions {
      padding: 8px 24px 16px;
    }

    mat-dialog-content {
      max-width: 600px;
    }
  `]
})
export class ErrorDialogComponent {
  constructor(
    public dialogRef: MatDialogRef<ErrorDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: ErrorDialogData
  ) {}

  close(): void {
    this.dialogRef.close();
  }

  copyError(): void {
    if (this.data.fullError) {
      navigator.clipboard.writeText(this.data.fullError).then(() => {
        console.log('Error copied to clipboard');
      });
    }
  }
}
