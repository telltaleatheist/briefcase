import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { FormsModule } from '@angular/forms';

export type ImportAction = 'import-only' | 'import-and-transcribe' | 'import-and-analyze';

@Component({
  selector: 'app-import-options-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    FormsModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>file_upload</mat-icon>
      Import Options
    </h2>

    <mat-dialog-content>
      <p class="dialog-message">
        You're about to import <strong>{{ data.videoCount }}</strong> video{{ data.videoCount !== 1 ? 's' : '' }}.
        Would you like to automatically process them?
      </p>

      <div class="options-container">
        <mat-radio-group [(ngModel)]="selectedAction" class="radio-group">
          <mat-radio-button value="import-only" class="radio-option">
            <div class="option-content">
              <div class="option-header">
                <mat-icon>cloud_upload</mat-icon>
                <strong>Import Only</strong>
              </div>
              <p class="option-description">
                Add videos to the library without processing. You can transcribe or analyze them later.
              </p>
            </div>
          </mat-radio-button>

          <mat-radio-button value="import-and-transcribe" class="radio-option">
            <div class="option-content">
              <div class="option-header">
                <mat-icon>transcribe</mat-icon>
                <strong>Import & Transcribe</strong>
              </div>
              <p class="option-description">
                Generate transcripts for all videos. Useful for searching through spoken content.
              </p>
            </div>
          </mat-radio-button>

          <mat-radio-button value="import-and-analyze" class="radio-option">
            <div class="option-content">
              <div class="option-header">
                <mat-icon>analytics</mat-icon>
                <strong>Import & Analyze (Full)</strong>
              </div>
              <p class="option-description">
                Transcribe and run AI analysis to identify key moments, topics, and insights.
              </p>
            </div>
          </mat-radio-button>
        </mat-radio-group>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="confirm()">
        <mat-icon>check</mat-icon>
        Continue
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-message {
      margin: 0 0 20px 0;
      font-size: 14px;
      color: var(--text-secondary);
      line-height: 1.5;

      strong {
        color: var(--primary-orange);
        font-weight: 600;
      }
    }

    .options-container {
      margin: 20px 0;
    }

    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .radio-option {
      padding: 16px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background-color: var(--bg-secondary);
      transition: all 0.2s;

      &:hover {
        background-color: var(--bg-tertiary);
        border-color: var(--primary-orange);
      }

      ::ng-deep .mdc-radio {
        align-self: flex-start;
        margin-top: 4px;
      }

      ::ng-deep .mdc-label {
        width: 100%;
        padding-left: 12px;
      }

      ::ng-deep .mdc-radio__background {
        .mdc-radio__outer-circle,
        .mdc-radio__inner-circle {
          border-color: var(--text-secondary) !important;
        }
      }

      ::ng-deep .mdc-radio--checked .mdc-radio__background {
        .mdc-radio__outer-circle {
          border-color: var(--primary-orange) !important;
        }

        .mdc-radio__inner-circle {
          border-color: var(--primary-orange) !important;
          background-color: var(--primary-orange) !important;
        }
      }
    }

    .option-content {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .option-header {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-primary);
      font-size: 15px;

      mat-icon {
        font-size: 20px;
        width: 20px;
        height: 20px;
        color: var(--primary-orange);
      }
    }

    .option-description {
      margin: 0;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        mat-icon {
          margin-right: 8px;
        }
      }
    }

    // Dark mode support
    @media (prefers-color-scheme: dark) {
      mat-dialog-actions {
        button.mat-mdc-button {
          color: #e2e8f0 !important;
        }

        button.mat-mdc-raised-button {
          color: white !important;
        }
      }
    }
  `]
})
export class ImportOptionsDialogComponent {
  selectedAction: ImportAction = 'import-only';

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: { videoCount: number },
    private dialogRef: MatDialogRef<ImportOptionsDialogComponent>
  ) {}

  confirm() {
    this.dialogRef.close(this.selectedAction);
  }

  cancel() {
    this.dialogRef.close(null);
  }
}
