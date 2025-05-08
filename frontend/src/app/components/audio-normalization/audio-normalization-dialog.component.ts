import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

@Component({
  selector: 'app-audio-normalization-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule
  ],
  template: `
    <h2 mat-dialog-title>Audio Normalization Options</h2>
    <mat-dialog-content>
      <div class="normalization-options">
        <mat-form-field appearance="outline">
          <mat-label>Normalization Method</mat-label>
          <mat-select [(ngModel)]="data.method">
            <mat-option value="ebur128">EBU R128 (Broadcast Standard)</mat-option>
            <mat-option value="rms">RMS Leveling</mat-option>
            <mat-option value="peak">Peak Normalization</mat-option>
          </mat-select>
        </mat-form-field>
        
        <mat-checkbox [(ngModel)]="data.advanced">
          Advanced Options
        </mat-checkbox>
        
        <div *ngIf="data.advanced" class="advanced-options">
          <mat-form-field appearance="outline">
            <mat-label>Target Loudness (LUFS)</mat-label>
            <input 
              matInput 
              type="number" 
              [(ngModel)]="data.targetLoudness" 
              min="-30" 
              max="0"
            >
            <mat-hint>Recommended range: -23 to -16 LUFS</mat-hint>
          </mat-form-field>
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions>
      <button mat-button (click)="onNoClick()">Cancel</button>
      <button mat-button [mat-dialog-close]="data" cdkFocusInitial>Save</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .normalization-options {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .advanced-options {
      margin-top: 16px;
    }
  `]
})
export class AudioNormalizationDialogComponent {
  constructor(
    public dialogRef: MatDialogRef<AudioNormalizationDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      method: 'ebur128' | 'rms' | 'peak',
      advanced: boolean,
      targetLoudness: number
    }
  ) {
    // Set default values if not provided
    if (!data.method) data.method = 'ebur128';
    if (data.advanced === undefined) data.advanced = false;
    if (!data.targetLoudness) data.targetLoudness = -16;
  }

  onNoClick(): void {
    this.dialogRef.close();
  }
}