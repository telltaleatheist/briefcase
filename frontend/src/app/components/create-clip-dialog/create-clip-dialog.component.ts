import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { LibraryService, LibraryAnalysis } from '../../services/library.service';

export interface CreateClipDialogData {
  analysis: LibraryAnalysis;
  startTime: number;
  endTime: number;
}

@Component({
  selector: 'app-create-clip-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './create-clip-dialog.component.html',
  styleUrls: ['./create-clip-dialog.component.scss']
})
export class CreateClipDialogComponent {
  title = '';
  isCreating = false;
  error: string | null = null;
  savePath = '';
  saveDirectory = '';
  isLoadingSavePath = true;
  customDirectory: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: CreateClipDialogData,
    private dialogRef: MatDialogRef<CreateClipDialogComponent>,
    private libraryService: LibraryService
  ) {
    // Set default title
    this.title = `Clip from ${this.data.analysis.title}`;

    // Load the default save path
    this.loadSavePath();
  }

  get duration(): number {
    return this.data.endTime - this.data.startTime;
  }

  formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  async loadSavePath() {
    try {
      this.isLoadingSavePath = true;
      const response = await fetch(`/api/library/analyses/${this.data.analysis.id}/clip-save-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startTime: this.data.startTime,
          endTime: this.data.endTime,
          customDirectory: this.customDirectory || undefined,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        this.savePath = data.outputPath;
        this.saveDirectory = data.outputDir;
      } else {
        console.error('Failed to load save path');
      }
    } catch (error) {
      console.error('Error loading save path:', error);
    } finally {
      this.isLoadingSavePath = false;
    }
  }

  async browseDirectory() {
    try {
      const result = await (window as any).electron?.openDirectoryPicker();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        this.customDirectory = result.filePaths[0];
        await this.loadSavePath(); // Reload the path with new custom directory
      }
    } catch (error) {
      console.error('Error browsing directory:', error);
    }
  }

  async createClip() {
    if (!this.title.trim()) {
      this.error = 'Please enter a title';
      return;
    }

    try {
      this.isCreating = true;
      this.error = null;

      const result = await this.libraryService.extractClip(
        this.data.analysis.id,
        {
          startTime: this.data.startTime,
          endTime: this.data.endTime,
          title: this.title,
          description: '',
          category: undefined,
          customDirectory: this.customDirectory || undefined,
        }
      );

      if (result.success) {
        this.dialogRef.close({ created: true, clip: result.clip, extraction: result.extraction });
      } else {
        this.error = result.error || 'Failed to create clip';
        this.isCreating = false;
      }

    } catch (error) {
      console.error('Error creating clip:', error);
      this.error = 'An error occurred while creating the clip';
      this.isCreating = false;
    }
  }

  cancel() {
    this.dialogRef.close({ created: false });
  }
}
