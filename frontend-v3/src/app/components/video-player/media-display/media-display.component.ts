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
  selector: 'app-media-display',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './media-display.component.html',
  styleUrls: ['./media-display.component.scss']
})
export class MediaDisplayComponent implements OnChanges, AfterViewInit, OnDestroy {
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

  // Web Audio API for volume amplification beyond 100%
  private audioContext?: AudioContext;
  private gainNode?: GainNode;
  private sourceNode?: MediaElementAudioSourceNode;
  private audioInitialized: boolean = false;

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
      this.applyVolume();
    }

    if (changes['playbackRate']) {
      video.playbackRate = this.playbackRate;
    }
  }

  ngOnDestroy(): void {
    if (this.updateThrottleTimeout) {
      clearTimeout(this.updateThrottleTimeout);
    }

    // Clean up Web Audio API
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
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

  setMuted(muted: boolean): void {
    if (this.videoRef?.nativeElement) {
      this.videoRef.nativeElement.muted = muted;
    }
  }

  /**
   * Initialize Web Audio API for volume amplification beyond 100%
   * Must be called after user interaction due to browser autoplay policies
   */
  private async initAudioContext(): Promise<void> {
    if (this.audioInitialized || !this.videoRef?.nativeElement) return;

    try {
      // Create audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      // Resume if suspended (required after user interaction)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('Audio context resumed from suspended state');
      }

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();

      // Create source from video element
      this.sourceNode = this.audioContext.createMediaElementSource(this.videoRef.nativeElement);

      // Connect: video -> gain -> output
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      this.audioInitialized = true;
      console.log('Audio context initialized for volume amplification, gain ready');

      // Apply current volume
      this.applyVolume();
    } catch (err) {
      console.error('Failed to initialize audio context:', err);
    }
  }

  /**
   * Public method to ensure audio context is ready (call on user interaction)
   */
  async ensureAudioContext(): Promise<void> {
    if (!this.audioInitialized) {
      await this.initAudioContext();
    } else if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Apply volume using Web Audio API gain for amplification
   * Falls back to native volume if audio context not initialized
   */
  private applyVolume(): void {
    if (!this.videoRef?.nativeElement) return;

    const video = this.videoRef.nativeElement;

    // If volume > 1 (amplification needed), use Web Audio API
    if (this.volume > 1) {
      // Initialize audio context if needed (requires user interaction)
      if (!this.audioInitialized) {
        // Trigger async init - will apply volume when ready
        this.initAudioContext();
        // For now, just set to max native volume
        video.volume = 1;
        return;
      }

      if (this.gainNode) {
        // Set video to max native volume, use gain for amplification
        video.volume = 1;
        this.gainNode.gain.value = this.volume;
        console.log(`Volume amplified to ${Math.round(this.volume * 100)}% via gain node`);
      } else {
        // Fallback: just set to max
        video.volume = 1;
      }
    } else {
      // Normal volume (0-100%), use native control
      video.volume = this.volume;
      if (this.gainNode) {
        this.gainNode.gain.value = 1;
      }
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
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  onDoubleClick(): void {
    this.doubleClick.emit();
  }
}
