import { Component, OnInit, OnDestroy, HostListener, ViewChild, ElementRef, Inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { Router, ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatMenuTrigger } from '@angular/material/menu';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatRadioModule } from '@angular/material/radio';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { AngularSplitModule } from 'angular-split';
import {
  DatabaseLibraryService,
  DatabaseVideo,
  DatabaseStats,
  BatchProgress
} from '../../services/database-library.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { ApiService } from '../../services/api.service';
import { DownloadProgressService } from '../../services/download-progress.service';
import { SocketService } from '../../services/socket.service';
import { LibraryStateService, ClipLibrary as LibraryStateClipLibrary } from '../../services/library-state.service';
import { VideoFilterService, FilterCriteria } from '../../services/video-filter.service';
import { VideoOperationsService } from '../../services/video-operations.service';
import { AnalysisQueueService } from '../../services/analysis-queue.service';
import { VideoAnalysisDialogComponent } from '../video-analysis-dialog/video-analysis-dialog.component';
import { RenameDialogComponent } from './rename-dialog.component';
import { NameSuggestionDialogComponent } from './name-suggestion-dialog.component';
import { PreviewDialogComponent, PreviewDialogData } from './preview-dialog/preview-dialog.component';
import { SearchBarComponent, SearchCriteriaChange, TagData } from './search-bar/search-bar.component';
import { LibraryHeaderComponent } from './library-header/library-header.component';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import {
  ListItem,
  ItemDisplayConfig,
  GroupConfig,
  KeyboardConfig,
  SelectionMode,
  ItemStatus,
  ItemProgress,
  ContextMenuAction,
  CascadeItem,
  CascadeChild,
  ChildrenConfig
} from '../../libs/cascade/src/lib/types/cascade.types';

interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

@Component({
  selector: 'app-library',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatDialogModule,
    MatInputModule,
    MatFormFieldModule,
    MatChipsModule,
    MatCheckboxModule,
    MatSelectModule,
    MatTabsModule,
    MatMenuModule,
    MatDividerModule,
    MatExpansionModule,
    MatSnackBarModule,
    ScrollingModule,
    AngularSplitModule,
    SearchBarComponent,
    LibraryHeaderComponent,
    CascadeListComponent
  ],
  templateUrl: './library.component.html',
  styleUrls: ['./library.component.scss']
})
export class LibraryComponent implements OnInit, OnDestroy {
  isLoading = false;
  isInitialLoad = true; // Track if this is the first load
  private cancelBackgroundLoad = false; // Flag to cancel ongoing background loads
  private backgroundLoadRunning = false; // Track if background load is actually running
  videos: DatabaseVideo[] = [];
  filteredVideos: DatabaseVideo[] = [];
  stats: DatabaseStats | null = null;
  batchProgress: BatchProgress | null = null;

  // Reactive observables from services (Phase 4 - Reactive Pattern)
  videos$ = this.libraryStateService.videos$;
  filteredVideos$ = this.libraryStateService.filteredVideos$;
  selectedVideoIds$ = this.libraryStateService.selectedVideoIds$;
  selectedCount$ = this.libraryStateService.selectedCount$;
  hasSelection$ = this.libraryStateService.hasSelection$;
  stats$ = this.libraryStateService.stats$;
  allTags$ = this.libraryStateService.allTags$;
  currentLibrary$ = this.libraryStateService.currentLibrary$;
  libraries$ = this.libraryStateService.libraries$;
  isLoadingLibraries$ = this.libraryStateService.isLoadingLibraries$;
  isInitialLoad$ = this.libraryStateService.isInitialLoad$;
  highlightedVideoId$ = this.libraryStateService.highlightedVideoId$;

  // Computed observable for highlighted video (combines ID with video list)
  highlightedVideo$ = combineLatest([
    this.videos$,
    this.highlightedVideoId$
  ]).pipe(
    map(([videos, highlightedId]) =>
      highlightedId ? videos.find(v => v.id === highlightedId) || null : null
    )
  );

  // Libraries
  libraries: ClipLibrary[] = [];
  activeLibrary: ClipLibrary | null = null;
  selectedLibraryId: string = '';
  isLoadingLibraries = true; // Track library loading state

  // Tabs
  selectedTabIndex = 0;

  // Tags
  allTags: { people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }> } | null = null;
  selectedTags: string[] = [];
  showTagFilters = false;

  // Search and filter
  searchQuery = '';
  sortBy: 'date' | 'upload-date' | 'date-added' | 'filename' | 'size' | 'no-transcript' | 'no-analysis' = 'date';
  sortOrder: 'asc' | 'desc' = 'desc';
  searchFilters = {
    filename: true,
    aiDescription: true,
    transcript: true,
    analysis: true,
    tags: true
  };
  showSearchFilters = false;
  showSearchAccordion = false; // For compact search/filter accordion
  searchFiltersExpanded = false; // For main accordion collapsed by default

  // File type filters
  fileTypeFilters = {
    video: true,
    audio: true,
    document: true,
    image: true,
    webpage: true
  };
  showFileTypeFilters = false;

  // Track open video player dialog to prevent multiple instances
  private openVideoPlayerDialog: any = null;

  // Selection
  selectedVideos = new Set<string>(); // Set of video IDs
  isAllSelected = false;
  isMissingTranscriptSelected = false;
  isMissingAnalysisSelected = false;

  // Virtual scrolling
  itemSize = 44; // Height of each video card (compact single-line design)

  // Processed list items (cached to avoid recomputation on every change detection)
  videosAsListItems: (DatabaseVideo & ListItem)[] = [];

  // Inline editing
  editingVideo: { [videoId: string]: { date: boolean; title: boolean; extension: boolean } } = {};
  editedValues: { [videoId: string]: { date: string; title: string; extension: string } } = {};
  currentlyEditingVideo: DatabaseVideo | null = null; // Track which video is being edited (for performance)

  // Cached selection count (updated when selectedVideos changes, for performance)
  selectedCount: number = 0;

  // Drag and drop
  isDragging = false;
  private dragCounter = 0; // Track nested drag events

  // Polling for batch progress
  private progressInterval: any;

  // Track completed videos in current batch
  completedVideos: Array<{
    filename: string;
    videoId: string;
    completedAt: Date;
    status: 'success' | 'failed' | 'skipped';
    error?: string;
  }> = [];
  private lastProcessedCount = 0;

  // Track video processing states for progress bars
  videoProcessingStates = new Map<string, { stage: 'transcribing' | 'analyzing', progress: number }>();
  progressVersion = 0; // Increment to force item-list to refresh progress

  // View mode (list or detail split view)
  viewMode: 'list' | 'detail' = 'list';
  selectedVideo: DatabaseVideo | null = null;
  autoPlayEnabled = true;
  backendUrl = '';

  // Video player state
  @ViewChild('detailVideoPlayer') detailVideoPlayer?: ElementRef<HTMLVideoElement>;
  @ViewChild('contextMenuTrigger') contextMenuTrigger?: MatMenuTrigger;
  @ViewChild('managementContextMenuTrigger') managementContextMenuTrigger?: MatMenuTrigger;
  @ViewChild('fileTypeMenuTrigger') fileTypeMenuTrigger?: MatMenuTrigger;
  @ViewChild('cascadeList') cascadeList?: CascadeListComponent<DatabaseVideo>;
  videoElement: HTMLVideoElement | null = null;
  isPlaying = false;

  // Preview modal state for list view
  highlightedVideo: DatabaseVideo | null = null;
  previewAutoPlayEnabled = true;

  // Context menu state
  contextMenuPosition = { x: 0, y: 0 };
  contextMenuVideo: DatabaseVideo | null = null;
  isContextMenuOpen = false;
  private contextMenuTimeout: any = null;

  // Week grouping state
  collapsedWeeks = new Set<string>(); // Set of collapsed week identifiers
  groupedVideos: { week: string; videos: DatabaseVideo[] }[] = [];
  selectedWeeks = new Set<string>(); // Set of selected week identifiers
  highlightedWeek: string | null = null; // Currently highlighted week section

  // Type-ahead search state
  private typeAheadBuffer = '';
  private typeAheadTimer: any;

  // Expose SelectionMode enum for template
  SelectionMode = SelectionMode;

  // CascadeListComponent configuration
  listDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'added_at',
    metadataField: 'duration_seconds',
    iconField: 'media_type',
    // badgeField removed - we show dates in secondary text instead
    renderPrimary: (item) => this.getVideoDisplayName(item as any),
    renderSecondary: (item) => this.formatVideoSecondaryText(item as any),
    renderMetadata: (item) => this.formatVideoDuration(item as any),
    renderIcon: (item) => this.getMediaIcon(item as any)
  };

  // Progress mapper - return null so master progress bar (from children) is used
  videoProgressMapper = (item: DatabaseVideo): ItemProgress | null => {
    // Videos with processing stages will show master progress bar from children
    return null;
  };

  // Children config for cascade - shows processing stages as ghost items
  listChildrenConfig: ChildrenConfig = {
    enabled: true,
    expandable: true,
    defaultExpanded: true,
    showMasterProgress: true,
    generator: (item: any) => this.generateVideoProcessingStages(item),
    masterProgressCalculator: (item: any) => this.calculateVideoMasterProgress(item)
  };

  listGroupConfig: GroupConfig<DatabaseVideo & ListItem> = {
    enabled: true,
    groupBy: (video) => {
      const downloadDate = new Date(video.download_date || video.added_at);
      const now = new Date();
      const hoursSinceDownload = (now.getTime() - downloadDate.getTime()) / (1000 * 60 * 60);

      // Videos from last 24 hours go in "New" group
      if (hoursSinceDownload < 24) {
        return 'NEW_VIDEOS_24H';
      }

      return this.getWeekIdentifier(downloadDate);
    },
    groupLabel: (weekKey) => {
      if (weekKey === 'NEW_VIDEOS_24H') {
        return '🆕 New (Last 24 Hours)';
      }
      return this.formatWeekLabel(weekKey);
    },
    sortDescending: true,
    selectableGroups: true
  };

  listKeyboardConfig: KeyboardConfig = {
    enableArrowNavigation: true,
    enableTypeAhead: true,
    typeAheadField: 'filename',
    enableSpaceAction: true,
    enableDelete: true,
    enableSelectAll: true,
    enableEscapeDeselect: true
  };

  listContextMenuActions: ContextMenuAction[] = [
    { id: 'open', label: 'Open in Video Editor', icon: 'play_arrow' },
    { id: 'openLocation', label: 'Open File Location', icon: 'folder_open' },
    { id: 'copyPath', label: 'Copy File Path', icon: 'content_copy' },
    { id: 'divider1', label: '', divider: true },
    { id: 'analyze', label: 'Run Analysis', icon: 'analytics' },
    { id: 'transcribe', label: 'Run Transcription', icon: 'transcribe' },
    { id: 'divider2', label: '', divider: true },
    { id: 'relink', label: 'Relink Video', icon: 'link' },
    { id: 'delete', label: 'Delete', icon: 'delete' }
  ];

  // Subscription management for cleanup
  private subscriptions: any[] = [];

  // Note: Keyboard handling is now fully managed by cascade-list component
  // item-list handles: arrow navigation, type-ahead, Cmd+A, Delete, Space, Escape
  // item-list emits events: spaceAction, deleteAction, itemsSelected, itemHighlighted, etc.
  // This component just responds to those events (see onListSpaceAction, onListDeleteAction, etc.)

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private router: Router,
    private route: ActivatedRoute,
    private apiService: ApiService,
    private snackBar: MatSnackBar,
    private downloadProgressService: DownloadProgressService,
    private socketService: SocketService,
    private cdr: ChangeDetectorRef,
    private libraryStateService: LibraryStateService,
    private videoFilterService: VideoFilterService,
    private videoOperationsService: VideoOperationsService,
    private analysisQueueService: AnalysisQueueService
  ) {
    console.log('[LibraryComponent] Constructor called at', new Date().toISOString());
    console.log('[LibraryComponent] Constructor completed at', new Date().toISOString());
  }

  async ngOnInit() {
    const startTime = performance.now();
    console.log('[LibraryComponent] ngOnInit started');

    // Add document listeners for closing context menu
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('contextmenu', this.handleDocumentContextMenu);

    // Load backend URL
    this.backendUrl = await this.backendUrlService.getBackendUrl();

    // Load view mode preference from localStorage
    const savedViewMode = localStorage.getItem('library-view-mode');
    if (savedViewMode === 'detail' || savedViewMode === 'list') {
      this.viewMode = savedViewMode;
    }

    // Load auto-play preference from localStorage
    const savedAutoPlay = localStorage.getItem('library-auto-play');
    if (savedAutoPlay !== null) {
      this.autoPlayEnabled = savedAutoPlay === 'true';
    }

    // Load preview auto-play preference from localStorage
    const savedPreviewAutoPlay = localStorage.getItem('library-preview-auto-play');
    if (savedPreviewAutoPlay !== null) {
      this.previewAutoPlayEnabled = savedPreviewAutoPlay === 'true';
    }

    // Load all data in parallel for maximum speed
    await Promise.all([
      this.loadLibraries(),
      this.loadStats(),
      this.loadVideos(),
      this.loadTags()
    ]);

    this.startProgressPolling();

    // Subscribe to analysis queue jobs to show progress bars
    const previousJobs = new Map<string, any>();
    this.subscriptions.push(this.downloadProgressService.jobs$.subscribe(jobsMap => {
      // Only update processing states when they actually change
      let hasChanges = false;

      // Build new processing states
      const newStates = new Map<string, { stage: 'transcribing' | 'analyzing', progress: number }>();
      jobsMap.forEach((job) => {
        if (job.videoId && job.stage !== 'completed' && job.stage !== 'failed') {
          let stage: 'transcribing' | 'analyzing' = 'analyzing';
          if (job.stage === 'transcribing') {
            stage = 'transcribing';
          }

          newStates.set(job.videoId, { stage, progress: job.progress });

          // Check if this state actually changed
          const oldState = this.videoProcessingStates.get(job.videoId);
          if (!oldState || oldState.stage !== stage || oldState.progress !== job.progress) {
            hasChanges = true;
          }
        }
      });

      // Only update Map reference if something actually changed
      if (hasChanges || newStates.size !== this.videoProcessingStates.size) {
        this.videoProcessingStates = newStates;
      }

      // Update previous jobs for next iteration
      previousJobs.clear();
      jobsMap.forEach((job, id) => previousJobs.set(id, { ...job }));
    }));

    // Subscribe to video renamed events from WebSocket
    this.subscriptions.push(this.socketService.onVideoRenamed().subscribe(event => {
      console.log('[LibraryComponent] Video renamed event received:', event);

      // Find the video in our local list and update it
      const videoIndex = this.videos.findIndex(v => v.id === event.videoId);
      if (videoIndex !== -1) {
        this.videos[videoIndex].filename = event.newFilename;
        this.videos[videoIndex].current_path = event.newPath;
        this.videos[videoIndex].file_extension = event.newFilename.split('.').pop() || '';

        // Also update in filteredVideos if needed
        const filteredIndex = this.filteredVideos.findIndex(v => v.id === event.videoId);
        if (filteredIndex !== -1) {
          this.filteredVideos[filteredIndex].filename = event.newFilename;
          this.filteredVideos[filteredIndex].current_path = event.newPath;
          this.filteredVideos[filteredIndex].file_extension = event.newFilename.split('.').pop() || '';
        }

        // If this is the selected/highlighted video, update that too
        if (this.selectedVideo && this.selectedVideo.id === event.videoId) {
          this.selectedVideo.filename = event.newFilename;
          this.selectedVideo.current_path = event.newPath;
          this.selectedVideo.file_extension = event.newFilename.split('.').pop() || '';
        }

        // Force re-render by creating new array references
        this.videos = [...this.videos];
        this.filteredVideos = [...this.filteredVideos];

        // Trigger change detection
        this.cdr.detectChanges();

        console.log('[LibraryComponent] Video updated in UI:', event.videoId, event.newFilename);
      }
    }));

    // Subscribe to video imported events from WebSocket
    this.subscriptions.push(this.socketService.onVideoImported().subscribe(async event => {
      console.log('[LibraryComponent] Video imported event received:', event);

      // Reload videos from the database to include the new video
      await this.loadVideos();

      console.log('[LibraryComponent] Videos reloaded after import. Total videos:', this.videos.length);
    }));

    // Subscribe to transcription completed events to update video has_transcript flag
    this.subscriptions.push(this.socketService.onTranscriptionCompleted().subscribe(event => {
      console.log('[LibraryComponent] Transcription completed event received:', event);

      // Find the video by path and update its transcript flag
      const video = this.videos.find(v =>
        event.outputFile && v.current_path &&
        (event.outputFile.includes(v.id) || event.outputFile.includes(v.filename.replace(/\.[^/.]+$/, '')))
      );

      if (video) {
        // Reload the specific video from database to get updated transcript flag
        this.databaseLibraryService.getVideoById(video.id).then(updatedVideo => {
          if (updatedVideo) {
            // Update in main videos array
            const videoIndex = this.videos.findIndex(v => v.id === video.id);
            if (videoIndex !== -1) {
              this.videos[videoIndex] = { ...this.videos[videoIndex], has_transcript: updatedVideo.has_transcript };
            }

            // Update in filtered videos array
            const filteredIndex = this.filteredVideos.findIndex(v => v.id === video.id);
            if (filteredIndex !== -1) {
              this.filteredVideos[filteredIndex] = { ...this.filteredVideos[filteredIndex], has_transcript: updatedVideo.has_transcript };
            }

            console.log('[LibraryComponent] Video transcript flag updated:', video.id);
          }
        });
      }
    }));

    // Subscribe to transcription failed events to handle errors
    this.subscriptions.push(this.socketService.onTranscriptionFailed().subscribe(event => {
      console.error('[LibraryComponent] Transcription failed:', event);
      this.notificationService.toastOnly('error', 'Transcription Failed', event.error || 'An error occurred during transcription');
    }));

    // Subscribe to processing completed events to update video has_analysis flag
    this.subscriptions.push(this.socketService.listenTo<any>('processing-completed').subscribe(event => {
      console.log('[LibraryComponent] Processing completed event received:', event);

      // Find the video by path or jobId and update its analysis flag
      const video = this.videos.find(v =>
        (event.outputFile && v.current_path &&
         (event.outputFile.includes(v.id) || event.outputFile.includes(v.filename.replace(/\.[^/.]+$/, '')))) ||
        (event.jobId && this.videoProcessingStates.has(v.id))
      );

      if (video) {
        // Reload the specific video from database to get updated analysis flag
        this.databaseLibraryService.getVideoById(video.id).then(updatedVideo => {
          if (updatedVideo) {
            // Update in main videos array
            const videoIndex = this.videos.findIndex(v => v.id === video.id);
            if (videoIndex !== -1) {
              this.videos[videoIndex] = { ...this.videos[videoIndex], has_analysis: updatedVideo.has_analysis };
            }

            // Update in filtered videos array
            const filteredIndex = this.filteredVideos.findIndex(v => v.id === video.id);
            if (filteredIndex !== -1) {
              this.filteredVideos[filteredIndex] = { ...this.filteredVideos[filteredIndex], has_analysis: updatedVideo.has_analysis };
            }

            console.log('[LibraryComponent] Video analysis flag updated:', video.id);
          }
        });
      }
    }));

    // Subscribe to processing failed events to handle analysis errors
    this.subscriptions.push(this.socketService.onProcessingFailed().subscribe(event => {
      console.error('[LibraryComponent] Processing failed:', event);
      this.notificationService.toastOnly('error', 'Analysis Failed', event.error || 'An error occurred during video analysis');
    }));

    // Check for query param to highlight a specific video
    this.subscriptions.push(this.route.queryParams.subscribe(params => {
      console.log('[LibraryComponent] Query params received:', params);
      const videoIdToHighlight = params['highlightVideo'] || params['highlight'];
      if (videoIdToHighlight) {
        console.log('[LibraryComponent] Highlighting video with ID:', videoIdToHighlight);
        this.highlightVideoById(videoIdToHighlight);
        // Clear the query param after handling it
        this.router.navigate([], {
          queryParams: { highlightVideo: null, highlight: null },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      }
    }));

    console.log(`[LibraryComponent] Total load time: ${(performance.now() - startTime).toFixed(0)}ms`);

    // Check if there are no libraries and prompt user to create one
    if (this.libraries.length === 0) {
      console.log('[LibraryComponent] No libraries found, prompting user to create one');
      this.notificationService.toastOnly(
        'info',
        'No Library Found',
        'Please create a library to get started'
      );
      // Automatically open the manage libraries dialog
      setTimeout(() => {
        this.openManageLibraries();
      }, 500); // Small delay to let the UI settle
    }
  }

  ngOnDestroy() {
    // Unsubscribe from all subscriptions to prevent memory leaks
    this.subscriptions.forEach(sub => {
      if (sub && typeof sub.unsubscribe === 'function') {
        sub.unsubscribe();
      }
    });
    this.subscriptions = [];

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // Clear video processing states
    this.videoProcessingStates.clear();

    // Clear any pending context menu timeout
    if (this.contextMenuTimeout) {
      clearTimeout(this.contextMenuTimeout);
      this.contextMenuTimeout = null;
    }

    // Close preview dialog when leaving the page
    if (this.currentPreviewDialogRef) {
      this.currentPreviewDialogRef.close();
    }

    // Remove document listeners
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentContextMenu);
  }

  // Note: Context menu Escape handling is now handled by MatMenu's built-in behavior

  /**
   * Handle document click to close context menu
   */
  private handleDocumentClick = (event: MouseEvent) => {
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
      this.isContextMenuOpen = false;
    }
  };

  /**
   * Handle document right-click to potentially close context menu
   */
  private handleDocumentContextMenu = (event: MouseEvent) => {
    // Only close if not right-clicking on a video card
    const target = event.target as HTMLElement;
    if (!target.closest('.video-card')) {
      if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
        this.contextMenuTrigger.closeMenu();
      }
    }
  };

  /**
   * Load database statistics
   */
  async loadStats() {
    try {
      this.stats = await this.databaseLibraryService.getStats();
      console.log('Database stats:', this.stats);

      // Update state service
      this.libraryStateService.setStats(this.stats);
    } catch (error) {
      console.error('Failed to load stats:', error);
      // Don't show error notification - empty library is expected
    }
  }

  /**
   * Load all videos from database with progressive loading
   */
  async loadVideos() {
    try {
      // Cancel any ongoing background loads to prevent duplicates
      this.cancelBackgroundLoad = true;

      // Wait for background load to actually stop (check every 50ms, max 500ms)
      let waitTime = 0;
      while (this.backgroundLoadRunning && waitTime < 500) {
        await new Promise(resolve => setTimeout(resolve, 50));
        waitTime += 50;
      }

      if (this.backgroundLoadRunning) {
        console.warn('[loadVideos] Background load still running after 500ms wait, proceeding anyway');
      }

      this.isLoading = true;

      // First, load a small batch quickly to show something to the user
      if (this.isInitialLoad) {
        // Reset cancel flag before starting new background load
        this.cancelBackgroundLoad = false;

        const initialResponse = await this.databaseLibraryService.getVideos(20, 0);
        this.videos = initialResponse.videos;

        // Update state service
        this.libraryStateService.setVideos(this.videos);

        this.applyFiltersAndSort();
        this.markItemsWithSuggestions(); // Add class to items with suggestions
        console.log(`[loadVideos] Loaded initial ${this.videos.length} videos`);

        // If there are more videos, continue loading in the background
        if (initialResponse.count > 20) {
          this.isLoading = false; // Show the initial results while loading more
          this.loadRemainingVideos(initialResponse.count);
        } else {
          this.isInitialLoad = false;
          this.isLoading = false;
        }
      } else {
        // On subsequent loads, load all at once (bypass cache to ensure fresh data)
        console.log(`[loadVideos] BEFORE fetch: this.videos.length = ${this.videos.length}`);
        const response = await this.databaseLibraryService.getVideos(1000, 0, false);
        console.log(`[loadVideos] Fetched ${response.videos.length} videos from API`);
        this.videos = response.videos;
        console.log(`[loadVideos] AFTER assignment: this.videos.length = ${this.videos.length}`);

        // Update state service
        this.libraryStateService.setVideos(this.videos);

        this.applyFiltersAndSort();
        this.markItemsWithSuggestions(); // Add class to items with suggestions
        console.log(`[loadVideos] Loaded ${this.videos.length} videos (full reload, fresh from DB)`);
        this.isLoading = false;

        // Reset cancel flag after reload is complete
        this.cancelBackgroundLoad = false;
      }
    } catch (error) {
      console.error('[loadVideos] Failed to load videos:', error);
      // Don't show error notification - empty library is expected
      this.isLoading = false;
      this.isInitialLoad = false;
      this.cancelBackgroundLoad = false; // Reset flag on error
    }
  }

  /**
   * Load remaining videos in the background after initial batch
   */
  private async loadRemainingVideos(totalCount: number) {
    this.backgroundLoadRunning = true;
    console.log('[loadRemainingVideos] Starting background load');

    try {
      // Load the rest in batches of 100
      const batchSize = 100;
      let offset = 20; // Start after the initial 20

      while (offset < totalCount && offset < 1000) {
        // Check if we should cancel this background load
        if (this.cancelBackgroundLoad) {
          console.log('[loadRemainingVideos] Background video loading cancelled');
          this.backgroundLoadRunning = false;
          return;
        }

        const response = await this.databaseLibraryService.getVideos(batchSize, offset);

        // Check again after async operation
        if (this.cancelBackgroundLoad) {
          console.log('[loadRemainingVideos] Background video loading cancelled after fetch');
          this.backgroundLoadRunning = false;
          return;
        }

        // CRITICAL: Log before appending to detect duplicates
        console.log(`[loadRemainingVideos] BEFORE append: this.videos.length = ${this.videos.length}`);
        console.log(`[loadRemainingVideos] About to append ${response.videos.length} videos`);

        this.videos = [...this.videos, ...response.videos];

        // Update state service
        this.libraryStateService.setVideos(this.videos);

        console.log(`[loadRemainingVideos] AFTER append: this.videos.length = ${this.videos.length}`);
        this.applyFiltersAndSort();
        offset += batchSize;
        console.log(`[loadRemainingVideos] Loaded ${offset} of ${totalCount} videos`);

        // Small delay to prevent overwhelming the UI
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`[loadRemainingVideos] Finished loading all ${this.videos.length} videos`);
      this.isInitialLoad = false;
      this.backgroundLoadRunning = false;
    } catch (error) {
      console.error('[loadRemainingVideos] Failed to load remaining videos:', error);
      this.isInitialLoad = false;
      this.backgroundLoadRunning = false;
    }
  }

  /**
   * Load all tags from database
   */
  async loadTags() {
    try {
      this.allTags = await this.databaseLibraryService.getTags();
      console.log('Loaded tags:', this.allTags);

      // Update state service
      this.libraryStateService.setAllTags(this.allTags);
    } catch (error) {
      console.error('Failed to load tags:', error);
    }
  }

  /**
   * Reload library data with cache clear
   * Consolidates the common pattern of clearCache + loadVideos + loadStats + loadTags
   */
  async reloadLibrary(options: { videos?: boolean; stats?: boolean; tags?: boolean } = {}) {
    // Default to reloading everything
    const { videos = true, stats = true, tags = true } = options;

    // Clear cache first
    this.databaseLibraryService.clearCache();

    // Reload requested data in parallel
    const promises: Promise<any>[] = [];

    if (videos) {
      promises.push(this.loadVideos());
    }

    if (stats) {
      promises.push(this.loadStats());
    }

    if (tags) {
      promises.push(this.loadTags());
    }

    await Promise.all(promises);
  }

  /**
   * Load all libraries with minimal retry logic
   */
  async loadLibraries(retryCount = 0, maxRetries = 3): Promise<void> {
    try {
      this.isLoadingLibraries = true;

      // Update state service
      this.libraryStateService.setLoadingLibraries(true);

      const url = await this.backendUrlService.getApiUrl('/database/libraries');
      const response = await this.http.get<{
        libraries: ClipLibrary[];
        activeLibrary: ClipLibrary | null;
      }>(url).toPromise();

      if (response) {
        this.libraries = response.libraries;
        this.activeLibrary = response.activeLibrary;
        this.selectedLibraryId = response.activeLibrary?.id || '';
        console.log(`[loadLibraries] Loaded ${this.libraries.length} libraries`);

        // Update state service
        this.libraryStateService.setLibraries(this.libraries);
        this.libraryStateService.setCurrentLibrary(this.activeLibrary);
      }
    } catch (error) {
      const errorStatus = (error as any)?.status;

      // Only retry for connection errors (not 404 or other HTTP errors)
      if (errorStatus === 0 && retryCount < maxRetries) {
        const retryDelay = 200; // Fast 200ms retry
        console.log(`[loadLibraries] Backend not ready, retrying in ${retryDelay}ms... (${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.loadLibraries(retryCount + 1, maxRetries);
      } else if (retryCount >= maxRetries) {
        console.error('[loadLibraries] Backend unavailable after retries');
        this.notificationService.toastOnly('error', 'Backend Unavailable', 'Could not connect to backend server');
      } else {
        console.error('[loadLibraries] Failed with status', errorStatus, error);
      }
    } finally {
      this.isLoadingLibraries = false;

      // Update state service
      this.libraryStateService.setLoadingLibraries(false);
    }
  }

  /**
   * Switch active library
   */
  async onLibraryChange() {
    if (!this.selectedLibraryId || this.selectedLibraryId === this.activeLibrary?.id) {
      return;
    }

    try {
      const baseUrl = await this.backendUrlService.getApiUrl('/database/libraries');
      const response = await this.http.post<{
        success: boolean;
        message?: string;
      }>(`${baseUrl}/${this.selectedLibraryId}/switch`, {})
        .toPromise();

      if (response?.success) {
        // Reset to initial load state for new library
        this.isInitialLoad = true;
        await this.loadLibraries();
        await this.loadStats();
        await this.loadVideos();
        await this.loadTags();
      }
    } catch (error) {
      console.error('Failed to switch library:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to switch library');
      // Revert selection
      this.selectedLibraryId = this.activeLibrary?.id || '';
    }
  }

  /**
   * Open manage libraries dialog
   */
  async openManageLibraries() {
    const { ManageLibrariesDialogComponent } = await import('./manage-libraries-dialog.component');

    const dialogRef = this.dialog.open(ManageLibrariesDialogComponent, {
      width: '700px',
      data: { activeLibraryId: this.activeLibrary?.id || null }
    });

    const librariesChanged = await dialogRef.afterClosed().toPromise();

    if (librariesChanged) {
      // Reset to initial load state when library changes
      this.isInitialLoad = true;
      await this.loadLibraries();
      await this.loadStats();
      await this.loadVideos();
      await this.loadTags();
    }
  }

  /**
   * Open video management dialog
   */
  viewUnimportedVideos() {
    // Navigate to library management view
    this.router.navigate(['/library-management']);
  }

  /**
   * Apply filters and sorting to videos
   */
  applyFiltersAndSort() {
    // Use VideoFilterService for all filtering/sorting
    const criteria: FilterCriteria = {
      searchQuery: this.searchQuery,
      searchFilters: this.searchFilters,
      selectedTags: this.selectedTags,
      fileTypeFilters: this.fileTypeFilters,
      sortBy: this.sortBy,
      sortOrder: this.sortOrder
    };

    const filtered = this.videoFilterService.applyFilters(this.videos, criteria);
    this.filteredVideos = filtered;

    // Update state service
    this.libraryStateService.setFilteredVideos(filtered);

    // Group videos by week/folder
    this.groupVideosByWeek();

    // Update cached list items (avoid recomputation on every change detection)
    this.updateVideosAsListItems();

    // Mark items with suggestions for orange styling
    this.markItemsWithSuggestions();
  }

  /**
   * Group videos by date folder/week using download date (when you downloaded it)
   */
  groupVideosByWeek() {
    const groups = new Map<string, DatabaseVideo[]>();

    for (const video of this.filteredVideos) {
      // Use video.download_date (file creation timestamp) for weekly grouping
      // This represents when YOU downloaded/created the file, not the content date
      const downloadDate = new Date(video.download_date || video.added_at);
      const week = this.getWeekIdentifier(downloadDate);

      if (!groups.has(week)) {
        groups.set(week, []);
      }

      // If this is a child video, insert a ghost parent reference first
      if (video.parent_id) {
        const parent = this.filteredVideos.find(v => v.id === video.parent_id);
        if (parent) {
          // Create a ghost parent reference (marked with a special property)
          const ghostParent = {
            ...parent,
            isGhostParent: true,
            ghostChildId: video.id  // Track which child this ghost belongs to
          } as any;
          groups.get(week)!.push(ghostParent);
        }
      }

      groups.get(week)!.push(video);
    }

    // Convert to array and sort by week name (descending - newest first)
    this.groupedVideos = Array.from(groups.entries())
      .map(([week, videos]) => ({ week, videos }))
      .sort((a, b) => b.week.localeCompare(a.week));
  }

  /**
   * Get week identifier for a date
   */
  private getWeekIdentifier(date: Date): string {
    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);

    // Get the Sunday of this week (start of week)
    const day = tempDate.getDay();
    const diff = tempDate.getDate() - day; // Sunday is 0, so subtract current day
    tempDate.setDate(diff);

    // Format as yyyy-mm-dd
    const year = tempDate.getFullYear();
    const month = String(tempDate.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(tempDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${dayOfMonth}`;
  }

  /**
   * Toggle week collapse state
   */
  toggleWeek(week: string, event?: Event) {
    if (event) {
      event.stopPropagation();
    }
    if (this.collapsedWeeks.has(week)) {
      this.collapsedWeeks.delete(week);
    } else {
      this.collapsedWeeks.add(week);
    }
  }

  /**
   * Check if week is collapsed
   */
  isWeekCollapsed(week: string): boolean {
    return this.collapsedWeeks.has(week);
  }

  /**
   * Format week label for display
   */
  private formatWeekLabel(weekStart: string | Date): string {
    const date = typeof weekStart === 'string' ? new Date(weekStart) : weekStart;
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    return `Week of ${date.toLocaleDateString('en-US', options)}`;
  }

  /**
   * Select all filtered videos
   */
  selectAll() {
    // Use LibraryStateService to select all filtered videos
    this.libraryStateService.selectAllVideos();

    // Also update local state for weeks
    this.selectedVideos = this.libraryStateService.getSelectedVideoIds();
  }

  /**
   * Toggle file type filter
   */
  toggleFileTypeFilter(type: 'video' | 'audio' | 'document' | 'image' | 'webpage') {
    this.fileTypeFilters[type] = !this.fileTypeFilters[type];
    this.applyFiltersAndSort();
  }

  /**
   * Select all file types
   */
  selectAllFileTypes() {
    this.fileTypeFilters = {
      video: true,
      audio: true,
      document: true,
      image: true,
      webpage: true
    };
    this.applyFiltersAndSort();
  }

  /**
   * Close the file type menu
   */
  closeFileTypeMenu() {
    if (this.fileTypeMenuTrigger) {
      this.fileTypeMenuTrigger.closeMenu();
    }
  }

  /**
   * Select all videos missing transcript
   */
  selectAllMissingTranscript() {
    // Toggle behavior: if already selected, deselect those videos
    if (this.isMissingTranscriptSelected) {
      // Use service to get videos missing transcript, then deselect them
      const videosToDeselect = this.videoFilterService.getVideosMissingTranscript(this.filteredVideos);
      videosToDeselect.forEach(video => {
        this.libraryStateService.deselectVideo(video.id);
        this.selectedVideos.delete(video.id);
      });
      this.isMissingTranscriptSelected = false;
    } else {
      // Use service to get and select videos missing transcript
      const videosToSelect = this.videoFilterService.getVideosMissingTranscript(this.filteredVideos);
      videosToSelect.forEach(video => {
        this.libraryStateService.selectVideo(video.id);
        this.selectedVideos.add(video.id);
      });
      this.isMissingTranscriptSelected = true;
    }

    this.updateSelectedCount(); // Update cached count
    this.updateAllSelectedState();
  }

  /**
   * Select all videos missing AI analysis
   */
  selectAllMissingAnalysis() {
    // Toggle behavior: if already selected, deselect those videos
    if (this.isMissingAnalysisSelected) {
      // Use service to get videos missing analysis, then deselect them
      const videosToDeselect = this.videoFilterService.getVideosMissingAnalysis(this.filteredVideos);
      videosToDeselect.forEach(video => {
        this.libraryStateService.deselectVideo(video.id);
        this.selectedVideos.delete(video.id);
      });
      this.isMissingAnalysisSelected = false;
    } else {
      // Use service to get and select videos missing analysis
      const videosToSelect = this.videoFilterService.getVideosMissingAnalysis(this.filteredVideos);
      videosToSelect.forEach(video => {
        this.libraryStateService.selectVideo(video.id);
        this.selectedVideos.add(video.id);
      });
      this.isMissingAnalysisSelected = true;
    }

    this.updateSelectedCount(); // Update cached count
    this.updateAllSelectedState();
  }

  /**
   * Handle search criteria change from SearchBarComponent
   */
  onSearchCriteriaChange(criteria: SearchCriteriaChange): void {
    this.searchQuery = criteria.searchQuery;
    this.searchFilters = criteria.searchFilters;
    this.selectedTags = criteria.selectedTags;
    this.fileTypeFilters = criteria.fileTypeFilters;
    this.sortBy = criteria.sortBy;
    this.sortOrder = criteria.sortOrder;

    this.applyFiltersAndSort();
  }

  /**
   * Handle clear all search filters
   */
  onClearAllSearch(): void {
    this.clearSearch();
  }

  /**
   * Clear all search filters
   */
  clearSearch() {
    this.searchQuery = '';
    this.selectedTags = [];
    // Reset file type filters to show all types
    this.fileTypeFilters = {
      video: true,
      audio: true,
      document: true,
      image: true,
      webpage: true
    };
    this.applyFiltersAndSort();
  }

  /**
   * Select a video for playback
   */
  selectVideo(video: DatabaseVideo) {
    console.log('[selectVideo] Selecting video:', video.id, video.filename);

    // Stop previous video if playing
    if (this.videoElement && !this.videoElement.paused) {
      this.videoElement.pause();
    }

    this.selectedVideo = video;
    this.isPlaying = false;

    // Auto-play the video if enabled
    if (this.autoPlayEnabled) {
      // Wait for video element to be ready and get fresh reference
      setTimeout(() => {
        // Get fresh reference to video element
        const videoEl = this.detailVideoPlayer?.nativeElement;
        if (videoEl) {
          this.videoElement = videoEl;
          videoEl.play().catch(err => {
            console.error('Auto-play failed:', err);
          });
          this.isPlaying = true;
        } else {
          console.warn('[selectVideo] Video element not found in DOM');
        }
      }, 150);
    }
  }

  /**
   * Get thumbnail URL for a video
   */
  getVideoThumbnailUrl(video: DatabaseVideo): string {
    return `${this.backendUrl}/api/database/videos/${video.id}/thumbnail`;
  }

  /**
   * Get streaming URL for a video
   */
  getVideoStreamUrl(video: DatabaseVideo): string {
    // Properly encode Unicode path to base64
    // Convert string -> UTF-8 bytes -> base64
    const utf8Bytes = new TextEncoder().encode(video.current_path);
    const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
    const encodedPath = btoa(binaryString);

    // Use dedicated image endpoint for images, video endpoint for everything else
    const endpoint = video.media_type === 'image'
      ? '/api/library/images/custom'
      : '/api/library/videos/custom';

    const url = `${this.backendUrl}${endpoint}?path=${encodeURIComponent(encodedPath)}`;
    console.log(`[Preview] Media type: ${video.media_type}, Path: ${video.current_path}`);
    console.log(`[Preview] Generated URL: ${url}`);
    return url;
  }

  /**
   * Get display name for video (remove extension and clean up)
   */
  getVideoDisplayName(video: DatabaseVideo): string {
    let name = video.filename;

    // Remove extension if present
    if (video.file_extension) {
      name = name.replace(new RegExp(video.file_extension + '$'), '');
    }

    // Remove leading date patterns from display:
    // - YYYY-MM-DD: "2025-11-02 - filename"
    // - YYYY-MM-TT: "2025-11-T1" or "2025-11-T2" or "2025-11-T3" (trimester format)
    // - YYYY-MM: "2025-11 filename"
    // - YYYY: "2025 filename"
    // Followed by optional separators: space, dash, underscore
    name = name.replace(/^\d{4}(-\d{2}(-(\d{2}|T[123]))?)?[\s_-]*/, '');

    return name;
  }

  /**
   * Format secondary text for video display
   */
  formatVideoSecondaryText(video: DatabaseVideo): string {
    const parts: string[] = [];

    // Name suggestion with preview (orange color will be applied via JavaScript)
    if (video.suggested_title) {
      // Show first 60 characters of suggested title
      const preview = video.suggested_title.length > 60
        ? video.suggested_title.substring(0, 60) + '...'
        : video.suggested_title;
      parts.push(`💡 Suggested: ${preview} - Click to View`);
    }

    // Upload date (from filename) - when content was created/filmed by the person
    if (video.upload_date) {
      const uploadDate = new Date(video.upload_date);
      parts.push(`Uploaded: ${uploadDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    }

    // Download date (when file was created/downloaded) - when user downloaded the video
    if (video.download_date) {
      const downloadDate = new Date(video.download_date);
      parts.push(`Downloaded: ${downloadDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    }

    return parts.join(' • ');
  }

  /**
   * Format video duration for display
   */
  formatVideoDuration(video: DatabaseVideo): string {
    if (!video.duration_seconds) {
      return '';
    }

    const hours = Math.floor(video.duration_seconds / 3600);
    const mins = Math.floor((video.duration_seconds % 3600) / 60);
    const secs = Math.floor(video.duration_seconds % 60);

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Get media type icon
   */
  getMediaIcon(video: DatabaseVideo): string {
    switch (video.media_type) {
      case 'video': return 'movie';
      case 'audio': return 'audiotrack';
      case 'document': return 'description';
      case 'image': return 'image';
      case 'webpage': return 'language';
      default: return 'description';
    }
  }

  /**
   * Map video status to visual indicator
   */
  getVideoStatusMapper = (video: DatabaseVideo): ItemStatus | null => {
    // Priority: missing both > has transcript only > has analysis (complete)
    if (!video.has_transcript && !video.has_analysis) {
      return { color: '#dc3545', tooltip: 'Missing transcript and analysis' }; // Red
    }
    if (!video.has_analysis) {
      // Has transcript but no analysis
      return { color: '#ff6600', tooltip: 'Missing analysis' }; // Orange
    }
    // If has_analysis is true, transcript must exist (can't analyze without transcript)
    // Long videos (>10 min) get blue marker
    if (video.duration_seconds && video.duration_seconds > 600) {
      return { color: '#0dcaf0', tooltip: 'Complete (>10 min)' }; // Blue
    }
    // Short videos (<10 min) get green marker
    return { color: '#198754', tooltip: 'Complete' }; // Green
  };

  /**
   * Convert DatabaseVideo array to ListItem compatible array
   * Updates the cached videosAsListItems property
   */
  private updateVideosAsListItems(): void {
    const result: any[] = [];
    const videoMap = new Map(this.filteredVideos.map(v => [v.id, v]));

    const getWeekForVideo = (video: any) => {
      return this.getWeekIdentifier(new Date(video.download_date || video.added_at));
    };

    const hasChildren = new Set<string>();
    for (const video of this.filteredVideos) {
      if (video.parent_id) {
        hasChildren.add(video.parent_id);
      }
    }

    const weekGroups = new Map<string, any[]>();
    for (const video of this.filteredVideos) {
      const week = getWeekForVideo(video);
      if (!weekGroups.has(week)) {
        weekGroups.set(week, []);
      }
      weekGroups.get(week)!.push(video);
    }

    const sortedWeeks = Array.from(weekGroups.keys()).sort((a, b) => b.localeCompare(a));
    const addedRealVideos = new Set<string>();

    for (const week of sortedWeeks) {
      const videosInWeek = weekGroups.get(week)!;
      const childrenByParent = new Map<string, any[]>();
      const orphanedVideos: any[] = [];

      for (const video of videosInWeek) {
        if (video.parent_id) {
          const parent = videoMap.get(video.parent_id);
          if (parent) {
            const parentWeek = getWeekForVideo(parent);
            if (parentWeek !== week) {
              if (!childrenByParent.has(video.parent_id)) {
                childrenByParent.set(video.parent_id, []);
              }
              childrenByParent.get(video.parent_id)!.push(video);
            } else {
              orphanedVideos.push(video);
            }
          } else {
            orphanedVideos.push(video);
          }
        } else {
          orphanedVideos.push(video);
        }
      }

      for (const [parentId, children] of childrenByParent.entries()) {
        const parent = videoMap.get(parentId);
        if (!parent) continue;

        const ghostParent = {
          ...parent,
          isGhostParent: true,
          isChild: false,
          isParent: hasChildren.has(parent.id),
          download_date: children[0].download_date
        } as any;
        result.push(ghostParent);

        for (const child of children) {
          if (addedRealVideos.has(child.id)) continue;
          result.push({
            ...child,
            isChild: true,
            isParent: hasChildren.has(child.id),
            isGhostParent: false,
            isGhostChild: false
          });
          addedRealVideos.add(child.id);
        }
      }

      for (const video of orphanedVideos) {
        if (addedRealVideos.has(video.id)) continue;
        result.push({
          ...video,
          isChild: !!video.parent_id,
          isParent: hasChildren.has(video.id),
          isGhostParent: false,
          isGhostChild: false
        });
        addedRealVideos.add(video.id);

        if (hasChildren.has(video.id)) {
          const children = this.filteredVideos.filter(v => v.parent_id === video.id);
          for (const child of children) {
            const childWeek = getWeekForVideo(child);
            if (childWeek !== week) {
              const ghostChild = {
                ...child,
                isGhostChild: true,
                isChild: true,
                isParent: false,
                ghostParentId: video.id,
                download_date: video.download_date
              } as any;
              result.push(ghostChild);
            }
          }
        }
      }
    }

    this.videosAsListItems = result as (DatabaseVideo & ListItem)[];
  }

  /**
   * Handle list item click
   */
  onListItemClick(video: DatabaseVideo) {
    this.highlightedVideo = video;
    if (this.viewMode === 'detail') {
      this.selectVideo(video);
    } else if (this.viewMode === 'list' && this.currentPreviewDialogRef) {
      this.loadPreviewVideo(video);
    }
  }

  /**
   * Handle list item double click
   */
  onListItemDoubleClick(video: DatabaseVideo) {
    this.openVideoPlayer(video);
  }

  /**
   * Show name suggestion dialog with Accept/Reject buttons
   */
  async showNameSuggestionDialog(video: DatabaseVideo) {
    if (!video.suggested_title) return;

    const dialogRef = this.dialog.open(NameSuggestionDialogComponent, {
      width: '600px',
      data: {
        currentFilename: video.filename,
        suggestedTitle: video.suggested_title,
        uploadDate: video.upload_date
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.action === 'accept' || result === 'accept') {
      // Accept and rename (support both old and new dialog format)
      const customFilename = result?.filename;
      await this.acceptVideoSuggestion(video, customFilename);
    } else if (result === 'reject') {
      // Just reject/clear
      await this.rejectVideoSuggestion(video);
    }
  }

  /**
   * Accept the name suggestion and rename the video
   */
  async acceptVideoSuggestion(video: DatabaseVideo, customFilename?: string) {
    try {
      const url = await this.backendUrlService.getApiUrl(`/database/videos/${video.id}/accept-suggested-title`);
      const body = customFilename ? { customFilename } : {};
      const result = await this.http.post<{ success: boolean; message?: string; error?: string; newPath?: string; newFilename?: string }>(url, body).toPromise();

      if (result?.success) {
        // Update the video object in place
        video.suggested_title = null;
        if (result.newFilename) {
          video.filename = result.newFilename;
        }

        // Update the DOM element directly
        this.updateListItemSecondaryText(video);

        this.notificationService.toastOnly('success', 'Renamed', 'File has been renamed successfully');
      } else {
        this.notificationService.toastOnly('error', 'Rename Failed', result?.error || 'Failed to rename video');
      }
    } catch (error: any) {
      console.error('Error accepting suggestion:', error);
      this.notificationService.toastOnly('error', 'Rename Failed', error.error?.message || 'Failed to rename video');
    }
  }

  /**
   * Reject the name suggestion (clear it)
   */
  async rejectVideoSuggestion(video: DatabaseVideo) {
    try {
      const url = await this.backendUrlService.getApiUrl(`/database/videos/${video.id}/reject-suggested-title`);
      const result = await this.http.post<{ success: boolean; message?: string; error?: string }>(url, {}).toPromise();

      if (result?.success) {
        // Update the video object in place
        video.suggested_title = null;

        // Update the DOM element directly
        this.updateListItemSecondaryText(video);

        this.notificationService.toastOnly('success', 'Suggestion Rejected', 'The suggestion has been removed');
      } else {
        this.notificationService.toastOnly('error', 'Rejection Failed', result?.error || 'Failed to reject suggestion');
      }
    } catch (error: any) {
      console.error('Error rejecting suggestion:', error);
      this.notificationService.toastOnly('error', 'Rejection Failed', error.error?.message || 'Failed to reject suggestion');
    }
  }

  /**
   * Update a specific list item's text without reloading the entire list
   */
  private updateListItemSecondaryText(video: DatabaseVideo) {
    // Find the DOM element for this video
    const listItem = document.getElementById(`item-${video.id}`);
    if (!listItem) {
      console.warn(`[updateListItemSecondaryText] Could not find list item for video ${video.id}`);
      return;
    }

    // Update the primary text (filename)
    const primaryTextElement = listItem.querySelector('.item-primary') as HTMLElement;
    if (primaryTextElement) {
      primaryTextElement.textContent = video.filename;
    }

    // Update the secondary text
    const secondaryTextElement = listItem.querySelector('.item-secondary') as HTMLElement;
    if (secondaryTextElement) {
      const newSecondaryText = this.formatVideoSecondaryText(video);
      secondaryTextElement.textContent = newSecondaryText;

      // Remove the styling attribute so it won't try to style it again
      secondaryTextElement.removeAttribute('data-suggestion-styled');
    }

    console.log(`[updateListItemSecondaryText] Updated list item for ${video.id}`);
  }

  /**
   * Add CSS class to list items that have name suggestions (for orange text)
   * Also add click handlers to secondary text to open video info
   */
  private markItemsWithSuggestions() {
    // Setup mutation observer to watch for DOM changes
    const observer = new MutationObserver(() => {
      this.styleSuggestionTexts();
    });

    // Observe the cascade list for changes
    const cascadeList = document.querySelector('cascade-list');
    if (cascadeList) {
      observer.observe(cascadeList, {
        childList: true,
        subtree: true
      });
    }

    // Also try immediately and with delays
    this.styleSuggestionTexts();
    setTimeout(() => this.styleSuggestionTexts(), 100);
    setTimeout(() => this.styleSuggestionTexts(), 500);
    setTimeout(() => this.styleSuggestionTexts(), 1000);
  }

  private styleSuggestionTexts() {
    // Use the exact approach that worked in console
    const allSecondaryElements = Array.from(document.querySelectorAll('.item-secondary'));
    const suggestionElements = allSecondaryElements.filter(el =>
      el.textContent && el.textContent.includes('Suggested:') && el.textContent.includes('Click to View')
    );

    console.log(`[styleSuggestionTexts] Found ${suggestionElements.length} suggestion elements`);

    suggestionElements.forEach((element) => {
      const secondaryText = element as HTMLElement;
      if (!secondaryText.getAttribute('data-suggestion-styled')) {
        console.log('[styleSuggestionTexts] Styling element:', secondaryText.textContent);

        const originalText = secondaryText.textContent || '';

        // Split the text to wrap only "Click to View" in a styled span
        const parts = originalText.split('Click to View');
        if (parts.length === 2) {
          // Clear the element and rebuild with span for "Click to View"
          secondaryText.innerHTML = '';

          // Add the first part (normal text)
          const normalText = document.createTextNode(parts[0]);
          secondaryText.appendChild(normalText);

          // Add "Click to View" as a styled span
          const clickSpan = document.createElement('span');
          clickSpan.textContent = 'Click to View';
          clickSpan.style.setProperty('color', '#ff8c00', 'important');
          clickSpan.style.cursor = 'pointer';
          secondaryText.appendChild(clickSpan);

          // Add any text after "Click to View"
          if (parts[1]) {
            const endText = document.createTextNode(parts[1]);
            secondaryText.appendChild(endText);
          }

          // Add click handler only to the orange span - find which video this belongs to
          const listItem = secondaryText.closest('.item-card') as HTMLElement;
          if (listItem) {
            const itemId = listItem.getAttribute('id');
            // Extract video ID from "item-{videoId}" format
            const videoId = itemId ? itemId.replace('item-', '') : null;
            if (videoId) {
              const video = this.videos.find(v => v.id === videoId);
              if (video) {
                clickSpan.onclick = (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  this.showNameSuggestionDialog(video);
                };
              }
            }
          }
        }

        secondaryText.setAttribute('data-suggestion-styled', 'true');
      }
    });
  }

  onListItemsSelected(videos: DatabaseVideo[]) {
    // Add selected videos to the selection set
    videos.forEach(video => this.selectedVideos.add(video.id));
    this.updateSelectedCount(); // Update cached count

    // Finder-like behavior: The last selected item becomes the highlighted one
    if (videos.length > 0) {
      this.highlightedVideo = videos[videos.length - 1];
    }
  }

  onListItemsDeselected(videos: DatabaseVideo[]) {
    // Remove deselected videos from the selection set
    videos.forEach(video => this.selectedVideos.delete(video.id));
    this.updateSelectedCount(); // Update cached count
  }

  onListSpaceAction(video: DatabaseVideo | null) {
    if (!video) return;

    // Finder-like behavior: If dialog is already open, close it
    if (this.currentPreviewDialogRef) {
      this.closePreviewModal();
      return;
    }

    // Set the video and open the preview dialog
    this.highlightedVideo = video;
    this.openPreviewModal();
  }

  onListDeleteAction(videos: DatabaseVideo[]) {
    this.deleteSelected();
  }

  onListItemHighlighted(video: DatabaseVideo | null) {
    // Save the previous highlighted video before updating
    const previousVideo = this.highlightedVideo;

    // Update highlighted video
    this.highlightedVideo = video;

    // Auto-load preview when navigating with arrow keys if preview dialog is open
    if (video && this.currentPreviewDialogRef && video.id !== previousVideo?.id) {
      this.loadPreviewVideo(video);
    }
  }

  onListContextMenu(data: { event: MouseEvent; item: DatabaseVideo }) {
    // Prevent default and stop propagation
    data.event.preventDefault();
    data.event.stopPropagation();

    // Finder-like behavior: If right-clicking on an unselected item, clear selection and select only that item
    if (!this.selectedVideos.has(data.item.id)) {
      // Clear all selections
      this.selectedVideos.clear();
      // Select only the right-clicked item
      this.selectedVideos.add(data.item.id);
      // Update cached count
      this.updateSelectedCount();
      // Highlight the right-clicked item
      this.highlightedVideo = data.item;
      this.updateAllSelectedState();
    }
    // If right-clicking on a selected item, keep the current selection (allows multi-item operations)

    // Set context menu position and video
    this.contextMenuPosition = {
      x: data.event.clientX,
      y: data.event.clientY
    };
    this.contextMenuVideo = data.item;

    // Clear any pending timeout to avoid race conditions
    if (this.contextMenuTimeout) {
      clearTimeout(this.contextMenuTimeout);
      this.contextMenuTimeout = null;
    }

    // If menu is already open, close it first then reopen at new position
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
      this.isContextMenuOpen = false;
      // Reopen after a short delay to allow closing animation
      this.contextMenuTimeout = setTimeout(() => {
        if (this.contextMenuTrigger) {
          this.contextMenuTrigger.openMenu();
          this.isContextMenuOpen = true;
        }
        this.contextMenuTimeout = null;
      }, 50);
    } else {
      // Open the Material menu with a slight delay to ensure it stays open
      this.contextMenuTimeout = setTimeout(() => {
        if (this.contextMenuTrigger) {
          this.contextMenuTrigger.openMenu();
          this.isContextMenuOpen = true;
        }
        this.contextMenuTimeout = null;
      }, 0);
    }
  }

  onListContextMenuAction(event: { action: string; items: DatabaseVideo[] }) {
    switch (event.action) {
      case 'open':
        if (event.items.length > 0) {
          this.openVideoPlayer(event.items[0]);
        }
        break;
      case 'openLocation':
        if (event.items.length > 0) {
          this.openFileLocation(event.items[0]);
        }
        break;
      case 'copyPath':
        if (event.items.length > 0) {
          this.copyFilename(event.items[0]);
        }
        break;
      case 'analyze':
        // Use event.items directly instead of relying on this.selectedVideos
        if (event.items && event.items.length > 0) {
          this.analyzeVideos(event.items);
        }
        break;
      case 'transcribe':
        // Use event.items directly instead of relying on this.selectedVideos
        if (event.items && event.items.length > 0) {
          this.analyzeVideos(event.items);
        }
        break;
      case 'relink':
        // TODO: Implement single video relink
        console.log('Relink not yet implemented for single video from list');
        break;
      case 'delete':
        this.deleteSelected();
        break;
    }
  }

  /**
   * Navigate through videos with arrow keys
   */
  navigateVideos(direction: number) {
    if (!this.selectedVideo || this.filteredVideos.length === 0) {
      // No video selected, select first one
      if (this.filteredVideos.length > 0) {
        this.selectVideo(this.filteredVideos[0]);
        this.scrollToVideo(this.filteredVideos[0]);
      }
      return;
    }

    const currentIndex = this.filteredVideos.findIndex(v => v.id === this.selectedVideo!.id);
    if (currentIndex === -1) return;

    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < this.filteredVideos.length) {
      const newVideo = this.filteredVideos[newIndex];
      this.selectVideo(newVideo);
      this.scrollToVideo(newVideo);
    }
  }

  /**
   * Scroll to a video in the list
   */
  scrollToVideo(video: DatabaseVideo) {
    setTimeout(() => {
      const videoElement = document.querySelector(`.video-list-item.selected`);
      if (videoElement) {
        videoElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);
  }

  /**
   * Handle spacebar key press for play/pause
   */
  onSpacebarPress(event: KeyboardEvent) {
    if (this.viewMode === 'detail' && this.videoElement) {
      event.preventDefault();
      if (this.videoElement.paused) {
        this.videoElement.play();
        this.isPlaying = true;
      } else {
        this.videoElement.pause();
        this.isPlaying = false;
      }
    }
  }

  /**
   * Reanalyze the selected video
   */
  reanalyzeSelectedVideo() {
    if (this.selectedVideo) {
      const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
        width: '700px',
        maxWidth: '90vw',
        maxHeight: '85vh',
        panelClass: 'video-analysis-dialog-panel',
        data: {
          selectedVideos: [this.selectedVideo]
        },
        disableClose: false
      });

      dialogRef.afterClosed().subscribe(result => {
        if (result && result.success && result.jobsToAdd) {
          setTimeout(() => {
            for (const jobData of result.jobsToAdd) {
              this.analysisQueueService.addPendingJob(jobData);
            }
            console.log(`Added ${result.jobsToAdd.length} job(s) to analysis queue`);
          }, 0);
        }
      });
    }
  }

  /**
   * Open video in editor/player
   */
  async openVideoPlayer(video: DatabaseVideo) {
    // Navigate to video editor with video data
    this.router.navigate(['/video-editor'], {
      state: {
        videoEditorData: {
          videoId: video.id,
          videoPath: video.current_path,
          videoTitle: video.filename
        }
      }
    });
  }

  /**
   * Open video info/metadata page
   */
  async openMetadataEditor(video: DatabaseVideo) {
    // Navigate to video info page with video data
    this.router.navigate(['/video-info', video.id], {
      state: {
        videoData: video
      }
    });
  }

  /**
   * Open video editor for the selected video
   */
  async openVideoEditor() {
    if (this.selectedVideos.size !== 1) {
      this.notificationService.toastOnly('info', 'Select One Video', 'Please select exactly one video to edit');
      return;
    }

    // Get the selected video ID
    const videoId = Array.from(this.selectedVideos)[0];
    const video = this.videos.find(v => v.id === videoId);

    if (!video) {
      this.notificationService.toastOnly('error', 'Video Not Found', 'Could not find the selected video');
      return;
    }

    // Navigate to video editor
    this.openVideoPlayer(video);
  }

  /**
   * Analyze selected videos (from toolbar button)
   */
  async analyzeSelected() {
    console.log('analyzeSelected called, selected count:', this.selectedVideos.size);

    if (this.selectedVideos.size === 0) {
      this.notificationService.toastOnly('info', 'No Videos Selected', 'Please select videos to analyze');
      return;
    }

    // Convert Set to array of video IDs
    const videoIds = Array.from(this.selectedVideos);
    console.log('Selected video IDs:', videoIds);

    // Get video details for selected videos
    const selectedVideoDetails = this.videos.filter(v => videoIds.includes(v.id));
    console.log('Selected video details:', selectedVideoDetails);

    if (selectedVideoDetails.length === 0) {
      console.error('No video details found for selected IDs');
      this.notificationService.toastOnly('error', 'Error', 'Could not find details for selected videos');
      return;
    }

    this.analyzeVideos(selectedVideoDetails);
  }

  /**
   * Analyze specific videos (can be called from context menu or other sources)
   */
  private async analyzeVideos(videos: DatabaseVideo[]) {
    // Delegate to VideoOperationsService
    await this.videoOperationsService.analyzeVideos(videos, this.analysisQueueService);

    // Clear selection after adding to queue
    this.selectedVideos.clear();
    this.updateAllSelectedState();
  }

  /**
   * Process selected videos (from context menu)
   */
  async processSelectedVideos() {
    if (this.selectedVideos.size === 0) {
      this.notificationService.toastOnly('info', 'No Videos Selected', 'Please select videos to process');
      return;
    }

    // Convert Set to array of video IDs
    const videoIds = Array.from(this.selectedVideos);

    // Get video details for selected videos
    const selectedVideoDetails = this.videos.filter(v => videoIds.includes(v.id));

    this.processVideos(selectedVideoDetails);
  }

  /**
   * Process videos to fix aspect ratio (add to analysis queue with process-only mode)
   */
  private async processVideos(videos: DatabaseVideo[]) {
    for (const video of videos) {
      try {
        // Add to analysis queue with process-only mode
        this.analysisQueueService.addToPendingQueue({
          videoId: video.id,
          videoPath: video.current_path,
          filename: video.filename,
          mode: 'process-only'
        });
      } catch (error: any) {
        console.error(`Failed to add video ${video.filename} to processing queue:`, error);
        this.notificationService.toastOnly('error', 'Failed to Process', `Could not add ${video.filename} to queue`);
      }
    }

    // Clear selection after adding to queue
    this.selectedVideos.clear();
    this.updateAllSelectedState();

    // Show success notification
    const count = videos.length;
    this.notificationService.toastOnly('success', 'Added to Queue', `${count} video${count > 1 ? 's' : ''} added to processing queue`);
  }

  /**
   * Open analyze dialog for a single video
   */
  async openAnalyzeDialog(video: DatabaseVideo) {
    await this.videoOperationsService.analyzeVideo(video, this.analysisQueueService);
  }

  /**
   * Analyze a single video (used by preview panel)
   */
  async analyzeVideo(video: DatabaseVideo) {
    await this.openAnalyzeDialog(video);
  }

  /**
   * Open metadata editor for the selected video (toolbar button)
   */
  async openMetadataEditorForSelected() {
    if (this.selectedVideos.size !== 1) {
      return;
    }

    const videoId = Array.from(this.selectedVideos)[0];
    const video = this.videos.find(v => v.id === videoId);

    if (video) {
      await this.openMetadataEditor(video);
    }
  }

  /**
   * Download from URL - open dialog for importing URL
   */
  async downloadFromUrl() {
    await this.videoOperationsService.downloadFromUrl(this.analysisQueueService);
  }

  async analyzeSelectedOld() {
    if (this.selectedVideos.size === 0) {
      return;
    }

    // Convert Set to array of video IDs
    const videoIds = Array.from(this.selectedVideos);

    // Check how many videos already have analysis
    let videosWithExistingAnalysis = 0;
    for (const videoId of videoIds) {
      const hasAnalysis = await this.databaseLibraryService.hasAnalysis(videoId);
      if (hasAnalysis) {
        videosWithExistingAnalysis++;
      }
    }

    // Import and open dialog
    const { AnalyzeSelectedDialogComponent } = await import('./analyze-selected-dialog.component');

    const dialogRef = this.dialog.open(AnalyzeSelectedDialogComponent, {
      width: '800px',
      maxHeight: '90vh',
      data: {
        selectedCount: this.selectedVideos.size,
        videosWithExistingAnalysis
      }
    });

    dialogRef.afterClosed().subscribe(async (result: {
      option: 'transcribe-only' | 'transcribe-analyze' | 'fix-aspect-ratio' | 'skip';
      forceReanalyze: boolean;
      aiProvider?: 'ollama' | 'claude' | 'openai';
      aiModel?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
    } | null) => {
      if (!result) {
        return; // User cancelled
      }

      if (result.option === 'skip') {
        // Just import metadata without processing
        this.notificationService.toastOnly('info', 'Videos Imported', `${videoIds.length} videos added to library`);
        this.selectedVideos.clear();
        this.updateAllSelectedState();
        return;
      }

      if (result.option === 'fix-aspect-ratio') {
        // Process videos to fix aspect ratio
        const selectedVideoDetails = this.videos.filter(v => videoIds.includes(v.id));
        this.processVideos(selectedVideoDetails);
        return;
      }

      // Start batch analysis with selected videos
      try {
        await this.databaseLibraryService.startBatchAnalysis({
          videoIds: videoIds,
          transcribeOnly: result.option === 'transcribe-only',
          forceReanalyze: result.forceReanalyze,
          aiProvider: result.aiProvider,
          aiModel: result.aiModel,
          claudeApiKey: result.claudeApiKey,
          openaiApiKey: result.openaiApiKey
        });

        const actionText = result.option === 'transcribe-only' ? 'Transcription' : 'Analysis';
        this.notificationService.toastOnly(
          'success',
          `${actionText} Started`,
          `Processing ${videoIds.length} video${videoIds.length > 1 ? 's' : ''}`
        );

        // Clear selection
        this.selectedVideos.clear();
        this.updateAllSelectedState();

        // Start polling for progress
        this.startProgressPolling();
      } catch (error: any) {
        console.error('Failed to start analysis:', error);
        this.notificationService.toastOnly(
          'error',
          'Error',
          error.error?.message || 'Failed to start analysis'
        );
      }
    });
  }

  /**
   * Trigger library scan
   */
  async scanLibrary() {
    try {
      const result = await this.databaseLibraryService.scanLibrary();

      // Only show notification if new videos were found
      if (result.newVideos > 0) {
        this.notificationService.toastOnly(
          'success',
          'Scan Complete',
          `Found ${result.newVideos} new videos`
        );
      }

      await this.reloadLibrary({ videos: true, stats: true, tags: false });
    } catch (error) {
      console.error('Scan failed:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to scan library');
    }
  }


  /**
   * Start batch analysis
   */
  async startBatchAnalysis(limit?: number) {
    try {
      await this.videoOperationsService.startBatchAnalysis(limit);
      // Start polling for progress
      this.startProgressPolling();
    } catch (error) {
      // Error already handled by service
    }
  }

  /**
   * Start polling for batch progress
   */
  startProgressPolling() {
    // Reset completed videos list when starting new batch
    this.completedVideos = [];
    this.lastProcessedCount = 0;

    // Poll every 3 seconds
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    this.progressInterval = setInterval(async () => {
      try {
        const newProgress = await this.databaseLibraryService.getBatchProgress();

        // Track video processing states for progress bars
        // Remove completed video from processing states
        if (newProgress.processedVideos && newProgress.processedVideos > this.lastProcessedCount) {
          // A video was just completed - remove it from processing states
          if (this.batchProgress?.currentVideoFilename) {
            // Find and remove the video by filename
            const completedVideo = this.videos.find(v => v.filename === this.batchProgress?.currentVideoFilename);
            if (completedVideo) {
              console.log('[LibraryComponent] Removing completed video from processing states:', completedVideo.id);
              this.videoProcessingStates.delete(completedVideo.id);
              // Create a new Map reference to trigger change detection
              this.videoProcessingStates = new Map(this.videoProcessingStates);
            }

            this.completedVideos.push({
              filename: this.batchProgress.currentVideoFilename,
              videoId: completedVideo?.id || '',
              completedAt: new Date(),
              status: 'success'
            });
          }
          this.lastProcessedCount = newProgress.processedVideos;
        }

        // Track the currently processing video
        if (newProgress.currentVideoFilename && newProgress.status === 'running') {
          const currentVideo = this.videos.find(v => v.filename === newProgress.currentVideoFilename);
          console.log('[LibraryComponent] Current video processing:', newProgress.currentVideoFilename, 'Found:', !!currentVideo);
          if (currentVideo) {
            // Determine stage based on video state
            const stage: 'transcribing' | 'analyzing' = currentVideo.has_transcript ? 'analyzing' : 'transcribing';
            // Show animated progress - since we don't have per-video progress, show an indeterminate state
            const progress = 65; // Show at 65% to indicate active processing
            console.log('[LibraryComponent] Setting progress state for video:', currentVideo.id, 'stage:', stage, 'progress:', progress);
            this.videoProcessingStates.set(currentVideo.id, { stage, progress });

            // Create a new Map reference to trigger change detection
            this.videoProcessingStates = new Map(this.videoProcessingStates);
          }
        }

        // Track errors
        if (newProgress.errors && newProgress.errors.length > 0) {
          newProgress.errors.forEach(error => {
            // Remove from processing states
            console.log('[LibraryComponent] Removing failed video from processing states:', error.videoId);
            this.videoProcessingStates.delete(error.videoId);

            const existingError = this.completedVideos.find(v => v.filename === error.filename);
            if (!existingError) {
              this.completedVideos.push({
                filename: error.filename,
                videoId: error.videoId,
                completedAt: new Date(error.timestamp),
                status: 'failed',
                error: error.error
              });
            }
          });
          // Create a new Map reference to trigger change detection
          this.videoProcessingStates = new Map(this.videoProcessingStates);
        }

        this.batchProgress = newProgress;

        // If batch completed, show notification and reload
        if (this.batchProgress.running && this.batchProgress.status === 'completed') {
          // Clear all processing states
          this.videoProcessingStates.clear();

          this.notificationService.toastOnly(
            'success',
            'Analysis Complete',
            `Processed ${this.batchProgress.processedVideos} videos`
          );
          // Clear cache to ensure fresh data
          await this.reloadLibrary({ videos: true, stats: true, tags: false });
          clearInterval(this.progressInterval);
        }
      } catch (error) {
        // Silent fail - don't spam errors
      }
    }, 3000);

    // Also fetch immediately
    this.databaseLibraryService.getBatchProgress().then(progress => {
      this.batchProgress = progress;
      this.lastProcessedCount = progress.processedVideos || 0;

      // If there's a batch running, initialize processing state for current video
      if (progress.status === 'running' && progress.currentVideoFilename) {
        const currentVideo = this.videos.find(v => v.filename === progress.currentVideoFilename);
        console.log('[LibraryComponent] Initial batch progress check - Current video:', progress.currentVideoFilename, 'Found:', !!currentVideo);
        if (currentVideo) {
          const stage: 'transcribing' | 'analyzing' = currentVideo.has_transcript ? 'analyzing' : 'transcribing';
          console.log('[LibraryComponent] Setting initial progress state for video:', currentVideo.id, 'stage:', stage);
          this.videoProcessingStates.set(currentVideo.id, { stage, progress: 65 });
          // Create a new Map reference to trigger change detection
          this.videoProcessingStates = new Map(this.videoProcessingStates);
        }
      }
    });
  }

  /**
   * Pause batch
   */
  async pauseBatch() {
    try {
      this.batchProgress = await this.videoOperationsService.pauseBatch();
    } catch (error) {
      // Error already handled by service
    }
  }

  /**
   * Resume batch
   */
  async resumeBatch() {
    try {
      this.batchProgress = await this.videoOperationsService.resumeBatch();
    } catch (error) {
      // Error already handled by service
    }
  }

  /**
   * Stop batch
   */
  async stopBatch() {
    try {
      // Clear all processing states when stopping
      this.videoProcessingStates.clear();
      this.batchProgress = await this.videoOperationsService.stopBatch();
    } catch (error) {
      // Error already handled by service
    }
  }

  /**
   * Format helpers
   */
  formatDate(dateString: string | null): string {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  }

  encodeURIComponent(str: string): string {
    return encodeURIComponent(btoa(str));
  }

  formatTimeRemaining(seconds: number | undefined): string {
    if (!seconds) return 'Calculating...';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `~${hours}h ${minutes}m remaining`;
    } else if (minutes > 0) {
      return `~${minutes}m remaining`;
    } else {
      return `<1m remaining`;
    }
  }

  /**
   * Get human-readable label for search match type
   */
  getMatchTypeLabel(matchType: string | undefined): string {
    if (!matchType) return '';

    const labels: { [key: string]: string } = {
      'filename': 'Filename',
      'ai_description': 'AI Description',
      'transcript': 'Transcript',
      'analysis': 'Analysis',
      'section': 'Analysis Section',
      'tag': 'Tag'
    };

    return labels[matchType] || matchType;
  }

  /**
   * Get icon for search match type
   */
  getMatchTypeIcon(matchType: string | undefined): string {
    if (!matchType) return '';

    const icons: { [key: string]: string } = {
      'filename': 'description',
      'ai_description': 'smart_toy',
      'transcript': 'subtitles',
      'analysis': 'analytics',
      'section': 'bookmark',
      'tag': 'label'
    };

    return icons[matchType] || 'search';
  }

  /**
   * Selection helpers
   */
  isVideoSelected(video: DatabaseVideo): boolean {
    return this.selectedVideos.has(video.id);
  }

  toggleVideoSelection(video: DatabaseVideo) {
    if (this.selectedVideos.has(video.id)) {
      this.selectedVideos.delete(video.id);
    } else {
      this.selectedVideos.add(video.id);
    }

    this.updateSelectedCount(); // Update cached count
    this.updateAllSelectedState();
  }

  toggleAllSelection() {
    if (this.isAllSelected) {
      // Deselect all using service
      this.libraryStateService.clearSelection();
      this.selectedVideos = new Set();
      this.selectedWeeks.clear();
      this.isAllSelected = false;
      this.isMissingTranscriptSelected = false;
      this.isMissingAnalysisSelected = false;
    } else {
      // Select all
      this.selectAll();
      this.isAllSelected = true;
    }
    this.updateSelectedCount(); // Update cached count
  }

  private updateAllSelectedState() {
    // Check if all visible videos are selected
    if (this.filteredVideos.length === 0) {
      this.isAllSelected = false;
      return;
    }

    this.isAllSelected = this.filteredVideos.every(video =>
      this.selectedVideos.has(video.id)
    );
  }

  getSelectedCount(): number {
    return this.selectedCount; // Use cached value instead of recalculating
  }

  /**
   * Update selected count cache (call this whenever selectedVideos changes)
   */
  private updateSelectedCount() {
    this.selectedCount = this.selectedVideos.size;
  }

  /**
   * Check if video is longer than 10 minutes
   */
  isLongVideo(video: DatabaseVideo): boolean {
    return (video.duration_seconds || 0) > 600; // 10 minutes = 600 seconds
  }

  /**
   * Delete a video from the library
   */
  async deleteVideo(video: DatabaseVideo) {
    // Delegate to VideoOperationsService with success callback
    const success = await this.videoOperationsService.deleteVideo(video, async () => {
      await this.reloadLibrary();
    });

    // Update state if successful
    if (success) {
      this.libraryStateService.removeVideos([video.id]);
    }
  }

  /**
   * Delete selected videos in bulk
   */
  async deleteSelected() {
    const selectedCount = this.selectedVideos.size;
    if (selectedCount === 0) {
      return;
    }

    const videoIds = Array.from(this.selectedVideos);

    // Delegate to VideoOperationsService with success callback
    const result = await this.videoOperationsService.deleteVideoBatch(
      videoIds,
      this.videos,
      async () => {
        await this.reloadLibrary();
      }
    );

    // Update state if successful
    if (result.success) {
      this.libraryStateService.removeVideos(videoIds);

      // Clear selection
      this.selectedVideos.clear();
      this.updateSelectedCount();
      this.isAllSelected = false;
    }
  }


  /**
   * Handle drag over event
   */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }

    if (!this.isDragging) {
      this.isDragging = true;
      this.dragCounter = 1;
    }
  }

  /**
   * Handle drag leave event
   */
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    this.dragCounter--;
    if (this.dragCounter === 0) {
      this.isDragging = false;
    }
  }

  /**
   * Handle drop event
   * Uses Electron's webUtils.getPathForFile to extract real file paths from dropped files
   */
  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    this.isDragging = false;
    this.dragCounter = 0;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    // Check for Electron API
    const electron = (window as any).electron;
    if (!electron || !electron.getFilePathFromFile) {
      this.notificationService.toastOnly(
        'error',
        'Not Available',
        'Drag and drop only works in Electron app'
      );
      return;
    }

    // Extract file paths and filter for supported media files
    const validExtensions = [
      // Videos
      '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv',
      // Audio
      '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg',
      // Documents
      '.pdf', '.epub', '.mobi', '.txt', '.md',
      // Images
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
      // Webpages
      '.html', '.htm', '.mhtml'
    ];
    const filePaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));

      if (validExtensions.includes(ext)) {
        try {
          // Use Electron's webUtils to get the real file path
          const filePath = electron.getFilePathFromFile(file);
          filePaths.push(filePath);
        } catch (error) {
          console.error('Failed to get file path for:', file.name, error);
        }
      }
    }

    if (filePaths.length === 0) {
      this.notificationService.toastOnly(
        'warning',
        'No Valid Media Files',
        'Please drop supported media files (videos, audio, documents, images, etc.)'
      );
      return;
    }

    // Separate files into those that can be transcribed/analyzed vs those that should just be imported
    const analyzableExtensions = [
      '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv',  // Videos
      '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg'   // Audio
    ];

    const analyzableFiles: string[] = [];
    const importOnlyFiles: string[] = [];

    for (const filePath of filePaths) {
      const ext = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
      if (analyzableExtensions.includes(ext)) {
        analyzableFiles.push(filePath);
      } else {
        importOnlyFiles.push(filePath);
      }
    }

    // Track results from both imports
    let totalImportedCount = 0;
    let nonAnalyzableCount = 0;
    let analyzableCount = 0;
    let importAction: 'import-only' | 'import-and-transcribe' | 'import-and-analyze' | null = null;
    let analyzableVideoIds: string[] = [];

    // If there are analyzable files, ask the user what to do with them
    if (analyzableFiles.length > 0) {
      const { ImportOptionsDialogComponent } = await import('./import-options-dialog.component');

      const optionsDialogRef = this.dialog.open(ImportOptionsDialogComponent, {
        width: '500px',
        data: { videoCount: analyzableFiles.length }
      });

      importAction = await optionsDialogRef.afterClosed().toPromise();

      if (!importAction) {
        // User cancelled
        return;
      }
    }

    // Import non-analyzable files first (if any)
    if (importOnlyFiles.length > 0) {
      const { ImportProgressDialogComponent } = await import('./import-progress-dialog.component');

      const dialogRef = this.dialog.open(ImportProgressDialogComponent, {
        width: '500px',
        disableClose: true,
        data: {
          filePaths: importOnlyFiles,
          suppressAutoClose: analyzableFiles.length > 0 // Suppress if we have more to import
        }
      });

      const importResult = await dialogRef.afterClosed().toPromise();

      if (importResult?.success) {
        nonAnalyzableCount = importResult.importedCount || 0;
        totalImportedCount += nonAnalyzableCount;
      } else if (importResult?.cancelled) {
        // User cancelled - abort the whole operation
        return;
      }
    }

    // Import analyzable files (if any)
    if (analyzableFiles.length > 0 && importAction) {
      const { ImportProgressDialogComponent } = await import('./import-progress-dialog.component');

      const dialogRef = this.dialog.open(ImportProgressDialogComponent, {
        width: '500px',
        disableClose: true,
        data: {
          filePaths: analyzableFiles,
          suppressAutoClose: true // Always suppress for analyzable files
        }
      });

      const importResult = await dialogRef.afterClosed().toPromise();

      if (importResult?.success) {
        analyzableCount = importResult.importedCount || 0;
        totalImportedCount += analyzableCount;
        analyzableVideoIds = importResult.imported || [];
      } else if (importResult?.cancelled) {
        // User cancelled analyzable files, but non-analyzable were already imported
        // Show notification for what was imported so far
        if (totalImportedCount > 0) {
          await this.reloadLibrary({ videos: true, stats: true, tags: false });

          // Build detailed notification message
          const parts: string[] = [];
          if (nonAnalyzableCount > 0) {
            parts.push(`${nonAnalyzableCount} document${nonAnalyzableCount !== 1 ? 's' : ''}`);
          }
          const message = parts.length > 0
            ? `Imported ${parts.join(' and ')} to library`
            : `Imported ${totalImportedCount} file${totalImportedCount !== 1 ? 's' : ''} to library`;

          this.notificationService.toastOnly(
            'success',
            'Import Completed',
            message
          );
        }
        return;
      }
    }

    // Refresh UI if anything was imported
    if (totalImportedCount > 0) {
      await this.reloadLibrary({ videos: true, stats: true, tags: false });
    }

    // Build detailed notification message
    const buildImportMessage = () => {
      const parts: string[] = [];
      if (nonAnalyzableCount > 0) {
        parts.push(`${nonAnalyzableCount} document${nonAnalyzableCount !== 1 ? 's' : ''}`);
      }
      if (analyzableCount > 0) {
        parts.push(`${analyzableCount} video${analyzableCount !== 1 ? 's' : ''}`);
      }

      if (parts.length === 0) {
        return `Imported ${totalImportedCount} file${totalImportedCount !== 1 ? 's' : ''}`;
      } else if (parts.length === 1) {
        return `Imported ${parts[0]}`;
      } else {
        return `Imported ${parts.join(' and ')}`;
      }
    };

    // Handle post-import actions for analyzable files
    if (importAction && analyzableVideoIds.length > 0) {
      if (importAction === 'import-and-transcribe') {
        try {
          await this.databaseLibraryService.startBatchAnalysis({
            videoIds: analyzableVideoIds,
            transcribeOnly: true
          });
          this.notificationService.toastOnly(
            'success',
            'Transcription Started',
            `${buildImportMessage()}. Transcribing ${analyzableVideoIds.length} video${analyzableVideoIds.length !== 1 ? 's' : ''}`
          );
          this.startProgressPolling();
        } catch (error: any) {
          console.error('Failed to start transcription:', error);
          this.notificationService.toastOnly(
            'error',
            'Error',
            error.error?.message || 'Failed to start transcription'
          );
        }
      } else if (importAction === 'import-and-analyze') {
        try {
          await this.databaseLibraryService.startBatchAnalysis({
            videoIds: analyzableVideoIds,
            transcribeOnly: false
          });
          this.notificationService.toastOnly(
            'success',
            'Analysis Started',
            `${buildImportMessage()}. Processing ${analyzableVideoIds.length} video${analyzableVideoIds.length !== 1 ? 's' : ''}`
          );
          this.startProgressPolling();
        } catch (error: any) {
          console.error('Failed to start analysis:', error);
          this.notificationService.toastOnly(
            'error',
            'Error',
            error.error?.message || 'Failed to start analysis'
          );
        }
      } else if (importAction === 'import-only') {
        this.notificationService.toastOnly(
          'success',
          'Import Completed',
          buildImportMessage()
        );
      }
    } else if (totalImportedCount > 0) {
      // Only non-analyzable files were imported
      this.notificationService.toastOnly(
        'success',
        'Import Completed',
        buildImportMessage()
      );
    }
  }

  /**
   * Show batch progress modal
   */
  async showBatchProgress() {
    const { BatchProgressDialogComponent } = await import('./batch-progress-dialog.component');

    this.dialog.open(BatchProgressDialogComponent, {
      width: '1400px',
      maxWidth: '95vw',
      maxHeight: 'none',
      autoFocus: false,
      panelClass: 'batch-progress-large-dialog',
      data: {
        batchProgress: this.batchProgress,
        completedVideos: this.completedVideos
      }
    });
  }

  /**
   * Download video only (no transcription or analysis)
   */
  async downloadOnly(video: DatabaseVideo) {
    // Check if video has a URL stored in metadata or description
    const videoUrl = await this.getVideoUrl(video);

    if (!videoUrl) {
      this.notificationService.toastOnly(
        'warning',
        'No URL Found',
        'This video does not have a source URL. You can add one in the metadata editor.'
      );
      return;
    }

    try {
      this.notificationService.toastOnly('info', 'Download Started', `Downloading ${video.filename}`);

      // Trigger download via API
      this.apiService.downloadVideo({
        url: videoUrl,
        quality: '1080',  // Valid quality value - backend accepts: 360, 480, 720, 1080, 1440, 2160
        convertToMp4: true,
        fixAspectRatio: false,
        useCookies: false,
        browser: 'auto',
        outputDir: this.activeLibrary?.clipsFolderPath || '',
        displayName: video.filename,
        transcribeVideo: false
      }).subscribe({
        next: (_result) => {
          this.notificationService.toastOnly(
            'success',
            'Download Complete',
            `${video.filename} downloaded successfully`
          );
          // Refresh library to show the updated video
          this.loadVideos();
        },
        error: (error) => {
          console.error('Download failed:', error);
          this.notificationService.toastOnly(
            'error',
            'Download Failed',
            error.error?.message || 'Failed to download video'
          );
        }
      });
    } catch (error) {
      console.error('Download error:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to start download');
    }
  }


  /**
   * Get video URL from database or prompt user
   */
  private async getVideoUrl(video: DatabaseVideo): Promise<string | null> {
    // First, check if the video has a source URL stored in the database
    if (video.source_url) {
      return video.source_url;
    }

    // If not, prompt the user to enter a URL
    const url = prompt(`Enter the source URL for "${video.filename}":`);

    if (!url) {
      return null;
    }

    // Basic URL validation
    try {
      new URL(url);

      // Save the URL to the database for future use
      const result = await this.databaseLibraryService.updateVideoSourceUrl(video.id, url);
      if (result.success) {
        // Update the local video object
        video.source_url = url;
        this.notificationService.toastOnly('success', 'URL Saved', 'Source URL has been saved for this video');
      }

      return url;
    } catch {
      this.notificationService.toastOnly('error', 'Invalid URL', 'Please enter a valid URL');
      return null;
    }
  }

  /**
   * Open download video dialog
   */
  async openDownloadDialog() {
    // Import dialog component
    const { DownloadVideoDialogComponent } = await import('./download-video-dialog.component');

    const dialogRef = this.dialog.open(DownloadVideoDialogComponent, {
      width: '600px',
      data: {
        activeLibrary: this.activeLibrary
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.success) {
      // Show initial download success notification
      this.notificationService.toastOnly(
        'success',
        'Download Complete',
        `Video downloaded and importing into library...`
      );

      // Scan library to import the new video
      try {
        const scanResult = await this.databaseLibraryService.scanLibrary();

        if (scanResult.newVideoIds && scanResult.newVideoIds.length > 0) {
          const newVideoId = scanResult.newVideoIds[0];

          // If transcription or analysis was requested, start batch analysis
          if (result.transcribe || result.analyze) {
            await this.databaseLibraryService.startBatchAnalysis({
              videoIds: [newVideoId],
              transcribeOnly: !result.analyze,
              aiProvider: result.aiProvider,
              aiModel: result.aiModel,
              claudeApiKey: result.claudeApiKey,
              openaiApiKey: result.openaiApiKey
            });

            const actionText = result.analyze ? 'AI analysis' : 'transcription';
            this.notificationService.toastOnly(
              'success',
              'Processing Started',
              `Video downloaded and added to ${actionText} queue. Check the download icon in the top right to monitor progress.`
            );
            this.startProgressPolling();
          } else {
            // Just downloaded without processing
            this.notificationService.toastOnly(
              'success',
              'Video Added',
              `Video has been added to your library`
            );
          }
        }

        // Refresh library
        await this.loadVideos();
        await this.loadStats();
      } catch (error) {
        console.error('Failed to process downloaded video:', error);
        this.notificationService.toastOnly(
          'warning',
          'Video Downloaded',
          'Video was downloaded but may need to be manually imported'
        );
      }
    }
  }

  /**
   * Move selected videos to another library
   */
  async moveToLibrary() {
    if (this.selectedVideos.size === 0) {
      return;
    }

    // Import the transfer dialog component
    const { TransferVideosDialogComponent } = await import('./transfer-videos-dialog.component');

    const dialogRef = this.dialog.open(TransferVideosDialogComponent, {
      width: '600px',
      data: {
        selectedVideoIds: Array.from(this.selectedVideos),
        currentLibraryId: this.activeLibrary?.id || ''
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.success) {
      // Clear selection
      this.selectedVideos.clear();
      this.isAllSelected = false;

      // Clear cache and reload data
      await this.reloadLibrary({ videos: true, stats: true, tags: false });
      await this.loadTags();
    }
  }

  /**
   * Import videos - open file picker directly
   */
  async openImportManager() {
    // Open file picker directly
    const electron = (window as any).electron;
    if (!electron || !electron.ipcRenderer) {
      this.notificationService.error('Not Available', 'File picker only works in Electron app');
      return;
    }

    try {
      // Open file picker for all supported media files
      const result = await electron.ipcRenderer.invoke('dialog:openFiles', {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'All Media', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv', 'mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'ogg', 'pdf', 'epub', 'mobi', 'txt', 'md', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'html', 'htm', 'mhtml'] },
          { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv'] },
          { name: 'Audio', extensions: ['mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'ogg'] },
          { name: 'Documents', extensions: ['pdf', 'epub', 'mobi', 'txt', 'md'] },
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
          { name: 'Webpages', extensions: ['html', 'htm', 'mhtml'] }
        ]
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return; // User cancelled
      }

      // Create video objects from selected file paths
      const selectedVideos = result.filePaths.map((filePath: string) => {
        const parts = filePath.split(/[/\\]/);
        const filename = parts[parts.length - 1] || 'Unknown';
        return {
          current_path: filePath,
          filename: filename
        };
      });

      // Open video analysis dialog with import mode and selected videos
      const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
        width: '700px',
        maxWidth: '90vw',
        maxHeight: '85vh',
        panelClass: 'video-analysis-dialog-panel',
        data: {
          mode: 'import',
          selectedVideos: selectedVideos
        },
        disableClose: false
      });

      dialogRef.afterClosed().subscribe(result => {
        if (result && result.success && result.jobsToAdd) {
          setTimeout(() => {
            for (const jobData of result.jobsToAdd) {
              this.analysisQueueService.addPendingJob(jobData);
            }
            console.log(`Added ${result.jobsToAdd.length} job(s) to analysis queue`);
          }, 0);
        }
      });
    } catch (error) {
      console.error('Error importing videos:', error);
      this.notificationService.error('Import Failed', 'Could not open import dialog');
    }
  }

  /**
   * Scan a directory for videos that haven't been imported yet
   */
  async scanDirectoryForVideos() {
    const electron = (window as any).electron;
    if (!electron || !electron.openDirectoryPicker) {
      this.notificationService.error('Not Available', 'Folder picker only works in Electron app');
      return;
    }

    try {
      // Open folder picker
      const result = await electron.openDirectoryPicker();

      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return; // User cancelled
      }

      const directoryPath = result.filePaths[0];

      // Call backend to scan directory for unimported videos
      const scanUrl = await this.backendUrlService.getApiUrl('/database/scan-directory');

      this.notificationService.toastOnly('info', 'Scanning Directory', 'Searching for media files...');

      const response = await this.http.post<{
        videos: Array<{ filename: string; fullPath: string }>;
        total: number;
        alreadyImported: number;
      }>(scanUrl, {
        directoryPath
      }).toPromise();

      if (!response || response.total === 0) {
        this.notificationService.toastOnly('info', 'No Media Found', 'No media files found in the selected directory');
        return;
      }

      if (response.videos.length === 0) {
        this.notificationService.toastOnly(
          'info',
          'All Videos Imported',
          `Found ${response.total} video${response.total !== 1 ? 's' : ''}, but all have already been imported`
        );
        return;
      }

      // Convert to the format expected by the import dialog
      const selectedVideos = response.videos.map(video => ({
        current_path: video.fullPath,
        filename: video.filename
      }));

      this.notificationService.toastOnly(
        'success',
        'Videos Found',
        `Found ${selectedVideos.length} new video${selectedVideos.length !== 1 ? 's' : ''} to import`
      );

      // Open video analysis dialog with import mode and unimported videos
      const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
        width: '700px',
        maxWidth: '90vw',
        maxHeight: '85vh',
        panelClass: 'video-analysis-dialog-panel',
        data: {
          mode: 'import',
          selectedVideos: selectedVideos
        },
        disableClose: false
      });

      dialogRef.afterClosed().subscribe(result => {
        if (result && result.success) {
          if (result.jobsToAdd) {
            setTimeout(() => {
              for (const jobData of result.jobsToAdd) {
                this.analysisQueueService.addPendingJob(jobData);
              }
              console.log(`Added ${result.jobsToAdd.length} job(s) to analysis queue`);
            }, 0);
          }
          this.loadVideos(); // Refresh the video list
        }
      });
    } catch (error: any) {
      console.error('Error scanning directory:', error);
      this.notificationService.error(
        'Scan Failed',
        error?.error?.message || 'Could not scan directory for videos'
      );
    }
  }

  /**
   * Parse filename into date, title, and extension components
   * Supports formats:
   * - yyyy-mm-dd filename.ext (full date)
   * - yyyy-mm-tT filename.ext (trimester: T1, T2, T3)
   * - yyyy-mm filename.ext (year-month)
   * - yyyy filename.ext (year only)
   */
  parseFilename(filename: string): { date: string; title: string; extension: string } {
    const lastDotIndex = filename.lastIndexOf('.');
    const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1) : '';
    const nameWithoutExt = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;

    // Try to match date patterns at the start (ordered from most specific to least specific)

    // Pattern 1: yyyy-mm-dd (full date)
    const fullDateMatch = nameWithoutExt.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
    if (fullDateMatch) {
      return {
        date: fullDateMatch[1],
        title: fullDateMatch[2],
        extension: extension
      };
    }

    // Pattern 2: yyyy-mm-tT (trimester format, e.g., 2024-11-T2)
    const trimesterMatch = nameWithoutExt.match(/^(\d{4}-\d{2}-T[123])\s+(.+)$/);
    if (trimesterMatch) {
      return {
        date: trimesterMatch[1],
        title: trimesterMatch[2],
        extension: extension
      };
    }

    // Pattern 3: yyyy-mm (year-month)
    const yearMonthMatch = nameWithoutExt.match(/^(\d{4}-\d{2})\s+(.+)$/);
    if (yearMonthMatch) {
      return {
        date: yearMonthMatch[1],
        title: yearMonthMatch[2],
        extension: extension
      };
    }

    // Pattern 4: yyyy (year only)
    const yearMatch = nameWithoutExt.match(/^(\d{4})\s+(.+)$/);
    if (yearMatch) {
      return {
        date: yearMatch[1],
        title: yearMatch[2],
        extension: extension
      };
    }

    // No date pattern found - entire name is the title
    return {
      date: '',
      title: nameWithoutExt,
      extension: extension
    };
  }

  /**
   * Format date for display in chip
   */
  formatDateChip(date: string): string {
    if (!date) return '';

    // Check if it's a trimester format
    if (date.match(/^\d{4}-\d{2}-T[123]$/)) {
      return date; // Display as-is for trimester format
    }

    // Standard date format - could format differently if needed
    return date;
  }

  /**
   * Start editing a specific field (date, title, or extension)
   */
  startEditing(video: DatabaseVideo, field: 'date' | 'title' | 'extension', event: Event) {
    event.stopPropagation();

    // Track which video is being edited (for performance - only render one edit overlay)
    this.currentlyEditingVideo = video;

    // Initialize editing state for this video if not exists
    if (!this.editingVideo[video.id]) {
      this.editingVideo[video.id] = { date: false, title: false, extension: false };
    }

    // Initialize edited values if not exists
    if (!this.editedValues[video.id]) {
      const parsed = this.parseFilename(video.filename);
      this.editedValues[video.id] = parsed;
    }

    // Set editing flag
    this.editingVideo[video.id][field] = true;

    // Auto-focus the input after it renders
    setTimeout(() => {
      const inputSelector = field === 'date' ? '.date-input' :
                           field === 'title' ? '.title-input' :
                           '.extension-input';
      const input = document.querySelector(inputSelector) as HTMLInputElement;
      if (input) {
        input.focus();
        input.select(); // Select all text for easy replacement
      }
    }, 0);
  }

  /**
   * Handle three-dot menu click (triggers same context menu as right-click)
   */
  onThreeDotsClick(event: MouseEvent, video: DatabaseVideo) {
    event.preventDefault();
    event.stopPropagation();

    // If menu is already open, close it
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
      return;
    }

    // Highlight the video and set context menu video
    this.highlightedVideo = video;
    this.contextMenuVideo = video;

    // Position the context menu at the click location
    this.contextMenuPosition = {
      x: event.clientX,
      y: event.clientY
    };

    // Open the context menu
    if (this.contextMenuTrigger) {
      this.contextMenuTrigger.openMenu();
    }
  }

  /**
   * Handle right-click context menu
   */
  onVideoContextMenu(event: MouseEvent, video: DatabaseVideo) {
    event.preventDefault();
    event.stopPropagation();

    // If right-clicked video is not selected, add it to selection
    if (!this.selectedVideos.has(video.id)) {
      this.selectedVideos.add(video.id);
      this.updateAllSelectedState();
    }

    // Highlight the video when right-clicking
    this.highlightedVideo = video;
    this.contextMenuVideo = video;

    // Position the context menu at cursor location
    this.contextMenuPosition = {
      x: event.clientX,
      y: event.clientY
    };

    // If menu is already open, close it first then reopen at new position
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
      this.isContextMenuOpen = false;
      // Reopen after a short delay to allow closing animation
      setTimeout(() => {
        if (this.contextMenuTrigger) {
          this.contextMenuTrigger.openMenu();
          this.isContextMenuOpen = true;
        }
      }, 50);
    } else {
      // Open the context menu
      if (this.contextMenuTrigger) {
        this.contextMenuTrigger.openMenu();
        this.isContextMenuOpen = true;
      }
    }
  }

  /**
   * Start renaming a video (opens rename dialog)
   */
  startRenamingVideo(video: DatabaseVideo) {
    const dialogRef = this.dialog.open(RenameDialogComponent, {
      width: '600px',
      data: {
        filename: video.filename,
        videoId: video.id
      }
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (result?.renamed) {
        await this.saveRenamedFilename(video, result);
      }
    });
  }

  /**
   * Save renamed filename from dialog result
   */
  async saveRenamedFilename(video: DatabaseVideo, result: { date?: string; title?: string; extension?: string }) {
    // Reconstruct filename
    let newFilename = '';
    if (result.date && result.date.trim()) {
      newFilename = `${result.date.trim()} ${result.title?.trim() || ''}`;
    } else {
      newFilename = result.title?.trim() || '';
    }

    if (result.extension && result.extension.trim()) {
      newFilename += `.${result.extension.trim()}`;
    }

    // Skip if unchanged
    if (newFilename === video.filename) {
      return;
    }

    try {
      // Call backend to rename the file
      const updateResult = await this.databaseLibraryService.updateVideoFilename(video.id, newFilename);

      if (updateResult.success) {
        // Update local copy with new filename and path
        video.filename = newFilename;
        if (updateResult.newPath) {
          video.current_path = updateResult.newPath;
        }

        this.notificationService.toastOnly('success', 'Renamed', `File renamed to: ${newFilename}`);
      } else {
        this.notificationService.toastOnly('error', 'Rename Failed', updateResult.error || 'Failed to rename video');
      }
    } catch (error: any) {
      console.error('Failed to rename video:', error);
      this.notificationService.toastOnly('error', 'Rename Failed', error.error?.message || 'Failed to rename video');
    }
  }

  /**
   * Save edited filename (legacy - for inline editing)
   */
  async saveFilename(video: DatabaseVideo) {
    const edited = this.editedValues[video.id];
    if (!edited) return;

    // Reconstruct filename
    let newFilename = '';
    if (edited.date) {
      newFilename = `${edited.date} ${edited.title}`;
    } else {
      newFilename = edited.title;
    }

    if (edited.extension) {
      newFilename += `.${edited.extension}`;
    }

    // Skip if unchanged
    if (newFilename === video.filename) {
      this.cancelEditing(video.id);
      return;
    }

    try {
      // Call backend to rename the file
      const result = await this.databaseLibraryService.updateVideoFilename(video.id, newFilename);

      if (result.success) {
        // Update local copy with new filename and path
        video.filename = newFilename;
        if (result.newPath) {
          video.current_path = result.newPath;
        }

        // Clear editing state
        this.cancelEditing(video.id);
      } else {
        this.notificationService.toastOnly('error', 'Rename Failed', result.error || 'Failed to rename video');
      }
    } catch (error: any) {
      console.error('Failed to rename video:', error);
      this.notificationService.toastOnly('error', 'Rename Failed', error.error?.message || 'Failed to rename video');
    }
  }

  /**
   * Cancel editing
   */
  cancelEditing(videoId: string) {
    if (this.editingVideo[videoId]) {
      this.editingVideo[videoId] = { date: false, title: false, extension: false };
    }
    // Clear currently editing video (performance optimization)
    this.currentlyEditingVideo = null;
  }

  /**
   * Get position for inline edit overlay in list view
   */
  getEditOverlayPosition(videoId: string): { top: number; left: number } {
    // Find the list item element
    const itemElement = document.getElementById(`item-${videoId}`);
    if (itemElement) {
      const rect = itemElement.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX
      };
    }
    return { top: 0, left: 0 };
  }

  /**
   * Handle Enter key to save, Escape to cancel
   */
  onEditKeydown(video: DatabaseVideo, event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.saveFilename(video);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEditing(video.id);

      // Reset to original values
      const parsed = this.parseFilename(video.filename);
      this.editedValues[video.id] = parsed;
    }
  }

  /**
   * Handle blur event to save changes
   */
  onEditBlur(video: DatabaseVideo, field: 'date' | 'title' | 'extension') {
    // Don't close fields immediately - wait to see if user is clicking another field
    setTimeout(() => {
      // Check if focus moved to another input field for this video
      const activeElement = document.activeElement;
      const isEditingAnotherField = activeElement && (
        activeElement.classList.contains('date-input') ||
        activeElement.classList.contains('title-input') ||
        activeElement.classList.contains('extension-input')
      );

      // Only close editing mode if user clicked outside all edit fields
      if (!isEditingAnotherField) {
        // Close all fields and save
        if (this.editingVideo[video.id]) {
          this.editingVideo[video.id] = { date: false, title: false, extension: false };
        }
        this.saveFilename(video);
      }
    }, 150);
  }

  /**
   * PREVIEW MODAL METHODS FOR LIST VIEW
   */

  /**
   * Highlight a video on single click (without opening preview)
   */
  highlightVideo(video: DatabaseVideo, event: Event) {
    event.stopPropagation();

    const mouseEvent = event as MouseEvent;

    // Close context menu if it's open
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
    }

    // Handle Cmd/Ctrl+Click for individual multi-select
    if (mouseEvent.metaKey || mouseEvent.ctrlKey) {
      if (this.selectedVideos.has(video.id)) {
        this.selectedVideos.delete(video.id);
        // If we just deselected the only video, clear the highlight
        if (this.selectedVideos.size === 0) {
          this.highlightedVideo = null;
        }
      } else {
        this.selectedVideos.add(video.id);
        this.highlightedVideo = video;
      }
      this.updateAllSelectedState();
      return;
    }

    // Handle Shift+Click for range selection using the display order (grouped videos)
    if (mouseEvent.shiftKey && this.highlightedVideo) {
      // Flatten grouped videos to get display order
      const displayOrder: DatabaseVideo[] = [];
      this.groupedVideos.forEach(group => {
        displayOrder.push(...group.videos);
      });

      const currentIndex = displayOrder.findIndex(v => v.id === video.id);
      const lastIndex = displayOrder.findIndex(v => v.id === this.highlightedVideo!.id);

      if (currentIndex !== -1 && lastIndex !== -1) {
        const startIndex = Math.min(currentIndex, lastIndex);
        const endIndex = Math.max(currentIndex, lastIndex);

        // Keep existing selections and add range (additive behavior)
        // Select all videos in the range
        for (let i = startIndex; i <= endIndex; i++) {
          this.selectedVideos.add(displayOrder[i].id);
        }

        // Update week selections
        this.groupedVideos.forEach(group => {
          if (group.videos.every(v => this.selectedVideos.has(v.id))) {
            this.selectedWeeks.add(group.week);
          }
        });

        this.updateAllSelectedState();
      }
      return;
    }

    // Normal click - highlight and select single video (clear other selections)
    this.highlightedVideo = video;
    this.selectedVideos.clear();
    this.selectedWeeks.clear();
    this.selectedVideos.add(video.id); // Add the clicked video to selection
    this.updateAllSelectedState();

    // Auto-play is now handled by the PreviewDialogComponent
  }

  /**
   * Highlight a video by its ID (used for notifications/deep links)
   */
  highlightVideoById(videoId: string) {
    // Find the video in the filtered videos list
    const video = this.filteredVideos.find(v => v.id === videoId);

    if (video) {
      // Clear existing selections
      this.selectedVideos.clear();
      this.selectedWeeks.clear();

      // Highlight and select the video
      this.highlightedVideo = video;
      this.selectedVideos.add(video.id);
      this.updateAllSelectedState();

      // Scroll the video into view
      setTimeout(() => {
        const videoElement = document.querySelector(`[data-video-id="${videoId}"]`);
        if (videoElement) {
          videoElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);

      console.log(`[LibraryComponent] Highlighted video with ID: ${videoId}`);
    } else {
      console.warn(`[LibraryComponent] Video with ID ${videoId} not found in filtered videos`);
    }
  }

  /**
   * Handle double-click to open preview modal
   */
  onVideoDoubleClick(video: DatabaseVideo, event: Event) {
    event.preventDefault(); // Prevent text selection
    event.stopPropagation();
    this.highlightedVideo = video;
    this.openPreviewModal();
  }

  /**
   * Open the preview modal for the highlighted video
   */
  /**
   * Get minimum Y position to keep panel below header
   */
  private getMinimumYPosition(): number {
    const header = document.querySelector('.library-header');
    const searchBar = document.querySelector('.search-bar-standalone');
    const accordion = document.querySelector('.search-filters-accordion');
    const resultsHeader = document.querySelector('.results-header');

    // Find the bottom-most element to position below
    let minY = 100; // Default fallback

    if (header) {
      minY = header.getBoundingClientRect().bottom;
    }
    if (searchBar) {
      const searchBottom = searchBar.getBoundingClientRect().bottom;
      minY = Math.max(minY, searchBottom);
    }
    if (accordion) {
      const accordionBottom = accordion.getBoundingClientRect().bottom;
      minY = Math.max(minY, accordionBottom);
    }
    if (resultsHeader) {
      const resultsBottom = resultsHeader.getBoundingClientRect().bottom;
      minY = Math.max(minY, resultsBottom);
    }

    // Add some padding below the last element
    return minY + 10;
  }

  private currentPreviewDialogRef: MatDialogRef<PreviewDialogComponent> | null = null;

  openPreviewModal() {
    if (!this.highlightedVideo) {
      // If no video highlighted, highlight the first one
      if (this.filteredVideos.length > 0) {
        this.highlightedVideo = this.filteredVideos[0];
      } else {
        return;
      }
    }

    // Close existing dialog if any
    if (this.currentPreviewDialogRef) {
      this.currentPreviewDialogRef.close();
    }

    // Open new dialog with MatDialog
    const dialogData: PreviewDialogData = {
      video: this.highlightedVideo,
      autoPlay: this.previewAutoPlayEnabled,
      videoStreamUrl: this.getVideoStreamUrl(this.highlightedVideo),
      parseFilename: (filename: string) => this.parseFilename(filename),
      getMediaTypeIcon: (mediaType: string) => this.getMediaTypeIcon(mediaType),
      getMediaTypeLabel: (mediaType: string) => this.getMediaTypeLabel(mediaType),
      canAnalyzeMedia: (video: DatabaseVideo) => this.canAnalyzeMedia(video),
      onAnalyze: (video: DatabaseVideo) => this.analyzeVideo(video),
      onOpenVideoEditor: (video: DatabaseVideo) => this.openVideoPlayer(video),
      onViewDetails: (video: DatabaseVideo) => this.openMetadataEditor(video),
      onAutoPlayToggle: (enabled: boolean) => {
        this.previewAutoPlayEnabled = enabled;
        localStorage.setItem('library-preview-auto-play', String(enabled));
      }
    };

    this.currentPreviewDialogRef = this.dialog.open(PreviewDialogComponent, {
      data: dialogData,
      width: '400px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'preview-dialog-panel',
      hasBackdrop: false,
      autoFocus: false, // Don't steal focus from the list
      restoreFocus: false, // Don't restore focus on close
      disableClose: false, // Allow closing
      ariaModal: false, // Disable modal behavior to allow keyboard events to pass through
      position: {
        top: '100px',
        right: '20px'
      }
    });

    // Explicitly refocus the cascade list after dialog opens
    this.currentPreviewDialogRef.afterOpened().subscribe(() => {
      // Focus immediately after dialog opens
      this.focusCascadeList();

      // Also focus again after a short delay to ensure it sticks
      setTimeout(() => {
        this.focusCascadeList();
      }, 50);
    });

    // Handle dialog close
    this.currentPreviewDialogRef.afterClosed().subscribe(() => {
      this.currentPreviewDialogRef = null;
    });
  }

  /**
   * Focus the cascade list so keyboard events work
   */
  private focusCascadeList() {
    if (this.cascadeList && this.cascadeList.listContainer) {
      this.cascadeList.listContainer.nativeElement.focus();
    }
  }

  /**
   * Load a new video in the preview modal
   */
  loadPreviewVideo(video: DatabaseVideo) {
    this.highlightedVideo = video;

    // If dialog is open, just update it; don't close/reopen
    if (this.currentPreviewDialogRef) {
      const componentInstance = this.currentPreviewDialogRef.componentInstance;
      componentInstance.updateVideoData(video, this.getVideoStreamUrl(video));
    }
  }

  /**
   * Close the preview modal
   */
  closePreviewModal() {
    if (this.currentPreviewDialogRef) {
      this.currentPreviewDialogRef.close();
    }
  }



  /**
   * Navigate highlighted video without opening preview
   */
  navigateHighlightedVideo(direction: number) {
    // Get the visual order of videos (matches how they appear on screen)
    const visualOrder = this.getVisualOrderVideos();

    if (!this.highlightedVideo || visualOrder.length === 0) {
      // No video highlighted, highlight the first one in visual order
      if (visualOrder.length > 0) {
        this.highlightedVideo = visualOrder[0];
        // Clear all selections and select only this video
        this.selectedVideos.clear();
        this.selectedWeeks.clear();
        this.selectedVideos.add(visualOrder[0].id);
        this.updateAllSelectedState();
        this.scrollToHighlightedVideo();
      }
      return;
    }

    const currentIndex = visualOrder.findIndex(v => v.id === this.highlightedVideo!.id);
    if (currentIndex === -1) return;

    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < visualOrder.length) {
      this.highlightedVideo = visualOrder[newIndex];
      // Clear all selections and select only the new video
      this.selectedVideos.clear();
      this.selectedWeeks.clear();
      this.selectedVideos.add(visualOrder[newIndex].id);
      this.updateAllSelectedState();
      this.scrollToHighlightedVideo();
    }
  }

  /**
   * Get videos in the order they appear visually on screen
   * This flattens the grouped videos, respecting collapsed weeks
   */
  private getVisualOrderVideos(): DatabaseVideo[] {
    const visualOrder: DatabaseVideo[] = [];

    for (const group of this.groupedVideos) {
      // Skip videos in collapsed weeks
      if (!this.isWeekCollapsed(group.week)) {
        visualOrder.push(...group.videos);
      }
    }

    return visualOrder;
  }

  /**
   * Scroll to the highlighted video in the list
   */
  private scrollToHighlightedVideo() {
    setTimeout(() => {
      const highlightedElement = document.querySelector('.video-card.highlighted');
      if (highlightedElement) {
        highlightedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }, 50);
  }

  /**
   * Handle type-ahead search to jump to videos by title
   */
  handleTypeAhead(key: string) {
    // Clear the existing timer
    if (this.typeAheadTimer) {
      clearTimeout(this.typeAheadTimer);
    }

    // Add the key to the buffer
    this.typeAheadBuffer += key.toLowerCase();

    // Find the first video that starts with the buffer
    const matchingVideo = this.filteredVideos.find(video => {
      const filename = this.parseFilename(video.filename);
      const title = filename.title.toLowerCase();
      return title.startsWith(this.typeAheadBuffer);
    });

    if (matchingVideo) {
      // Clear all selections and select the matching video
      this.selectedVideos.clear();
      this.selectedWeeks.clear();
      this.highlightedVideo = matchingVideo;
      this.selectedVideos.add(matchingVideo.id);
      this.updateAllSelectedState();
      this.scrollToHighlightedVideo();
    }

    // Reset the buffer after 1 second of no typing
    this.typeAheadTimer = setTimeout(() => {
      this.typeAheadBuffer = '';
    }, 1000);
  }

  /**
   * Handle clicks on the list container to deselect when clicking empty space
   */
  onListContainerClick(event: Event) {
    // Check if the click target is the container itself (not a child element)
    const target = event.target as HTMLElement;
    if (target.classList.contains('video-list-container')) {
      // Clear all selections
      this.selectedVideos.clear();
      this.selectedWeeks.clear();
      this.highlightedVideo = null;
      this.updateAllSelectedState();
    }
  }

  /**
   * Toggle preview auto-play
   */
  togglePreviewAutoPlay() {
    this.previewAutoPlayEnabled = !this.previewAutoPlayEnabled;
    localStorage.setItem('library-preview-auto-play', String(this.previewAutoPlayEnabled));
  }

  /**
   * Copy filename to clipboard
   */
  copyFilename(video: DatabaseVideo) {
    // Use VideoOperationsService for clipboard operations
    this.videoOperationsService.copyFilename(video.filename);
  }

  /**
   * Open file location in Finder/Explorer
   */
  openFileLocation(video: DatabaseVideo) {
    if (!video.current_path) {
      this.notificationService.toastOnly('warning', 'File Path Not Available', 'The file path is not available for this video');
      return;
    }

    // Use VideoOperationsService for file system operations
    this.videoOperationsService.openFileLocation(video.current_path);
  }

  /**
   * Check if a video is highlighted
   */
  isVideoHighlighted(video: DatabaseVideo): boolean {
    return this.highlightedVideo?.id === video.id;
  }

  /**
   * Get status tooltip for a video
   */
  getStatusTooltip(video: DatabaseVideo): string {
    // Non-analyzable media types don't need transcript/analysis status
    if (!this.canAnalyzeMedia(video)) {
      return `${this.getMediaTypeLabel(video.media_type)} - No analysis needed`;
    }

    if (video.has_transcript && video.has_analysis) {
      return 'Has transcript and analysis';
    } else if (video.has_transcript) {
      return 'Has transcript only';
    } else if (video.has_analysis) {
      return 'Has analysis only';
    } else {
      return 'No transcript or analysis';
    }
  }

  /**
   * Get media type icon for a media item
   */
  getMediaTypeIcon(mediaType: string): string {
    switch (mediaType) {
      case 'video':
        return 'videocam';
      case 'audio':
        return 'audiotrack';
      case 'document':
        return 'description';
      case 'image':
        return 'image';
      case 'webpage':
        return 'public';
      default:
        return 'video_library';
    }
  }

  /**
   * Get media type label for a media item
   */
  getMediaTypeLabel(mediaType: string): string {
    switch (mediaType) {
      case 'video':
        return 'Video';
      case 'audio':
        return 'Audio';
      case 'document':
        return 'Document';
      case 'image':
        return 'Image';
      case 'webpage':
        return 'Web Page';
      default:
        return 'Media';
    }
  }

  /**
   * Check if a media item can be analyzed (video or audio only)
   */
  canAnalyzeMedia(video: DatabaseVideo | null): boolean {
    if (!video) return false;
    return this.videoFilterService.canAnalyzeMedia(video);
  }

  /**
   * Check if any selected items can be analyzed
   */
  hasAnalyzableSelection(): boolean {
    const selectedVideoIds = Array.from(this.selectedVideos);
    return selectedVideoIds.some(videoId => {
      const video = this.videos.find(v => v.id === videoId);
      return this.canAnalyzeMedia(video || null);
    });
  }


  private calculateJobMasterProgress(job: any): number {
    const currentStage = job.stage;
    const progress = job.progress || 0;

    // Determine all stages this job will go through
    // For analysis jobs: downloading/importing → transcribing → analyzing
    const stages = [];

    // Stage 1: Download or Import
    if (job.url) {
      stages.push('downloading');
    } else {
      stages.push('importing');
    }

    // Stage 2: Transcribe (always included)
    stages.push('transcribing');

    // Stage 3: Analyze (only in full mode, which is the default)
    // We assume full mode unless explicitly transcribe-only
    stages.push('analyzing');

    // Calculate progress for each stage
    let totalProgress = 0;
    const currentStageIndex = stages.indexOf(currentStage);

    stages.forEach((stage, index) => {
      if (index < currentStageIndex) {
        // Completed stages
        totalProgress += 100;
      } else if (index === currentStageIndex) {
        // Current stage
        totalProgress += progress;
      }
      // else: pending stages contribute 0
    });

    // Return average progress
    return Math.round(totalProgress / stages.length);
  }

  /**
   * Generate ghost items (children) for a video based on its processing stages
   * Similar to download-queue but for library videos
   */
  private generateVideoProcessingStages(video: DatabaseVideo): CascadeChild[] {
    const state = this.videoProcessingStates.get(video.id);
    if (!state) return []; // No processing, no children

    const children: CascadeChild[] = [];

    // Get the job from the jobs map to determine what stages to show
    const jobs = Array.from(this.downloadProgressService['jobs'].value.values());
    const job = jobs.find(j => j.videoId === video.id);

    // Determine stages based on job info
    const stages: Array<{
      id: string;
      label: string;
      icon: string;
      stageName: string;
    }> = [];

    // Add import stage (we don't know if it was from URL or file, so just call it import)
    stages.push({ id: 'import', label: 'Import', icon: 'input', stageName: 'importing' });

    // Add transcribe stage (always included)
    stages.push({ id: 'transcribe', label: 'Transcribe', icon: 'subtitles', stageName: 'transcribing' });

    // Add analyze stage (assume it's included unless we know otherwise)
    stages.push({ id: 'analyze', label: 'Analyze', icon: 'psychology', stageName: 'analyzing' });

    // Map current stage to determine status of each child
    const currentStage = job?.stage || state.stage;
    const progress = job?.progress || state.progress;

    stages.forEach((stage, index) => {
      let status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped' = 'pending';
      let stageProgress = 0;

      // Determine status based on current stage
      if (currentStage === 'completed') {
        status = 'completed';
        stageProgress = 100;
      } else if (currentStage === 'failed') {
        status = index === 0 ? 'failed' : 'pending';
        stageProgress = status === 'failed' ? progress : 0;
      } else if (stage.stageName === currentStage || stage.stageName === state.stage) {
        status = 'active';
        stageProgress = progress;
      } else {
        // Check if this stage is before or after the current stage
        const currentStageIndex = stages.findIndex(s => s.stageName === currentStage || s.stageName === state.stage);
        if (currentStageIndex !== -1 && index < currentStageIndex) {
          status = 'completed';
          stageProgress = 100;
        } else {
          status = 'pending';
          stageProgress = 0;
        }
      }

      children.push({
        id: `${video.id}-${stage.id}`,
        parentId: video.id,
        label: stage.label,
        icon: stage.icon,
        status: status,
        progress: { value: stageProgress }
      });
    });

    return children;
  }

  /**
   * Calculate master progress for a video from all its stages
   * Same logic as download-queue: average of all stage progress values
   */
  private calculateVideoMasterProgress(video: DatabaseVideo): number {
    const children = this.generateVideoProcessingStages(video);

    if (children.length === 0) return 0;

    const totalProgress = children.reduce((sum, child) => {
      return sum + (child.progress?.value || 0);
    }, 0);

    return Math.round(totalProgress / children.length);
  }
}

/**
 * Delete Confirmation Dialog Component
 */
@Component({
  selector: 'delete-confirmation-dialog',
  template: `
    <h2 mat-dialog-title>Delete {{ data.count > 1 ? data.count + ' Videos' : 'Video' }}</h2>
    <mat-dialog-content>
      <p *ngIf="data.videoName" style="margin-bottom: 16px; font-weight: 500;">{{ data.videoName }}</p>
      <p style="margin-bottom: 16px;">What would you like to do?</p>
      <mat-radio-group [(ngModel)]="selectedOption" style="display: flex; flex-direction: column; gap: 12px;">
        <mat-radio-button value="library" style="margin-bottom: 8px;">
          <div style="margin-left: 8px;">
            <div style="font-weight: 500;">Remove from Library</div>
            <div style="font-size: 13px; color: #666; margin-top: 4px;">
              Only remove from database. Video file{{ data.count > 1 ? 's' : '' }} will remain in the clips folder.
            </div>
          </div>
        </mat-radio-button>
        <mat-radio-button value="everything" color="warn">
          <div style="margin-left: 8px;">
            <div style="font-weight: 500; color: #f44336;">Delete Everything</div>
            <div style="font-size: 13px; color: #666; margin-top: 4px;">
              Permanently delete video file{{ data.count > 1 ? 's' : '' }}, metadata, transcripts, analyses, and tags. Cannot be undone!
            </div>
          </div>
        </mat-radio-button>
      </mat-radio-group>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button [color]="selectedOption === 'everything' ? 'warn' : 'primary'"
              (click)="onConfirm()"
              [disabled]="!selectedOption">
        {{ selectedOption === 'everything' ? 'Delete Everything' : 'Remove from Library' }}
      </button>
    </mat-dialog-actions>
  `,
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatRadioModule,
    FormsModule
  ]
})
export class DeleteConfirmationDialog {
  selectedOption: 'library' | 'everything' | null = null;

  constructor(
    public dialogRef: MatDialogRef<DeleteConfirmationDialog>,
    @Inject(MAT_DIALOG_DATA) public data: { count: number; videoName: string | null }
  ) {}

  onCancel(): void {
    this.dialogRef.close(null);
  }

  onConfirm(): void {
    this.dialogRef.close(this.selectedOption);
  }
}

