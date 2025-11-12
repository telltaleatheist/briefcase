import { Component, Inject, ViewChild, ElementRef, AfterViewInit, OnDestroy, OnChanges, SimpleChanges, HostListener } from '@angular/core';
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
  onAutoPlayToggle?: (enabled: boolean) => void;
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
export class PreviewDialogComponent implements AfterViewInit, OnDestroy {
  @ViewChild('videoPlayer') videoPlayer?: ElementRef<HTMLVideoElement>;

  autoPlayEnabled: boolean;
  imageLoaded = false;
  imageError = false;
  private previousVideoId: string | null = null;

  constructor(
    public dialogRef: MatDialogRef<PreviewDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: PreviewDialogData
  ) {
    this.autoPlayEnabled = data.autoPlay;
    this.previousVideoId = data.video.id;

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

  ngOnDestroy() {
    // Stop video playback when dialog is destroyed
    this.stopVideo();
  }

  /**
   * Public method to update video data (called by parent component)
   */
  updateVideoData(video: DatabaseVideo, videoStreamUrl: string) {
    // Only update if video actually changed
    if (this.previousVideoId === video.id) {
      return;
    }

    this.previousVideoId = video.id;
    this.imageLoaded = false;
    this.imageError = false;

    // Update data object
    this.data.video = video;
    this.data.videoStreamUrl = videoStreamUrl;

    // If we have a video element, update its source
    if (this.videoPlayer?.nativeElement && video.media_type === 'video') {
      const video = this.videoPlayer.nativeElement;

      // Pause current video
      video.pause();

      // Update the source
      video.src = videoStreamUrl;
      video.load();

      // Auto-play if enabled
      if (this.autoPlayEnabled) {
        video.play().catch(err => {
          console.error('Auto-play failed:', err);
        });
      }
    }
  }

  /**
   * Stop video/audio playback completely (only on close)
   */
  private stopVideo() {
    if (this.videoPlayer?.nativeElement) {
      const video = this.videoPlayer.nativeElement;
      video.pause();
      video.currentTime = 0;
    }
  }

  // Removed @HostListener - let ALL keyboard events pass through to the list
  // The list will handle everything (arrow keys, space, etc.)

  toggleAutoPlay() {
    this.autoPlayEnabled = !this.autoPlayEnabled;

    // Notify parent component to update the auto-play preference
    if (this.data.onAutoPlayToggle) {
      this.data.onAutoPlayToggle(this.autoPlayEnabled);
    }
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
