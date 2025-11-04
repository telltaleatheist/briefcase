import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatListModule } from '@angular/material/list';
import { LibraryService, LibraryAnalysis } from '../../services/library.service';

interface RelinkCandidate {
  filename: string;
  fullPath: string;
  score: number;
}

@Component({
  selector: 'app-relink-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatListModule,
  ],
  templateUrl: './relink-dialog.component.html',
  styleUrls: ['./relink-dialog.component.scss']
})
export class RelinkDialogComponent implements OnInit {
  isLoading = true;
  autoRelinkSuccess = false;
  suggestedPath: string | null = null;
  confidence: 'high' | 'low' | null = null;
  candidates: RelinkCandidate[] = [];
  errorMessage: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: { analysis: LibraryAnalysis },
    private dialogRef: MatDialogRef<RelinkDialogComponent>,
    private libraryService: LibraryService
  ) {}

  async ngOnInit() {
    await this.attemptAutoRelink();
  }

  async attemptAutoRelink() {
    try {
      this.isLoading = true;
      this.errorMessage = null;

      const result = await this.libraryService.autoRelinkVideo(this.data.analysis.id);

      if (result.success) {
        this.autoRelinkSuccess = true;
        this.suggestedPath = result.suggestedPath || null;
        this.confidence = result.confidence || null;
        this.candidates = result.candidates || [];
      } else {
        this.autoRelinkSuccess = false;
        this.errorMessage = result.reason || 'Could not find video automatically';
        this.candidates = [];
      }

    } catch (error) {
      console.error('Auto-relink error:', error);
      this.errorMessage = 'Failed to search for video';
      this.autoRelinkSuccess = false;
    } finally {
      this.isLoading = false;
    }
  }

  async selectCandidate(candidate: RelinkCandidate) {
    try {
      this.isLoading = true;

      const result = await this.libraryService.manualRelinkVideo(
        this.data.analysis.id,
        candidate.fullPath
      );

      if (result.success) {
        this.dialogRef.close({ relinked: true, path: candidate.fullPath });
      } else {
        this.errorMessage = result.reason || 'Failed to relink video';
        this.isLoading = false;
      }

    } catch (error) {
      console.error('Relink error:', error);
      this.errorMessage = 'Failed to relink video';
      this.isLoading = false;
    }
  }

  async manualSelect() {
    try {
      // Use electron file picker
      const result = await (window as any).electron?.selectFile({
        title: 'Select Video File',
        filters: [
          { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }
        ]
      });

      if (result && result.filePath) {
        this.isLoading = true;

        const relinkResult = await this.libraryService.manualRelinkVideo(
          this.data.analysis.id,
          result.filePath
        );

        if (relinkResult.success) {
          this.dialogRef.close({ relinked: true, path: result.filePath });
        } else {
          this.errorMessage = relinkResult.reason || 'Failed to relink video';
          this.isLoading = false;
        }
      }

    } catch (error) {
      console.error('Manual select error:', error);
      this.errorMessage = 'Failed to select file';
      this.isLoading = false;
    }
  }

  cancel() {
    this.dialogRef.close({ relinked: false });
  }

  getConfidenceColor(score: number): string {
    if (score > 0.8) return '#4caf50'; // green
    if (score > 0.6) return '#ff9800'; // orange
    return '#f44336'; // red
  }

  getConfidenceText(score: number): string {
    if (score > 0.8) return 'High confidence';
    if (score > 0.6) return 'Medium confidence';
    return 'Low confidence';
  }
}
