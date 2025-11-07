import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';

export interface AnalyzeDialogData {
  selectedCount: number;
  videosWithExistingAnalysis?: number; // Number of selected videos that already have analysis
}

export type AnalysisOption = 'transcribe-only' | 'transcribe-analyze' | 'skip';

@Component({
  selector: 'app-analyze-selected-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>analytics</mat-icon>
      Analyze {{ data.selectedCount }} Video{{ data.selectedCount > 1 ? 's' : '' }}
    </h2>

    <mat-dialog-content>
      <p>Choose how you want to process the selected videos:</p>

      <div *ngIf="data.videosWithExistingAnalysis && data.videosWithExistingAnalysis > 0" class="warning-message">
        <mat-icon>warning</mat-icon>
        <span>
          {{ data.videosWithExistingAnalysis }} of {{ data.selectedCount }} video{{data.videosWithExistingAnalysis !== 1 ? 's' : ''}}
          already {{data.videosWithExistingAnalysis === 1 ? 'has' : 'have'}} an AI analysis.
          These will be skipped unless you check "Force Re-analyze" below.
        </span>
      </div>

      <mat-radio-group [(ngModel)]="selectedOption" class="analysis-options">
        <mat-radio-button value="transcribe-only">
          <div class="option-content">
            <strong>Transcribe Only</strong>
            <span class="option-description">Generate transcript using Whisper (faster)</span>
          </div>
        </mat-radio-button>

        <mat-radio-button value="transcribe-analyze">
          <div class="option-content">
            <strong>Transcribe + AI Analysis</strong>
            <span class="option-description">Generate transcript and perform AI analysis (recommended)</span>
          </div>
        </mat-radio-button>

        <mat-radio-button value="skip">
          <div class="option-content">
            <strong>Skip Analysis</strong>
            <span class="option-description">Import without processing (metadata only)</span>
          </div>
        </mat-radio-button>
      </mat-radio-group>

      <div *ngIf="selectedOption === 'transcribe-analyze' && data.videosWithExistingAnalysis && data.videosWithExistingAnalysis > 0" class="force-reanalyze-option">
        <mat-checkbox [(ngModel)]="forceReanalyze">
          Force re-analyze videos that already have analysis
        </mat-checkbox>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="onConfirm()" [disabled]="!selectedOption">
        <mat-icon>play_arrow</mat-icon>
        Start Processing
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    h2 {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0;

      mat-icon {
        color: var(--primary-color, #1976d2);
      }
    }

    mat-dialog-content {
      min-width: 450px;
      padding: 20px 24px;

      p {
        margin-top: 0;
        margin-bottom: 20px;
        color: var(--text-secondary);
      }
    }

    .analysis-options {
      display: flex;
      flex-direction: column;
      gap: 16px;

      mat-radio-button {
        margin-bottom: 8px;

        .option-content {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding-left: 8px;

          strong {
            font-size: 15px;
            color: var(--text-primary);
          }

          .option-description {
            font-size: 13px;
            color: var(--text-secondary);
          }
        }
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        display: flex;
        align-items: center;
        gap: 6px;
      }
    }

    .warning-message {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      margin-bottom: 20px;
      background-color: var(--warning-background, rgba(255, 152, 0, 0.1));
      border: 1px solid var(--warning-border, #ffc107);
      border-radius: 4px;

      mat-icon {
        color: var(--warning-icon, #ff9800);
        font-size: 24px;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        margin-top: 2px;
      }

      span {
        font-size: 14px;
        color: var(--text-primary);
        line-height: 1.5;
      }
    }

    .force-reanalyze-option {
      margin-top: 20px;
      padding: 12px 16px;
      background-color: var(--surface-elevated, rgba(255, 255, 255, 0.05));
      border-radius: 4px;
      border-left: 3px solid var(--primary-color, #1976d2);

      mat-checkbox {
        ::ng-deep .mat-checkbox-label {
          font-size: 14px;
          font-weight: 500;
        }
      }
    }
  `]
})
export class AnalyzeSelectedDialogComponent {
  selectedOption: AnalysisOption = 'transcribe-analyze';
  forceReanalyze = false;

  constructor(
    public dialogRef: MatDialogRef<AnalyzeSelectedDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: AnalyzeDialogData
  ) {}

  onCancel(): void {
    this.dialogRef.close(null);
  }

  onConfirm(): void {
    this.dialogRef.close({
      option: this.selectedOption,
      forceReanalyze: this.forceReanalyze
    });
  }
}
