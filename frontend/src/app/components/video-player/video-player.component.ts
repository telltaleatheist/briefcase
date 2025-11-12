import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, Inject, Optional, NgZone, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule, MatTabGroup } from '@angular/material/tabs';
import { MatExpansionModule } from '@angular/material/expansion';
import { LibraryService, LibraryAnalysis, ParsedAnalysisMetadata } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';
import { DatabaseLibraryService } from '../../services/database-library.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { AnalysisQueueService } from '../../services/analysis-queue.service';
import { VideoTimelineComponent, TimelineSection, TimelineSelection } from '../video-timeline/video-timeline.component';
import { TranscriptSearchComponent } from '../transcript-search/transcript-search.component';
import { TranscriptViewerComponent } from '../transcript-viewer/transcript-viewer.component';

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
    MatExpansionModule,
    VideoTimelineComponent,
    TranscriptSearchComponent,
    TranscriptViewerComponent,
  ],
  templateUrl: './video-player.component.html',
  styleUrls: ['./video-player.component.scss']
  // Removed ChangeDetectionStrategy.OnPush - was causing dialog to reinitialize and clear video src
})
export class VideoPlayerComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('videoElement', { static: false }) videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('audioElement', { static: false }) audioElement!: ElementRef<HTMLAudioElement>;
  @ViewChild('imageElement', { static: false }) imageElement!: ElementRef<HTMLImageElement>;
  @ViewChild('tabGroup', { static: false}) tabGroup!: MatTabGroup;
  @ViewChild(VideoTimelineComponent, { static: false }) timelineComponent?: VideoTimelineComponent;

  videoEl: HTMLVideoElement | null = null;
  mediaType: string = 'video'; // 'video', 'audio', 'image', 'document', 'webpage'
  imageSrc: string | null = null;
  isLoading = true;
  error: string | null = null;
  metadata: ParsedAnalysisMetadata | null = null;
  loadingMessage = 'Loading video...';
  loadingTime = 0;
  private loadingStartTime = 0;
  private loadingProgressInterval: any = null;

  // Timeline state
  currentTime = 0;
  duration = 0;
  isPlaying = false;
  timelineSections: TimelineSection[] = [];
  currentSelection: TimelineSelection = { startTime: 0, endTime: 0 };
  activeSectionIndex: number | null = null;
  previousActiveSectionIndex: number | null = null;

  // Throttle timer for performance optimization
  private updateThrottleTimer: any = null;
  private readonly UPDATE_THROTTLE_MS = 200; // Update at most every 200ms (5 times per second)
  private seekDebounceTimer: any = null;
  private readonly SEEK_DEBOUNCE_MS = 50; // Debounce seek operations quickly
  private loadingTimeoutTimer: any = null;

  // Event listener references for cleanup
  private eventListeners: Array<{
    element: HTMLVideoElement;
    event: string;
    handler: EventListener;
  }> = [];

  // Track all timers for cleanup
  private timers: Set<any> = new Set();

  // Transcript state
  transcriptText: string | null = null;
  transcriptExists = false;

  // Auto-scroll state
  autoScrollEnabled = true;
  currentTabIndex = 0; // Track which tab is active (0=Analysis, 1=Search, 2=Transcript)

  // Track if opened as dialog or route
  isDialogMode = false;

  // Drag and drop state
  isDragOver = false;

  // Category filter state (exposed from timeline component)
  get categoryFilters() {
    return this.timelineComponent?.categoryFilters || [];
  }

  get filteredMetadataSections() {
    if (!this.metadata?.sections || this.categoryFilters.length === 0) {
      return this.metadata?.sections || [];
    }

    const enabledCategories = new Set(
      this.categoryFilters
        .filter(f => f.enabled)
        .map(f => f.category)
    );

    return this.metadata.sections.filter(section => {
      const category = section.category?.toLowerCase() || 'other';
      return enabledCategories.has(category);
    });
  }

  public data: {
    analysis?: LibraryAnalysis;
    customVideo?: any;
    videoId?: string;
    videoPath?: string;
    videoTitle?: string;
    hasAnalysis?: boolean;
    hasTranscript?: boolean;
    realFilePath?: string; // Real file path for custom videos (for backend processing)
  } = {};

  constructor(
    @Inject(MAT_DIALOG_DATA) @Optional() dialogData: any,
    @Optional() private dialogRef: MatDialogRef<VideoPlayerComponent>,
    private libraryService: LibraryService,
    private databaseLibraryService: DatabaseLibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private router: Router,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private backendUrlService: BackendUrlService,
    private http: HttpClient,
    private analysisQueueService: AnalysisQueueService
  ) {
    // If opened as dialog, use dialog data; otherwise use router state
    if (dialogData) {
      this.data = dialogData;
      this.isDialogMode = true;
    } else {
      this.isDialogMode = false;
      // Get data from router navigation state
      const navigation = this.router.getCurrentNavigation();
      const state = navigation?.extras?.state || (history.state?.navigationId ? history.state : null);

      if (state && state['videoEditorData']) {
        const routeData = state['videoEditorData'];
        this.data = {
          videoId: routeData.videoId,
          videoPath: routeData.videoPath,
          videoTitle: routeData.videoTitle
        };
      }
    }
  }

  async ngOnInit() {
    try {
      // Determine the video ID to use for loading metadata
      const videoId = this.data.videoId || this.data.analysis?.id;

      // If hasAnalysis/hasTranscript not provided, check them asynchronously
      let hasAnalysis = this.data.hasAnalysis;
      let hasTranscript = this.data.hasTranscript;

      if (videoId && (hasAnalysis === undefined || hasTranscript === undefined)) {
        // Check in parallel without blocking the rest of the component initialization
        const [analysisCheck, transcriptCheck] = await Promise.all([
          hasAnalysis !== undefined ? Promise.resolve(hasAnalysis) : this.databaseLibraryService.hasAnalysis(videoId),
          hasTranscript !== undefined ? Promise.resolve(hasTranscript) : this.databaseLibraryService.hasTranscript(videoId)
        ]);

        hasAnalysis = analysisCheck;
        hasTranscript = transcriptCheck;
      }

      // Load analysis metadata from database if this video has been analyzed
      if (videoId && hasAnalysis) {
        try {
          const dbAnalysis = await this.databaseLibraryService.getAnalysis(videoId);
          if (dbAnalysis) {
            // Parse analysis sections from the database
            const sections = await this.databaseLibraryService.getAnalysisSections(videoId);

            // Convert database sections to timeline format
            if (sections && sections.length > 0) {
              this.timelineSections = sections.map(section => ({
                startTime: section.start_seconds,
                endTime: section.end_seconds || (section.start_seconds + 30),
                category: section.category || 'General',
                description: section.description || section.title || '',
                color: this.getCategoryColor(section.category || 'General')
              }));

              // Build metadata object for display
              this.metadata = {
                sections: sections.map(s => ({
                  startSeconds: s.start_seconds,
                  endSeconds: s.end_seconds,
                  timeRange: this.formatTimeRange(s.start_seconds, s.end_seconds),
                  category: s.category || 'General',
                  description: s.description || s.title || '',
                  quotes: [] // Database doesn't store quotes separately
                }))
              } as any;
            }
          }
        } catch (error) {
          console.warn('Failed to load analysis metadata (video may only have transcript):', error);
          this.metadata = null;
        }
      }

      // Load transcript from database if available
      if (videoId && hasTranscript) {
        try {
          const dbTranscript = await this.databaseLibraryService.getTranscript(videoId);
          if (dbTranscript && dbTranscript.srt_format) {
            // Use SRT format from database (includes timestamps for seeking)
            // The transcript search component needs timestamps to enable jump-to-time functionality
            this.transcriptText = dbTranscript.srt_format;
            this.transcriptExists = !!(this.transcriptText && this.transcriptText.trim().length > 0);
          } else {
            this.transcriptExists = false;
            this.transcriptText = null;
          }
        } catch (error) {
          console.error('Failed to load transcript:', error);
          this.transcriptExists = false;
          this.transcriptText = null;
        }
      }
      // For custom videos or videos without analysis/transcript, we don't have metadata or transcript
    } catch (error) {
      console.error('Failed to initialize video player:', error);
      // Don't set this.error here - let the video try to load anyway
      // Only critical errors should prevent video playback
    }
  }

  ngAfterViewInit() {
    // Get media element reference (video or audio) immediately so keyboard shortcuts work from the start
    if (this.videoElement) {
      this.videoEl = this.videoElement.nativeElement;
    } else if (this.audioElement) {
      this.videoEl = this.audioElement.nativeElement as any; // Audio and video elements have same API
    }

    // Set up keyboard shortcuts immediately so spacebar works from the start
    this.setupKeyboardShortcuts();

    // Initialize media player after view is ready
    setTimeout(() => {
      this.initializePlayer();
    }, 100);
  }

  /**
   * Open document or webpage in external application
   */
  openInExternalApp() {
    const electron = (window as any).electron;
    if (electron && this.data.videoPath) {
      electron.shell.openPath(this.data.videoPath);
    }
  }

  ngOnDestroy() {
    console.log('[ngOnDestroy] Cleaning up video player');

    // Remove all video event listeners
    this.eventListeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this.eventListeners = [];

    // Clean up video element
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.src = '';
      this.videoEl.load();
      this.videoEl = null;
    }

    // Keyboard listener is now on component element, no need to remove global listener

    // Clear ALL tracked timers
    this.timers.forEach(timer => {
      clearTimeout(timer);
      clearInterval(timer);
    });
    this.timers.clear();

    // Clear specific timers
    if (this.updateThrottleTimer) {
      clearTimeout(this.updateThrottleTimer);
      this.updateThrottleTimer = null;
    }

    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }

    if (this.loadingTimeoutTimer) {
      clearTimeout(this.loadingTimeoutTimer);
      this.loadingTimeoutTimer = null;
    }

    if (this.loadingProgressInterval) {
      clearInterval(this.loadingProgressInterval);
      this.loadingProgressInterval = null;
    }
  }

  /**
   * Add event listener and track it for cleanup
   */
  private addVideoEventListener(event: string, handler: EventListener) {
    if (this.videoEl) {
      this.videoEl.addEventListener(event, handler);
      this.eventListeners.push({ element: this.videoEl, event, handler });
    }
  }

  /**
   * Clean up video resources (listeners and timers) but keep the component alive
   */
  private cleanupVideoResources() {
    console.log('[cleanupVideoResources] Cleaning up old resources');

    // Remove all video event listeners
    this.eventListeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this.eventListeners = [];

    // Clear all tracked timers
    this.timers.forEach(timer => {
      clearTimeout(timer);
      clearInterval(timer);
    });
    this.timers.clear();

    // Clear specific timers
    if (this.updateThrottleTimer) {
      clearTimeout(this.updateThrottleTimer);
      this.updateThrottleTimer = null;
    }

    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }

    if (this.loadingTimeoutTimer) {
      clearTimeout(this.loadingTimeoutTimer);
      this.loadingTimeoutTimer = null;
    }

    if (this.loadingProgressInterval) {
      clearInterval(this.loadingProgressInterval);
      this.loadingProgressInterval = null;
    }

    // Pause and reset video element if it exists
    if (this.videoEl) {
      this.videoEl.pause();
      // Don't clear src or set to null - we'll reuse the element
    }
  }

  async initializePlayer() {
    console.log('[initializePlayer] Starting initialization');

    // Clean up any existing listeners and timers from previous video
    this.cleanupVideoResources();

    try {
      // Detect media type from database if we have a videoId
      if (this.data.videoId) {
        try {
          const video = await this.databaseLibraryService.getVideoById(this.data.videoId);
          if (video) {
            this.mediaType = video.media_type || 'video';
            console.log('[initializePlayer] Detected media type:', this.mediaType);

            // For images, set the image source
            if (this.mediaType === 'image' && video.current_path) {
              const backendUrl = await this.backendUrlService.getBackendUrl();
              const encodedPath = btoa(unescape(encodeURIComponent(video.current_path)));
              this.imageSrc = `${backendUrl}/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
            }

            // For documents/webpages, no player initialization needed
            if (this.mediaType === 'document' || this.mediaType === 'webpage') {
              this.isLoading = false;
              return;
            }
          }
        } catch (error) {
          console.warn('Failed to detect media type, defaulting to video:', error);
        }
      }

      // Check for appropriate element based on media type
      if (this.mediaType === 'image') {
        if (!this.imageElement) {
          this.error = 'Image element not found';
          this.isLoading = false;
          return;
        }
        // Images don't need player initialization
        this.isLoading = false;
        return;
      } else if (this.mediaType === 'audio') {
        if (!this.audioElement) {
          this.error = 'Audio element not found';
          this.isLoading = false;
          return;
        }
        // Get native audio element
        this.videoEl = this.audioElement.nativeElement as any;
        console.log('[initializePlayer] Audio element obtained');
      } else {
        // Default to video
        if (!this.videoElement) {
          this.error = 'Video element not found';
          this.isLoading = false;
          return;
        }
        // Get native video element
        this.videoEl = this.videoElement.nativeElement;
        console.log('[initializePlayer] Video element obtained');
      }

      // Get backend URL first
      const backendUrl = await this.backendUrlService.getBackendUrl();
      console.log('[initializePlayer] Backend URL:', backendUrl);

      // Determine media source based on whether it's an analyzed video, custom video, or library video
      let videoUrl: string;

      if (this.data.customVideo) {
        // For custom videos, encode the file path in base64 and pass it as a query parameter
        const encodedPath = btoa(unescape(encodeURIComponent(this.data.customVideo.videoPath)));
        videoUrl = `${backendUrl}/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
        console.log('Loading custom video from path:', this.data.customVideo.videoPath);
        console.log('Video URL:', videoUrl);
      } else if (this.data.videoPath) {
        // For library videos, encode the file path in base64 and pass it as a query parameter
        const encodedPath = btoa(unescape(encodeURIComponent(this.data.videoPath)));
        videoUrl = `${backendUrl}/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
        console.log('Loading library video from path:', this.data.videoPath);
        console.log('Video URL:', videoUrl);
      } else if (this.data.analysis) {
        videoUrl = `${backendUrl}/api/library/videos/${this.data.analysis.id}`;
      } else if (this.data.videoId) {
        videoUrl = `${backendUrl}/api/library/videos/${this.data.videoId}`;
      } else {
        this.error = 'No video source provided';
        this.isLoading = false;
        return;
      }

      // Set video source
      if (!this.videoEl) {
        this.error = 'Video element not initialized';
        this.isLoading = false;
        return;
      }
      this.videoEl.src = videoUrl;
      console.log('Video source set to:', videoUrl);

      // Start loading timer
      this.loadingStartTime = Date.now();
      this.loadingTime = 0;
      this.loadingMessage = 'Loading video...';
      this.cdr.markForCheck();

      // Update loading message every second
      this.loadingProgressInterval = setInterval(() => {
        if (this.isLoading) {
          this.loadingTime = Math.floor((Date.now() - this.loadingStartTime) / 1000);
          this.loadingMessage = `Loading video... (${this.loadingTime}s)`;
          this.cdr.markForCheck();
        } else {
          if (this.loadingProgressInterval) {
            clearInterval(this.loadingProgressInterval);
            this.timers.delete(this.loadingProgressInterval);
          }
        }
      }, 1000);
      this.timers.add(this.loadingProgressInterval);

      // Add loading timeout (30 seconds)
      this.loadingTimeoutTimer = setTimeout(() => {
        if (this.isLoading) {
          console.error('Video loading timeout after 30 seconds');
          this.isLoading = false;

          // Check if video is actually playable despite slow metadata loading
          if (this.videoEl && this.videoEl.readyState >= 2) {
            console.log('Video data loaded, forcing playback despite slow metadata');
            this.duration = this.videoEl.duration || 0;
            this.currentSelection = { startTime: 0, endTime: this.duration };
            this.cdr.markForCheck();
          } else {
            this.error = 'Video loading timeout. The video file may use an unsupported codec. Try converting to MP4.';
            this.cdr.markForCheck();
          }
        }
      }, 30000);
      this.timers.add(this.loadingTimeoutTimer);

      // Handle loadedmetadata event
      this.addVideoEventListener('loadedmetadata', () => {
        if (this.loadingTimeoutTimer) {
          clearTimeout(this.loadingTimeoutTimer);
          this.timers.delete(this.loadingTimeoutTimer);
        }
        // Run in NgZone to trigger change detection
        this.ngZone.run(() => {
          this.isLoading = false;
          this.duration = this.videoEl!.duration;
          this.currentSelection = { startTime: 0, endTime: this.duration };
          console.log('Video loaded, duration:', this.duration);
        });
      });

      // Handle loadeddata event (fires earlier than loadedmetadata)
      this.addVideoEventListener('loadeddata', () => {
        console.log('Video data loaded (readyState:', this.videoEl!.readyState, ')');
        // If metadata still not loaded after data is available, try to force it
        if (this.isLoading && this.videoEl!.duration) {
          if (this.loadingTimeoutTimer) {
            clearTimeout(this.loadingTimeoutTimer);
            this.timers.delete(this.loadingTimeoutTimer);
          }
          // Run in NgZone to trigger change detection
          this.ngZone.run(() => {
            this.isLoading = false;
            this.duration = this.videoEl!.duration;
            this.currentSelection = { startTime: 0, endTime: this.duration };
            console.log('Using duration from loadeddata event:', this.duration);
          });
        }
      });

      // Handle timeupdate event with throttling for performance
      this.addVideoEventListener('timeupdate', () => {
        this.currentTime = this.videoEl!.currentTime;

        // Throttle updateActiveSection to avoid excessive DOM operations
        if (!this.updateThrottleTimer) {
          this.updateThrottleTimer = setTimeout(() => {
            this.updateActiveSection();
            this.updateThrottleTimer = null;
          }, this.UPDATE_THROTTLE_MS);
        }
      });

      // Handle play event
      this.addVideoEventListener('play', () => {
        this.isPlaying = true;
      });

      // Handle pause event
      this.addVideoEventListener('pause', () => {
        this.isPlaying = false;
      });

      // Handle error event
      this.addVideoEventListener('error', (e) => {
        const videoError = this.videoEl?.error;
        console.error('Video error:', videoError);
        console.error('Error code:', videoError?.code);
        console.error('Error message:', videoError?.message);
        console.error('Video src:', this.videoEl?.src);
        console.error('Video readyState:', this.videoEl?.readyState);
        console.error('Video networkState:', this.videoEl?.networkState);

        // MediaError codes:
        // 1 = MEDIA_ERR_ABORTED - fetching process aborted by user
        // 2 = MEDIA_ERR_NETWORK - error occurred when downloading
        // 3 = MEDIA_ERR_DECODE - error occurred when decoding
        // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED - video format not supported

        let errorMessage = 'Failed to load video';
        if (videoError?.code === 3) {
          errorMessage = 'Video codec not supported by browser. The .MOV file may use a codec (like ProRes or H.265) that HTML5 video cannot decode. Try converting to H.264 MP4.';
        } else if (videoError?.code === 4) {
          errorMessage = 'Video format not supported. Try converting to MP4 with H.264 codec.';
        } else if (videoError?.code === 2) {
          errorMessage = 'Network error while loading video. Please check the file path and try again.';
        } else if (videoError?.code === 1) {
          errorMessage = 'Video loading was aborted.';
        }

        this.error = errorMessage;
        this.isLoading = false;
        this.cdr.markForCheck();
      });

      // Prevent context menu
      this.addVideoEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
      });

    } catch (error) {
      console.error('Failed to initialize player:', error);
      this.error = 'Failed to initialize video player';
      this.isLoading = false;
    }
  }

  setupKeyboardShortcuts() {
    // Keyboard shortcuts are now handled via (keydown) binding on the component root element
    // No need for global document listener
  }

  handleKeyPress = (event: KeyboardEvent) => {
    if (!this.videoEl) return;

    // Only handle if not typing in an input
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('.mat-mdc-input-element') ||
        target.classList.contains('mat-mdc-input-element')) {
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
        // Debounce seeking to prevent freezing during rapid key presses
        if (this.seekDebounceTimer) {
          clearTimeout(this.seekDebounceTimer);
        }
        const newTimeLeft = Math.max(0, this.videoEl.currentTime - 5);
        this.seekDebounceTimer = setTimeout(() => {
          if (this.videoEl) {
            this.videoEl.currentTime = newTimeLeft;
          }
        }, this.SEEK_DEBOUNCE_MS);
        break;

      case 'ArrowRight':
        event.preventDefault();
        // Debounce seeking to prevent freezing during rapid key presses
        if (this.seekDebounceTimer) {
          clearTimeout(this.seekDebounceTimer);
        }
        const newTimeRight = Math.min(this.duration, this.videoEl.currentTime + 5);
        this.seekDebounceTimer = setTimeout(() => {
          if (this.videoEl) {
            this.videoEl.currentTime = newTimeRight;
          }
        }, this.SEEK_DEBOUNCE_MS);
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
    if (sectionIndex !== undefined && this.metadata?.sections) {
      // Verify the index is within bounds
      if (sectionIndex >= 0 && sectionIndex < this.metadata.sections.length) {
        this.activeSectionIndex = sectionIndex;

        // Auto-select the section's time range
        const section = this.metadata.sections[sectionIndex];
        if (section) {
          const endTime = section.endSeconds ||
            (this.metadata.sections[sectionIndex + 1]?.startSeconds || this.duration);
          this.currentSelection = {
            startTime: section.startSeconds,
            endTime: endTime
          };
        }
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

      // Auto-scroll to section in AI Analysis tab if it's currently open (works during playback AND scrubbing)
      if (this.tabGroup && this.tabGroup.selectedIndex === 0) {
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
    // Only auto-scroll if enabled
    if (!this.autoScrollEnabled) return;

    // Wait for next tick to ensure DOM is updated
    setTimeout(() => {
      const activeElement = document.querySelector('.section-item.active');
      if (activeElement) {
        // Use instant scrolling instead of smooth to reduce performance impact
        activeElement.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      }
    }, 100);
  }

  /**
   * Toggle auto-scroll for AI analysis and transcript
   */
  toggleAutoScroll() {
    this.autoScrollEnabled = !this.autoScrollEnabled;
  }

  /**
   * Handle tab change to track which tab is active
   */
  onTabChange(event: any) {
    this.currentTabIndex = event.index;
  }

  /**
   * Get dynamic tooltip text based on current tab
   */
  getAutoScrollTooltip(): string {
    if (!this.autoScrollEnabled) {
      return 'Auto-scroll: OFF - Click to enable scrolling with video playback';
    }

    switch (this.currentTabIndex) {
      case 0: // Analysis tab
        return 'Auto-scroll: ON - Analysis sections will scroll with video playback';
      case 1: // Search tab
        return 'Auto-scroll: ON - (Search tab does not auto-scroll)';
      case 2: // Transcript tab
        return 'Auto-scroll: ON - Transcript will scroll with video playback';
      default:
        return 'Auto-scroll: ON - Content will scroll with video playback';
    }
  }

  /**
   * Get dynamic label text based on current tab
   */
  getAutoScrollLabel(): string {
    if (!this.autoScrollEnabled) {
      return 'Auto-scroll disabled';
    }

    switch (this.currentTabIndex) {
      case 0: // Analysis tab
        return 'Auto-scroll: Analysis';
      case 1: // Search tab
        return 'Auto-scroll enabled (N/A for search)';
      case 2: // Transcript tab
        return 'Auto-scroll: Transcript';
      default:
        return 'Auto-scroll enabled';
    }
  }

  /**
   * Check if a section is currently active
   */
  isSectionActive(index: number): boolean {
    return this.activeSectionIndex === index;
  }

  close() {
    if (this.dialogRef) {
      // Opened as dialog - close it
      this.dialogRef.close();
    } else {
      // Opened as route - navigate back to library
      this.router.navigate(['/library']);
    }
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
    // If we have a videoPath but no analysis or customVideo, create a customVideo object
    let customVideoData = this.data.customVideo;
    if (!this.data.analysis && !this.data.customVideo && this.data.videoPath) {
      customVideoData = {
        videoPath: this.data.videoPath,
        title: this.data.videoTitle || 'Video'
      };
    }

    // For custom videos with real file paths (dragged/dropped files), ensure we pass the real path
    if (customVideoData && this.data.realFilePath) {
      customVideoData = {
        ...customVideoData,
        realFilePath: this.data.realFilePath
      };
    }

    // Import and open the CreateClipDialogComponent as a modal
    const { CreateClipDialogComponent } = await import('../create-clip-dialog/create-clip-dialog.component');

    const dialogRef = this.dialog.open(CreateClipDialogComponent, {
      width: '600px',
      data: {
        analysis: this.data.analysis,
        customVideo: customVideoData,
        startTime: this.currentSelection.startTime,
        endTime: this.currentSelection.endTime
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.created) {
      console.log('[VideoPlayer] Clip created, result:', result);

      // If the clip is queued for background processing, don't show a notification yet
      // The notification will be shown when the background processing completes
      if (result.queued) {
        console.log('[VideoPlayer] Clip queued for background processing, skipping immediate notification');
        return;
      }

      // Check if we have a videoId (from import) to navigate to
      const videoId = result.videoId;
      console.log('[VideoPlayer] VideoId:', videoId);

      if (videoId) {
        console.log('[VideoPlayer] Showing navigation notification');
        // If the clip was imported to the library, offer navigation
        this.notificationService.toastOnly(
          'success',
          'Clip Created',
          'Click to view in library',
          {
            type: 'navigate-library',
            videoId: videoId
          }
        );
      } else {
        console.log('[VideoPlayer] No videoId, showing folder notification');
        // Otherwise, just offer to open the folder
        this.notificationService.toastOnly(
          'success',
          'Clip Created',
          `Clip saved to: ${result.extraction?.outputPath || 'clips folder'}`,
          {
            type: 'open-folder',
            path: result.extraction?.outputPath
          }
        );
      }
    }
  }

  async openAddMarkerDialog() {
    const videoId = this.data.videoId || this.data.analysis?.id;

    if (!videoId) {
      this.notificationService.toastOnly('error', 'Error', 'No video ID available for marker creation');
      return;
    }

    // Import and open the AddMarkerDialogComponent as a modal
    const { AddMarkerDialogComponent } = await import('../add-marker-dialog/add-marker-dialog.component');

    const dialogRef = this.dialog.open(AddMarkerDialogComponent, {
      width: '600px',
      data: {
        videoId: videoId,
        videoTitle: this.data.videoTitle || 'Video',
        startTime: this.currentSelection.startTime,
        endTime: this.currentSelection.endTime
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.created) {
      // Reload timeline sections to show the new marker
      await this.reloadAnalysisSections();

      // Show success notification with action to navigate to library
      this.notificationService.toastOnly(
        'success',
        'Marker Created',
        'New marker has been added to the timeline',
        {
          type: 'navigate-library',
          videoId: videoId
        }
      );
    }
  }

  /**
   * Reload analysis sections from database
   */
  private async reloadAnalysisSections() {
    const videoId = this.data.videoId || this.data.analysis?.id;
    if (!videoId) return;

    try {
      const sections = await this.databaseLibraryService.getAnalysisSections(videoId);

      if (sections && sections.length > 0) {
        this.timelineSections = sections.map(section => ({
          startTime: section.start_seconds,
          endTime: section.end_seconds || (section.start_seconds + 30),
          category: section.category || 'General',
          description: section.description || section.title || '',
          color: this.getCategoryColor(section.category || 'General')
        }));

        // Also update metadata for sidebar display
        this.metadata = {
          sections: sections.map(s => ({
            startSeconds: s.start_seconds,
            endSeconds: s.end_seconds,
            timeRange: this.formatTimeRange(s.start_seconds, s.end_seconds || s.start_seconds),
            category: s.category || 'General',
            description: s.description || s.title || '',
            quotes: []
          }))
        } as any;
      } else {
        // No sections left
        this.timelineSections = [];
        if (this.metadata) {
          this.metadata.sections = [];
        }
      }

      this.cdr.detectChanges();
    } catch (error) {
      console.error('Failed to reload analysis sections:', error);
    }
  }

  /**
   * Delete an analysis section
   */
  async deleteSection(section: any, index: number) {
    const videoId = this.data.videoId || this.data.analysis?.id;
    if (!videoId) {
      this.notificationService.toastOnly('error', 'Error', 'No video ID available');
      return;
    }

    // Find the actual database section ID
    // We need to get all sections from the database to find the matching one
    try {
      const dbSections = await this.databaseLibraryService.getAnalysisSections(videoId);
      const matchingSection = dbSections.find(s =>
        s.start_seconds === section.startSeconds &&
        s.category === section.category &&
        s.description === section.description
      );

      if (!matchingSection) {
        this.notificationService.toastOnly('error', 'Error', 'Could not find section to delete');
        return;
      }

      // Delete the section from the database
      const result = await this.databaseLibraryService.deleteAnalysisSection(videoId, matchingSection.id);

      if (result.success) {
        // Reload all sections to refresh the UI
        await this.reloadAnalysisSections();
      } else {
        this.notificationService.toastOnly('error', 'Delete Failed', result.error || 'Failed to delete section');
      }
    } catch (error) {
      console.error('Error deleting section:', error);
      this.notificationService.toastOnly('error', 'Delete Failed', 'An error occurred while deleting');
    }
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  formatTimeRange(startSeconds: number, endSeconds: number): string {
    return `${this.formatTime(startSeconds)} - ${this.formatTime(endSeconds)}`;
  }

  /**
   * Toggle category filter
   */
  toggleCategoryFilter(category: string) {
    if (this.timelineComponent) {
      this.timelineComponent.toggleCategoryFilter(category);
    }
  }

  /**
   * Open bulk export dialog with filtered sections
   */
  async openBulkExport() {
    const videoId = this.data.videoId || this.data.analysis?.id;
    if (!videoId) {
      this.notificationService.toastOnly('error', 'Error', 'No video ID available');
      return;
    }

    const videoPath = this.data.videoPath || this.data.analysis?.video.currentPath;
    if (!videoPath) {
      this.notificationService.toastOnly('error', 'Error', 'No video path available');
      return;
    }

    // Get the filtered sections from the database
    const dbSections = await this.databaseLibraryService.getAnalysisSections(videoId);

    // Filter sections based on active category filters
    const enabledCategories = new Set(
      this.categoryFilters
        .filter(f => f.enabled)
        .map(f => f.category)
    );

    const filteredSections = dbSections.filter(section => {
      const category = section.category?.toLowerCase() || 'other';
      return enabledCategories.has(category);
    });

    if (filteredSections.length === 0) {
      this.notificationService.toastOnly('info', 'No Clips', 'No sections match the current filter');
      return;
    }

    // Import and open the BulkExportDialogComponent
    const { BulkExportDialogComponent } = await import('../bulk-export-dialog/bulk-export-dialog.component');

    const dialogRef = this.dialog.open(BulkExportDialogComponent, {
      width: '600px',
      data: {
        videoId: videoId,
        videoPath: videoPath,
        sections: filteredSections
      }
    });

    await dialogRef.afterClosed().toPromise();
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
      'custom': '#22c55e',       // Bright green - User-created markers
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
   * This directly starts transcription without prompting for AI analysis
   */
  async onRunTranscriptAnalysis() {
    // Get video details
    const videoId = this.data.videoId || this.data.analysis?.id;
    const videoPath = this.data.analysis?.video?.currentPath || this.data.videoPath;
    const videoTitle = this.data.analysis?.title || this.data.videoTitle || 'Unknown';

    if (!videoPath) {
      this.notificationService.toastOnly('error', 'Error', 'No video path available for transcription');
      return;
    }

    // Add to analysis queue (transcribe-only mode)
    this.analysisQueueService.addPendingJob({
      input: videoPath,
      inputType: 'file',
      mode: 'transcribe-only',
      aiModel: 'ollama:qwen2.5:7b',
      whisperModel: 'base',
      language: 'en',
      customInstructions: '',
      displayName: videoTitle,
      videoId: videoId,
      loading: false
    });

    this.notificationService.toastOnly(
      'success',
      'Added to Queue',
      'Video transcription has been added to the analysis queue. Click the queue button in the header to start processing.'
    );
  }

  /**
   * Generate AI analysis and/or transcript for this video
   */
  async generateAnalysis() {
    // Get video details
    const videoId = this.data.videoId || this.data.analysis?.id;
    let videoPath = this.data.analysis?.video?.currentPath || this.data.videoPath || this.data.realFilePath;
    const videoTitle = this.data.analysis?.title || this.data.videoTitle || this.data.customVideo?.title || 'Unknown';

    // For custom/dropped videos, use the real file path
    if (this.data.customVideo?.videoPath || (this.data.videoPath && !this.data.videoId)) {
      videoPath = this.data.realFilePath || this.data.videoPath;
    }

    // Check if we have a valid file path (not a blob URL)
    if (!videoPath || videoPath.startsWith('blob:')) {
      this.notificationService.toastOnly(
        'error',
        'Cannot Analyze',
        'Unable to get file path for this video. Please import the video to the library first.'
      );
      return;
    }

    // Add to analysis queue (full analysis mode)
    this.analysisQueueService.addPendingJob({
      input: videoPath,
      inputType: 'file',
      mode: 'full',
      aiModel: 'ollama:qwen2.5:7b',
      whisperModel: 'base',
      language: 'en',
      customInstructions: '',
      displayName: videoTitle,
      videoId: videoId,
      loading: false
    });

    this.notificationService.toastOnly(
      'success',
      'Added to Queue',
      'Video has been added to the analysis queue. Click the queue button in the header to start processing.'
    );
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

  /**
   * Handle drag over event
   */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
  }

  /**
   * Handle drag leave event
   */
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
  }

  /**
   * Handle drop event
   */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.loadVideoFile(files[0]);
    }
  }

  /**
   * Handle file selection from input
   */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.loadVideoFile(input.files[0]);
    }
  }

  /**
   * Load a video from the database with its analysis and transcript data
   */
  private async loadExistingVideoFromDatabase(response: any, filePath: string): Promise<void> {
    const video = response.video;
    const analysis = response.analysis;
    const transcript = response.transcript;
    const sections = response.sections;

    console.log('Loading existing video from database:', {
      videoId: video.id,
      mediaType: video.media_type,
      hasAnalysis: !!analysis,
      hasTranscript: !!transcript,
      sectionsCount: sections?.length || 0
    });

    // Set media type from database
    this.mediaType = video.media_type || 'video';

    // Update component data to use the database video
    this.data = {
      videoId: video.id,
      videoPath: filePath,
      videoTitle: video.filename,
      hasAnalysis: !!analysis,
      hasTranscript: !!transcript
    };

    // Parse and load analysis metadata if available
    if (analysis) {
      try {
        // Convert database sections to timeline format
        if (sections && sections.length > 0) {
          this.timelineSections = sections.map((section: any) => ({
            startTime: section.start_seconds,
            endTime: section.end_seconds || (section.start_seconds + 30),
            category: section.category || 'General',
            description: section.description || section.title || '',
            color: this.getCategoryColor(section.category || 'General')
          }));

          // Build metadata object for display
          this.metadata = {
            sections: sections.map((s: any) => ({
              startSeconds: s.start_seconds,
              endSeconds: s.end_seconds,
              timeRange: this.formatTimeRange(s.start_seconds, s.end_seconds),
              category: s.category || 'General',
              description: s.description || s.title || '',
              quotes: [] // Database doesn't store quotes separately
            }))
          } as any;
        }

        console.log('Loaded analysis with', this.timelineSections.length, 'sections');
      } catch (error) {
        console.error('Failed to parse analysis metadata:', error);
      }
    }

    // Load transcript if available
    if (transcript) {
      try {
        // Use SRT format from database if available (includes timestamps for seeking)
        // Otherwise fall back to plain text
        this.transcriptText = transcript.srt_format || transcript.plain_text;
        this.transcriptExists = !!(this.transcriptText && this.transcriptText.trim().length > 0);
        console.log('Loaded transcript');
      } catch (error) {
        console.error('Failed to load transcript:', error);
      }
    }

    // Now initialize the video player using the normal flow
    // This will use the videoPath we set in this.data
    this.initializePlayer();
  }

  /**
   * Setup event listeners for video element
   */
  private setupVideoEventListeners(): void {
    if (!this.videoEl) return;

    // Handle loadedmetadata event
    this.addVideoEventListener('loadedmetadata', () => {
      this.cleanupLoadingTimers();
      // Run in NgZone to trigger change detection
      this.ngZone.run(() => {
        this.isLoading = false;
        this.duration = this.videoEl!.duration;
        this.currentSelection = { startTime: 0, endTime: this.duration };
        console.log('Video loaded, duration:', this.duration);
      });
    });

    // Handle loadeddata event (fires earlier than loadedmetadata)
    this.addVideoEventListener('loadeddata', () => {
      console.log('Video data loaded (readyState:', this.videoEl!.readyState, ')');
      // If metadata still not loaded after data is available, try to force it
      if (this.isLoading && this.videoEl!.duration) {
        this.cleanupLoadingTimers();
        // Run in NgZone to trigger change detection
        this.ngZone.run(() => {
          this.isLoading = false;
          this.duration = this.videoEl!.duration;
          this.currentSelection = { startTime: 0, endTime: this.duration };
          console.log('Using duration from loadeddata event:', this.duration);
        });
      }
    });

    // Handle timeupdate event with throttling for performance
    this.addVideoEventListener('timeupdate', () => {
      this.currentTime = this.videoEl!.currentTime;

      // Throttle updateActiveSection to avoid excessive DOM operations
      if (!this.updateThrottleTimer) {
        this.updateThrottleTimer = setTimeout(() => {
          this.updateActiveSection();
          this.updateThrottleTimer = null;
        }, this.UPDATE_THROTTLE_MS);
      }
    });

    // Handle play event
    this.addVideoEventListener('play', () => {
      this.isPlaying = true;
    });

    // Handle pause event
    this.addVideoEventListener('pause', () => {
      this.isPlaying = false;
    });

    // Handle error event
    this.addVideoEventListener('error', (e: any) => {
      console.error('Video error event:', e, this.videoEl?.error);
      this.cleanupLoadingTimers();

      // Run in NgZone to trigger change detection
      this.ngZone.run(() => {
        this.isLoading = false;
        const errorCode = this.videoEl?.error?.code;
        const errorMessage = this.videoEl?.error?.message || 'Unknown error';

        switch (errorCode) {
          case 1: // MEDIA_ERR_ABORTED
            this.error = 'Video loading was aborted';
            break;
          case 2: // MEDIA_ERR_NETWORK
            this.error = 'Network error while loading video';
            break;
          case 3: // MEDIA_ERR_DECODE
            this.error = 'Video decoding failed. The file may be corrupted or use an unsupported codec.';
            break;
          case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
            this.error = 'Video format not supported';
            break;
          default:
            this.error = `Video error: ${errorMessage}`;
        }
      });
    });
  }

  /**
   * Load a video file from disk
   */
  private async loadVideoFile(file: File): Promise<void> {
    // Validate file type
    if (!file.type.startsWith('video/')) {
      this.notificationService.toastOnly('error', 'Invalid File', 'Please select a valid video file');
      return;
    }

    // Clear any existing errors
    this.error = null;
    this.isLoading = true;
    this.loadingMessage = 'Checking if video exists in database...';

    // Try to get the real file path (only works in Electron)
    const electron = (window as any).electron;
    let filePath: string | null = null;

    if (electron && electron.getFilePathFromFile) {
      try {
        filePath = electron.getFilePathFromFile(file);
        console.log('Got file path from Electron:', filePath);
      } catch (error) {
        console.warn('Failed to get file path from Electron:', error);
      }
    }

    // If we have a file path, check if this video exists in the database
    if (filePath) {
      try {
        const url = await this.backendUrlService.getApiUrl('/database/videos/lookup-by-file');
        const response = await this.http.post<any>(url, { filePath }).toPromise();

        if (response?.success && response.found) {
          // Video exists in database! Load it with its analysis and transcript
          console.log('Video found in database:', response.video);

          this.notificationService.toastOnly(
            'info',
            'Video Found in Library',
            'Loading existing analysis and transcript data...'
          );

          // Load the video from the database with all its metadata
          await this.loadExistingVideoFromDatabase(response, filePath);
          return;
        } else {
          console.log('Video not found in database, loading as new video');
        }
      } catch (error) {
        console.error('Error checking if video exists in database:', error);
        // Continue loading as a new video if lookup fails
      }
    }

    // Video not in database or no file path - load as custom video
    this.loadingMessage = 'Loading video...';

    // Create object URL for the file (for browser playback)
    const videoUrl = URL.createObjectURL(file);

    // Update data to reflect custom video
    this.data = {
      ...this.data,
      customVideo: {
        title: file.name,
        videoPath: videoUrl, // Blob URL for browser playback
        isLocalFile: true
      },
      videoTitle: file.name,
      realFilePath: filePath || undefined // Real file path for backend processing (if available)
    };

    // Clean up any existing listeners and timers from previous video
    this.cleanupVideoResources();

    // Initialize video element if not already done
    if (!this.videoEl && this.videoElement) {
      this.videoEl = this.videoElement.nativeElement;
    }

    if (this.videoEl) {
      // Set video source
      this.videoEl.src = videoUrl;

      // Start loading timer
      this.loadingStartTime = Date.now();
      this.loadingTime = 0;
      this.loadingMessage = 'Loading video...';

      // Update loading message every second
      this.loadingProgressInterval = setInterval(() => {
        if (this.isLoading) {
          this.loadingTime = Math.floor((Date.now() - this.loadingStartTime) / 1000);
          this.loadingMessage = `Loading video... (${this.loadingTime}s)`;
          this.cdr.markForCheck();
        } else {
          this.cleanupLoadingTimers();
        }
      }, 1000);
      this.timers.add(this.loadingProgressInterval);

      // Add loading timeout (30 seconds)
      this.loadingTimeoutTimer = setTimeout(() => {
        if (this.isLoading) {
          this.error = 'Video loading timed out. The file may be corrupted or use an unsupported codec.';
          this.isLoading = false;
          this.cleanupLoadingTimers();
          this.cdr.markForCheck();
        }
      }, 30000);
      this.timers.add(this.loadingTimeoutTimer);

      // Setup video event listeners
      this.setupVideoEventListeners();
    }
  }

  /**
   * Get the current media element (video or audio) for waveform generation
   */
  getMediaElement(): HTMLVideoElement | HTMLAudioElement | undefined {
    if (this.mediaType === 'audio' && this.audioElement) {
      return this.audioElement.nativeElement;
    } else if (this.mediaType === 'video' && this.videoElement) {
      return this.videoElement.nativeElement;
    }
    return undefined;
  }

  /**
   * Cleanup loading timers
   */
  private cleanupLoadingTimers(): void {
    if (this.loadingProgressInterval) {
      clearInterval(this.loadingProgressInterval);
      this.timers.delete(this.loadingProgressInterval);
      this.loadingProgressInterval = null;
    }
    if (this.loadingTimeoutTimer) {
      clearTimeout(this.loadingTimeoutTimer);
      this.timers.delete(this.loadingTimeoutTimer);
      this.loadingTimeoutTimer = null;
    }
  }
}
