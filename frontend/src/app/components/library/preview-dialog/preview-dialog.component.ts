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
  mediaType: string;
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
    // Add error handling for video element
    if (this.videoPlayer?.nativeElement) {
      const videoElement = this.videoPlayer.nativeElement;

      videoElement.addEventListener('error', (e) => {
        const error = videoElement.error;
        console.error('Preview video error:', {
          code: error?.code,
          message: error?.message,
          src: videoElement.src
        });

        if (error?.code === MediaError.MEDIA_ERR_DECODE) {
          console.error('Video codec not supported by browser');
        } else if (error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          console.error('Video format not supported');
        } else if (error?.code === MediaError.MEDIA_ERR_NETWORK) {
          console.error('Network error while loading video');
        } else if (error?.code === MediaError.MEDIA_ERR_ABORTED) {
          console.error('Video loading aborted');
        }
      });
    }

    // Auto-play video if enabled
    if (this.autoPlayEnabled && this.data.mediaType === 'video' && this.videoPlayer?.nativeElement) {
      const videoElement = this.videoPlayer.nativeElement;

      // Wait for video to be ready before playing
      const playWhenReady = () => {
        videoElement.play().catch(err => {
          console.error('Auto-play failed:', err);
        });
      };

      // If already loaded, play immediately
      if (videoElement.readyState >= 2) {
        playWhenReady();
      } else {
        // Otherwise wait for loadeddata event
        videoElement.addEventListener('loadeddata', playWhenReady, { once: true });
      }
    }

    // Auto-play audio if enabled
    if (this.autoPlayEnabled && this.data.mediaType === 'audio') {
      setTimeout(() => {
        const audioElement = document.querySelector('.preview-dialog-content audio') as HTMLAudioElement;
        if (audioElement) {
          const playWhenReady = () => {
            audioElement.play().catch(err => {
              console.error('Auto-play failed:', err);
            });
          };

          // If already loaded, play immediately
          if (audioElement.readyState >= 2) {
            playWhenReady();
          } else {
            // Otherwise wait for loadeddata event
            audioElement.addEventListener('loadeddata', playWhenReady, { once: true });
          }
        }
      }, 50);
    }
  }

  ngOnDestroy() {
    // Stop video playback when dialog is destroyed
    this.stopVideo();
  }

  /**
   * Public method to update video data (called by parent component)
   */
  updateVideoData(video: DatabaseVideo, videoStreamUrl: string, mediaType: string) {
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
    this.data.mediaType = mediaType;

    // If we have a video element, update its source
    if (this.videoPlayer?.nativeElement && mediaType === 'video') {
      const videoElement = this.videoPlayer.nativeElement;

      // Pause current video
      videoElement.pause();

      // Update the source
      videoElement.src = videoStreamUrl;
      videoElement.load();

      // Auto-play if enabled - wait for video to be ready
      if (this.autoPlayEnabled) {
        const playWhenReady = () => {
          videoElement.play().catch(err => {
            console.error('Auto-play failed:', err);
          });
        };

        // If already loaded, play immediately
        if (videoElement.readyState >= 2) {
          playWhenReady();
        } else {
          // Otherwise wait for loadeddata event
          videoElement.addEventListener('loadeddata', playWhenReady, { once: true });
        }
      }
    }

    // Handle audio element auto-play when navigating
    if (mediaType === 'audio' && this.autoPlayEnabled) {
      setTimeout(() => {
        const audioElement = document.querySelector('.preview-dialog-content audio') as HTMLAudioElement;
        if (audioElement) {
          audioElement.pause();
          audioElement.src = videoStreamUrl;
          audioElement.load();

          const playWhenReady = () => {
            audioElement.play().catch(err => {
              console.error('Auto-play failed:', err);
            });
          };

          // If already loaded, play immediately
          if (audioElement.readyState >= 2) {
            playWhenReady();
          } else {
            // Otherwise wait for loadeddata event
            audioElement.addEventListener('loadeddata', playWhenReady, { once: true });
          }
        }
      }, 50);
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
