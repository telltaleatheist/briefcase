import { Component, Inject, HostListener, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';

export interface VideoPreviewData {
  id: string;
  filename: string;
  current_path: string;
  upload_date?: string;
  download_date?: string;
  duration_seconds?: number;
  needs_transcript: number;
  needs_analysis: number;
  videoStreamUrl: string;
}

@Component({
  selector: 'app-video-preview-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatIconModule,
    MatButtonModule,
    MatDividerModule,
    MatChipsModule
  ],
  templateUrl: './video-preview-dialog.component.html',
  styleUrls: ['./video-preview-dialog.component.scss']
})
export class VideoPreviewDialogComponent {
  @ViewChild('videoPlayer') videoPlayer?: ElementRef<HTMLVideoElement>;
  videoError = false;
  private previousVideoId: string | null = null;

  constructor(
    public dialogRef: MatDialogRef<VideoPreviewDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: VideoPreviewData
  ) {
    this.previousVideoId = data.id;
  }

  /**
   * Close dialog on escape only (spacebar handled by parent)
   */
  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  close(): void {
    this.dialogRef.close();
  }

  /**
   * Format duration for display
   */
  formatDuration(seconds: number | undefined): string {
    if (!seconds) return 'Unknown';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Format date for display
   */
  formatDate(date: string | undefined): string {
    if (!date) return 'Unknown';

    try {
      const d = new Date(date);
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return date;
    }
  }

  /**
   * Get file extension
   */
  getFileExtension(): string {
    const parts = this.data.filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : 'VIDEO';
  }

  /**
   * Get file size from path if available
   */
  getFilePath(): string {
    return this.data.current_path || 'Unknown';
  }

  /**
   * Get video URL for preview
   */
  getVideoUrl(): string {
    return this.data.videoStreamUrl || '';
  }

  /**
   * Handle video load error
   */
  onVideoError(event: any): void {
    console.error('Video preview error:', event);
    this.videoError = true;
  }

  /**
   * Update video data when navigating to different video
   */
  updateVideoData(videoData: VideoPreviewData): void {
    // Only update if video actually changed
    if (this.previousVideoId === videoData.id) {
      return;
    }

    this.previousVideoId = videoData.id;
    this.videoError = false;

    // Update data object
    this.data = videoData;

    // If we have a video element, update its source
    if (this.videoPlayer?.nativeElement) {
      const videoElement = this.videoPlayer.nativeElement;

      // Pause current video
      videoElement.pause();

      // Update the source
      videoElement.src = this.data.videoStreamUrl;
      videoElement.load();
    }
  }
}
