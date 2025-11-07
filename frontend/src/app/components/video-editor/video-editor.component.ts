import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule, MatTabGroup } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatListModule } from '@angular/material/list';
import { LibraryService, LibraryAnalysis } from '../../services/library.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { NotificationService } from '../../services/notification.service';
import { DatabaseLibraryService } from '../../services/database-library.service';
import { VideoTimelineComponent, TimelineSection, TimelineSelection } from '../video-timeline/video-timeline.component';

interface VideoListItem {
  id: string;
  title: string;
  thumbnailPath?: string;
  videoPath?: string;
  duration?: number;
}

@Component({
  selector: 'app-video-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatTooltipModule,
    MatListModule,
    VideoTimelineComponent,
  ],
  templateUrl: './video-editor.component.html',
  styleUrls: ['./video-editor.component.scss']
})
export class VideoEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('videoElement', { static: false }) videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('tabGroup', { static: false}) tabGroup!: MatTabGroup;
  @ViewChild('dropZone', { static: false }) dropZone!: ElementRef<HTMLDivElement>;

  videoEl: HTMLVideoElement | null = null;
  title = '';
  isCreating = false;
  isLoadingVideo = false;
  error: string | null = null;
  savePath = '';
  saveDirectory = '';
  isLoadingSavePath = false;
  customDirectory: string | null = null;

  // Current video data
  currentVideoId: string | null = null;
  currentVideoPath: string | null = null;
  currentVideoTitle: string | null = null;
  currentAnalysis: LibraryAnalysis | null = null;

  // Video state
  duration = 0;
  currentTime = 0;
  isPlaying = false;

  // Timeline
  timelineSections: TimelineSection[] = [];
  currentSelection: TimelineSelection = { startTime: 0, endTime: 0 };

  // Video list for picker
  videoList: VideoListItem[] = [];
  isLoadingVideos = false;

  // Drag and drop
  isDragging = false;

  private eventListeners: Array<{
    element: HTMLVideoElement;
    event: string;
    handler: EventListener;
  }> = [];

  constructor(
    private router: Router,
    private libraryService: LibraryService,
    private backendUrlService: BackendUrlService,
    private notificationService: NotificationService,
    private databaseLibraryService: DatabaseLibraryService
  ) {}

  async ngOnInit() {
    console.log('[VideoEditor] ngOnInit started');

    // Ensure we start with clean state
    this.isLoadingVideo = false;
    this.error = null;

    // Load recent videos for picker first (don't block on this)
    this.loadRecentVideos().catch(err => {
      console.error('[VideoEditor] Failed to load recent videos:', err);
    });

    // Check if video data was passed via navigation state
    // Try getCurrentNavigation() first (works during navigation guards/resolvers)
    // Fall back to history.state (works after navigation completes, i.e., in ngOnInit)
    const navigation = this.router.getCurrentNavigation();
    console.log('[VideoEditor] getCurrentNavigation():', navigation);
    console.log('[VideoEditor] history.state:', history.state);

    const state = navigation?.extras?.state || (history.state?.navigationId ? history.state : null);

    if (state && state['videoEditorData']) {
      console.log('[VideoEditor] Video data found in state:', state['videoEditorData']);
      const data = state['videoEditorData'];

      // Store the data but don't try to load video until view is ready
      this.currentVideoId = data.videoId || null;
      this.currentVideoPath = data.videoPath || null;
      this.currentVideoTitle = data.videoTitle || 'Video';

      console.log('[VideoEditor] Set currentVideoPath to:', this.currentVideoPath);
      console.log('[VideoEditor] Set currentVideoId to:', this.currentVideoId);
      console.log('[VideoEditor] Set currentVideoTitle to:', this.currentVideoTitle);

      if (data.startTime !== undefined && data.endTime !== undefined) {
        this.currentSelection = { startTime: data.startTime, endTime: data.endTime };
      }

      this.currentAnalysis = data.analysis || null;
    } else {
      console.log('[VideoEditor] No navigation state found - showing empty editor');
    }

    console.log('[VideoEditor] ngOnInit completed - hasVideoSelected:', this.hasVideoSelected(), 'hasVideoLoaded:', this.hasVideoLoaded());
  }

  ngAfterViewInit() {
    console.log('[VideoEditor] ngAfterViewInit started');

    // Initialize video if we have video data from navigation
    if (this.currentVideoId || this.currentVideoPath) {
      console.log('[VideoEditor] Initializing video from navigation data');
      // Use setTimeout to ensure Angular has finished rendering
      setTimeout(() => {
        this.initializePlayer().catch(err => {
          console.error('[VideoEditor] Failed to initialize player:', err);
          this.error = 'Failed to load video. Please try again.';
          this.isLoadingVideo = false;
        });
      }, 100);
    }

    console.log('[VideoEditor] ngAfterViewInit completed');
  }

  ngOnDestroy() {
    console.log('[VideoEditor] ngOnDestroy called');

    // Clear initialization timeout
    if (this.initializationTimeout) {
      clearTimeout(this.initializationTimeout);
      this.initializationTimeout = null;
    }

    this.cleanupVideoResources();
  }

  private cleanupVideoResources() {
    console.log('[VideoEditor] Cleaning up video resources');

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
  }

  private addVideoEventListener(event: string, handler: EventListener) {
    if (this.videoEl) {
      this.videoEl.addEventListener(event, handler);
      this.eventListeners.push({ element: this.videoEl, event, handler });
    }
  }

  async loadRecentVideos() {
    try {
      this.isLoadingVideos = true;
      const result = await this.databaseLibraryService.getVideos(20, 0, false);

      this.videoList = result.videos.map((v: any) => ({
        id: v.id,
        title: v.filename,
        videoPath: v.current_path,
        duration: v.duration_seconds
      }));
    } catch (error) {
      console.error('Failed to load recent videos:', error);
    } finally {
      this.isLoadingVideos = false;
    }
  }

  async loadVideoFromData(data: any) {
    this.currentAnalysis = data.analysis || null;
    this.currentVideoId = data.videoId || data.analysis?.id || null;
    this.currentVideoPath = data.videoPath || null;
    this.currentVideoTitle = data.videoTitle || data.analysis?.title || 'Video';

    if (data.startTime !== undefined && data.endTime !== undefined) {
      this.currentSelection = { startTime: data.startTime, endTime: data.endTime };
    }

    await this.initializePlayer();
  }

  async selectVideo(video: VideoListItem) {
    this.currentVideoId = video.id;
    this.currentVideoPath = video.videoPath || null;
    this.currentVideoTitle = video.title;
    this.currentAnalysis = null;

    // Try to load analysis if available
    try {
      const analysis = await this.databaseLibraryService.getAnalysis(video.id);
      if (analysis) {
        // Analysis exists but we don't need to convert it for clip creation
        // Just mark that we have one
        this.currentAnalysis = { id: video.id, title: video.title } as any;
      }
    } catch (error) {
      console.log('No analysis found for video:', video.id);
    }

    this.currentSelection = { startTime: 0, endTime: video.duration || 0 };

    await this.initializePlayer();
  }

  async openFilePicker() {
    try {
      const result = await (window as any).electron?.openFilePicker({
        filters: [
          { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'] }
        ],
        properties: ['openFile']
      });

      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        const fileName = filePath.split('/').pop() || 'Custom Video';

        this.currentVideoId = null;
        this.currentVideoPath = filePath;
        this.currentVideoTitle = fileName;
        this.currentAnalysis = null;

        await this.initializePlayer();
      }
    } catch (error) {
      console.error('Error opening file picker:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to open file picker');
    }
  }

  private initializationTimeout: any = null;
  private readonly INIT_TIMEOUT_MS = 10000; // 10 second timeout

  async initializePlayer() {
    console.log('[VideoEditor] ==> initializePlayer START');

    // Validate video element exists
    if (!this.videoElement) {
      console.error('[VideoEditor] Video element not found in DOM');
      this.error = 'Video player not ready. Please try again.';
      return;
    }

    try {
      // Clean up any previous resources
      this.cleanupVideoResources();

      // Set loading state
      this.isLoadingVideo = true;
      this.error = null;

      console.log('[VideoEditor] Video element ready, getting native element');
      this.videoEl = this.videoElement.nativeElement;

      // Validate we have a video path
      if (!this.currentVideoPath) {
        console.error('[VideoEditor] No video path provided');
        this.error = 'No video path available.';
        this.isLoadingVideo = false;
        return;
      }

      console.log('[VideoEditor] Video path:', this.currentVideoPath);

      // Construct video URL (simplified - just use direct encoding)
      console.log('[VideoEditor] Encoding video path...');
      const encodedPath = btoa(unescape(encodeURIComponent(this.currentVideoPath)));
      console.log('[VideoEditor] Encoded path (first 50 chars):', encodedPath.substring(0, 50));

      // Get backend URL (with timeout protection via service)
      console.log('[VideoEditor] Getting backend URL...');
      const baseUrl = await this.backendUrlService.getBackendUrl();
      const videoUrl = `${baseUrl}/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
      console.log('[VideoEditor] Final video URL:', videoUrl);

      // Set up timeout for loading (do this BEFORE setting src)
      console.log('[VideoEditor] Setting up 10s timeout...');
      this.initializationTimeout = setTimeout(() => {
        console.error('[VideoEditor] ❌ TIMEOUT after 10 seconds');
        if (this.isLoadingVideo) {
          this.error = 'Video loading timeout. Please check the video file and try again.';
          this.isLoadingVideo = false;
        }
      }, this.INIT_TIMEOUT_MS);

      // Generate default title
      this.title = `Clip from ${this.currentVideoTitle}`;

      console.log('[VideoEditor] Attaching event listeners...');

      // Success handler - video metadata loaded
      const onMetadataLoaded = () => {
        console.log('[VideoEditor] ✅ Video loaded successfully');
        clearTimeout(this.initializationTimeout!);
        this.initializationTimeout = null;
        this.isLoadingVideo = false;
        this.duration = this.videoEl!.duration;
        if (this.currentSelection.endTime === 0) {
          this.currentSelection = { startTime: 0, endTime: this.duration };
        }
        console.log('[VideoEditor] Video duration:', this.duration);
        console.log('[VideoEditor] Video should now be visible. State:', {
          hasVideoSelected: this.hasVideoSelected(),
          hasVideoLoaded: this.hasVideoLoaded(),
          isLoadingVideo: this.isLoadingVideo,
          error: this.error,
          duration: this.duration
        });
      };

      // Error handler - video failed to load
      const onVideoError = () => {
        console.error('[VideoEditor] ❌ Video failed to load');
        clearTimeout(this.initializationTimeout!);
        this.initializationTimeout = null;

        const videoError = this.videoEl?.error;
        console.error('[VideoEditor] Error code:', videoError?.code, 'Message:', videoError?.message);

        let errorMessage = 'Failed to load video. ';
        if (videoError?.code === 1) errorMessage += 'Loading aborted.';
        else if (videoError?.code === 2) errorMessage += 'Network error.';
        else if (videoError?.code === 3) errorMessage += 'Decode error - codec may not be supported.';
        else if (videoError?.code === 4) errorMessage += 'Format not supported.';

        this.error = errorMessage;
        this.isLoadingVideo = false;
      };

      // Attach event listeners
      this.addVideoEventListener('loadedmetadata', onMetadataLoaded);
      this.addVideoEventListener('error', onVideoError);
      this.addVideoEventListener('timeupdate', () => { this.currentTime = this.videoEl!.currentTime; });
      this.addVideoEventListener('play', () => { this.isPlaying = true; });
      this.addVideoEventListener('pause', () => { this.isPlaying = false; });

      console.log('[VideoEditor] Setting video source...');
      this.videoEl.src = videoUrl;
      console.log('[VideoEditor] Calling video.load()...');
      this.videoEl.load();
      console.log('[VideoEditor] ==> initializePlayer END (loading started)');

      // Load save path (non-blocking)
      this.loadSavePath().catch(err => {
        console.error('[VideoEditor] Failed to load save path:', err);
      });

    } catch (error) {
      console.error('[VideoEditor] Error in initializePlayer:', error);
      if (this.initializationTimeout) {
        clearTimeout(this.initializationTimeout);
        this.initializationTimeout = null;
      }
      this.error = 'Failed to initialize video player. Please try again.';
      this.isLoadingVideo = false;
    }
  }

  // Drag and drop handlers
  @HostListener('dragenter', ['$event'])
  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = true;
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    // Only set isDragging to false if we're leaving the component entirely
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;

    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      this.isDragging = false;
    }
  }

  @HostListener('drop', ['$event'])
  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      const filePath = (file as any).path; // Electron provides the path

      if (filePath) {
        this.currentVideoId = null;
        this.currentVideoPath = filePath;
        this.currentVideoTitle = file.name;
        this.currentAnalysis = null;

        await this.initializePlayer();
      }
    }
  }

  get selectionDuration(): number {
    return this.currentSelection.endTime - this.currentSelection.startTime;
  }

  formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  async loadSavePath() {
    if (!this.currentVideoTitle) return;

    try {
      this.isLoadingSavePath = true;

      if (this.currentAnalysis) {
        // For analyzed videos, use the backend API
        const savePathUrl = await this.backendUrlService.getApiUrl(`/library/analyses/${this.currentAnalysis.id}/clip-save-path`);
        const response = await fetch(savePathUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startTime: this.currentSelection.startTime,
            endTime: this.currentSelection.endTime,
            customDirectory: this.customDirectory || undefined,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          this.savePath = data.outputPath;
          this.saveDirectory = data.outputDir;
        }
      } else {
        // Generate a simple save path
        const filename = this.currentVideoTitle || 'video';
        const safeFilename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const timestamp = `${Math.floor(this.currentSelection.startTime)}-${Math.floor(this.currentSelection.endTime)}`;
        const clipFilename = `${safeFilename}_${timestamp}.mp4`;

        const homedir = await (window as any).electron?.getPath('downloads') || 'Downloads';
        this.saveDirectory = `${homedir}/clippy/clips`;
        this.savePath = `${this.saveDirectory}/${clipFilename}`;
      }
    } catch (error) {
      console.error('Error loading save path:', error);
    } finally {
      this.isLoadingSavePath = false;
    }
  }

  async browseDirectory() {
    try {
      const result = await (window as any).electron?.openDirectoryPicker();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        this.customDirectory = result.filePaths[0];
        await this.loadSavePath();
      }
    } catch (error) {
      console.error('Error browsing directory:', error);
    }
  }

  async createClip() {
    if (!this.title.trim()) {
      this.error = 'Please enter a title';
      return;
    }

    if (!this.currentVideoPath && !this.currentVideoId) {
      this.error = 'No video loaded';
      return;
    }

    try {
      this.isCreating = true;
      this.error = null;

      let result: any;

      if (this.currentAnalysis && this.currentVideoId) {
        // Extract clip from analyzed video
        result = await this.libraryService.extractClip(
          this.currentVideoId,
          {
            startTime: this.currentSelection.startTime,
            endTime: this.currentSelection.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
          }
        );
      } else if (this.currentVideoPath) {
        // Extract clip from custom/library video
        const extractUrl = await this.backendUrlService.getApiUrl('/library/videos/custom/extract-clip');
        const response = await fetch(extractUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: this.currentVideoPath,
            startTime: this.currentSelection.startTime,
            endTime: this.currentSelection.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to extract clip');
        }

        result = await response.json();
      } else {
        this.error = 'No video source available';
        this.isCreating = false;
        return;
      }

      if (result.success) {
        const outputPath = result.extraction?.outputPath || result.clip?.outputPath;
        this.notificationService.toastOnly(
          'success',
          'Clip Created',
          'Clip created successfully',
          outputPath ? {
            type: 'open-folder',
            path: outputPath
          } : undefined
        );

        // Reset for next clip
        this.title = `Clip from ${this.currentVideoTitle}`;
        this.isCreating = false;
      } else {
        this.error = result.error || 'Failed to create clip';
        this.isCreating = false;
      }

    } catch (error) {
      console.error('Error creating clip:', error);
      this.error = 'An error occurred while creating the clip';
      this.isCreating = false;
    }
  }

  togglePlayPause() {
    if (!this.videoEl) return;

    if (this.videoEl.paused) {
      this.videoEl.play();
    } else {
      this.videoEl.pause();
    }
  }

  onTimelineSeek(time: number) {
    if (this.videoEl) {
      this.videoEl.currentTime = time;
    }
  }

  onSelectionChange(selection: TimelineSelection) {
    this.currentSelection = selection;
    // Don't reload save path on every selection change - it's too expensive
    // and causes performance issues. User can browse directory if needed.
  }

  onPlayPause() {
    this.togglePlayPause();
  }

  onPlaybackSpeed(speed: number) {
    if (!this.videoEl) return;

    if (speed < 0) {
      const absSpeed = Math.abs(speed);
      this.videoEl.pause();
      const jumpAmount = 0.5 * absSpeed;
      this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - jumpAmount);
    } else if (speed === 0) {
      this.videoEl.pause();
      this.videoEl.playbackRate = 1;
    } else {
      this.videoEl.playbackRate = speed;
      if (this.videoEl.paused) {
        this.videoEl.play();
      }
    }
  }

  hasVideoLoaded(): boolean {
    // Only consider video loaded if we have metadata (duration)
    return this.currentVideoPath !== null && this.duration > 0;
  }

  hasVideoSelected(): boolean {
    // Returns true if a video is selected, even if not yet loaded
    return this.currentVideoPath !== null;
  }
}
