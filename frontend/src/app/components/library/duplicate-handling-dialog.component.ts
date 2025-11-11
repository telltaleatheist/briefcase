import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';

interface DuplicateFile {
  path: string;
  filename: string;
  existingVideo: {
    id: string;
    filename: string;
    current_path: string;
    added_at: string;
  };
}

export interface DuplicateHandlingResult {
  action: 'proceed' | 'cancel';
  handling: { [key: string]: 'skip' | 'replace' | 'keep-both' };
}

@Component({
  selector: 'app-duplicate-handling-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatRadioModule,
    MatCheckboxModule,
    MatIconModule,
    FormsModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon style="vertical-align: middle; margin-right: 8px; color: #ff9800;">warning</mat-icon>
      Duplicate Videos Found
    </h2>

    <mat-dialog-content class="dialog-content">
      <p class="dialog-message">
        {{ data.duplicates.length }} video{{ data.duplicates.length !== 1 ? 's are' : ' is' }} already in your library.
        How would you like to handle {{ data.duplicates.length !== 1 ? 'them' : 'it' }}?
      </p>

      <!-- Apply to All Section -->
      <div class="apply-to-all-section">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
          <mat-checkbox [(ngModel)]="applyToAll" (change)="onApplyToAllChange()">
            Apply to all duplicates
          </mat-checkbox>
        </div>

        <div *ngIf="applyToAll" style="margin-left: 32px;">
          <mat-radio-group [(ngModel)]="globalAction" (change)="onGlobalActionChange()">
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <mat-radio-button value="skip">
                <strong>Skip</strong> - Don't import these videos
              </mat-radio-button>
              <mat-radio-button value="replace">
                <strong>Replace</strong> - Delete existing entries and import fresh (removes all metadata, transcripts, analyses)
              </mat-radio-button>
              <mat-radio-button value="keep-both">
                <strong>Keep Both</strong> - Update the path of existing entries
              </mat-radio-button>
            </div>
          </mat-radio-group>
        </div>
      </div>

      <!-- Individual Files -->
      <div *ngIf="!applyToAll" style="display: flex; flex-direction: column; gap: 16px;">
        <div *ngFor="let duplicate of data.duplicates; let i = index" class="duplicate-item">
          <div style="margin-bottom: 8px;">
            <div style="font-weight: 500; margin-bottom: 4px;">{{ duplicate.filename }}</div>
            <div class="duplicate-info">
              Conflicts with: {{ duplicate.existingVideo.filename }}
              <br>
              Added: {{ formatDate(duplicate.existingVideo.added_at) }}
            </div>
          </div>

          <mat-radio-group [(ngModel)]="individualActions[duplicate.path]">
            <div style="display: flex; flex-direction: column; gap: 4px; font-size: 13px;">
              <mat-radio-button value="skip">Skip</mat-radio-button>
              <mat-radio-button value="replace">Replace existing</mat-radio-button>
              <mat-radio-button value="keep-both">Keep both</mat-radio-button>
            </div>
          </mat-radio-group>
        </div>
      </div>

      <!-- Summary -->
      <div *ngIf="data.uniqueCount > 0" class="summary-section">
        <mat-icon style="vertical-align: middle; margin-right: 8px; color: #2196f3; font-size: 18px; width: 18px; height: 18px;">info</mat-icon>
        <span style="font-size: 13px;">
          {{ data.uniqueCount }} video{{ data.uniqueCount !== 1 ? 's' : '' }} will be imported without conflicts.
        </span>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="onProceed()" [disabled]="!isValid()">
        Proceed
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    ::ng-deep .mat-mdc-dialog-content {
      padding: 0 24px !important;
    }

    mat-radio-button {
      display: block;
      margin-bottom: 8px;
    }

    .dialog-content {
      max-height: 60vh;
      overflow-y: auto;
    }

    .dialog-message {
      margin-bottom: 16px;
      color: var(--text-color);
      opacity: 0.8;
    }

    .apply-to-all-section {
      background: rgba(var(--text-color-rgb, 0, 0, 0), 0.05);
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 16px;
    }

    .duplicate-item {
      border: 1px solid rgba(var(--text-color-rgb, 0, 0, 0), 0.12);
      border-radius: 4px;
      padding: 12px;
    }

    .duplicate-info {
      font-size: 12px;
      color: var(--text-color);
      opacity: 0.7;
    }

    .summary-section {
      margin-top: 16px;
      padding: 12px;
      background: rgba(33, 150, 243, 0.1);
      border-radius: 4px;
      border: 1px solid rgba(33, 150, 243, 0.3);
    }
  `]
})
export class DuplicateHandlingDialogComponent {
  applyToAll = false;
  globalAction: 'skip' | 'replace' | 'keep-both' = 'skip';
  individualActions: { [key: string]: 'skip' | 'replace' | 'keep-both' } = {};

  constructor(
    public dialogRef: MatDialogRef<DuplicateHandlingDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      duplicates: DuplicateFile[];
      uniqueCount: number;
    }
  ) {
    // Initialize individual actions with default 'skip'
    for (const duplicate of data.duplicates) {
      this.individualActions[duplicate.path] = 'skip';
    }
  }

  onApplyToAllChange() {
    if (this.applyToAll) {
      // Apply global action to all
      this.onGlobalActionChange();
    }
  }

  onGlobalActionChange() {
    if (this.applyToAll) {
      // Set all individual actions to match global
      for (const duplicate of this.data.duplicates) {
        this.individualActions[duplicate.path] = this.globalAction;
      }
    }
  }

  isValid(): boolean {
    // All duplicates must have an action selected
    return this.data.duplicates.every(d =>
      this.individualActions[d.path] !== undefined
    );
  }

  formatDate(dateString: string): string {
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateString;
    }
  }

  onCancel(): void {
    this.dialogRef.close({ action: 'cancel' });
  }

  onProceed(): void {
    this.dialogRef.close({
      action: 'proceed',
      handling: this.individualActions
    } as DuplicateHandlingResult);
  }
}
