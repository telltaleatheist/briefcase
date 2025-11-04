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
  description = '';
  category = '';
  isCreating = false;
  error: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: CreateClipDialogData,
    private dialogRef: MatDialogRef<CreateClipDialogComponent>,
    private libraryService: LibraryService
  ) {
    // Set default title
    this.title = `Clip from ${this.data.analysis.title}`;
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
          description: this.description,
          category: this.category || undefined,
        }
      );

      if (result.success) {
        this.dialogRef.close({ created: true, clip: result.clip });
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
