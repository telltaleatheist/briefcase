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
  analysis?: LibraryAnalysis;
  customVideo?: any;
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
    // Set default title based on whether it's an analyzed video or custom video
    if (this.data.analysis) {
      this.title = `Clip from ${this.data.analysis.title}`;
    } else if (this.data.customVideo) {
      this.title = `Clip from ${this.data.customVideo.title}`;
    } else {
      this.title = 'New Clip';
    }

    // Load the default save path (only for analyzed videos)
    if (this.data.analysis) {
      this.loadSavePath();
    } else {
      // For custom videos, we'll need a different approach
      this.loadCustomVideoSavePath();
    }
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
    if (!this.data.analysis) return;

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

  async loadCustomVideoSavePath() {
    try {
      this.isLoadingSavePath = true;
      // For custom videos, generate a simple save path
      const filename = this.data.customVideo?.title || 'custom_video';
      const safeFilename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const timestamp = `${Math.floor(this.data.startTime)}-${Math.floor(this.data.endTime)}`;
      const clipFilename = `${safeFilename}_${timestamp}.mp4`;

      // Use default Downloads/clippy/clips directory
      const homedir = await (window as any).electron?.getPath('downloads') || 'Downloads';
      this.saveDirectory = `${homedir}/clippy/clips`;
      this.savePath = `${this.saveDirectory}/${clipFilename}`;
    } catch (error) {
      console.error('Error generating custom video save path:', error);
      this.savePath = 'clip.mp4';
      this.saveDirectory = 'Downloads';
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

      let result: any;

      if (this.data.analysis) {
        // Extract clip from analyzed video
        result = await this.libraryService.extractClip(
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
      } else if (this.data.customVideo) {
        // Extract clip from custom video
        const response = await fetch('/api/library/videos/custom/extract-clip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: this.data.customVideo.videoPath,
            startTime: this.data.startTime,
            endTime: this.data.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to extract clip from custom video');
        }

        result = await response.json();
      } else {
        this.error = 'No video source available';
        this.isCreating = false;
        return;
      }

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
