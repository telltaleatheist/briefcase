import {
  Component,
  Input,
  Output,
  EventEmitter,
  ViewChild,
  ElementRef,
  OnChanges,
  SimpleChanges,
  AfterViewInit,
  OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './video-player.component.html',
  styleUrls: ['./video-player.component.scss']
})
export class VideoPlayerComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() videoUrl?: string;
  @Input() currentTime: number = 0;
  @Input() isPlaying: boolean = false;
  @Input() volume: number = 1;
  @Input() playbackRate: number = 1;

  @Output() timeUpdate = new EventEmitter<number>();
  @Output() durationChange = new EventEmitter<number>();
  @Output() playStateChange = new EventEmitter<boolean>();
  @Output() ended = new EventEmitter<void>();
  @Output() error = new EventEmitter<string>();
  @Output() doubleClick = new EventEmitter<void>();

  @ViewChild('videoElement') videoRef!: ElementRef<HTMLVideoElement>;

  duration: number = 0;
  isLoading: boolean = false;
  hasError: boolean = false;
  errorMessage: string = '';

  private isSeeking: boolean = false;
  private updateThrottleTimeout?: any;

  ngAfterViewInit(): void {
    this.setupVideoListeners();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.videoRef?.nativeElement) return;

    const video = this.videoRef.nativeElement;

    if (changes['currentTime'] && !this.isSeeking) {
      const diff = Math.abs(video.currentTime - this.currentTime);
      if (diff > 0.5) {
        video.currentTime = this.currentTime;
      }
    }

    if (changes['isPlaying']) {
      if (this.isPlaying && video.paused) {
        video.play().catch(err => {
          console.error('Failed to play video:', err);
          this.playStateChange.emit(false);
        });
      } else if (!this.isPlaying && !video.paused) {
        video.pause();
      }
    }

    if (changes['volume']) {
      video.volume = this.volume;
    }

    if (changes['playbackRate']) {
      video.playbackRate = this.playbackRate;
    }
  }

  ngOnDestroy(): void {
    if (this.updateThrottleTimeout) {
      clearTimeout(this.updateThrottleTimeout);
    }
  }

  private setupVideoListeners(): void {
    const video = this.videoRef.nativeElement;

    video.addEventListener('loadedmetadata', () => {
      this.duration = video.duration;
      this.durationChange.emit(video.duration);
      this.isLoading = false;
    });

    video.addEventListener('timeupdate', () => {
      if (!this.isSeeking) {
        // Throttle time updates
        if (!this.updateThrottleTimeout) {
          this.updateThrottleTimeout = setTimeout(() => {
            this.timeUpdate.emit(video.currentTime);
            this.updateThrottleTimeout = undefined;
          }, 100);
        }
      }
    });

    video.addEventListener('play', () => {
      this.playStateChange.emit(true);
    });

    video.addEventListener('pause', () => {
      this.playStateChange.emit(false);
    });

    video.addEventListener('ended', () => {
      this.ended.emit();
      this.playStateChange.emit(false);
    });

    video.addEventListener('waiting', () => {
      this.isLoading = true;
    });

    video.addEventListener('canplay', () => {
      this.isLoading = false;
    });

    video.addEventListener('error', () => {
      this.hasError = true;
      this.errorMessage = 'Failed to load video';
      this.error.emit(this.errorMessage);
    });

    video.addEventListener('seeking', () => {
      this.isSeeking = true;
    });

    video.addEventListener('seeked', () => {
      this.isSeeking = false;
      this.timeUpdate.emit(video.currentTime);
    });
  }

  seekTo(time: number): void {
    if (this.videoRef?.nativeElement) {
      this.videoRef.nativeElement.currentTime = time;
    }
  }

  togglePlay(): void {
    const video = this.videoRef?.nativeElement;
    if (!video) return;

    if (video.paused) {
      video.play().catch(console.error);
    } else {
      video.pause();
    }
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  onDoubleClick(): void {
    this.doubleClick.emit();
  }
}
