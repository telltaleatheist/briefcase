import { Component, OnInit, OnDestroy } from '@angular/core';
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
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { ScrollingModule } from '@angular/cdk/scrolling';
import {
  DatabaseLibraryService,
  DatabaseVideo,
  DatabaseStats,
  BatchProgress
} from '../../services/database-library.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { ApiService } from '../../services/api.service';

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
    ScrollingModule
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
  sortBy: 'date' | 'filename' | 'size' = 'date';
  sortOrder: 'asc' | 'desc' = 'desc';

  // Track open video player dialog to prevent multiple instances
  private openVideoPlayerDialog: any = null;

  // Selection
  selectedVideos = new Set<string>(); // Set of video IDs
  isAllSelected = false;

  // Virtual scrolling
  itemSize = 44; // Height of each video card (compact single-line design)

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

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private router: Router,
    private apiService: ApiService
  ) {
    console.log('[LibraryComponent] Constructor called at', new Date().toISOString());
    console.log('[LibraryComponent] Constructor completed at', new Date().toISOString());
  }

  async ngOnInit() {
    const startTime = performance.now();
    console.log('[LibraryComponent] ngOnInit started');

    // Load all data in parallel for maximum speed
    await Promise.all([
      this.loadLibraries(),
      this.loadStats(),
      this.loadVideos(),
      this.loadTags()
    ]);

    this.startProgressPolling();

    console.log(`[LibraryComponent] Total load time: ${(performance.now() - startTime).toFixed(0)}ms`);
  }

  ngOnDestroy() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
  }

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

    // Then apply search
    filtered = await this.databaseLibraryService.searchVideos(
      this.searchQuery,
      filtered
    );

    // Sort
    filtered = this.databaseLibraryService.sortVideos(
      filtered,
      this.sortBy,
      this.sortOrder
    );

    this.filteredVideos = filtered;
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
  changeSortBy(sortBy: 'date' | 'filename' | 'size') {
    if (this.sortBy === sortBy) {
      // Toggle order if same criteria
      this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortBy = sortBy;
      this.sortOrder = 'desc';
    }
    this.applyFiltersAndSort();
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
      this.isAllSelected = false;
    } else {
      // Select all visible videos
      this.filteredVideos.forEach(video => this.selectedVideos.add(video.id));
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

    // Show import options dialog
    const { ImportOptionsDialogComponent } = await import('./import-options-dialog.component');

    const optionsDialogRef = this.dialog.open(ImportOptionsDialogComponent, {
      width: '500px',
      data: { videoCount: filePaths.length }
    });

    const importAction = await optionsDialogRef.afterClosed().toPromise();

    if (!importAction) {
      return; // User cancelled
    }

    // Open import progress dialog
    const { ImportProgressDialogComponent } = await import('./import-progress-dialog.component');

    const dialogRef = this.dialog.open(ImportProgressDialogComponent, {
      width: '500px',
      disableClose: true,
      data: { filePaths: filePaths }
    });

    // Wait for import to complete
    const importResult = await dialogRef.afterClosed().toPromise();

    // Refresh library if successful
    if (importResult?.success) {
      // Clear cache since data changed
      this.databaseLibraryService.clearCache();

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
   * Transcribe video (no download, just transcribe existing file)
   */
  async downloadAndTranscribe(video: DatabaseVideo) {
    // Navigate to video analysis page with video pre-filled and transcribe-only mode
    this.router.navigate(['/analysis'], {
      state: {
        videoPath: video.current_path,
        videoTitle: video.filename,
        mode: 'transcribe-only'
      }
    });
  }

  /**
   * AI analyze video (no download, just analyze existing file)
   */
  async downloadAndAnalyze(video: DatabaseVideo) {
    // Navigate to video analysis page with video pre-filled and full analysis mode
    this.router.navigate(['/analysis'], {
      state: {
        videoPath: video.current_path,
        videoTitle: video.filename,
        mode: 'full'
      }
    });
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

      // Show import options dialog first
      const { ImportOptionsDialogComponent } = await import('./import-options-dialog.component');

      const optionsDialogRef = this.dialog.open(ImportOptionsDialogComponent, {
        width: '500px',
        data: { videoCount: result.filePaths.length }
      });

      const importAction = await optionsDialogRef.afterClosed().toPromise();

      if (!importAction) {
        return; // User cancelled
      }

      // Open import progress dialog
      const { ImportProgressDialogComponent } = await import('./import-progress-dialog.component');

      const dialogRef = this.dialog.open(ImportProgressDialogComponent, {
        width: '500px',
        disableClose: true,
        data: { filePaths: result.filePaths }
      });

      // Wait for import to complete
      const importResult = await dialogRef.afterClosed().toPromise();

      // Refresh library if successful
      if (importResult?.success) {
        // Clear cache since data changed
        this.databaseLibraryService.clearCache();

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
    } catch (error) {
      console.error('Error importing videos:', error);
      this.notificationService.error('Import Failed', 'Could not open import dialog');
    }
  }
}
