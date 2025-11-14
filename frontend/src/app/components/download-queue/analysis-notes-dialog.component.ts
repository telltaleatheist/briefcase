import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';

export interface AnalysisNotesDialogData {
  jobTitle: string;
  currentNotes: string;
}

@Component({
  selector: 'app-analysis-notes-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>edit_note</mat-icon>
      Custom Analysis Instructions
    </h2>

    <mat-dialog-content>
      <div class="job-title">{{ data.jobTitle }}</div>

      <mat-form-field appearance="outline" class="notes-field">
        <mat-label>Custom Instructions (Optional)</mat-label>
        <textarea matInput
                  [(ngModel)]="notes"
                  placeholder="Add specific instructions for this video's analysis...&#10;&#10;Examples:&#10;• Focus on technical discussions&#10;• Identify timestamps with code examples&#10;• Note any product mentions"
                  rows="8"
                  cdkTextareaAutosize
                  cdkAutosizeMinRows="8"
                  cdkAutosizeMaxRows="20"></textarea>
        <mat-hint>These instructions will be sent to the AI during analysis</mat-hint>
      </mat-form-field>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Cancel</button>
      <button mat-button (click)="clear()" *ngIf="notes && notes.trim()">Clear</button>
      <button mat-raised-button color="primary" (click)="save()">
        <mat-icon>save</mat-icon>
        Save
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    h2 {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 20px 24px 16px;

      mat-icon {
        color: var(--primary-orange);
      }
    }

    mat-dialog-content {
      padding: 0 24px 20px;
      min-width: 500px;
      max-width: 600px;
    }

    .job-title {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 16px;
      padding: 8px 12px;
      background: rgba(255, 107, 53, 0.05);
      border-left: 3px solid var(--primary-orange);
      border-radius: 4px;
    }

    .notes-field {
      width: 100%;

      textarea {
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 0.875rem;
        line-height: 1.5;
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
          margin-right: 4px;
        }
      }
    }
  `]
})
export class AnalysisNotesDialogComponent {
  notes: string;

  constructor(
    public dialogRef: MatDialogRef<AnalysisNotesDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: AnalysisNotesDialogData
  ) {
    this.notes = data.currentNotes || '';
  }

  cancel(): void {
    this.dialogRef.close();
  }

  clear(): void {
    this.notes = '';
  }

  save(): void {
    this.dialogRef.close(this.notes.trim());
  }
}
