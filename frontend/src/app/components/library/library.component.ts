import { Component, OnInit, OnDestroy, HostListener, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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

  // Unimported videos
  unimportedVideos: UnimportedVideo[] = [];
  loadingUnimported = false;
  selectedUnimportedVideos = new Set<string>(); // Set of file paths
  isAllUnimportedSelected = false;

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

  // Week grouping state
  collapsedWeeks = new Set<string>(); // Set of collapsed week identifiers
  groupedVideos: { week: string; videos: DatabaseVideo[] }[] = [];

  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    // Handle preview modal in list view
    if (this.viewMode === 'list' && this.isPreviewModalOpen) {
      if (event.code === 'Space') {
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
      if (event.code === 'Space') {
        this.onSpacebarPress(event);
      } else if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        this.navigateVideos(event.code === 'ArrowUp' ? -1 : 1);
      }
    }
    // Handle navigation in list view without modal
    else if (this.viewMode === 'list' && this.highlightedVideo && !this.isPreviewModalOpen) {
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        this.navigateHighlightedVideo(event.code === 'ArrowUp' ? -1 : 1);
      } else if (event.code === 'Space') {
        event.preventDefault();
        this.openPreviewModal();
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
      this.isLoading = true;

      // First, load a small batch quickly to show something to the user
      if (this.isInitialLoad) {
        const initialResponse = await this.databaseLibraryService.getVideos(20, 0);
        this.videos = initialResponse.videos;
        this.applyFiltersAndSort();
        console.log(`Loaded initial ${this.videos.length} videos`);

        // If there are more videos, continue loading in the background
        if (initialResponse.count > 20) {
          this.isLoading = false; // Show the initial results while loading more
          this.loadRemainingVideos(initialResponse.count);
        } else {
          this.isInitialLoad = false;
          this.isLoading = false;
        }
      } else {
        // On subsequent loads, load all at once
        const response = await this.databaseLibraryService.getVideos(1000);
        this.videos = response.videos;
        this.applyFiltersAndSort();
        console.log(`Loaded ${this.videos.length} videos`);
        this.isLoading = false;
      }
    } catch (error) {
      console.error('Failed to load videos:', error);
      // Don't show error notification - empty library is expected
      this.isLoading = false;
      this.isInitialLoad = false;
    }
  }

  /**
   * Load remaining videos in the background after initial batch
   */
  private async loadRemainingVideos(totalCount: number) {
    try {
      // Load the rest in batches of 100
      const batchSize = 100;
      let offset = 20; // Start after the initial 20

      while (offset < totalCount && offset < 1000) {
        const response = await this.databaseLibraryService.getVideos(batchSize, offset);
        this.videos = [...this.videos, ...response.videos];
        this.applyFiltersAndSort();
        offset += batchSize;

        // Small delay to prevent overwhelming the UI
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`Finished loading all ${this.videos.length} videos`);
      this.isInitialLoad = false;
    } catch (error) {
      console.error('Failed to load remaining videos:', error);
      this.isInitialLoad = false;
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
        this.notificationService.toastOnly('success', 'Library Switched', 'Active library changed');
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
   * View unimported videos - for now shows unimported dialog
   * TODO: Create separate unimported videos page/component
   */
  async viewUnimportedVideos() {
    // For now, just load unimported videos and show a dialog or switch view
    // In the future, this should navigate to a separate route
    await this.loadUnimportedVideos();

    // Import and open unimported videos dialog
    const { UnimportedVideosDialogComponent } = await import('./unimported-videos-dialog.component');

    const dialogRef = this.dialog.open(UnimportedVideosDialogComponent, {
      width: '900px',
      maxWidth: '95vw',
      maxHeight: '90vh',
      data: {
        activeLibrary: this.activeLibrary,
        unimportedVideos: this.unimportedVideos
      }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.videosImported) {
      // Reload library data
      this.databaseLibraryService.clearCache();
      await this.loadVideos();
      await this.loadStats();
      await this.loadTags();
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
   * Check if tag is selected
   */
  isTagSelected(tagName: string): boolean {
    return this.selectedTags.includes(tagName);
  }

  /**
   * Apply search, tag filters, and sorting
   */
  async applyFiltersAndSort() {
    let filtered = this.videos;

    // Apply tag filter first
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
   * Group videos by date folder/week
   */
  groupVideosByWeek() {
    const groups = new Map<string, DatabaseVideo[]>();

    for (const video of this.filteredVideos) {
      let week = video.date_folder;

      // If no date_folder, generate one from the video's creation date
      if (!week) {
        const createdDate = new Date(video.created_at || video.added_at);
        week = this.getWeekIdentifier(createdDate);
      }

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
   * Get week identifier in YYYY-Www format (ISO week date)
   */
  private getWeekIdentifier(date: Date): string {
    // Get the ISO week number
    const tempDate = new Date(date.getTime());
    tempDate.setHours(0, 0, 0, 0);
    // Thursday in current week decides the year
    tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
    // January 4 is always in week 1
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    // Calculate full weeks to nearest Thursday
    const weekNum = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);

    // Format as YYYY-Www
    const year = tempDate.getFullYear();
    return `${year}-W${String(weekNum).padStart(2, '0')}`;
  }

  /**
   * Toggle week collapse state
   */
  toggleWeek(week: string) {
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
      // Extract date from filename (assuming format: YYYY-MM-DD at start)
      const dateMatch = video.filename.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const videoDate = new Date(dateMatch[1]);
        const weekStart = this.getWeekStartDate(videoDate);
        const weekLabel = this.formatWeekLabel(weekStart);

        // Add separator if we're in a new week
        if (weekLabel !== currentWeek) {
          grouped.push({ type: 'separator', weekLabel });
          currentWeek = weekLabel;
        }
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
      // Deselect all (including transcript and analysis checkboxes)
      this.selectedVideos.clear();
      this.isAllSelected = false;
      this.isMissingTranscriptSelected = false;
      this.isMissingAnalysisSelected = false;
    } else {
      // Select all visible videos
      this.filteredVideos.forEach(video => this.selectedVideos.add(video.id));
      this.isAllSelected = true;
      // Don't automatically check the other boxes when selecting all
    }
  }

  /**
   * Select all videos missing transcription
   */
  selectAllMissingTranscript() {
    if (this.isMissingTranscriptSelected) {
      // Deselect - clear all selections
      this.selectedVideos.clear();
      this.isMissingTranscriptSelected = false;
      this.isAllSelected = false;
    } else {
      // Clear current selection
      this.selectedVideos.clear();

      // Select all videos without transcription
      this.filteredVideos.forEach(video => {
        if (!video.has_transcript) {
          this.selectedVideos.add(video.id);
        }
      });

      this.isMissingTranscriptSelected = true;
      this.isMissingAnalysisSelected = false;
      this.updateAllSelectedState();
    }
  }

  /**
   * Select all videos missing AI analysis
   */
  selectAllMissingAnalysis() {
    if (this.isMissingAnalysisSelected) {
      // Deselect - clear all selections
      this.selectedVideos.clear();
      this.isMissingAnalysisSelected = false;
      this.isAllSelected = false;
    } else {
      // Clear current selection
      this.selectedVideos.clear();

      // Select all videos without analysis
      this.filteredVideos.forEach(video => {
        if (!video.has_analysis) {
          this.selectedVideos.add(video.id);
        }
      });

      this.isMissingAnalysisSelected = true;
      this.isMissingTranscriptSelected = false;
      this.updateAllSelectedState();
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
    // Confirm deletion
    const confirmed = await this.confirmDeletion(video);
    if (!confirmed) {
      return;
    }

    try {
      await this.databaseLibraryService.deleteVideo(video.id);

      this.notificationService.toastOnly(
        'success',
        'Video Deleted',
        `${video.filename} has been removed from the library`
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

    // Confirm bulk deletion
    const confirmed = confirm(
      `Are you sure you want to delete ${selectedCount} video${selectedCount > 1 ? 's' : ''} from the library?\n\n` +
      `This will permanently delete:\n` +
      `- Video files from library folder\n` +
      `- Video metadata\n` +
      `- Transcripts (if exist)\n` +
      `- Analyses (if exist)\n` +
      `- All tags\n\n` +
      `THIS CANNOT BE UNDONE!`
    );

    if (!confirmed) {
      return;
    }

    try {
      const videoIds = Array.from(this.selectedVideos);

      // Delete videos one by one
      let successCount = 0;
      let errorCount = 0;

      for (const videoId of videoIds) {
        try {
          await this.databaseLibraryService.deleteVideo(videoId);
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
          'Bulk Delete Complete',
          `Deleted ${successCount} video${successCount > 1 ? 's' : ''}` +
          (errorCount > 0 ? `. ${errorCount} failed.` : '')
        );
      }

      // Clear cache and reload
      this.databaseLibraryService.clearCache();
      await this.loadVideos();
      await this.loadStats();
      await this.loadTags();
    } catch (error: any) {
      console.error('Bulk delete failed:', error);
      this.notificationService.toastOnly(
        'error',
        'Delete Failed',
        error.error?.message || 'Failed to delete videos'
      );
    }
  }

  /**
   * Confirm video deletion with a dialog
   */
  private async confirmDeletion(video: DatabaseVideo): Promise<boolean> {
    return new Promise((resolve) => {
      // Use native confirm for now - can be replaced with Material dialog later
      const result = confirm(
        `Are you sure you want to delete "${video.filename}" from the library?\n\n` +
        `This will permanently delete:\n` +
        `- Video file from library folder\n` +
        `- Video metadata\n` +
        `- Transcript (if exists)\n` +
        `- Analysis (if exists)\n` +
        `- All tags\n\n` +
        `THIS CANNOT BE UNDONE!`
      );
      resolve(result);
    });
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

    // Extract file paths and filter for video files
    const validExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
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
        'No Valid Videos',
        'Please drop video files (.mp4, .mov, .avi, etc.)'
      );
      return;
    }

    // Create video objects from dropped file paths
    const selectedVideos = filePaths.map((filePath: string) => {
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
      // Open file picker for video files
      const result = await electron.ipcRenderer.invoke('dialog:openFiles', {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv'] }
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
    // End editing for this field immediately
    if (this.editingVideo[video.id]) {
      this.editingVideo[video.id][field] = false;
    }

    // Small timeout to allow clicking between fields
    setTimeout(() => {
      const editing = this.editingVideo[video.id];
      // If no fields are being edited anymore, save changes
      if (!editing || (!editing.date && !editing.title && !editing.extension)) {
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

    // Close context menu if it's open
    if (this.contextMenuTrigger && this.contextMenuTrigger.menuOpen) {
      this.contextMenuTrigger.closeMenu();
    }

    this.highlightedVideo = video;
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
    if (!this.highlightedVideo || this.filteredVideos.length === 0) {
      // No video highlighted, highlight the first one
      if (this.filteredVideos.length > 0) {
        this.highlightedVideo = this.filteredVideos[0];
        this.scrollToHighlightedVideo();
      }
      return;
    }

    const currentIndex = this.filteredVideos.findIndex(v => v.id === this.highlightedVideo!.id);
    if (currentIndex === -1) return;

    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < this.filteredVideos.length) {
      this.highlightedVideo = this.filteredVideos[newIndex];
      this.scrollToHighlightedVideo();
    }
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
   * Check if a video is highlighted
   */
  isVideoHighlighted(video: DatabaseVideo): boolean {
    return this.highlightedVideo?.id === video.id;
  }

  /**
   * Get status tooltip for a video
   */
  getStatusTooltip(video: DatabaseVideo): string {
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
   * Start resizing the preview panel
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
}
