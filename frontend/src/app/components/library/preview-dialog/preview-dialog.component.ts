import { Component, Inject, ViewChild, ElementRef, AfterViewInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DragDropModule, CdkDrag } from '@angular/cdk/drag-drop';
import { DatabaseVideo } from '../../../services/database-library.service';

export interface PreviewDialogData {
  video: DatabaseVideo;
  autoPlay: boolean;
  videoStreamUrl: string;
  parseFilename: (filename: string) => { title: string };
  getMediaTypeIcon: (mediaType: string) => string;
  getMediaTypeLabel: (mediaType: string) => string;
  canAnalyzeMedia: (video: DatabaseVideo) => boolean;
  onAnalyze?: (video: DatabaseVideo) => void;
  onOpenVideoEditor?: (video: DatabaseVideo) => void;
  onViewDetails?: (video: DatabaseVideo) => void;
}

@Component({
  selector: 'app-preview-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    DragDropModule
  ],
  templateUrl: './preview-dialog.component.html',
  styleUrls: ['./preview-dialog.component.scss']
})
export class PreviewDialogComponent implements AfterViewInit {
  @ViewChild('videoPlayer') videoPlayer?: ElementRef<HTMLVideoElement>;

  autoPlayEnabled: boolean;
  imageLoaded = false;
  imageError = false;

  constructor(
    public dialogRef: MatDialogRef<PreviewDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: PreviewDialogData
  ) {
    this.autoPlayEnabled = data.autoPlay;

    // Make dialog draggable by disabling auto-focus
    this.dialogRef.disableClose = false;
  }

  ngAfterViewInit() {
    // Auto-play video if enabled
    if (this.autoPlayEnabled && this.data.video.media_type === 'video') {
      setTimeout(() => {
        this.videoPlayer?.nativeElement.play().catch(err => {
          console.error('Auto-play failed:', err);
        });
      }, 150);
    }
  }

  @HostListener('keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    // Spacebar to toggle play/pause
    if (event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      const video = this.videoPlayer?.nativeElement;
      if (video) {
        if (video.paused) {
          video.play();
        } else {
          video.pause();
        }
      }
    }

    // Escape to close (already handled by MatDialog, but we can also do it explicitly)
    if (event.code === 'Escape') {
      event.stopPropagation();
      this.dialogRef.close();
    }

    // Arrow keys - pass through to parent for navigation
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
      event.stopPropagation();
      this.dialogRef.close({ navigate: event.code === 'ArrowUp' ? -1 : 1 });
    }
  }

  toggleAutoPlay() {
    this.autoPlayEnabled = !this.autoPlayEnabled;
  }

  onImageError() {
    this.imageError = true;
  }

  onImageLoaded() {
    this.imageLoaded = true;
  }

  analyze() {
    if (this.data.onAnalyze) {
      this.data.onAnalyze(this.data.video);
    }
  }

  openVideoEditor() {
    if (this.data.onOpenVideoEditor) {
      this.data.onOpenVideoEditor(this.data.video);
      this.dialogRef.close();
    }
  }

  viewDetails() {
    if (this.data.onViewDetails) {
      this.data.onViewDetails(this.data.video);
      this.dialogRef.close();
    }
  }
}
