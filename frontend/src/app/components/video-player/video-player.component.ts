import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule, MatTabGroup } from '@angular/material/tabs';
import { LibraryService, LibraryAnalysis, ParsedAnalysisMetadata } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';
import { VideoTimelineComponent, TimelineSection, TimelineSelection } from '../video-timeline/video-timeline.component';
import { TranscriptSearchComponent } from '../transcript-search/transcript-search.component';

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
    MatTabsModule,
    VideoTimelineComponent,
    TranscriptSearchComponent,
  ],
  templateUrl: './video-player.component.html',
  styleUrls: ['./video-player.component.scss']
})
export class VideoPlayerComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('videoElement', { static: false }) videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('tabGroup', { static: false}) tabGroup!: MatTabGroup;

  videoEl: HTMLVideoElement | null = null;
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
  previousActiveSectionIndex: number | null = null;

  // Transcript state
  transcriptText: string | null = null;
  transcriptExists = false;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: { analysis?: LibraryAnalysis; customVideo?: any },
    private dialogRef: MatDialogRef<VideoPlayerComponent>,
    private libraryService: LibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    try {
      // Only load metadata if this is an analyzed video (not a custom video)
      if (this.data.analysis) {
        // Load analysis metadata
        this.metadata = await this.libraryService.getAnalysisMetadata(this.data.analysis.id);

        // Convert sections to timeline format
        if (this.metadata?.sections) {
          this.timelineSections = this.metadata.sections.map(section => ({
            startTime: section.startSeconds,
            endTime: section.endSeconds || (section.startSeconds + 30), // Use endSeconds or default 30-second duration
            category: section.category,
            description: section.description,
            color: this.getCategoryColor(section.category) // Match AI analysis box colors
          }));
        }

        // Load transcript
        try {
          const transcriptResult = await this.libraryService.getAnalysisTranscript(this.data.analysis.id);
          this.transcriptExists = transcriptResult.exists;
          this.transcriptText = transcriptResult.text;
        } catch (error) {
          console.error('Failed to load transcript:', error);
          this.transcriptExists = false;
          this.transcriptText = null;
        }
      }
      // For custom videos, we don't have metadata or transcript
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
    // Clean up video element event listeners
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.src = '';
      this.videoEl.load();
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

      // Get native video element
      this.videoEl = this.videoElement.nativeElement;

      // Determine video source based on whether it's an analyzed video or custom video
      let videoUrl: string;

      if (this.data.customVideo) {
        // For custom videos, encode the file path in base64 and pass it as a query parameter
        const encodedPath = btoa(this.data.customVideo.videoPath);
        videoUrl = `/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
        console.log('Loading custom video from path:', this.data.customVideo.videoPath);
        console.log('Video URL:', videoUrl);
      } else if (this.data.analysis) {
        videoUrl = `/api/library/videos/${this.data.analysis.id}`;
      } else {
        this.error = 'No video source provided';
        this.isLoading = false;
        return;
      }

      // Set video source
      this.videoEl.src = videoUrl;

      // Handle loadedmetadata event
      this.videoEl.addEventListener('loadedmetadata', () => {
        this.isLoading = false;
        this.duration = this.videoEl!.duration;
        this.currentSelection = { startTime: 0, endTime: this.duration };
        console.log('Video loaded, duration:', this.duration);
      });

      // Handle timeupdate event
      this.videoEl.addEventListener('timeupdate', () => {
        this.currentTime = this.videoEl!.currentTime;
        this.updateActiveSection();
      });

      // Handle play event
      this.videoEl.addEventListener('play', () => {
        this.isPlaying = true;
      });

      // Handle pause event
      this.videoEl.addEventListener('pause', () => {
        this.isPlaying = false;
      });

      // Handle error event
      this.videoEl.addEventListener('error', (e) => {
        const videoError = this.videoEl?.error;
        console.error('Video error:', videoError);

        // Provide helpful error messages
        if (this.data.customVideo) {
          const ext = this.data.customVideo.videoPath.split('.').pop()?.toLowerCase();
          this.error = `Unable to play ${ext?.toUpperCase()} file. The video codec may not be supported. Try using a different video file or convert it to a web-compatible format.`;
        } else {
          this.error = videoError?.message || 'Failed to load video';
        }

        this.isLoading = false;
      });

      // Prevent context menu
      this.videoEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
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
    if (!this.videoEl) return;

    // Only handle if not typing in an input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    switch (event.code) {
      case 'Space':
        event.preventDefault();
        // Spacebar always resets to 1x speed and toggles play/pause
        this.videoEl.playbackRate = 1;
        if (this.videoEl.paused) {
          this.videoEl.play();
        } else {
          this.videoEl.pause();
        }
        break;

      case 'ArrowLeft':
        event.preventDefault();
        this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - 5);
        break;

      case 'ArrowRight':
        event.preventDefault();
        this.videoEl.currentTime = Math.min(this.duration, this.videoEl.currentTime + 5);
        break;

      case 'KeyF':
        event.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          this.videoEl.requestFullscreen();
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
    if (this.videoEl) {
      this.videoEl.currentTime = seconds;
      this.videoEl.play();
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

    if (currentSection !== -1 && currentSection !== this.previousActiveSectionIndex) {
      this.activeSectionIndex = currentSection;
      this.previousActiveSectionIndex = currentSection;

      // Auto-scroll to section in AI Analysis tab if it's currently open and video is playing
      if (this.isPlaying && this.tabGroup && this.tabGroup.selectedIndex === 0) {
        this.scrollToActiveSection();
      }
    } else if (currentSection === -1) {
      this.previousActiveSectionIndex = null;
    }
  }

  /**
   * Scroll to the active section in the sections list
   */
  private scrollToActiveSection() {
    // Wait for next tick to ensure DOM is updated
    setTimeout(() => {
      const activeElement = document.querySelector('.section-item.active');
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
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
    if (this.videoEl) {
      this.videoEl.currentTime = time;
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
    if (this.videoEl) {
      if (this.videoEl.paused) {
        this.videoEl.play();
      } else {
        this.videoEl.pause();
      }
    }
  }

  /**
   * Handle playback speed change from timeline (J/K/L keys)
   */
  onPlaybackSpeed(speed: number) {
    if (!this.videoEl) return;

    if (speed < 0) {
      // Backwards playback - simulate by jumping backwards repeatedly
      const absSpeed = Math.abs(speed);
      this.videoEl.pause();
      // Jump back proportional to speed (1x = 0.5s, 2x = 1s, 4x = 2s, 8x = 4s)
      const jumpAmount = 0.5 * absSpeed;
      this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - jumpAmount);
    } else if (speed === 0) {
      // Pause (K key)
      this.videoEl.pause();
      this.videoEl.playbackRate = 1; // Reset to normal speed
    } else {
      // Forward playback at specified speed (L key)
      this.videoEl.playbackRate = speed;
      if (this.videoEl.paused) {
        this.videoEl.play();
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
      hasBackdrop: true,
      backdropClass: 'dialog-backdrop',
      disableClose: false,
      data: {
        analysis: this.data.analysis,
        customVideo: this.data.customVideo,
        startTime: this.currentSelection.startTime,
        endTime: this.currentSelection.endTime
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.created) {
      const outputPath = result.extraction?.outputPath || result.clip?.outputPath;
      this.notificationService.toastOnly(
        'success',
        'Clip Created',
        'Click to open clip location',
        outputPath ? {
          type: 'open-folder',
          path: outputPath
        } : undefined
      );
    }
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getCategoryColor(category: string): string {
    if (!category) return '#757575';

    // Normalize category name for consistent matching
    const normalizedCategory = category.toLowerCase().trim();

    // Define specific colors for known categories
    const categoryColors: { [key: string]: string } = {
      'routine': '#a855f7',      // Purple
      'extremism': '#ef4444',    // Red
      'hate': '#f97316',         // Orange
      'violence': '#dc2626',     // Dark red
      'conspiracy': '#eab308',   // Yellow
      'misinformation': '#f59e0b', // Amber
      'interesting': '#3b82f6',  // Blue
      'notable': '#06b6d4',      // Cyan
      'important': '#10b981',    // Green
      'controversial': '#ec4899', // Pink
    };

    // Check if we have a specific color for this category
    if (categoryColors[normalizedCategory]) {
      return categoryColors[normalizedCategory];
    }

    // Fall back to hash-based color for unknown categories
    const colors = [
      '#ef4444', '#f97316', '#eab308', '#22c55e',
      '#3b82f6', '#a855f7', '#ec4899',
    ];

    const hash = category.split('').reduce((acc, char) => {
      return char.charCodeAt(0) + ((acc << 5) - acc);
    }, 0);

    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Handle transcript search seek event
   */
  onTranscriptSeek(timestamp: number) {
    console.log('onTranscriptSeek called with timestamp:', timestamp);
    this.seekToTime(timestamp);
  }

  /**
   * Handle run analysis request from transcript search
   */
  onRunTranscriptAnalysis() {
    this.notificationService.toastOnly('info', 'Run Analysis', 'Transcription feature coming soon!');
    // TODO: Implement transcription-only analysis trigger
  }

  /**
   * Open relink dialog to fix missing video
   */
  async relinkVideo() {
    const { RelinkDialogComponent } = await import('../relink-dialog/relink-dialog.component');

    const dialogRef = this.dialog.open(RelinkDialogComponent, {
      width: '700px',
      data: { analysis: this.data.analysis }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.relinked) {
      // Video was successfully relinked, reload the player
      this.error = null;
      this.isLoading = true;

      // Clear old video element
      if (this.videoEl) {
        this.videoEl.pause();
        this.videoEl.src = '';
      }

      // Reinitialize the player with new video path
      setTimeout(() => {
        this.initializePlayer();
      }, 100);

      this.notificationService.toastOnly('success', 'Video Relinked', 'Video has been successfully relinked!');
    }
  }
}
