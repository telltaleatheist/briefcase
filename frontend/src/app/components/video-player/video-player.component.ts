import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { LibraryService, LibraryAnalysis, ParsedAnalysisMetadata } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';
import { VideoTimelineComponent, TimelineSection, TimelineSelection } from '../video-timeline/video-timeline.component';
import videojs from 'video.js';
import Player from 'video.js/dist/types/player';

@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatSnackBarModule,
    VideoTimelineComponent,
  ],
  templateUrl: './video-player.component.html',
  styleUrls: ['./video-player.component.scss']
})
export class VideoPlayerComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('videoElement', { static: false }) videoElement!: ElementRef<HTMLVideoElement>;

  player: Player | null = null;
  isLoading = true;
  error: string | null = null;
  metadata: ParsedAnalysisMetadata | null = null;

  // Timeline state
  currentTime = 0;
  duration = 0;
  isPlaying = false;
  timelineSections: TimelineSection[] = [];
  currentSelection: TimelineSelection = { startTime: 0, endTime: 0 };
  activeSectionIndex: number | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: { analysis: LibraryAnalysis },
    private dialogRef: MatDialogRef<VideoPlayerComponent>,
    private libraryService: LibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    try {
      // Load analysis metadata
      this.metadata = await this.libraryService.getAnalysisMetadata(this.data.analysis.id);

      // Convert sections to timeline format
      if (this.metadata?.sections) {
        this.timelineSections = this.metadata.sections.map(section => ({
          startTime: section.startSeconds,
          endTime: section.endSeconds || (section.startSeconds + 30), // Use endSeconds or default 30-second duration
          category: section.category,
          description: section.description,
          color: '#ff6600' // Use orange for all sections in dark mode
        }));
      }
    } catch (error) {
      console.error('Failed to load metadata:', error);
      this.error = 'Failed to load analysis metadata';
    }
  }

  ngAfterViewInit() {
    // Initialize Video.js player after view is ready
    setTimeout(() => {
      this.initializePlayer();
    }, 100);
  }

  ngOnDestroy() {
    // Clean up player on component destroy
    if (this.player) {
      this.player.dispose();
      this.player = null;
    }

    // Remove keyboard event listener
    document.removeEventListener('keydown', this.handleKeyPress);
  }

  initializePlayer() {
    try {
      if (!this.videoElement) {
        this.error = 'Video element not found';
        this.isLoading = false;
        return;
      }

      const videoUrl = `/api/library/videos/${this.data.analysis.id}`;

      this.player = videojs(this.videoElement.nativeElement, {
        controls: true,
        fluid: true,
        responsive: true,
        preload: 'metadata',
        playbackRates: [0.5, 1, 1.5, 2],
        sources: [{
          src: videoUrl,
          type: 'video/mp4'
        }]
      });

      // Handle player ready
      this.player.ready(() => {
        this.isLoading = false;
        console.log('Video player ready');

        // Get duration
        const dur = this.player?.duration();
        if (dur && typeof dur === 'number') {
          this.duration = dur;
          this.currentSelection = { startTime: 0, endTime: dur };
        }
      });

      // Handle time update
      this.player.on('timeupdate', () => {
        const time = this.player?.currentTime();
        if (time && typeof time === 'number') {
          this.currentTime = time;
          this.updateActiveSection();
        }
      });

      // Handle duration change
      this.player.on('loadedmetadata', () => {
        const dur = this.player?.duration();
        if (dur && typeof dur === 'number') {
          this.duration = dur;
          if (this.currentSelection.endTime === 0) {
            this.currentSelection = { startTime: 0, endTime: dur };
          }
        }
      });

      // Handle play/pause events
      this.player.on('play', () => {
        this.isPlaying = true;
      });

      this.player.on('pause', () => {
        this.isPlaying = false;
      });

      // Handle errors
      this.player.on('error', () => {
        const error = this.player?.error();
        this.error = error?.message || 'Failed to load video';
        this.isLoading = false;
        console.error('Video player error:', error);
      });

      // Handle keyboard shortcuts
      this.setupKeyboardShortcuts();

    } catch (error) {
      console.error('Failed to initialize player:', error);
      this.error = 'Failed to initialize video player';
      this.isLoading = false;
    }
  }

  setupKeyboardShortcuts() {
    // Add spacebar play/pause
    document.addEventListener('keydown', this.handleKeyPress);
  }

  handleKeyPress = (event: KeyboardEvent) => {
    if (!this.player) return;

    // Only handle if not typing in an input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    switch (event.code) {
      case 'Space':
        event.preventDefault();
        if (this.player.paused()) {
          this.player.play();
        } else {
          this.player.pause();
        }
        break;

      case 'ArrowLeft':
        event.preventDefault();
        if (this.player) {
          const currentTime = this.player.currentTime();
          if (typeof currentTime === 'number') {
            this.player.currentTime(currentTime - 5);
          }
        }
        break;

      case 'ArrowRight':
        event.preventDefault();
        if (this.player) {
          const currentTime = this.player.currentTime();
          if (typeof currentTime === 'number') {
            this.player.currentTime(currentTime + 5);
          }
        }
        break;

      case 'KeyF':
        event.preventDefault();
        if (this.player.isFullscreen()) {
          this.player.exitFullscreen();
        } else {
          this.player.requestFullscreen();
        }
        break;

      case 'KeyI':
        event.preventDefault();
        // Set In point (selection start) to current time
        this.currentSelection = {
          startTime: this.currentTime,
          endTime: Math.max(this.currentTime + 1, this.currentSelection.endTime)
        };
        break;

      case 'KeyO':
        event.preventDefault();
        // Set Out point (selection end) to current time
        this.currentSelection = {
          startTime: Math.min(this.currentSelection.startTime, this.currentTime - 1),
          endTime: this.currentTime
        };
        break;
    }
  };

  seekToTime(seconds: number, sectionIndex?: number) {
    if (this.player) {
      this.player.currentTime(seconds);
      this.player.play();
    }
    // Set active section if index provided
    if (sectionIndex !== undefined) {
      this.activeSectionIndex = sectionIndex;

      // Auto-select the section's time range
      const section = this.metadata?.sections[sectionIndex];
      if (section) {
        const endTime = section.endSeconds ||
          (this.metadata!.sections[sectionIndex + 1]?.startSeconds || this.duration);
        this.currentSelection = {
          startTime: section.startSeconds,
          endTime: endTime
        };
      }
    }
  }

  /**
   * Update active section based on current playback time
   */
  updateActiveSection() {
    if (!this.metadata?.sections) return;

    const currentSection = this.metadata.sections.findIndex((section, index) => {
      const startTime = section.startSeconds;
      const endTime = section.endSeconds ||
        (this.metadata!.sections[index + 1]?.startSeconds || this.duration);

      return this.currentTime >= startTime && this.currentTime < endTime;
    });

    if (currentSection !== -1) {
      this.activeSectionIndex = currentSection;
    }
  }

  /**
   * Check if a section is currently active
   */
  isSectionActive(index: number): boolean {
    return this.activeSectionIndex === index;
  }

  close() {
    this.dialogRef.close();
  }


  /**
   * Handle timeline seek event
   */
  onTimelineSeek(time: number) {
    if (this.player) {
      this.player.currentTime(time);
    }
  }

  /**
   * Handle timeline selection change event
   */
  onSelectionChange(selection: TimelineSelection) {
    this.currentSelection = selection;
    console.log('Selection changed:', selection);
  }

  /**
   * Handle play/pause toggle from timeline
   */
  onPlayPause() {
    if (this.player) {
      if (this.player.paused()) {
        this.player.play();
      } else {
        this.player.pause();
      }
    }
  }

  /**
   * Handle playback speed change from timeline
   */
  onPlaybackSpeed(speed: number) {
    if (!this.player) return;

    if (speed < 0) {
      // Backwards playback - Video.js doesn't support this natively
      // We'll pause and jump backwards
      this.player.pause();
      const currentTime = this.player.currentTime();
      if (typeof currentTime === 'number') {
        // Jump back 2 seconds for J key (backwards at "2x")
        this.player.currentTime(Math.max(0, currentTime - 2));
      }
    } else if (speed === 0) {
      // Pause
      this.player.pause();
      this.player.playbackRate(1); // Reset to normal speed
    } else {
      // Forward playback at specified speed
      this.player.playbackRate(Math.abs(speed));
      if (this.player.paused()) {
        this.player.play();
      }
    }
  }

  /**
   * Open create clip dialog
   */
  async openCreateClipDialog() {
    const { CreateClipDialogComponent } = await import('../create-clip-dialog/create-clip-dialog.component');

    const dialogRef = this.dialog.open(CreateClipDialogComponent, {
      width: '600px',
      data: {
        analysis: this.data.analysis,
        startTime: this.currentSelection.startTime,
        endTime: this.currentSelection.endTime
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.created) {
      this.notificationService.toastOnly('success', 'Clip Created', 'Clip created successfully!');
    }
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getCategoryColor(category: string): string {
    if (!category) return '#757575';

    const colors = [
      '#ef4444', '#f97316', '#eab308', '#22c55e',
      '#3b82f6', '#a855f7', '#ec4899',
    ];

    const hash = category.split('').reduce((acc, char) => {
      return char.charCodeAt(0) + ((acc << 5) - acc);
    }, 0);

    return colors[Math.abs(hash) % colors.length];
  }
}
