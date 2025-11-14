import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { TextFieldModule } from '@angular/cdk/text-field';

export interface NameSuggestionDialogData {
  currentFilename: string;
  suggestedTitle: string;
  uploadDate: string | null;
}

@Component({
  selector: 'app-name-suggestion-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    TextFieldModule
  ],
  template: `
    <div class="dialog-container">
      <h2 mat-dialog-title class="dialog-title">
        <mat-icon class="title-icon">auto_awesome</mat-icon>
        AI Suggested Name
      </h2>
      <mat-dialog-content class="dialog-content">
        <div class="filename-section">
          <div class="label">Current filename</div>
          <div class="current-filename">{{ data.currentFilename }}</div>
        </div>
        <div class="arrow-container">
          <mat-icon class="arrow-icon">arrow_downward</mat-icon>
        </div>
        <div class="filename-section editable-section">
          <div class="label">Suggested filename (editable)</div>
          <mat-form-field appearance="outline" class="filename-input">
            <textarea matInput
                      [(ngModel)]="editableFilename"
                      placeholder="Enter filename"
                      class="suggested-filename-input"
                      cdkTextareaAutosize
                      cdkAutosizeMinRows="3"
                      cdkAutosizeMaxRows="8"></textarea>
          </mat-form-field>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions class="dialog-actions">
        <button mat-button (click)="cancel()" class="cancel-button">
          Cancel
        </button>
        <div class="action-buttons">
          <button mat-stroked-button (click)="reject()" class="reject-button">
            <mat-icon>close</mat-icon>
            Reject
          </button>
          <button mat-raised-button color="primary" (click)="accept()" class="accept-button">
            <mat-icon>check</mat-icon>
            Accept & Rename
          </button>
        </div>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .dialog-container {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .dialog-title {
      display: flex;
      align-items: center;
      font-size: 20px;
      font-weight: 500;
      margin: 0;
      padding: 24px 24px 16px;
      border-bottom: 1px solid #e0e0e0;
    }

    .title-icon {
      margin-right: 8px;
      color: #ff8c00;
    }

    .dialog-content {
      padding: 24px 24px 24px 24px;
      min-width: 500px;
    }

    .filename-section {
      padding: 16px;
      border-radius: 8px;
      background: rgba(128, 128, 128, 0.2);
      border: 1px solid rgba(128, 128, 128, 0.3);
    }

    .filename-section:first-child {
      margin-top: 20px;
    }

    .label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }

    .current-filename {
      font-size: 14px;
      color: #333;
      word-wrap: break-word;
      overflow-wrap: break-word;
      font-family: 'Courier New', monospace;
    }

    .arrow-container {
      display: flex;
      justify-content: center;
      margin: 16px 0;
    }

    .arrow-icon {
      color: #999;
      font-size: 24px;
      width: 24px;
      height: 24px;
    }

    .suggested-filename {
      font-size: 14px;
      color: #ff8c00;
      font-weight: 500;
      word-wrap: break-word;
      overflow-wrap: break-word;
      font-family: 'Courier New', monospace;
    }

    .editable-section {
      background: rgba(255, 140, 0, 0.1);
      border: 1px solid rgba(255, 140, 0, 0.3);
    }

    .filename-input {
      width: 100%;
      margin: 0;
    }

    .suggested-filename-input {
      font-size: 15px;
      color: #ff8c00;
      font-weight: 500;
      font-family: 'Courier New', monospace;
      line-height: 1.6;
      resize: vertical;
    }

    ::ng-deep .editable-section .mat-mdc-form-field {
      width: 100%;
    }

    ::ng-deep .editable-section .mat-mdc-text-field-wrapper {
      padding: 0;
    }

    ::ng-deep .editable-section .mat-mdc-form-field-infix {
      min-height: auto;
      padding-top: 8px;
      padding-bottom: 8px;
    }

    ::ng-deep .editable-section textarea.mat-mdc-input-element {
      margin: 0;
      padding: 8px;
    }

    .dialog-actions {
      padding: 16px 24px;
      border-top: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .cancel-button {
      color: #666;
    }

    .action-buttons {
      display: flex;
      gap: 12px;
    }

    .reject-button {
      border-color: #d32f2f;
      color: #d32f2f;
    }

    .reject-button:hover {
      background-color: #ffebee;
    }

    .accept-button {
      background-color: #4caf50;
      color: white;
    }

    .accept-button:hover {
      background-color: #45a049;
    }
  `]
})
export class NameSuggestionDialogComponent {
  editableFilename: string;

  constructor(
    public dialogRef: MatDialogRef<NameSuggestionDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: NameSuggestionDialogData
  ) {
    // Initialize editable filename with the formatted suggestion
    this.editableFilename = this.formatSuggestedFilename();
  }

  formatSuggestedFilename(): string {
    const extension = this.data.currentFilename.split('.').pop() || 'mp4';

    // Strip any date prefix that the AI might have included (format: YYYY-MM-DD)
    // This ensures we don't duplicate dates
    let cleanTitle = this.data.suggestedTitle;
    const datePattern = /^\d{4}-\d{2}-\d{2}\s+/;
    if (datePattern.test(cleanTitle)) {
      cleanTitle = cleanTitle.replace(datePattern, '').trim();
    }

    // Always prepend upload date if available
    if (this.data.uploadDate) {
      return `${this.data.uploadDate} ${cleanTitle}.${extension}`;
    }

    return `${cleanTitle}.${extension}`;
  }

  accept() {
    this.dialogRef.close({ action: 'accept', filename: this.editableFilename });
  }

  reject() {
    this.dialogRef.close('reject');
  }

  cancel() {
    this.dialogRef.close('cancel');
  }
}
