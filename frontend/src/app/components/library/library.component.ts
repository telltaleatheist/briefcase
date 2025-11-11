import { Component, OnInit, OnDestroy, HostListener, ViewChild, ElementRef, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
import { VideoAnalysisDialogComponent } from '../video-analysis-dialog/video-analysis-dialog.component';

interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

interface UnimportedVideo {
  filename: string;
  fullPath: string;
  dateFolder?: string;
  hash?: string;
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
    AngularSplitModule
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

  // Libraries
  libraries: ClipLibrary[] = [];
  activeLibrary: ClipLibrary | null = null;
  selectedLibraryId: string = '';
  isLoadingLibraries = true; // Track library loading state

  // Tabs
  selectedTabIndex = 0;

  // Page mode: 'library' or 'management'
  pageMode: 'library' | 'management' = 'library';
  managementMode: 'unimported' | 'orphaned' | 'scan' = 'orphaned';

  // Unimported videos
  unimportedVideos: UnimportedVideo[] = [];
  loadingUnimported = false;
  selectedUnimportedVideos = new Set<string>(); // Set of file paths
  isAllUnimportedSelected = false;

  // Orphaned videos
  orphanedVideos: DatabaseVideo[] = [];
  loadingOrphaned = false;
  selectedOrphanedVideos = new Set<string>(); // Set of video IDs
  isAllOrphanedSelected = false;

  // Tags
  allTags: { people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }> } | null = null;
  selectedTags: string[] = [];
  showTagFilters = false;

  // Search and filter
  searchQuery = '';
  sortBy: 'date' | 'date-added' | 'filename' | 'size' | 'no-transcript' | 'no-analysis' = 'date';
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

  // Inline editing
  editingVideo: { [videoId: string]: { date: boolean; title: boolean; extension: boolean } } = {};
  editedValues: { [videoId: string]: { date: string; title: string; extension: string } } = {};

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

  // View mode (list or detail split view)
  viewMode: 'list' | 'detail' = 'list';
  selectedVideo: DatabaseVideo | null = null;
  autoPlayEnabled = true;
  backendUrl = '';

  // Video player state
  @ViewChild('detailVideoPlayer') detailVideoPlayer?: ElementRef<HTMLVideoElement>;
  @ViewChild('previewVideoPlayer') previewVideoPlayer?: ElementRef<HTMLVideoElement>;
  @ViewChild('contextMenuTrigger') contextMenuTrigger?: MatMenuTrigger;
  @ViewChild('managementContextMenuTrigger') managementContextMenuTrigger?: MatMenuTrigger;
  videoElement: HTMLVideoElement | null = null;
  isPlaying = false;

  // Preview modal state for list view
  highlightedVideo: DatabaseVideo | null = null;
  isPreviewModalOpen = false;
  previewAutoPlayEnabled = true;

  // Preview panel position and dragging
  previewPanelWidth = 500;
  previewPanelHeight = 400;
  previewPanelX = 100;
  previewPanelY = 100;
  isDraggingPreviewPanel = false;
  isResizingPreviewPanel = false;

  // Context menu state
  contextMenuPosition = { x: 0, y: 0 };
  contextMenuVideo: DatabaseVideo | null = null;
  managementContextMenuPosition = { x: 0, y: 0 };

  // Week grouping state
  collapsedWeeks = new Set<string>(); // Set of collapsed week identifiers
  groupedVideos: { week: string; videos: DatabaseVideo[] }[] = [];
  selectedWeeks = new Set<string>(); // Set of selected week identifiers
  highlightedWeek: string | null = null; // Currently highlighted week section

  // Type-ahead search state
  private typeAheadBuffer = '';
  private typeAheadTimer: any;

  handleKeyDown(event: KeyboardEvent) {
    // Check if user is editing any video field - if so, disable all keyboard shortcuts
    const isEditing = Object.values(this.editingVideo).some(fields =>
      fields.date || fields.title || fields.extension
    );

    // Also check if focus is on an input/textarea element
    const activeElement = document.activeElement;
    const target = event.target as HTMLElement;
    const isFocusedOnInput = (activeElement && ['INPUT', 'TEXTAREA'].includes(activeElement.tagName)) ||
                             target instanceof HTMLInputElement ||
                             target instanceof HTMLTextAreaElement ||
                             target.tagName === 'INPUT' ||
                             target.tagName === 'TEXTAREA' ||
                             target.closest('input') ||
                             target.closest('textarea') ||
                             target.closest('.mat-mdc-input-element') ||
                             target.classList.contains('mat-mdc-input-element');

    // If user is editing, allow only escape key to cancel editing
    if (isEditing || isFocusedOnInput) {
      if (event.code === 'Escape') {
        // Cancel all editing
        for (const videoId in this.editingVideo) {
          this.editingVideo[videoId] = { date: false, title: false, extension: false };
        }
        // Blur the active input
        if (activeElement && activeElement instanceof HTMLElement) {
          activeElement.blur();
        }
      }
      // Don't process any other shortcuts while editing
      return;
    }

    // Handle Cmd+A / Ctrl+A for select all
    if ((event.metaKey || event.ctrlKey) && event.code === 'KeyA') {
      event.preventDefault();
      this.selectAll();
      return;
    }

    // Handle Delete/Backspace to delete selected videos
    // Delete key on Windows/Linux, or Cmd+Backspace on Mac, or plain Backspace
    if (event.code === 'Delete' ||
        (event.code === 'Backspace' && (event.metaKey || !event.target || (event.target as HTMLElement).tagName !== 'INPUT'))) {
      if (this.selectedVideos.size > 0) {
        event.preventDefault();
        this.deleteSelected();
        return;
      }
    }

    // Handle preview modal in list view
    if (this.viewMode === 'list' && this.isPreviewModalOpen) {
      if (event.code === 'Space' && !isFocusedOnInput) {
        event.preventDefault();
        this.togglePreviewPlayPause();
      } else if (event.code === 'Escape') {
        event.preventDefault();
        this.closePreviewModal();
      } else if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        this.navigatePreviewVideos(event.code === 'ArrowUp' ? -1 : 1);
      }
    }
    // Handle detail view
    else if (this.viewMode === 'detail') {
      if (event.code === 'Space' && !isFocusedOnInput) {
        this.onSpacebarPress(event);
      } else if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        this.navigateVideos(event.code === 'ArrowUp' ? -1 : 1);
      }
    }
    // Handle navigation in list view without modal
    else if (this.viewMode === 'list' && !this.isPreviewModalOpen) {
      // Up/Down arrows navigate videos
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        this.navigateHighlightedVideo(event.code === 'ArrowUp' ? -1 : 1);
      }
      // Left/Right arrows expand/collapse sections with selected videos
      else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        this.toggleSelectedSections(event.code === 'ArrowRight');
      }
      // Space opens preview modal
      else if (event.code === 'Space' && !isFocusedOnInput) {
        event.preventDefault();
        this.openPreviewModal();
      }
      // Type-ahead search (alphanumeric keys when not editing)
      else if (!isFocusedOnInput && !event.metaKey && !event.ctrlKey && !event.altKey &&
               event.key.length === 1 && event.key.match(/[a-z0-9 ]/i)) {
        event.preventDefault();
        this.handleTypeAhead(event.key);
      }
    }
  }

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private router: Router,
    private route: ActivatedRoute,
    private apiService: ApiService,
    private snackBar: MatSnackBar
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

    // Load all data in parallel for maximum speed
    await Promise.all([
      this.loadLibraries(),
      this.loadStats(),
      this.loadVideos(),
      this.loadTags()
    ]);

    this.startProgressPolling();

    // Check for query param to highlight a specific video
    this.route.queryParams.subscribe(params => {
      console.log('[LibraryComponent] Query params received:', params);
      const videoIdToHighlight = params['highlightVideo'];
      if (videoIdToHighlight) {
        console.log('[LibraryComponent] Highlighting video with ID:', videoIdToHighlight);
        this.highlightVideoById(videoIdToHighlight);
        // Clear the query param after handling it
        this.router.navigate([], {
          queryParams: { highlightVideo: null },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      }
    });

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
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // Remove document listeners
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('contextmenu', this.handleDocumentContextMenu);
  }

  /**
   * Handle document click to close context menu
   */
  private handleDocumentClick = (event: MouseEvent) => {
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
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
        this.applyFiltersAndSort();
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
        this.applyFiltersAndSort();
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
    } catch (error) {
      console.error('Failed to load tags:', error);
    }
  }

  /**
   * Load all libraries with minimal retry logic
   */
  async loadLibraries(retryCount = 0, maxRetries = 3): Promise<void> {
    try {
      this.isLoadingLibraries = true;

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
   * Handle tab change
   */
  async onTabChange(index: number) {
    this.selectedTabIndex = index;
    if (index === 1) {
      // Unimported tab selected
      await this.loadUnimportedVideos();
    }
  }

  /**
   * Open video management dialog
   */
  async viewUnimportedVideos() {
    // Switch to management page mode
    this.pageMode = 'management';
    this.managementMode = 'orphaned';
    await this.loadOrphanedVideos();
  }

  /**
   * Switch back to library view
   */
  backToLibrary() {
    this.pageMode = 'library';
    // Reload library data in case anything changed
    this.databaseLibraryService.clearCache();
    this.loadVideos();
    this.loadStats();
    this.loadTags();
  }

  /**
   * Handle management tab change
   */
  onManagementTabChange(event: any) {
    const selectedIndex = event.index;

    // Tab 0: Orphaned Files, Tab 1: Orphaned Database Entries
    if (selectedIndex === 0) {
      this.managementMode = 'unimported';
      this.loadUnimportedVideos();
    } else if (selectedIndex === 1) {
      this.managementMode = 'orphaned';
      this.loadOrphanedVideos();
    }
  }

  /**
   * Load orphaned videos
   */
  async loadOrphanedVideos() {
    this.loadingOrphaned = true;
    try {
      // First run a full scan to mark missing videos
      const scanUrl = await this.backendUrlService.getApiUrl('/database/scan');
      await this.http.post(scanUrl, {}).toPromise();

      // Get the actual orphaned video details (is_linked = 0)
      const videosUrl = await this.backendUrlService.getApiUrl('/database/videos?linkedOnly=false');
      const response = await this.http.get<{ videos: DatabaseVideo[] }>(videosUrl).toPromise();

      this.orphanedVideos = response?.videos.filter(v => v.is_linked === 0) || [];
      this.selectedOrphanedVideos.clear();
    } catch (error) {
      console.error('Failed to load orphaned videos:', error);
      this.snackBar.open('Failed to load orphaned videos', 'Close', { duration: 3000 });
      this.orphanedVideos = [];
    } finally {
      this.loadingOrphaned = false;
    }
  }

  /**
   * Load unimported videos from clips folder
   */
  async loadUnimportedVideos() {
    if (!this.activeLibrary) {
      this.unimportedVideos = [];
      return;
    }

    this.loadingUnimported = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/unimported');
      const response = await this.http.get<{
        success: boolean;
        count: number;
        videos: UnimportedVideo[];
        error?: string;
      }>(url).toPromise();

      if (response?.success) {
        this.unimportedVideos = response.videos;
        console.log(`Found ${response.count} unimported videos`);
      } else {
        console.error('Failed to load unimported videos:', response?.error);
        this.unimportedVideos = [];
      }
    } catch (error) {
      console.error('Failed to load unimported videos:', error);
      this.unimportedVideos = [];
    } finally {
      this.loadingUnimported = false;
    }
  }

  /**
   * Toggle unimported video selection
   */
  toggleUnimportedSelection(video: UnimportedVideo) {
    if (this.selectedUnimportedVideos.has(video.fullPath)) {
      this.selectedUnimportedVideos.delete(video.fullPath);
    } else {
      this.selectedUnimportedVideos.add(video.fullPath);
    }
    this.updateAllUnimportedSelectedState();
  }

  /**
   * Toggle all unimported selection
   */
  toggleAllUnimportedSelection() {
    if (this.isAllUnimportedSelected) {
      this.selectedUnimportedVideos.clear();
      this.isAllUnimportedSelected = false;
    } else {
      this.unimportedVideos.forEach(video => this.selectedUnimportedVideos.add(video.fullPath));
      this.isAllUnimportedSelected = true;
    }
  }

  /**
   * Update all unimported selected state
   */
  private updateAllUnimportedSelectedState() {
    if (this.unimportedVideos.length === 0) {
      this.isAllUnimportedSelected = false;
      return;
    }
    this.isAllUnimportedSelected = this.unimportedVideos.every(video =>
      this.selectedUnimportedVideos.has(video.fullPath)
    );
  }

  /**
   * Toggle unimported video selection
   */
  toggleUnimportedVideo(videoPath: string) {
    if (this.selectedUnimportedVideos.has(videoPath)) {
      this.selectedUnimportedVideos.delete(videoPath);
    } else {
      this.selectedUnimportedVideos.add(videoPath);
    }
    this.updateAllUnimportedSelectedState();
  }

  /**
   * Handle click on management video with modifier keys
   */
  onManagementVideoClick(event: MouseEvent, identifier: string, type: 'unimported' | 'orphaned') {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
    const shift = event.shiftKey;

    if (type === 'unimported') {
      if (cmdOrCtrl) {
        // Cmd/Ctrl+click: toggle single selection
        this.toggleUnimportedVideo(identifier);
      } else if (shift) {
        // Shift+click: range select (TODO: implement range selection)
        this.toggleUnimportedVideo(identifier);
      } else {
        // Regular click: clear other selections and select this one
        this.selectedUnimportedVideos.clear();
        this.selectedUnimportedVideos.add(identifier);
        this.updateAllUnimportedSelectedState();
      }
    } else {
      if (cmdOrCtrl) {
        // Cmd/Ctrl+click: toggle single selection
        this.toggleOrphanedVideo(identifier);
      } else if (shift) {
        // Shift+click: range select (TODO: implement range selection)
        this.toggleOrphanedVideo(identifier);
      } else {
        // Regular click: clear other selections and select this one
        this.selectedOrphanedVideos.clear();
        this.selectedOrphanedVideos.add(identifier);
        this.updateOrphanedSelectionState();
      }
    }
  }

  /**
   * Handle right-click context menu on management videos
   */
  onManagementVideoRightClick(
    event: MouseEvent,
    video: any,
    type: 'unimported' | 'orphaned'
  ) {
    event.preventDefault();
    event.stopPropagation();

    const identifier = type === 'unimported' ? video.fullPath : video.id;
    const selectedSet = type === 'unimported' ? this.selectedUnimportedVideos : this.selectedOrphanedVideos;

    // If right-clicked video is not in selection, select only it
    if (!selectedSet.has(identifier)) {
      selectedSet.clear();
      selectedSet.add(identifier);

      if (type === 'unimported') {
        this.updateAllUnimportedSelectedState();
      } else {
        this.updateOrphanedSelectionState();
      }
    }

    // Position the context menu at cursor location
    this.managementContextMenuPosition = {
      x: event.clientX,
      y: event.clientY
    };

    // Open the menu using the positioned trigger
    if (this.managementContextMenuTrigger) {
      this.managementContextMenuTrigger.openMenu();
    }
  }

  /**
   * Handle clicks on management view container to close menu
   */
  onManagementViewClick(event: MouseEvent) {
    // Close the menu if it's open and user clicked outside of a menu item
    if (this.managementContextMenuTrigger?.menuOpen) {
      const target = event.target as HTMLElement;
      // Don't close if clicking on menu items or the menu itself
      if (!target.closest('.mat-mdc-menu-panel') && !target.closest('.actions-menu')) {
        this.managementContextMenuTrigger.closeMenu();
      }
    }
  }

  /**
   * Handle right-click on management view background to close menu
   */
  onManagementViewRightClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    // If right-clicking outside of a video row, close any open menu
    if (!target.closest('.management-video-row') && this.managementContextMenuTrigger?.menuOpen) {
      this.managementContextMenuTrigger.closeMenu();
    }
  }

  /**
   * Delete unimported video file
   */
  async deleteUnimportedVideo(video: UnimportedVideo) {
    // Delete single file - just call the batch method with one item
    this.selectedUnimportedVideos.clear();
    this.selectedUnimportedVideos.add(video.fullPath);
    await this.deleteSelectedUnimportedVideos();
  }

  /**
   * Delete selected unimported videos
   */
  async deleteSelectedUnimportedVideos() {
    if (this.selectedUnimportedVideos.size === 0) return;

    const fileCount = this.selectedUnimportedVideos.size;

    // Open delete confirmation dialog
    const dialogRef = this.dialog.open(DeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: fileCount,
        videoName: null
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (!result) {
      return; // User cancelled
    }

    try {
      const filePaths = Array.from(this.selectedUnimportedVideos);
      const deleteUrl = await this.backendUrlService.getApiUrl('/database/delete-unimported-files');

      const response = await this.http.post<{
        success: boolean;
        deletedCount: number;
        failedCount: number;
        errors?: string[];
        message: string;
      }>(deleteUrl, { filePaths }).toPromise();

      if (response?.success) {
        this.notificationService.toastOnly('success', 'Files Deleted', response.message);

        // Clear selection
        this.selectedUnimportedVideos.clear();
        this.updateAllUnimportedSelectedState();

        // Reload the unimported videos list
        await this.loadUnimportedVideos();
      } else {
        const errorMsg = response?.errors?.join('\n') || 'Could not delete files';
        this.notificationService.error('Delete Failed', errorMsg);
      }
    } catch (error: any) {
      console.error('Error deleting files:', error);
      this.notificationService.error('Delete Failed', error?.error?.message || 'Could not delete video files');
    }
  }

  /**
   * Relink orphaned videos
   */
  async relinkOrphanedVideos() {
    if (this.selectedOrphanedVideos.size === 0) return;

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

      const newFolder = result.filePaths[0];
      const selectedIds = Array.from(this.selectedOrphanedVideos);

      // Call backend to relink
      const relinkUrl = await this.backendUrlService.getApiUrl('/database/relink');

      const response = await this.http.post<{
        success: boolean;
        relinkedCount: number;
        failedCount: number;
        message: string;
      }>(relinkUrl, {
        videoIds: selectedIds,
        newFolder: newFolder
      }).toPromise();

      if (response?.success) {
        this.notificationService.toastOnly('success', 'Videos Relinked', response.message);
        this.selectedOrphanedVideos.clear();
        await this.loadOrphanedVideos();
      } else {
        this.notificationService.error('Relink Failed', response?.message || 'Could not relink videos');
      }
    } catch (error: any) {
      console.error('Error relinking videos:', error);
      this.notificationService.error(
        'Relink Failed',
        error?.error?.message || 'Could not relink videos'
      );
    }
  }

  /**
   * Check if unimported video is selected
   */
  isUnimportedVideoSelected(video: UnimportedVideo): boolean {
    return this.selectedUnimportedVideos.has(video.fullPath);
  }

  /**
   * Import selected unimported videos
   */
  async importSelectedVideos() {
    if (this.selectedUnimportedVideos.size === 0) {
      return;
    }

    const videoPaths = Array.from(this.selectedUnimportedVideos);

    // First, show options dialog
    const { ImportOptionsDialogComponent } = await import('./import-options-dialog.component');

    const optionsDialogRef = this.dialog.open(ImportOptionsDialogComponent, {
      width: '500px',
      data: { videoCount: videoPaths.length }
    });

    const importAction = await optionsDialogRef.afterClosed().toPromise();

    if (!importAction) {
      // User cancelled
      return;
    }

    // Open import progress dialog
    const { ImportProgressDialogComponent } = await import('./import-progress-dialog.component');

    const dialogRef = this.dialog.open(ImportProgressDialogComponent, {
      width: '500px',
      disableClose: true,
      data: { filePaths: videoPaths }
    });

    const importResult = await dialogRef.afterClosed().toPromise();

    if (importResult?.success) {
      // Clear cache since data changed
      this.databaseLibraryService.clearCache();

      this.selectedUnimportedVideos.clear();
      this.updateAllUnimportedSelectedState();
      await this.loadUnimportedVideos();
      await this.loadVideos();
      await this.loadStats();

      // Get the imported video IDs
      const importedVideoIds = importResult.imported || [];

      // Start batch analysis if requested
      if (importAction === 'import-and-transcribe' && importedVideoIds.length > 0) {
        try {
          await this.databaseLibraryService.startBatchAnalysis({
            videoIds: importedVideoIds,
            transcribeOnly: true
          });
          this.notificationService.toastOnly(
            'success',
            'Transcription Started',
            `Transcribing ${importedVideoIds.length} video${importedVideoIds.length !== 1 ? 's' : ''}`
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
      } else if (importAction === 'import-and-analyze' && importedVideoIds.length > 0) {
        try {
          await this.databaseLibraryService.startBatchAnalysis({
            videoIds: importedVideoIds,
            transcribeOnly: false
          });
          this.notificationService.toastOnly(
            'success',
            'Analysis Started',
            `Processing ${importedVideoIds.length} video${importedVideoIds.length !== 1 ? 's' : ''}`
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
      }
    }
  }

  /**
   * Toggle tag filter
   */
  toggleTag(tagName: string) {
    const index = this.selectedTags.indexOf(tagName);
    if (index > -1) {
      this.selectedTags.splice(index, 1);
    } else {
      this.selectedTags.push(tagName);
    }
    this.applyFiltersAndSort();
  }

  /**
   * Clear all tag filters
   */
  clearTagFilters() {
    this.selectedTags = [];
    this.applyFiltersAndSort();
  }

  /**
   * Clear search query and tag filters
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
    this.onSearchChange();
  }

  /**
   * Check if tag is selected
   */
  isTagSelected(tagName: string): boolean {
    return this.selectedTags.includes(tagName);
  }

  /**
   * Apply file type filter to videos
   */
  applyFileTypeFilter(videos: DatabaseVideo[]): DatabaseVideo[] {
    // If all filters are enabled, return all videos
    if (Object.values(this.fileTypeFilters).every(v => v)) {
      return videos;
    }

    // Define file extension categories
    const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
    const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg'];
    const DOCUMENT_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.txt', '.md'];
    const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const WEBPAGE_EXTENSIONS = ['.html', '.htm', '.mhtml'];

    return videos.filter(video => {
      const ext = '.' + (video.filename.split('.').pop()?.toLowerCase() || '');

      if (this.fileTypeFilters.video && VIDEO_EXTENSIONS.includes(ext)) return true;
      if (this.fileTypeFilters.audio && AUDIO_EXTENSIONS.includes(ext)) return true;
      if (this.fileTypeFilters.document && DOCUMENT_EXTENSIONS.includes(ext)) return true;
      if (this.fileTypeFilters.image && IMAGE_EXTENSIONS.includes(ext)) return true;
      if (this.fileTypeFilters.webpage && WEBPAGE_EXTENSIONS.includes(ext)) return true;

      return false;
    });
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
   * Apply search, tag filters, file type filters, and sorting
   */
  async applyFiltersAndSort() {
    let filtered = this.videos;

    // Apply file type filter first
    filtered = this.applyFileTypeFilter(filtered);

    // Apply tag filter
    if (this.selectedTags.length > 0) {
      try {
        const response = await this.databaseLibraryService.getVideosByTags(this.selectedTags);
        // Filter current videos to only include those in the tag-filtered results
        const tagFilteredIds = new Set(response.videos.map(v => v.id));
        filtered = filtered.filter(v => tagFilteredIds.has(v.id));
      } catch (error) {
        console.error('Failed to filter by tags:', error);
      }
    }

    // Then apply search with filters
    filtered = await this.databaseLibraryService.searchVideos(
      this.searchQuery,
      filtered,
      this.searchFilters
    );

    // Sort
    filtered = this.databaseLibraryService.sortVideos(
      filtered,
      this.sortBy,
      this.sortOrder
    );

    this.filteredVideos = filtered;

    // Group videos by week/folder
    this.groupVideosByWeek();
  }

  /**
   * Group videos by date folder/week using file creation date (when downloaded)
   */
  groupVideosByWeek() {
    const groups = new Map<string, DatabaseVideo[]>();

    for (const video of this.filteredVideos) {
      // Use video.created_at (file creation timestamp) for weekly grouping
      // This represents when YOU downloaded/created the file, not the content date
      const createdDate = new Date(video.created_at || video.added_at);
      const week = this.getWeekIdentifier(createdDate);

      if (!groups.has(week)) {
        groups.set(week, []);
      }
      groups.get(week)!.push(video);
    }

    // Convert to array and sort by week name (descending - newest first)
    this.groupedVideos = Array.from(groups.entries())
      .map(([week, videos]) => ({ week, videos }))
      .sort((a, b) => b.week.localeCompare(a.week));
  }

  /**
   * Get week identifier in yyyy-mm-dd format (date of Monday of that week)
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
   * Select a week section (clicking the week header selects all videos in that week)
   */
  selectWeekSection(week: string, event?: Event) {
    if (event) {
      event.stopPropagation();
    }

    const mouseEvent = event as MouseEvent | undefined;
    const weekGroup = this.groupedVideos.find(g => g.week === week);
    if (!weekGroup) return;

    // Handle Cmd/Ctrl+Click for individual multi-select of weeks
    if (mouseEvent && (mouseEvent.metaKey || mouseEvent.ctrlKey)) {
      if (this.selectedWeeks.has(week)) {
        this.selectedWeeks.delete(week);
        // Deselect all videos in this week
        weekGroup.videos.forEach(v => this.selectedVideos.delete(v.id));
      } else {
        this.selectedWeeks.add(week);
        // Select all videos in this week
        weekGroup.videos.forEach(v => this.selectedVideos.add(v.id));
      }
      // Also highlight the first video in this week
      if (weekGroup.videos.length > 0) {
        this.highlightedVideo = weekGroup.videos[0];
      }
      this.updateAllSelectedState();
      return;
    }

    // Handle Shift+Click for range selection (select videos from last highlighted to first in this week)
    if (mouseEvent && mouseEvent.shiftKey && this.highlightedVideo) {
      const lastVideoIndex = this.filteredVideos.findIndex(v => v.id === this.highlightedVideo!.id);
      // Find the first video in this week
      const firstVideoInWeek = weekGroup.videos[0];
      const currentIndex = this.filteredVideos.findIndex(v => v.id === firstVideoInWeek.id);

      if (currentIndex !== -1 && lastVideoIndex !== -1) {
        const startIndex = Math.min(currentIndex, lastVideoIndex);
        const endIndex = Math.max(currentIndex, lastVideoIndex);

        // Select all videos in the range
        for (let i = startIndex; i <= endIndex; i++) {
          this.selectedVideos.add(this.filteredVideos[i].id);
          // Also mark the week as selected if all videos in it are selected
          // Use created_at for weekly grouping (not date_folder which is content date)
          const videoWeek = this.getWeekIdentifier(new Date(this.filteredVideos[i].created_at || this.filteredVideos[i].added_at));
          const weekGroupForVideo = this.groupedVideos.find(g => g.week === videoWeek);
          if (weekGroupForVideo && weekGroupForVideo.videos.every(v => this.selectedVideos.has(v.id))) {
            this.selectedWeeks.add(videoWeek);
          }
        }
        this.updateAllSelectedState();
      }
      return;
    }

    // Normal click - select all videos in this week (clear other selections)
    this.selectedVideos.clear();
    this.selectedWeeks.clear();
    this.selectedWeeks.add(week);
    weekGroup.videos.forEach(v => this.selectedVideos.add(v.id));
    // Highlight the first video in this week
    if (weekGroup.videos.length > 0) {
      this.highlightedVideo = weekGroup.videos[0];
    }
    this.updateAllSelectedState();
  }

  /**
   * Check if week is highlighted
   */
  isWeekHighlighted(week: string): boolean {
    return this.highlightedWeek === week;
  }

  /**
   * Check if week is selected
   */
  isWeekSelected(week: string): boolean {
    // Week is only selected if ALL videos in that week are selected
    const weekGroup = this.groupedVideos.find(g => g.week === week);
    if (!weekGroup || weekGroup.videos.length === 0) {
      return false;
    }
    return weekGroup.videos.every(v => this.selectedVideos.has(v.id));
  }

  /**
   * Select all videos and weeks
   */
  selectAll() {
    // Select all videos
    this.filteredVideos.forEach(video => this.selectedVideos.add(video.id));

    // Select all weeks
    this.groupedVideos.forEach(group => this.selectedWeeks.add(group.week));

    this.updateAllSelectedState();
  }

  /**
   * Toggle expand/collapse for sections with selected videos
   * @param expand true to expand, false to collapse
   */
  toggleSelectedSections(expand: boolean) {
    if (this.selectedVideos.size === 0) return;

    // Find all weeks that have selected videos
    const weeksWithSelectedVideos = new Set<string>();
    this.groupedVideos.forEach(group => {
      const hasSelectedVideo = group.videos.some(v => this.selectedVideos.has(v.id));
      if (hasSelectedVideo) {
        weeksWithSelectedVideos.add(group.week);
      }
    });

    // Expand or collapse those weeks
    weeksWithSelectedVideos.forEach(week => {
      if (expand) {
        this.collapsedWeeks.delete(week);
      } else {
        this.collapsedWeeks.add(week);
      }
    });
  }

  /**
   * Select all videos missing transcript
   */
  selectAllMissingTranscript() {
    // Toggle behavior: if already selected, deselect those videos
    if (this.isMissingTranscriptSelected) {
      // Deselect all videos without transcription (only analyzable media)
      this.filteredVideos.forEach(video => {
        if (!video.has_transcript && this.canAnalyzeMedia(video)) {
          this.selectedVideos.delete(video.id);
        }
      });
      this.isMissingTranscriptSelected = false;
    } else {
      // Add videos without transcription to current selection (only analyzable media)
      this.filteredVideos.forEach(video => {
        if (!video.has_transcript && this.canAnalyzeMedia(video)) {
          this.selectedVideos.add(video.id);
        }
      });
      this.isMissingTranscriptSelected = true;
    }

    this.updateAllSelectedState();
  }

  /**
   * Select all videos missing AI analysis
   */
  selectAllMissingAnalysis() {
    // Toggle behavior: if already selected, deselect those videos
    if (this.isMissingAnalysisSelected) {
      // Deselect all videos without analysis (only analyzable media)
      this.filteredVideos.forEach(video => {
        if (!video.has_analysis && this.canAnalyzeMedia(video)) {
          this.selectedVideos.delete(video.id);
        }
      });
      this.isMissingAnalysisSelected = false;
    } else {
      // Add videos without analysis to current selection (only analyzable media)
      this.filteredVideos.forEach(video => {
        if (!video.has_analysis && this.canAnalyzeMedia(video)) {
          this.selectedVideos.add(video.id);
        }
      });
      this.isMissingAnalysisSelected = true;
    }

    this.updateAllSelectedState();
  }

  /**
   * Handle search input
   */
  onSearchChange() {
    this.applyFiltersAndSort();
  }

  /**
   * Change sort criteria
   */
  changeSortBy(sortBy: 'date' | 'date-added' | 'filename' | 'size' | 'no-transcript' | 'no-analysis') {
    if (this.sortBy === sortBy) {
      // Toggle order if same criteria
      this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortBy = sortBy;
      // For missing transcript/analysis, default to showing missing first (desc)
      this.sortOrder = (sortBy === 'no-transcript' || sortBy === 'no-analysis') ? 'desc' : 'desc';
    }
    this.applyFiltersAndSort();
  }

  /**
   * Toggle between list and detail view modes
   */
  toggleViewMode() {
    this.viewMode = this.viewMode === 'list' ? 'detail' : 'list';
    localStorage.setItem('library-view-mode', this.viewMode);

    // If switching to detail view and there are videos, select the first one
    if (this.viewMode === 'detail' && this.filteredVideos.length > 0 && !this.selectedVideo) {
      this.selectVideo(this.filteredVideos[0]);
    }
  }

  /**
   * Toggle auto-play feature
   */
  toggleAutoPlay() {
    this.autoPlayEnabled = !this.autoPlayEnabled;
    localStorage.setItem('library-auto-play', String(this.autoPlayEnabled));
  }

  /**
   * Select a video in detail view
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
   * Get video stream URL for playing
   */
  getVideoStreamUrl(video: DatabaseVideo): string {
    const encodedPath = encodeURIComponent(btoa(video.current_path));
    return `${this.backendUrl}/api/library/videos/custom?path=${encodedPath}`;
  }

  /**
   * Handle thumbnail loading error
   */
  onThumbnailError(event: Event) {
    const img = event.target as HTMLImageElement;
    img.src = '/assets/video-placeholder.png';
  }

  /**
   * Handle video loaded event
   */
  onVideoLoaded(videoEl: HTMLVideoElement) {
    this.videoElement = videoEl;
  }

  /**
   * Group videos by week for display with separators
   */
  getGroupedVideos(): Array<{type: 'separator', weekLabel: string} | {type: 'video', video: DatabaseVideo}> {
    const grouped: Array<{type: 'separator', weekLabel: string} | {type: 'video', video: DatabaseVideo}> = [];
    let currentWeek: string | null = null;

    for (const video of this.filteredVideos) {
      // Use video.created_at (file creation date) for weekly separators
      // This represents when you downloaded/created the file, not the content date
      const createdDate = new Date(video.created_at);
      const weekStart = this.getWeekStartDate(createdDate);
      const weekLabel = this.formatWeekLabel(weekStart);

      // Add separator if we're in a new week
      if (weekLabel !== currentWeek) {
        grouped.push({ type: 'separator', weekLabel });
        currentWeek = weekLabel;
      }

      grouped.push({ type: 'video', video });
    }

    return grouped;
  }

  /**
   * Get the start date (Sunday) of the week for a given date
   */
  private getWeekStartDate(date: Date): Date {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const sunday = new Date(date);
    sunday.setDate(date.getDate() - dayOfWeek);
    sunday.setHours(0, 0, 0, 0);
    return sunday;
  }

  /**
   * Format week label (e.g., "Week of Nov 4, 2025")
   */
  private formatWeekLabel(weekStart: Date): string {
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    return `Week of ${weekStart.toLocaleDateString('en-US', options)}`;
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
   * Analyze selected videos
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

    // Open dialog without specifying mode - let user choose
    const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'video-analysis-dialog-panel',
      data: {
        selectedVideos: selectedVideoDetails
      },
      disableClose: false
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.success) {
        // Clear selection after adding to queue
        this.selectedVideos.clear();
        this.updateAllSelectedState();
      }
    });
  }

  /**
   * Open analyze dialog for a single video
   */
  async openAnalyzeDialog(video: DatabaseVideo) {
    const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'video-analysis-dialog-panel',
      data: {
        selectedVideos: [video]
      },
      disableClose: false
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.success) {
        console.log('Video added to analysis queue');
      }
    });
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
    const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'video-analysis-dialog-panel',
      data: {
        mode: 'download'
      },
      disableClose: false
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.success) {
        console.log('URL download added to queue');
      }
    });
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
      option: 'transcribe-only' | 'transcribe-analyze' | 'skip';
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

      // Clear cache since data changed
      this.databaseLibraryService.clearCache();

      // Only show notification if new videos were found
      if (result.newVideos > 0) {
        this.notificationService.toastOnly(
          'success',
          'Scan Complete',
          `Found ${result.newVideos} new videos`
        );
      }

      await this.loadStats();
      await this.loadVideos();
    } catch (error) {
      console.error('Scan failed:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to scan library');
    }
  }

  /**
   * Prune orphaned videos from database
   */
  async pruneOrphanedVideos() {
    if (!this.stats || this.stats.unlinkedVideos === 0) {
      this.notificationService.toastOnly('info', 'No Orphaned Videos', 'There are no orphaned videos to prune');
      return;
    }

    // Confirm with user
    const confirmed = confirm(
      `This will permanently delete ${this.stats.unlinkedVideos} orphaned video${this.stats.unlinkedVideos > 1 ? 's' : ''} from the database.\n\n` +
      `These are videos that were deleted from your clips folder but their metadata is still in the database.\n\n` +
      `This action cannot be undone. Continue?`
    );

    if (!confirmed) {
      return;
    }

    try {
      const result = await this.databaseLibraryService.pruneOrphanedVideos();

      // Clear cache since data changed
      this.databaseLibraryService.clearCache();

      this.notificationService.toastOnly(
        'success',
        'Prune Complete',
        result.message
      );

      await this.loadStats();
      await this.loadVideos();
    } catch (error) {
      console.error('Prune failed:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to prune orphaned videos');
    }
  }

  /**
   * Start batch analysis
   */
  async startBatchAnalysis(limit?: number) {
    try {
      const options = limit ? { limit } : undefined;
      const result = await this.databaseLibraryService.startBatchAnalysis(options);

      // Don't show "batch started" notification - progress bar is visible
      // Start polling for progress
      this.startProgressPolling();
    } catch (error: any) {
      console.error('Failed to start batch:', error);
      this.notificationService.toastOnly(
        'error',
        'Error',
        error.error?.message || 'Failed to start batch analysis'
      );
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

        // Track newly completed videos
        if (newProgress.processedVideos && newProgress.processedVideos > this.lastProcessedCount) {
          // A video was just completed - add it to the list
          // Note: We use currentVideoFilename from the previous state as it represents the just-completed video
          if (this.batchProgress?.currentVideoFilename) {
            this.completedVideos.push({
              filename: this.batchProgress.currentVideoFilename,
              videoId: '', // We don't have the ID readily available, but filename is sufficient
              completedAt: new Date(),
              status: 'success'
            });
          }
          this.lastProcessedCount = newProgress.processedVideos;
        }

        // Track errors
        if (newProgress.errors && newProgress.errors.length > 0) {
          newProgress.errors.forEach(error => {
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
        }

        this.batchProgress = newProgress;

        // If batch completed, show notification and reload
        if (this.batchProgress.running && this.batchProgress.status === 'completed') {
          this.notificationService.toastOnly(
            'success',
            'Analysis Complete',
            `Processed ${this.batchProgress.processedVideos} videos`
          );
          // Clear cache to ensure fresh data
          this.databaseLibraryService.clearCache();
          await this.loadStats();
          await this.loadVideos();
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
    });
  }

  /**
   * Pause batch
   */
  async pauseBatch() {
    try {
      await this.databaseLibraryService.pauseBatch();
      // Don't show notification - progress bar shows paused state
      this.batchProgress = await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to pause:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to pause batch');
    }
  }

  /**
   * Resume batch
   */
  async resumeBatch() {
    try {
      await this.databaseLibraryService.resumeBatch();
      // Don't show notification - progress bar shows running state
      this.batchProgress = await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to resume:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to resume batch');
    }
  }

  /**
   * Stop batch
   */
  async stopBatch() {
    try {
      await this.databaseLibraryService.stopBatch();
      this.notificationService.toastOnly('info', 'Batch Stopped', 'Analysis has been stopped');
      this.batchProgress = await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to stop:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to stop batch');
    }
  }

  /**
   * Format helpers
   */
  formatFileSize(bytes: number | null): string {
    return this.databaseLibraryService.formatFileSize(bytes);
  }

  formatDuration(seconds: number | null): string {
    return this.databaseLibraryService.formatDuration(seconds);
  }

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

    this.updateAllSelectedState();
  }

  toggleAllSelection() {
    if (this.isAllSelected) {
      // Deselect all
      this.selectedVideos.clear();
      this.selectedWeeks.clear();
      this.isAllSelected = false;
      this.isMissingTranscriptSelected = false;
      this.isMissingAnalysisSelected = false;
    } else {
      // Select all
      this.selectAll();
      this.isAllSelected = true;
    }
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
    return this.selectedVideos.size;
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
    // Open delete options dialog
    const dialogRef = this.dialog.open(DeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: 1,
        videoName: video.filename
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (!result || result.action === 'cancel') {
      return;
    }

    const deleteFiles = result.action === 'delete-all';

    try {
      await this.databaseLibraryService.deleteVideo(video.id, deleteFiles);

      this.notificationService.toastOnly(
        'success',
        deleteFiles ? 'Video Deleted' : 'Video Removed',
        deleteFiles
          ? `${video.filename} has been permanently deleted`
          : `${video.filename} has been removed from the library`
      );

      // Clear cache and reload
      this.databaseLibraryService.clearCache();
      await this.loadVideos();
      await this.loadStats();
      await this.loadTags();
    } catch (error: any) {
      console.error('Failed to delete video:', error);
      this.notificationService.toastOnly(
        'error',
        'Delete Failed',
        error.error?.message || 'Failed to delete video'
      );
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

    // Open delete options dialog
    const dialogRef = this.dialog.open(DeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: selectedCount,
        videoName: selectedCount === 1 ? this.videos.find(v => this.selectedVideos.has(v.id))?.filename : null
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (!result) {
      return; // User cancelled
    }

    const deleteFiles = result === 'everything';

    try {
      const videoIds = Array.from(this.selectedVideos);

      // Delete videos one by one
      let successCount = 0;
      let errorCount = 0;

      for (const videoId of videoIds) {
        try {
          await this.databaseLibraryService.deleteVideo(videoId, deleteFiles);
          successCount++;
        } catch (error) {
          console.error(`Failed to delete video ${videoId}:`, error);
          errorCount++;
        }
      }

      // Clear selection
      this.selectedVideos.clear();
      this.isAllSelected = false;

      // Show result notification
      if (successCount > 0) {
        this.notificationService.toastOnly(
          errorCount > 0 ? 'warning' : 'success',
          deleteFiles ? 'Delete Complete' : 'Removed from Library',
          `${deleteFiles ? 'Deleted' : 'Removed'} ${successCount} video${successCount > 1 ? 's' : ''}` +
          (errorCount > 0 ? `. ${errorCount} failed.` : '')
        );
      }

      // Clear cache and reload
      this.databaseLibraryService.clearCache();
      await this.loadVideos();
      await this.loadStats();
      await this.loadTags();
    } catch (error: any) {
      console.error('Delete operation failed:', error);
      this.notificationService.toastOnly(
        'error',
        'Delete Failed',
        error.error?.message || 'Failed to delete videos'
      );
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
          this.databaseLibraryService.clearCache();
          await this.loadVideos();
          await this.loadStats();

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
      this.databaseLibraryService.clearCache();
      await this.loadVideos();
      await this.loadStats();
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
      this.databaseLibraryService.clearCache();
      await this.loadVideos();
      await this.loadStats();
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
        if (result && result.success) {
          console.log('Import added to queue');
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
          console.log('Import added to queue');
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

    // If menu is already open, close it
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
      return;
    }

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

    // Open the context menu
    if (this.contextMenuTrigger) {
      this.contextMenuTrigger.openMenu();
    }
  }

  /**
   * Start renaming a video (opens inline editor for all three parts)
   */
  startRenamingVideo(video: DatabaseVideo) {
    // Initialize editing state for this video if not exists
    if (!this.editingVideo[video.id]) {
      this.editingVideo[video.id] = { date: false, title: false, extension: false };
    }

    // Initialize edited values if not exists
    if (!this.editedValues[video.id]) {
      const parsed = this.parseFilename(video.filename);
      this.editedValues[video.id] = parsed;
    }

    // Enable editing for all three parts simultaneously
    this.editingVideo[video.id].date = true;
    this.editingVideo[video.id].title = true;
    this.editingVideo[video.id].extension = true;

    // Auto-focus the title input after it renders
    setTimeout(() => {
      const input = document.querySelector('.title-input') as HTMLInputElement;
      if (input) {
        input.focus();
        input.select(); // Select all text for easy replacement
      }
    }, 0);
  }

  /**
   * Save edited filename
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

    // Auto-play if preview modal is open and auto-play is enabled
    if (this.isPreviewModalOpen && this.previewAutoPlayEnabled) {
      setTimeout(() => {
        const videoEl = this.previewVideoPlayer?.nativeElement;
        if (videoEl) {
          videoEl.play().catch(err => {
            console.error('Auto-play failed:', err);
          });
        }
      }, 150);
    }
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
  openPreviewModal() {
    if (!this.highlightedVideo) {
      // If no video highlighted, highlight the first one
      if (this.filteredVideos.length > 0) {
        this.highlightedVideo = this.filteredVideos[0];
      } else {
        return;
      }
    }

    // Position panel on the right side of the screen
    this.previewPanelX = window.innerWidth - this.previewPanelWidth - 20;
    this.previewPanelY = 100;

    this.isPreviewModalOpen = true;

    // Auto-play the video if enabled
    if (this.previewAutoPlayEnabled) {
      setTimeout(() => {
        const videoEl = this.previewVideoPlayer?.nativeElement;
        if (videoEl) {
          videoEl.play().catch(err => {
            console.error('Auto-play failed:', err);
          });
        }
      }, 150);
    }
  }

  /**
   * Close the preview modal
   */
  closePreviewModal() {
    this.isPreviewModalOpen = false;

    // Pause the video when closing
    const videoEl = this.previewVideoPlayer?.nativeElement;
    if (videoEl && !videoEl.paused) {
      videoEl.pause();
    }
  }

  /**
   * Toggle play/pause in preview modal
   */
  togglePreviewPlayPause() {
    const videoEl = this.previewVideoPlayer?.nativeElement;
    if (videoEl) {
      if (videoEl.paused) {
        videoEl.play();
      } else {
        videoEl.pause();
      }
    }
  }

  /**
   * Navigate between videos in preview modal
   */
  navigatePreviewVideos(direction: number) {
    if (!this.highlightedVideo || this.filteredVideos.length === 0) {
      return;
    }

    const currentIndex = this.filteredVideos.findIndex(v => v.id === this.highlightedVideo!.id);
    if (currentIndex === -1) return;

    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < this.filteredVideos.length) {
      // Stop current video
      const videoEl = this.previewVideoPlayer?.nativeElement;
      if (videoEl && !videoEl.paused) {
        videoEl.pause();
      }

      // Update highlighted video
      this.highlightedVideo = this.filteredVideos[newIndex];

      // Auto-play new video if enabled
      if (this.previewAutoPlayEnabled) {
        setTimeout(() => {
          const newVideoEl = this.previewVideoPlayer?.nativeElement;
          if (newVideoEl) {
            newVideoEl.play().catch(err => {
              console.error('Auto-play failed:', err);
            });
          }
        }, 150);
      }
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
    navigator.clipboard.writeText(video.filename).then(() => {
      this.snackBar.open('Filename copied to clipboard', 'Close', {
        duration: 2000
      });
    }).catch(err => {
      console.error('Failed to copy filename:', err);
      this.snackBar.open('Failed to copy filename', 'Close', {
        duration: 2000
      });
    });
  }

  /**
   * Open file location in Finder/Explorer
   */
  openFileLocation(video: DatabaseVideo) {
    if (!video.current_path) {
      this.snackBar.open('File path not available', 'Close', {
        duration: 2000
      });
      return;
    }

    this.http.post(`${this.backendUrl}/api/path/open-file-location`, {
      filePath: video.current_path
    }).subscribe({
      next: () => {
        this.snackBar.open('Opened file location', 'Close', {
          duration: 2000
        });
      },
      error: (error) => {
        console.error('Failed to open file location:', error);
        this.snackBar.open('Failed to open file location', 'Close', {
          duration: 2000
        });
      }
    });
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
    return video.media_type === 'video' || video.media_type === 'audio';
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

  /**
   * Start dragging the preview panel
   */
  startDragPreviewPanel(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingPreviewPanel = true;

    const startX = event.clientX;
    const startY = event.clientY;
    const startPanelX = this.previewPanelX;
    const startPanelY = this.previewPanelY;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDraggingPreviewPanel) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      // Keep panel within viewport bounds
      const maxX = window.innerWidth - this.previewPanelWidth - 20;
      const maxY = window.innerHeight - 200; // approximate panel height

      this.previewPanelX = Math.max(10, Math.min(maxX, startPanelX + deltaX));
      this.previewPanelY = Math.max(10, Math.min(maxY, startPanelY + deltaY));
    };

    const onMouseUp = () => {
      this.isDraggingPreviewPanel = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Start resizing the preview panel from bottom-right
   */
  startResizePreviewPanel(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isResizingPreviewPanel = true;

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = this.previewPanelWidth;
    const startHeight = this.previewPanelHeight;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizingPreviewPanel) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      // Calculate new dimensions with min/max constraints
      const newWidth = Math.max(300, Math.min(800, startWidth + deltaX));
      const newHeight = Math.max(200, Math.min(600, startHeight + deltaY));

      this.previewPanelWidth = newWidth;
      this.previewPanelHeight = newHeight;

      // Adjust position if panel goes out of bounds
      const maxX = window.innerWidth - this.previewPanelWidth - 20;
      const maxY = window.innerHeight - this.previewPanelHeight - 20;

      this.previewPanelX = Math.max(10, Math.min(maxX, this.previewPanelX));
      this.previewPanelY = Math.max(10, Math.min(maxY, this.previewPanelY));
    };

    const onMouseUp = () => {
      this.isResizingPreviewPanel = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Start resizing the preview panel from bottom-left
   */
  startResizePreviewPanelLeft(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isResizingPreviewPanel = true;

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = this.previewPanelWidth;
    const startHeight = this.previewPanelHeight;
    const startPanelX = this.previewPanelX;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizingPreviewPanel) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      // Calculate new dimensions with min/max constraints
      // When resizing from left, we grow in the opposite direction
      const newWidth = Math.max(300, Math.min(800, startWidth - deltaX));
      const newHeight = Math.max(200, Math.min(600, startHeight + deltaY));

      // Adjust X position to keep the right edge fixed
      const newX = startPanelX + (startWidth - newWidth);

      this.previewPanelWidth = newWidth;
      this.previewPanelHeight = newHeight;
      this.previewPanelX = Math.max(10, newX);

      // Adjust Y position if panel goes out of bounds
      const maxY = window.innerHeight - this.previewPanelHeight - 20;
      this.previewPanelY = Math.max(10, Math.min(maxY, this.previewPanelY));
    };

    const onMouseUp = () => {
      this.isResizingPreviewPanel = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Toggle selection of an orphaned video
   */
  toggleOrphanedVideo(videoId: string) {
    if (this.selectedOrphanedVideos.has(videoId)) {
      this.selectedOrphanedVideos.delete(videoId);
    } else {
      this.selectedOrphanedVideos.add(videoId);
    }
    this.updateOrphanedSelectionState();
  }

  /**
   * Toggle all orphaned videos selection
   */
  toggleAllOrphanedSelection() {
    if (this.isAllOrphanedSelected) {
      this.selectedOrphanedVideos.clear();
    } else {
      this.orphanedVideos.forEach(v => this.selectedOrphanedVideos.add(v.id));
    }
    this.updateOrphanedSelectionState();
  }

  /**
   * Update orphaned selection state
   */
  private updateOrphanedSelectionState() {
    this.isAllOrphanedSelected = this.orphanedVideos.length > 0 &&
      this.orphanedVideos.every(v => this.selectedOrphanedVideos.has(v.id));
  }

  /**
   * Relink selected orphaned videos
   */
  async relinkSelectedOrphans() {
    if (this.selectedOrphanedVideos.size === 0) return;

    // Open folder selection dialog
    const result = await (window as any).electron.openFolderDialog();
    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return;
    }

    const newFolder = result.filePaths[0];
    const selectedIds = Array.from(this.selectedOrphanedVideos);

    try {
      const url = await this.backendUrlService.getApiUrl('/database/relink');
      const response = await this.http.post<{
        success: boolean;
        relinkedCount: number;
        failedCount: number;
        message: string;
      }>(url, {
        videoIds: selectedIds,
        newFolder: newFolder
      }).toPromise();

      if (response?.success) {
        this.snackBar.open(
          `Relinked ${response.relinkedCount} video${response.relinkedCount !== 1 ? 's' : ''}`,
          'Close',
          { duration: 3000 }
        );
        this.selectedOrphanedVideos.clear();
        await this.loadOrphanedVideos();
      } else {
        this.snackBar.open(response?.message || 'Failed to relink videos', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to relink videos:', error);
      this.snackBar.open('Failed to relink videos', 'Close', { duration: 3000 });
    }
  }

  /**
   * Delete selected orphaned videos
   */
  async deleteSelectedOrphans() {
    if (this.selectedOrphanedVideos.size === 0) return;

    const entryCount = this.selectedOrphanedVideos.size;

    // Open delete confirmation dialog
    const dialogRef = this.dialog.open(OrphanedDeleteConfirmationDialog, {
      width: '500px',
      data: {
        count: entryCount,
        videoName: entryCount === 1 ? this.orphanedVideos.find(v => this.selectedOrphanedVideos.has(v.id))?.filename : null
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (!result) {
      return; // User cancelled
    }

    const selectedIds = Array.from(this.selectedOrphanedVideos);
    try {
      const url = await this.backendUrlService.getApiUrl('/database/prune-selected');
      const response = await this.http.post<{
        success: boolean;
        deletedCount: number;
        message: string;
      }>(url, { videoIds: selectedIds }).toPromise();

      if (response?.success) {
        this.notificationService.toastOnly('success', 'Entries Deleted', response.message);
        this.selectedOrphanedVideos.clear();
        await this.loadOrphanedVideos();
      } else {
        this.notificationService.error('Delete Failed', 'Failed to delete selected entries');
      }
    } catch (error: any) {
      console.error('Failed to delete selected entries:', error);
      this.notificationService.error('Delete Failed', error?.error?.message || 'Failed to delete selected entries');
    }
  }

  /**
   * Prune all orphaned videos
   */
  async pruneAllOrphans() {
    if (this.orphanedVideos.length === 0) return;

    const confirmed = confirm(
      `Are you sure you want to permanently delete ${this.orphanedVideos.length} orphaned database entr${this.orphanedVideos.length !== 1 ? 'ies' : 'y'}?\n\n` +
      'This will remove these entries from the database. This action cannot be undone.'
    );

    if (!confirmed) return;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/prune');
      const response = await this.http.post<{
        success: boolean;
        deletedCount: number;
        message: string;
      }>(url, {}).toPromise();

      if (response?.success) {
        this.snackBar.open(response.message, 'Close', { duration: 3000 });
        this.orphanedVideos = [];
        this.selectedOrphanedVideos.clear();
      } else {
        this.snackBar.open('Failed to prune orphaned entries', 'Close', { duration: 3000 });
      }
    } catch (error) {
      console.error('Failed to prune orphaned entries:', error);
      this.snackBar.open('Failed to prune orphaned entries', 'Close', { duration: 3000 });
    }
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

/**
 * Orphaned Delete Confirmation Dialog Component
 * Simpler dialog for deleting orphaned database entries (no file deletion option)
 */
@Component({
  selector: 'orphaned-delete-confirmation-dialog',
  template: `
    <h2 mat-dialog-title>Delete {{ data.count > 1 ? data.count + ' Orphaned Entries' : 'Orphaned Entry' }}</h2>
    <mat-dialog-content>
      <p *ngIf="data.videoName" style="margin-bottom: 16px; font-weight: 500;">{{ data.videoName }}</p>
      <p style="margin-bottom: 16px;">Are you sure you want to delete {{ data.count > 1 ? 'these entries' : 'this entry' }} from the database?</p>
      <div style="background: var(--warning-bg); border: 1px solid var(--warning-text); border-radius: 4px; padding: 12px; margin-bottom: 16px;">
        <div style="display: flex; align-items: flex-start; gap: 8px;">
          <mat-icon style="color: var(--warning-text); font-size: 20px; width: 20px; height: 20px;">warning</mat-icon>
          <div style="flex: 1; font-size: 13px; color: var(--warning-text);">
            This will permanently remove {{ data.count > 1 ? 'these database entries' : 'this database entry' }} and all associated metadata, transcripts, analyses, and tags. This action cannot be undone.
          </div>
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="warn" (click)="onConfirm()">
        Delete from Database
      </button>
    </mat-dialog-actions>
  `,
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ]
})
export class OrphanedDeleteConfirmationDialog {
  constructor(
    public dialogRef: MatDialogRef<OrphanedDeleteConfirmationDialog>,
    @Inject(MAT_DIALOG_DATA) public data: { count: number; videoName: string | null }
  ) {}

  onCancel(): void {
    this.dialogRef.close(null);
  }

  onConfirm(): void {
    this.dialogRef.close(true);
  }
}
