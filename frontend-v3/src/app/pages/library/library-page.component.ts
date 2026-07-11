import { Component, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy, ChangeDetectorRef, computed, ViewChild, effect, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { LibrarySearchFiltersComponent, LibraryFilters } from '../../components/library-search-filters/library-search-filters.component';
import { CascadeComponent, CascadeEmptyAction, CascadeEmptyState } from '../../components/cascade/cascade.component';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { QueueItemConfigModalComponent } from '../../components/queue-item-config-modal/queue-item-config-modal.component';
import { AiSetupWizardComponent } from '../../components/ai-setup-wizard/ai-setup-wizard.component';
import { VideoPreviewModalComponent, PreviewItem } from '../../components/video-preview-modal/video-preview-modal.component';
import { VideoConfigDialogComponent } from '../../components/video-config-dialog/video-config-dialog.component';
import { TabsTabComponent } from '../../components/tabs-tab/tabs-tab.component';
import { NewTabDialogComponent } from '../../components/new-tab-dialog/new-tab-dialog.component';
import { QueueTabComponent } from '../../components/queue-tab/queue-tab.component';
import { ArchivesTabComponent } from '../../components/archives-tab/archives-tab.component';
import { VideoWeek, VideoItem, ChildrenConfig, VideoChild, ItemProgress } from '../../models/video.model';
import { Library, NewLibrary, OpenLibrary } from '../../models/library.model';
import { QueueItemTask } from '../../models/queue.model';
import { TaskType, AVAILABLE_TASKS } from '../../models/task.model';
import { LibraryService } from '../../services/library.service';
import { WebsocketService, TaskStarted, TaskCompleted, TaskProgress, TaskFailed, AnalysisCompleted } from '../../services/websocket.service';
import { AiSetupService } from '../../services/ai-setup.service';
import { NotificationService } from '../../services/notification.service';
import { TabsService } from '../../services/tabs.service';
import { FileImportService } from '../../services/file-import.service';
import { ElectronService } from '../../services/electron.service';
import { TourService } from '../../services/tour.service';
import { QueueService } from '../../services/queue.service';
import { LibraryFilterService } from '../../services/library-filter.service';
import { WebArchiveService } from '../../services/web-archive.service';
import { QueueJob, QueueTask, createQueueJob, createQueueTask } from '../../models/queue-job.model';
import { VideoJobSettings } from '../../models/video-processing.model';
import { ExportIndicatorComponent } from '../../components/export-indicator/export-indicator.component';
import { TrimOpenerModalComponent } from '../../components/trim-opener-modal/trim-opener-modal.component';
import { getApiBase } from '../../core/runtime-url';
import { ErrorSurface, describeError } from '../../core/error-surface.service';
import { WorkspaceActionsService, AddDownloadsPayload } from '../../core/stores/workspace-actions.service';
import { QueueSelectionStore } from '../../core/stores/queue-selection.store';
import { PIPELINE_STEPS, PipelinePresetsService, PipelineStep, PipelineStepType } from '../../core/stores/pipeline-presets.service';
import { NavigationStore } from '../../core/stores/navigation.store';
import { InspectorStore } from '../../core/stores/inspector.store';
import { classifyItemKind } from '../../core/item-kind';
import { SelectionStore } from '../../core/stores/selection.store';
import { UiSegmentedControlComponent } from '../../ui';

// Local queue item for the processing section
export interface ProcessingQueueItem {
  id: string;
  url?: string;
  videoId?: string;
  title: string;
  duration?: string;
  thumbnail?: string;
  status: 'loading' | 'pending' | 'processing' | 'completed' | 'failed';
  tasks: ProcessingTask[];
  jobId?: string; // Frontend job ID from videoProcessingService
  backendJobId?: string; // Backend job ID for mapping
  titleResolved?: boolean; // True when title has been built (not a placeholder)
  warnings?: string[]; // Non-fatal backend issues, shown on the queue item
}

export interface ProcessingTask {
  type: TaskType;
  options: any;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  errorMessage?: string; // Error message when task fails
  eta?: number;          // Estimated seconds remaining
  taskLabel?: string;    // Human-readable task name (e.g., "Transcribing...")
}

@Component({
  selector: 'app-library-page',
  standalone: true,
  imports: [
    CommonModule,
    LibrarySearchFiltersComponent,
    CascadeComponent,
    LibraryManagerModalComponent,
    QueueItemConfigModalComponent,
    AiSetupWizardComponent,
    VideoPreviewModalComponent,
    VideoConfigDialogComponent,
    TabsTabComponent,
    NewTabDialogComponent,
    QueueTabComponent,
    ArchivesTabComponent,
    ExportIndicatorComponent,
    TrimOpenerModalComponent,
    UiSegmentedControlComponent
  ],
  templateUrl: './library-page.component.html',
  styleUrls: ['./library-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LibraryPageComponent implements OnInit, OnDestroy {
  private libraryService = inject(LibraryService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  private websocketService = inject(WebsocketService);
  private aiSetupService = inject(AiSetupService);
  private notificationService = inject(NotificationService);
  private errorSurface = inject(ErrorSurface);
  private pipelinePresets = inject(PipelinePresetsService);
  private tabsService = inject(TabsService);
  private fileImportService = inject(FileImportService);
  private electronService = inject(ElectronService);
  private tourService = inject(TourService);
  private queueService = inject(QueueService);
  private filterService = inject(LibraryFilterService);
  private webArchiveService = inject(WebArchiveService);
  private cdr = inject(ChangeDetectorRef);
  private workspaceActions = inject(WorkspaceActionsService);
  private queueSelection = inject(QueueSelectionStore);
  private inspectorStore = inject(InspectorStore);
  /** Active /collections/:id — scopes the collections view to one collection. */
  protected navStore = inject(NavigationStore);
  private selectionStore = inject(SelectionStore);

  /** True when running in a plain browser (LAN web client) rather than Electron. */
  get isWeb(): boolean {
    return !this.electronService.isElectron;
  }

  @ViewChild(CascadeComponent) private cascadeComponent?: CascadeComponent;
  @ViewChild(TabsTabComponent) private tabsTabComponent?: TabsTabComponent;
  @ViewChild(LibrarySearchFiltersComponent) private searchFilters?: LibrarySearchFiltersComponent;

  // File input for import button
  private fileInput?: HTMLInputElement;

  // Track videos with pending renames to avoid race conditions
  private pendingRenames = new Set<string>();

  // Navigate-to-queue event handler reference (for cleanup)
  private navigateToQueueHandler?: () => void;

  // Track videos pending analysis (waiting for AI wizard to complete)
  private pendingAnalysisVideos: VideoItem[] = [];

  // Tabbed video IDs - local signal synced from TabsService for OnPush cascade @Input
  tabbedVideoIds = signal<Set<string>>(new Set());

  // Drag and drop state
  isDraggingOver = signal(false);

  // AI Setup wizard state
  aiWizardOpen = signal(false);

  videoWeeks = signal<VideoWeek[]>([]);
  filteredWeeks = signal<VideoWeek[]>([]);

  /**
   * Set when loading the library (or the current-library lookup) failed —
   * the cascade renders an honest load-error state with retry instead of
   * pretending the library is empty (fallback-audit critical #3).
   */
  libraryLoadError = signal<string | null>(null);

  // Queue state - writable signals synced from QueueService (source of truth)
  // These are writable for backward compatibility, synced via effect in constructor
  stagingQueue = signal<ProcessingQueueItem[]>([]);  // Pending jobs not yet submitted
  processingQueue = signal<ProcessingQueueItem[]>([]); // Jobs actively being processed
  completedQueue = signal<ProcessingQueueItem[]>([]); // Jobs that have finished

  // Queue UI state
  queueExpanded = signal(true);
  expandedQueueItems = signal<Set<string>>(new Set());
  selectedQueueItems = signal<Set<string>>(new Set());

  // Track video currently processing AI (transcribe or ai-analyze)
  aiProcessingVideoId = computed(() => {
    const queue = this.processingQueue();
    console.log('[AI-GREEN-DOT] Processing queue:', queue.map(q => ({
      id: q.id,
      videoId: q.videoId,
      status: q.status,
      tasks: q.tasks.map(t => ({ type: t.type, status: t.status }))
    })));

    const processingItem = queue.find(item => {
      if (item.status !== 'processing') return false;

      // Check if any AI-related task is currently running
      const hasRunningAI = item.tasks.some(task =>
        (task.type === 'transcribe' || task.type === 'ai-analyze') &&
        task.status === 'running'
      );

      if (hasRunningAI) {
        console.log(`[AI-GREEN-DOT] Found item with running AI task: videoId=${item.videoId}, tasks=`, item.tasks);
      }

      return hasRunningAI;
    });

    const resultVideoId = processingItem?.videoId || null;
    console.log(`[AI-GREEN-DOT] Result aiProcessingVideoId: ${resultVideoId}`);
    return resultVideoId;
  });

  // Queue-specific AI processing ID (uses queue item ID with processing- prefix)
  aiProcessingQueueItemId = computed(() => {
    const queue = this.processingQueue();
    const processingItem = queue.find(item => {
      if (item.status !== 'processing') return false;

      // Check if any AI-related task is currently running
      return item.tasks.some(task =>
        (task.type === 'transcribe' || task.type === 'ai-analyze') &&
        task.status === 'running'
      );
    });

    return processingItem ? `processing-${processingItem.id}` : null;
  });

  // Library tab now shows ONLY library videos (no queue items - they're on Queue tab)
  /**
   * Library type filter (toolbar segmented control): Archives folded into the
   * Library as a type, per the redesign. Layered on top of search/filters.
   */
  typeFilter = signal<'all' | 'video' | 'doc' | 'web'>('all');

  readonly typeFilterOptions = [
    { value: 'all', label: 'All' },
    { value: 'video', label: 'Videos' },
    { value: 'doc', label: 'Documents' },
    { value: 'web', label: 'Web Archives' },
  ];

  combinedWeeks = computed(() => {
    const weeks = this.filteredWeeks();
    const filter = this.typeFilter();
    if (filter === 'all') return weeks;

    return weeks
      .map(week => ({
        ...week,
        videos: week.videos.filter(v => this.matchesTypeFilter(v, filter))
      }))
      .filter(week => week.videos.length > 0);
  });

  /**
   * Honest empty-state for the cascade: distinguishes "library is empty"
   * from "load failed" from "everything is hidden by filters"
   * (fallback-audit critical #4 — one empty state told three lies).
   */
  cascadeEmptyState = computed<CascadeEmptyState>(() => {
    const error = this.libraryLoadError();
    if (error) {
      return { kind: 'error', detail: error };
    }
    const shown = this.combinedWeeks().reduce((sum, w) => sum + w.videos.length, 0);
    if (shown > 0) {
      return { kind: 'empty' }; // not shown — cascade has items
    }
    const total = this.videoWeeks().reduce((sum, w) => sum + w.videos.length, 0);
    if (total > 0) {
      return { kind: 'filtered', hiddenCount: total };
    }
    return { kind: 'empty' };
  });

  onCascadeEmptyAction(action: CascadeEmptyAction): void {
    if (action === 'retry') {
      this.retryLibraryLoad();
    } else {
      // Clear every layer that can hide items: search/filters accordion,
      // the type-filter segments, and any active search query.
      this.searchFilters?.clearFilters();
      this.typeFilter.set('all');
    }
  }

  onTypeFilterChange(value: string): void {
    this.typeFilter.set(value as 'all' | 'video' | 'doc' | 'web');
  }

  private matchesTypeFilter(video: VideoItem, filter: 'video' | 'doc' | 'web'): boolean {
    // Shared taxonomy with the inspector (core/item-kind.ts).
    return classifyItemKind(video) === filter;
  }

  // Total video count for library toolbar
  totalVideoCount = computed(() => {
    return this.filteredWeeks().reduce((sum, week) => sum + week.videos.length, 0);
  });

  // Children config for processing items (task accordions)
  processingChildrenConfig: ChildrenConfig = {
    enabled: true,
    expandable: true,
    defaultExpanded: false,
    showMasterProgress: true,
    showStatus: true,
    clickable: false,
    generator: (video: VideoItem) => this.generateTaskChildren(video),
    masterProgressCalculator: (video: VideoItem) => this.calculateMasterProgress(video)
  };

  // Progress mapper for queue items
  // Reads directly from QueueService to avoid effect timing issues
  queueProgressMapper = (video: VideoItem): ItemProgress | null => {
    // Handle staging, queue, and processing tags
    const queueTag = video.tags?.find(t => t.startsWith('queue:') || t.startsWith('processing:') || t.startsWith('staging:'));
    if (!queueTag) return null;

    const queueId = queueTag.replace(/^(queue:|processing:|staging:)/, '');

    // Look directly in QueueService for most up-to-date data
    let job = this.queueService.processingJobs().find(j => j.id === queueId);
    if (!job) {
      job = this.queueService.pendingJobs().find(j => j.id === queueId);
    }
    if (!job) return null;

    // Calculate overall progress
    if (job.tasks.length === 0) return null;

    const totalProgress = job.tasks.reduce((sum, task) => sum + task.progress, 0);
    const overallProgress = Math.round(totalProgress / job.tasks.length);

    // Only show progress bar when processing
    if (job.state === 'pending') {
      return null;
    }

    // Find the currently running task for ETA and label
    const runningTask = job.tasks.find(t => t.state === 'running');
    const taskLabel = runningTask?.taskLabel;
    const etaLabel = runningTask?.eta !== undefined ? this.formatEta(runningTask.eta) : undefined;

    // Determine color based on status
    let color = 'var(--primary-orange)';
    if (job.state === 'completed') {
      color = 'var(--status-complete)';
    } else if (job.state === 'failed') {
      color = 'var(--status-error)';
    }

    return {
      value: overallProgress,
      color,
      indeterminate: false,
      taskLabel,
      etaLabel
    };
  };

  /**
   * Format ETA seconds into human-readable string
   */
  private formatEta(seconds: number): string {
    if (seconds <= 0 || !isFinite(seconds)) return '';
    if (seconds < 60) return `~${Math.round(seconds)}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins < 60) return `~${mins}:${secs.toString().padStart(2, '0')} remaining`;
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `~${hours}h ${remainingMins}m remaining`;
  }

  // Config modal state
  configModalOpen = signal(false);
  configItemIds = signal<string[]>([]);
  configBulkMode = signal(false);
  configItemSource = signal<'url' | 'library'>('url');
  configExistingTasks = signal<QueueItemTask[]>([]);
  configHasTranscript = signal(false); // Whether the video(s) already have transcript

  // Pending videos waiting for config (not yet added to queue)
  pendingConfigVideos = signal<VideoItem[]>([]);

  // Library manager state
  libraryManagerOpen = signal(false);
  libraries = signal<Library[]>([]);
  currentLibrary = signal<Library | null>(null);

  // Selection state
  selectedCount = signal(0);
  selectedVideoIds = signal<Set<string>>(new Set());

  // Video preview modal state
  previewModalOpen = signal(false);
  previewItems = signal<PreviewItem[]>([]);
  previewSelectedId = signal<string | undefined>(undefined);
  previewRefreshKey = signal(0); // Increment to force preview reload after video path update

  // New tab dialog state
  newTabDialogOpen = signal(false);
  newTabPendingVideos = signal<string[]>([]);

  // Download Dialog
  downloadDialogOpen = signal(false);

  // Trim Opener Modal state
  trimModalOpen = signal(false);
  trimModalVideoTitle = signal('');
  trimModalInitialTime = signal(0);
  trimModalInitialEndTime = signal(0);
  trimModalJobId = signal<string | null>(null);

  // Filters
  currentFilters: LibraryFilters | null = null;

  // Tab State — set by the route.data subscription (URL is the source of truth)
  activeTab = signal<'library' | 'queue' | 'tabs' | 'archives'>('library');

  // Default task settings (loaded from localStorage)
  private defaultTaskSettings: QueueItemTask[] = [];

  // Counter for generating unique queue item IDs
  private queueIdCounter = 0;

  // Flag to prevent saving during initial load
  private isLoadingQueue = true;

  constructor() {
    // Watch for library manager requests from child components
    effect(() => {
      const requestCount = this.libraryService.libraryManagerRequested();
      if (requestCount > 0) {
        this.openLibraryManager();
      }
    });

    // Sync queue signals from QueueService (source of truth)
    // This allows existing code to work while we gradually migrate to using QueueService directly
    effect(() => {
      const pending = this.queueService.pendingJobs();
      this.stagingQueue.set(pending.map(job => this.convertQueueJobToProcessingItem(job)));
    }, { allowSignalWrites: true });

    effect(() => {
      const processing = this.queueService.processingJobs();
      this.processingQueue.set(processing.map(job => this.convertQueueJobToProcessingItem(job)));
    }, { allowSignalWrites: true });

    effect(() => {
      const completed = this.queueService.completedJobs();
      this.completedQueue.set(completed.map(job => this.convertQueueJobToProcessingItem(job)));
    }, { allowSignalWrites: true });

    // Sync tabbed video IDs from TabsService → local signal → cascade @Input
    effect(() => {
      const ids = this.tabsService.tabbedVideoIds();
      this.tabbedVideoIds.set(ids);
    }, { allowSignalWrites: true });

    // The URL is the source of truth for which workspace section shows.
    // WorkspaceReuseStrategy keeps this component alive across
    // /library ↔ /queue ↔ /collections ↔ … navigations, so this fires on
    // every section change without re-running ngOnInit.
    this.route.data.pipe(takeUntilDestroyed()).subscribe(data => {
      const section = data['section'] as Parameters<LibraryPageComponent['applySection']>[0] | undefined;
      if (section && section !== this.activeTab()) {
        this.applySection(section);
      } else if (section === 'queue') {
        // Re-entering /queue (e.g. from a popout callback) still refreshes.
        this.applySection('queue');
      }
    });

    // Shell toolbar → workspace action channel (Phase 2). The toolbar owns
    // the buttons; this component owns the handlers/modals they trigger.
    this.workspaceActions.actions$.pipe(takeUntilDestroyed()).subscribe(action => {
      switch (action.type) {
        case 'import':
          this.openImportDialog();
          break;
        case 'openDownloadDialog':
          this.openDownloadDialog();
          break;
        case 'submitDownloads':
          if (this.requireLibrary()) {
            this.onDownloadSubmit(action.payload.items);
          }
          break;
        case 'openEditor':
          if (action.videoId) {
            this.openConnectedInEditor(action.videoId);
          } else {
            this.openInEditor();
          }
          break;
        case 'locateVideo':
          this.locateVideo(action.videoId);
          break;
        case 'viewInfo':
          this.viewMore();
          break;
        case 'transcribeSelection':
          this.transcribeSelected();
          break;
        case 'analyzeSelection':
          this.analyzeSelected();
          break;
        case 'processSelection':
          this.processSelection(action.steps);
          break;
        case 'updatePendingJobs':
          this.updatePendingJobs(
            action.jobIds,
            action.steps,
            action.trimStartSeconds,
            action.trimEndSeconds
          );
          break;
        case 'openAiSetup':
          this.aiWizardOpen.set(true);
          break;
        case 'addSelectionToTab':
          this.addVideosToTab(action.tabId, this.getSelectedLibraryVideos().map(v => v.id));
          break;
        case 'createTabWithSelection':
          this.openNewTabDialog(this.getSelectedLibraryVideos().map(v => v.id));
          break;
      }
    });

    // Feed the inspector a flattened, deduped snapshot of the library items
    // so the shell's inspector panel can resolve the selection (Phase 3).
    effect(() => {
      this.inspectorStore.setLibraryItems(this.allLibraryItems());
    }, { allowSignalWrites: true });
  }

  async ngOnInit() {
    // Note: Queue state is managed by QueueService (single source of truth)
    // No need to load from localStorage here - QueueService handles persistence

    this.loadDefaultTaskSettings();

    // Subscribe to websocket events (for library refresh only - queue updates handled by QueueService)
    this.websocketService.connect();

    // Listen for navigate-to-queue events (from popout editor or same-window editor).
    // Route navigation triggers applySection('queue') → refreshFromBackend, so
    // don't call it twice — two parallel refreshes could both hit Pass 3 in
    // restoreFromBackend and create duplicate frontend jobs for a single backend
    // export-clip job. If we're ALREADY on /queue the navigation no-ops, so
    // refresh directly in that case only.
    this.navigateToQueueHandler = () => {
      if (this.activeTab() === 'queue') {
        this.queueService.refreshFromBackend();
      } else {
        this.setActiveTab('queue');
      }
    };
    window.addEventListener('electron-navigate-to-queue', this.navigateToQueueHandler);
    window.addEventListener('navigate-to-queue', this.navigateToQueueHandler);

    // Check for first-time setup with error handling
    try {
      await this.checkFirstTimeSetup();
    } catch (error) {
      console.error('Error during first-time setup check:', error);
      // If setup check fails, still try to load library directly
      this.loadCurrentLibrary();
    }

    // Task completion - refresh library (queue updates handled by QueueService)
    this.websocketService.onTaskCompleted((event: TaskCompleted) => {
      console.log('Task completed:', event);

      // Refresh library when a task completes
      // Skip if there's a pending rename for this video to avoid race conditions
      const refreshTaskTypes = ['analyze', 'transcribe', 'import', 'download', 'fix-aspect-ratio', 'normalize-audio', 'process-video', 'export-clip'];
      if (refreshTaskTypes.includes(event.type)) {
        if (event.videoId && this.pendingRenames.has(event.videoId)) {
          console.log('Skipping library refresh - pending rename for videoId:', event.videoId);
        } else {
          this.loadCurrentLibrary();
        }
      }
    });

    // Task failed - show notification (queue updates handled by QueueService)
    this.websocketService.onTaskFailed((event: TaskFailed) => {

      // Get error message
      const errorMessage = event.error?.message || 'Unknown error';

      // Show notification to user
      this.notificationService.error(
        `Task failed: ${event.type}`,
        errorMessage,
        true  // showToast
      );
    });

    // Video renamed - update video list (including upload date and path)
    this.websocketService.onVideoRenamed((event) => {
      console.log('Video renamed event received:', event);
      this.updateVideoName(event.videoId, event.newFilename, event.uploadDate, event.newPath);
      this.cdr.markForCheck(); // Trigger change detection for OnPush strategy
    });

    // Video path updated - refresh video data (e.g., after aspect ratio fix or audio normalization)
    this.websocketService.onVideoPathUpdated((event) => {
      console.log('Video path updated event received:', event);
      this.updateVideoPath(event.videoId, event.newPath);

      // If the video is currently being previewed, force the preview modal to reload
      const selectedId = this.previewSelectedId();
      if (selectedId && selectedId === event.videoId && this.previewModalOpen()) {
        console.log('Video being previewed was updated, triggering refresh');
        this.previewRefreshKey.update(k => k + 1);
      }

      this.cdr.markForCheck(); // Trigger change detection for OnPush strategy
    });

    // Analysis completed - update video with suggested title
    this.websocketService.onAnalysisCompleted((event) => {
      console.log('Analysis completed event received:', event);
      this.updateVideoSuggestedTitle(event.videoId, event.suggestedTitle, event.aiDescription);
      this.cdr.markForCheck(); // Trigger change detection for OnPush strategy
    });

    // Suggestion rejected - reload library to clear the suggestion
    this.websocketService.onSuggestionRejected((event) => {
      console.log('Suggestion rejected event received:', event);
      this.loadLibrary(); // Reload to get updated data from database
    });

    // Video added - reload library to show new video
    this.websocketService.onVideoAdded((event) => {
      console.log('Video added event received:', event);
      this.loadLibrary(); // Reload to show the new video
    });

    // Check for navigation state to trigger analysis
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || history.state;

    if (state?.triggerAnalysis && state?.videoId) {
      // Wait for library to load, then add video to queue
      setTimeout(() => {
        this.addVideoToAnalysisQueue(state.videoId, state.videoName);
      }, 500);
    }

    // Auto-start welcome tour on first app visit, then chain to tab-specific tour.
    // Skip entirely on the web client — the tour is anchored to desktop-sized
    // chrome and just obscures the (small) screen on a phone.
    if (this.isWeb) {
      // no tour on mobile/web
    } else if (!this.tourService.isTourCompleted('welcome')) {
      // Queue the library tour to run after welcome tour completes
      this.tourService.queueTour(this.activeTab());
      this.tourService.tryAutoStartTour('welcome');
    } else {
      // Welcome already done, just show the tab tour
      this.tourService.tryAutoStartTour(this.activeTab());
    }
  }

  // Check for first-time setup (AI config and library)
  private async checkFirstTimeSetup() {
    // First check if any libraries exist - this must happen before anything else
    try {
      const librariesResponse = await firstValueFrom(this.libraryService.getLibraries());
      if (librariesResponse.success) {
        this.libraries.set(librariesResponse.data);

        if (librariesResponse.data.length === 0) {
          // No libraries exist - show library manager first, skip AI wizard for now
          console.log('No libraries found, opening library manager');
          this.libraryManagerOpen.set(true);
          return; // Don't proceed with AI setup or loading - need library first
        }
      }
    } catch (error) {
      console.error('Error checking libraries:', error);
      // If we can't check libraries, open the manager to let user create one
      this.libraryManagerOpen.set(true);
      return;
    }

    // Libraries exist - load them. AI is no longer prompted at startup; it's
    // configured from Settings, or on demand when the user runs an analysis.
    this.aiSetupService.checkAIAvailability();
    this.loadCurrentLibrary();
  }

  // Handle AI wizard completion
  onAiWizardCompleted() {
    this.aiWizardOpen.set(false);

    // Refresh AI availability after setup
    this.aiSetupService.checkAIAvailability();

    // If there were videos pending analysis, reveal the Process config seeded
    // for them now that AI is set up (rather than reopening the old modal).
    if (this.pendingAnalysisVideos.length > 0) {
      const videos = [...this.pendingAnalysisVideos];
      this.pendingAnalysisVideos = [];
      // Let the wizard close fully before revealing the inspector.
      setTimeout(() => this.revealProcessForAnalyze(videos), 100);
      return;
    }

    // Load libraries after AI setup
    this.loadLibraries();

    // Check if user has any libraries
    this.libraryService.getLibraries().subscribe({
      next: (response) => {
        if (response.success) {
          this.libraries.set(response.data);

          if (response.data.length === 0) {
            // No libraries - open library manager
            this.libraryManagerOpen.set(true);
          } else {
            // Has libraries - load current library
            this.loadCurrentLibrary();
          }
        } else {
          // Error loading libraries - open manager
          this.libraryManagerOpen.set(true);
        }
      },
      error: () => {
        // Error - open library manager
        this.libraryManagerOpen.set(true);
      }
    });
  }

  // Handle AI wizard closed/skipped
  onAiWizardClosed() {
    this.aiWizardOpen.set(false);

    // Clear any pending analysis videos since user skipped AI setup
    if (this.pendingAnalysisVideos.length > 0) {
      this.notificationService.info(
        'AI Setup Required',
        'Video analysis requires AI to be configured. Set up AI in Settings when ready.'
      );
      this.pendingAnalysisVideos = [];
    }

    // Still need to load libraries even if AI setup was skipped
    this.loadLibraries();

    // Check if user has any libraries
    this.libraryService.getLibraries().subscribe({
      next: (response) => {
        if (response.success) {
          this.libraries.set(response.data);

          if (response.data.length === 0) {
            // No libraries - open library manager
            this.libraryManagerOpen.set(true);
          } else {
            // Has libraries - load current library
            this.loadCurrentLibrary();
          }
        } else {
          this.libraryManagerOpen.set(true);
        }
      },
      error: () => {
        this.libraryManagerOpen.set(true);
      }
    });
  }

  // Start the tutorial tour for the current tab
  startTour() {
    const tab = this.activeTab();
    let tourId = 'library';

    // Map tabs to tour IDs
    if (tab === 'queue') {
      tourId = 'queue';
    } else if (tab === 'library') {
      tourId = 'library';
    }

    this.tourService.startTour(tourId);
  }

  // Load default task settings from localStorage
  private loadDefaultTaskSettings() {
    const saved = localStorage.getItem('briefcase-task-defaults');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const tasks = parsed.tasks || [];
        // Only use saved settings if they were explicitly configured
        // Otherwise use defaults (download-import only for new URLs)
        if (tasks.length > 0) {
          this.defaultTaskSettings = tasks;
        } else {
          this.defaultTaskSettings = this.getDefaultTasks();
        }
      } catch (e) {
        console.error('Failed to load task defaults:', e);
        this.defaultTaskSettings = this.getDefaultTasks();
      }
    } else {
      this.defaultTaskSettings = this.getDefaultTasks();
    }

    // Clear old defaults that included extra tasks - force reset to download-only
    // Remove this after users have updated
    if (this.defaultTaskSettings.length > 1) {
      localStorage.removeItem('briefcase-task-defaults');
      this.defaultTaskSettings = this.getDefaultTasks();
    }
  }

  // Get default tasks when none are saved
  private getDefaultTasks(): QueueItemTask[] {
    return [
      { type: 'download-import', status: 'pending', progress: 0, config: {} }
    ];
  }

  // Save task settings to localStorage
  private saveDefaultTaskSettings(tasks: QueueItemTask[]) {
    localStorage.setItem('briefcase-task-defaults', JSON.stringify({
      tasks,
      savedAt: new Date().toISOString()
    }));
    this.defaultTaskSettings = tasks;
  }

  // Save processing queue to localStorage
  private saveProcessingQueueToStorage(queue: ProcessingQueueItem[]) {
    try {
      localStorage.setItem('briefcase-processing-queue', JSON.stringify(queue));

      // Also save the processing flags (video IDs that are in queue)
      const processingVideoIds = queue
        .filter(item => item.videoId)
        .map(item => item.videoId!);
      localStorage.setItem('briefcase-processing-flags', JSON.stringify(processingVideoIds));

      // Save the backend-to-frontend job ID mapping for items that have started processing
      const jobIdMapping: Record<string, string> = {};
      queue.forEach(item => {
        if (item.jobId && item.backendJobId) {
          jobIdMapping[item.backendJobId] = item.jobId;
        }
      });
      localStorage.setItem('briefcase-job-id-mapping', JSON.stringify(jobIdMapping));
    } catch (e) {
      console.error('Failed to save processing queue:', e);
    }
  }

  // Check if a video is in the processing queue
  isVideoInProcessingQueue(videoId: string): boolean {
    return this.processingQueue().some(item => item.videoId === videoId);
  }

  // Get all video IDs currently in processing queue (from localStorage)
  static getProcessingVideoIds(): string[] {
    try {
      const saved = localStorage.getItem('briefcase-processing-flags');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load processing flags:', e);
    }
    return [];
  }

  // Load processing queue from localStorage
  private loadProcessingQueueFromStorage() {
    try {
      const saved = localStorage.getItem('briefcase-processing-queue');
      if (saved) {
        const queue: ProcessingQueueItem[] = JSON.parse(saved);
        if (Array.isArray(queue) && queue.length > 0) {
          this.processingQueue.set(queue);

          // Update the counter to avoid ID collisions
          const maxId = queue.reduce((max, item) => {
            const match = item.id.match(/\d+$/);
            if (match) {
              return Math.max(max, parseInt(match[0], 10));
            }
            return max;
          }, 0);
          this.queueIdCounter = maxId;

          console.log(`Restored ${queue.length} items from processing queue`);
        }
      }
    } catch (e) {
      console.error('Failed to load processing queue:', e);
      localStorage.removeItem('briefcase-processing-queue');
    }
  }

  // Save completed queue to sessionStorage (temporary, clears when app restarts)
  private saveCompletedQueueToStorage(queue: ProcessingQueueItem[]) {
    try {
      sessionStorage.setItem('briefcase-completed-queue', JSON.stringify(queue));
    } catch (e) {
      console.error('Failed to save completed queue:', e);
    }
  }

  // Load completed queue from sessionStorage (for navigation within session)
  private loadCompletedQueueFromStorage() {
    try {
      const saved = sessionStorage.getItem('briefcase-completed-queue');
      if (saved) {
        const queue: ProcessingQueueItem[] = JSON.parse(saved);
        if (Array.isArray(queue) && queue.length > 0) {
          this.completedQueue.set(queue);
          console.log(`Restored ${queue.length} items from completed queue`);
        }
      }
    } catch (e) {
      console.error('Failed to load completed queue:', e);
      sessionStorage.removeItem('briefcase-completed-queue');
    }
  }

  // Generate task children for a queue item
  private generateTaskChildren(video: VideoItem): VideoChild[] {
    // Check if this is a staging, queue, or processing item
    const queueTag = video.tags?.find(t => t.startsWith('queue:') || t.startsWith('processing:') || t.startsWith('staging:'));
    if (!queueTag) return [];

    const queueId = queueTag.replace(/^(queue:|processing:|staging:)/, '');

    // Look in both staging and processing queues
    let queueItem = this.processingQueue().find(q => q.id === queueId);
    if (!queueItem) {
      queueItem = this.stagingQueue().find(q => q.id === queueId);
    }
    if (!queueItem) return [];

    return queueItem.tasks.map(task => {
      const taskInfo = AVAILABLE_TASKS.find(t => t.type === task.type);
      // Use "Download" instead of "Download and Import" for cleaner display
      const label = task.type === 'download-import' ? 'Download' : (taskInfo?.label || task.type);
      return {
        id: `${queueId}-${task.type}`,
        parentId: video.id,
        label,
        icon: this.getTaskStatusIcon(task.status),
        status: this.mapTaskStatus(task.status),
        progress: task.status === 'running' ? {
          value: task.progress,
          color: 'var(--primary-orange)'
        } : undefined,
        metadata: task.status === 'running' ? `${task.progress}%` : undefined
      };
    });
  }

  // Calculate master progress for a queue item
  private calculateMasterProgress(video: VideoItem): number {
    const queueTag = video.tags?.find(t => t.startsWith('queue:') || t.startsWith('processing:') || t.startsWith('staging:'));
    if (!queueTag) return 0;

    const queueId = queueTag.replace(/^(queue:|processing:|staging:)/, '');

    // Look in both staging and processing queues
    let queueItem = this.processingQueue().find(q => q.id === queueId);
    if (!queueItem) {
      queueItem = this.stagingQueue().find(q => q.id === queueId);
    }
    if (!queueItem || queueItem.tasks.length === 0) return 0;

    const totalProgress = queueItem.tasks.reduce((sum, task) => sum + task.progress, 0);
    return Math.round(totalProgress / queueItem.tasks.length);
  }

  // Map task status to child status
  private mapTaskStatus(status: string): 'pending' | 'active' | 'completed' | 'failed' {
    switch (status) {
      case 'running': return 'active';
      case 'completed': return 'completed';
      case 'failed': return 'failed';
      default: return 'pending';
    }
  }

  // Get status icon for task
  private getTaskStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return '✓';
      case 'running': return '⟳';
      case 'failed': return '✗';
      case 'pending': return '⏳';
      default: return '○';
    }
  }

  // Update video name and upload date in the library when renamed via WebSocket
  private updateVideoName(videoId: string, newFilename: string, uploadDate?: string | null, newPath?: string) {
    const weeks = this.videoWeeks();
    let updated = false;

    // Find and update the video in the weeks array
    const updatedWeeks = weeks.map(week => {
      const videos = week.videos.map(video => {
        if (video.id === videoId) {
          updated = true;
          const updates: any = {
            ...video,
            name: newFilename,
            // Clear AI suggestions since user renamed the file
            suggestedFilename: undefined,
            suggestedTitle: undefined
          };
          // Update uploadDate if provided
          if (uploadDate !== undefined) {
            updates.uploadDate = uploadDate ? new Date(uploadDate) : undefined;
          }
          // Update filePath to the new on-disk location. Without this, opening
          // the editor (or any other action that reads filePath) after a
          // rename passes a stale path that no longer exists, causing downstream
          // tasks like export-clip to fail with "Video file not found".
          if (newPath) {
            updates.filePath = newPath;
          }
          return updates;
        }
        return video;
      });
      return { ...week, videos };
    });

    if (updated) {
      this.videoWeeks.set(updatedWeeks);
      console.log(`Updated video ${videoId} name to: ${newFilename}, uploadDate: ${uploadDate}, cleared AI suggestions`);

      // Re-apply filters to remove video if it no longer matches (e.g., no longer has suggestions)
      this.applyFilters();
      console.log('Re-applied filters after rename - video will be removed if it no longer matches filter criteria');
    }
  }

  // Update video suggested title in the library when analysis completes via WebSocket
  private updateVideoSuggestedTitle(videoId: string, suggestedTitle: string, aiDescription: string) {
    const weeks = this.videoWeeks();
    let updated = false;

    // Find and update the video in the weeks array
    const updatedWeeks = weeks.map(week => {
      const videos = week.videos.map(video => {
        if (video.id === videoId) {
          updated = true;
          return {
            ...video,
            suggestedTitle: suggestedTitle,
            suggestedFilename: suggestedTitle,
            aiDescription: aiDescription,
            hasAnalysis: true
          };
        }
        return video;
      });
      return { ...week, videos };
    });

    if (updated) {
      this.videoWeeks.set(updatedWeeks);
      console.log(`Updated video ${videoId} with suggested title: ${suggestedTitle}`);

      // Also update filtered weeks if they exist
      const filtered = this.filteredWeeks();
      if (filtered.length > 0) {
        const updatedFiltered = filtered.map(week => {
          const videos = week.videos.map(video => {
            if (video.id === videoId) {
              return {
                ...video,
                suggestedTitle: suggestedTitle,
                suggestedFilename: suggestedTitle,
                aiDescription: aiDescription,
                hasAnalysis: true
              };
            }
            return video;
          });
          return { ...week, videos };
        });
        this.filteredWeeks.set(updatedFiltered);
      }
    }
  }

  // Update video path in the library when it changes (e.g., after aspect ratio fix or audio normalization)
  private updateVideoPath(videoId: string, newPath: string) {
    const weeks = this.videoWeeks();
    let updated = false;

    // Extract new filename from path (handle both forward and backslashes)
    const pathParts = newPath.replace(/\\/g, '/').split('/');
    const newFilename = pathParts[pathParts.length - 1] || newPath;

    // Find and update the video in the weeks array
    const updatedWeeks = weeks.map(week => {
      const videos = week.videos.map(video => {
        if (video.id === videoId) {
          updated = true;
          return {
            ...video,
            currentPath: newPath,
            name: newFilename
          };
        }
        return video;
      });
      return { ...week, videos };
    });

    if (updated) {
      this.videoWeeks.set(updatedWeeks);
      console.log(`Updated video ${videoId} path to: ${newPath}`);

      // Also update filtered weeks
      const filtered = this.filteredWeeks();
      if (filtered.length > 0) {
        const updatedFiltered = filtered.map(week => {
          const videos = week.videos.map(video => {
            if (video.id === videoId) {
              return {
                ...video,
                currentPath: newPath,
                name: newFilename
              };
            }
            return video;
          });
          return { ...week, videos };
        });
        this.filteredWeeks.set(updatedFiltered);
      }
    }
  }

  // Update queue task progress only (don't change status if already completed)
  private updateQueueTaskProgress(jobId: string, taskType: string, progress: number) {
    const queue = this.processingQueue();

    // Find the queue item
    let itemIndex = queue.findIndex(q => q.jobId === jobId);
    if (itemIndex === -1) {
      itemIndex = queue.findIndex(q => q.backendJobId === jobId);
    }
    if (itemIndex === -1) {
      try {
        const mapping = localStorage.getItem('briefcase-job-id-mapping');
        if (mapping) {
          const jobIdMap: Record<string, string> = JSON.parse(mapping);
          const frontendJobId = jobIdMap[jobId];
          if (frontendJobId) {
            itemIndex = queue.findIndex(q => q.jobId === frontendJobId);
          }
        }
      } catch (e) {
        console.error('Failed to load job ID mapping:', e);
      }
    }
    if (itemIndex === -1) return;

    const item = queue[itemIndex];

    // Handle process-video task which updates both fix-aspect-ratio and normalize-audio
    if (taskType === 'process-video') {
      const updatedTasks = [...item.tasks];
      const aspectIndex = updatedTasks.findIndex(t => t.type === 'fix-aspect-ratio');
      const audioIndex = updatedTasks.findIndex(t => t.type === 'normalize-audio');

      let anyUpdated = false;
      if (aspectIndex !== -1 && updatedTasks[aspectIndex].status !== 'completed' && updatedTasks[aspectIndex].status !== 'failed') {
        updatedTasks[aspectIndex] = { ...updatedTasks[aspectIndex], status: 'running', progress };
        anyUpdated = true;
      }
      if (audioIndex !== -1 && updatedTasks[audioIndex].status !== 'completed' && updatedTasks[audioIndex].status !== 'failed') {
        updatedTasks[audioIndex] = { ...updatedTasks[audioIndex], status: 'running', progress };
        anyUpdated = true;
      }

      if (anyUpdated) {
        const updatedItem: ProcessingQueueItem = {
          ...item,
          tasks: updatedTasks,
          status: 'processing'
        };
        const newQueue = [...queue];
        newQueue[itemIndex] = updatedItem;
        this.processingQueue.set(newQueue);
      }
      return;
    }

    const mappedType = this.mapBackendTaskType(taskType);
    const taskIndex = item.tasks.findIndex(t => t.type === mappedType);
    if (taskIndex === -1) return;

    const currentTask = item.tasks[taskIndex];

    // Don't update if task is already completed or failed
    if (currentTask.status === 'completed' || currentTask.status === 'failed') {
      return;
    }

    // Update progress and set to running if not already
    const updatedTask = {
      ...currentTask,
      status: 'running' as const,
      progress
    };
    const updatedTasks = [...item.tasks];
    updatedTasks[taskIndex] = updatedTask;

    const updatedItem: ProcessingQueueItem = {
      ...item,
      tasks: updatedTasks,
      status: 'processing'
    };

    const newQueue = [...queue];
    newQueue[itemIndex] = updatedItem;
    this.processingQueue.set(newQueue);
  }

  // DEPRECATED: Queue task progress updates are now handled by QueueService via WebSocket
  private updateQueueTaskProgressOnly(jobId: string, taskType: string, progress: number) {
    // No-op: QueueService handles all queue state updates
    console.log('[DEPRECATED] updateQueueTaskProgressOnly called - QueueService handles this');
  }

  // Track which backend sub-tasks have completed for combined frontend tasks
  private completedSubTasks = new Map<string, Set<string>>();

  // DEPRECATED: Queue task status updates are now handled by QueueService via WebSocket
  private updateQueueTaskStatus(jobId: string, taskType: string, status: 'pending' | 'running' | 'completed' | 'failed', progress: number, errorMessage?: string) {
    // No-op: QueueService handles all queue state updates via WebSocket events
    console.log('[DEPRECATED] updateQueueTaskStatus called - QueueService handles this');
  }

  // Map backend task types to frontend types
  private mapBackendTaskType(type: string): TaskType {
    const mapping: Record<string, TaskType> = {
      'get-info': 'download-import',
      'download': 'download-import',
      'import': 'download-import',
      'transcribe': 'transcribe',
      'analyze': 'ai-analyze',
      'fix-aspect-ratio': 'fix-aspect-ratio',
      'normalize-audio': 'normalize-audio',
      'process-video': 'fix-aspect-ratio'  // Combined task - maps to first visible task
    };
    return mapping[type] || 'download-import';
  }

  /**
   * Map VideoTask types to QueueItemTask types
   */
  private mapVideoTaskTypeToQueueTaskType(type: string): TaskType {
    const mapping: Record<string, TaskType> = {
      'download': 'download-import',
      'import': 'download-import',
      'aspect-ratio': 'fix-aspect-ratio',
      'normalize-audio': 'normalize-audio',
      'transcribe': 'transcribe',
      'ai-analysis': 'ai-analyze'
    };
    return mapping[type] || 'download-import';
  }

  /**
   * Combine backend job tasks into frontend ProcessingTask format
   * Combines download + import + get-info into a single "Download" task
   * Note: QueueService already combines these into a single 'download-import' task,
   * so we also need to check for that case
   */
  private combineJobTasks(tasks: any[]): ProcessingTask[] {
    const result: ProcessingTask[] = [];

    // Find download-related tasks
    const downloadTask = tasks.find(t => t.type === 'download');
    const importTask = tasks.find(t => t.type === 'import');
    const getInfoTask = tasks.find(t => t.type === 'get-info');

    // Combine download/import/get-info into single "Download" task
    if (downloadTask || importTask || getInfoTask) {
      // Determine combined status and progress
      let status: 'pending' | 'running' | 'completed' | 'failed' = 'pending';
      let progress = 0;
      let errorMessage: string | undefined;

      // Check for failures first
      if (downloadTask?.status === 'failed' || importTask?.status === 'failed') {
        status = 'failed';
        errorMessage = downloadTask?.error || importTask?.error;
      } else if (importTask?.status === 'completed') {
        // Backend has separate import task that's completed
        status = 'completed';
        progress = 100;
      } else if (downloadTask?.status === 'completed' && !importTask) {
        // QueueService combines download+import into single 'download-import' task
        // If it's completed and there's no separate import task, the whole download is done
        status = 'completed';
        progress = 100;
      } else if (importTask?.status === 'in-progress' || downloadTask?.status === 'completed') {
        status = 'running';
        progress = 100; // Download done, import is quick
      } else if (downloadTask?.status === 'in-progress') {
        status = 'running';
        progress = downloadTask.progress || 0;
      } else if (getInfoTask?.status === 'in-progress') {
        status = 'running';
        progress = 0;
      }

      result.push({
        type: 'download-import',
        options: {},
        status,
        progress,
        errorMessage
      });
    }

    // Add other tasks (skip download/import/get-info)
    for (const task of tasks) {
      if (task.type === 'download' || task.type === 'import' || task.type === 'get-info') continue;

      result.push({
        type: this.mapVideoTaskTypeToQueueTaskType(task.type),
        options: {},
        status: task.status === 'pending' ? 'pending' as const :
                task.status === 'in-progress' ? 'running' as const :
                task.status === 'completed' ? 'completed' as const : 'failed' as const,
        progress: task.progress || 0,
        errorMessage: task.error
      });
    }

    return result;
  }

  /**
   * Convert QueueJob (from QueueService) to ProcessingQueueItem (for queue-tab)
   */
  private convertQueueJobToProcessingItem(job: QueueJob): ProcessingQueueItem {
    return {
      id: job.id,
      url: job.url,
      videoId: job.videoId,
      title: job.title,
      duration: job.duration,
      thumbnail: job.thumbnail,
      status: job.state === 'pending' ? 'pending' :
              job.state === 'processing' ? 'processing' :
              job.state === 'completed' ? 'completed' : 'failed',
      tasks: job.tasks.map(task => ({
        type: task.type,
        options: task.options,
        status: task.state === 'pending' ? 'pending' :
                task.state === 'running' ? 'running' :
                task.state === 'completed' ? 'completed' : 'failed',
        progress: task.progress,
        errorMessage: task.errorMessage,
        eta: task.eta,
        taskLabel: task.taskLabel
      })),
      jobId: job.id,
      backendJobId: job.backendJobId,
      titleResolved: job.titleResolved,
      warnings: job.warnings
    };
  }

  // Store videoId in queue item when download/import completes
  private storeVideoIdInQueueItem(frontendJobId: string, backendJobId: string, videoId: string): void {
    const queue = this.processingQueue();

    // Find item by frontend job ID
    let itemIndex = queue.findIndex(q => q.jobId === frontendJobId);

    // If not found, try backend job ID
    if (itemIndex === -1) {
      itemIndex = queue.findIndex(q => q.backendJobId === backendJobId);
    }

    // If still not found, try localStorage mapping
    if (itemIndex === -1) {
      try {
        const mapping = localStorage.getItem('briefcase-job-id-mapping');
        if (mapping) {
          const jobIdMap: Record<string, string> = JSON.parse(mapping);
          const mappedFrontendId = jobIdMap[backendJobId];
          if (mappedFrontendId) {
            itemIndex = queue.findIndex(q => q.jobId === mappedFrontendId);
          }
        }
      } catch (e) {
        console.error('Failed to load job ID mapping:', e);
      }
    }

    if (itemIndex !== -1) {
      const newQueue = [...queue];
      newQueue[itemIndex] = { ...newQueue[itemIndex], videoId };
      this.processingQueue.set(newQueue);
      console.log('Stored videoId in queue item:', videoId, 'for job:', frontendJobId);
    }
  }

  // Rename video file after download completes and title is fetched
  private renameDownloadedVideo(videoId: string, newTitle: string): void {
    // Extract filename from title (remove extension if present, add .mp4)
    const cleanTitle = newTitle.replace(/\.(mp4|mov|avi|mkv|webm)$/i, '');
    const filename = `${cleanTitle}.mp4`;

    // Track this rename to prevent race conditions with library refresh
    this.pendingRenames.add(videoId);
    console.log('Starting rename for videoId:', videoId, 'to:', filename);

    this.libraryService.renameVideoFile(videoId, filename).subscribe({
      next: (response) => {
        if (response.success) {
          console.log('Video renamed successfully:', filename);
          // Remove from pending renames
          this.pendingRenames.delete(videoId);
          // Don't reload library - WebSocket event will update the video in place
          // and re-apply filters to remove it if it no longer matches
        } else {
          console.error('Failed to rename video:', response.error);
          this.pendingRenames.delete(videoId);
        }
      },
      error: (error) => {
        console.error('Error renaming video:', error);
        this.pendingRenames.delete(videoId);
      }
    });
  }

  // Open config modal for selected items
  openConfigModal(itemIds: string[]) {
    if (itemIds.length === 0) return;

    const queueItems = this.processingQueue().filter(q =>
      itemIds.some(id => id === `queue-${q.id}` || id.endsWith(`|queue-${q.id}`))
    );

    if (queueItems.length === 0) return;

    // Get existing tasks from first item
    const firstItem = queueItems[0];
    const existingTasks: QueueItemTask[] = firstItem.tasks.map(t => ({
      type: t.type,
      status: 'pending',
      progress: 0,
      config: t.options
    }));

    // Check if items have transcripts (for library items)
    // URL items don't have transcripts yet
    // For library items, look up the video data
    let hasTranscript = false;
    if (!firstItem.url && firstItem.videoId) {
      const allVideos = this.videoWeeks().flatMap(week => week.videos);
      const videosInQueue = queueItems
        .filter(q => q.videoId)
        .map(q => allVideos.find(v => v.id === q.videoId))
        .filter((v): v is VideoItem => v !== undefined);

      // Only true if ALL videos have transcripts
      hasTranscript = videosInQueue.length > 0 && videosInQueue.every(v => v.hasTranscript === true);
    }

    this.configItemIds.set(queueItems.map(q => q.id));
    this.configBulkMode.set(queueItems.length > 1);
    this.configItemSource.set(firstItem.url ? 'url' : 'library');
    this.configExistingTasks.set(existingTasks);
    this.configHasTranscript.set(hasTranscript);
    this.configModalOpen.set(true);
  }

  // Close config modal
  closeConfigModal() {
    this.configModalOpen.set(false);
    this.configItemIds.set([]);
    // Clear any pending videos (user cancelled)
    this.pendingConfigVideos.set([]);
  }

  // Handle config save - uses QueueService as single source of truth
  onConfigSave(tasks: QueueItemTask[]) {
    const pendingVideos = this.pendingConfigVideos();
    const itemIds = this.configItemIds();

    if (pendingVideos.length > 0) {
      // Adding new videos from analyzeVideos - add via QueueService
      for (const video of pendingVideos) {
        const queueTasks: QueueTask[] = tasks.map(t =>
          createQueueTask(t.type, t.config || {})
        );

        this.queueService.addJob({
          videoId: video.id,
          title: video.name,
          duration: video.duration,
          thumbnail: video.thumbnailUrl,
          tasks: queueTasks,
          titleResolved: true // Library videos already have resolved titles
        });
      }

      // Clear pending videos
      this.pendingConfigVideos.set([]);

      // Switch to Queue tab to show staging items
      this.setActiveTab('queue');
    } else {
      // Updating existing jobs - update via QueueService
      itemIds.forEach(itemId => {
        const queueTasks: QueueTask[] = tasks.map(t =>
          createQueueTask(t.type, t.config || {})
        );
        this.queueService.updateJobTasks(itemId, queueTasks);
      });
    }

    // Save as defaults
    this.saveDefaultTaskSettings(tasks);

    this.closeConfigModal();

    // Scroll to the processing queue section (at the top)
    setTimeout(() => {
      if (this.cascadeComponent) {
        this.cascadeComponent.scrollToTop();
      }
    }, 100);
  }

  // Check if there are items in staging (ready to be processed)
  get hasStagingItems(): boolean {
    return this.stagingQueue().length > 0;
  }

  // Get queue stats (combines both staging and processing)
  get queueStats() {
    const staging = this.stagingQueue();
    const processing = this.processingQueue();
    return {
      total: staging.length + processing.length,
      staging: staging.length,
      processing: processing.filter(q => q.status === 'processing').length,
      pending: processing.filter(q => q.status === 'pending').length
    };
  }

  private addVideoToAnalysisQueue(videoId: string, videoName?: string) {
    // Find the video in the loaded library
    const allVideos = this.videoWeeks().flatMap(week => week.videos);
    const video = allVideos.find(v => v.id === videoId);

    if (video) {
      this.analyzeVideos([video]);
    } else {
      // Video not found in current view, create a minimal video item
      const minimalVideo: VideoItem = {
        id: videoId,
        name: videoName || 'Video',
        hasAnalysis: false
      };
      this.analyzeVideos([minimalVideo]);
    }
  }

  ngOnDestroy() {
    this.websocketService.disconnect();
    this.selectionStore.clear();
    this.inspectorStore.reset();

    if (this.navigateToQueueHandler) {
      window.removeEventListener('electron-navigate-to-queue', this.navigateToQueueHandler);
      window.removeEventListener('navigate-to-queue', this.navigateToQueueHandler);
    }
  }

  loadLibrary() {
    console.log('Loading library videos...');
    // Get processing queue IDs to exclude from "New" section
    const processingQueueIds = this.processingQueue().map(item => item.id);

    this.libraryService.getVideosByWeek(processingQueueIds).subscribe({
      next: (response) => {
        console.log('Videos response:', response);
        if (response.success) {
          console.log('Setting video weeks:', response.data.length, 'weeks');
          this.libraryLoadError.set(null);
          this.videoWeeks.set(response.data);
          // Re-apply current filters to preserve user's filter selections
          this.applyFilters();
        } else {
          // A success:false response is a failed load, not an empty library.
          this.libraryLoadError.set('The backend reported an error loading this library.');
          this.errorSurface.surfaceError('Failed to load library', response);
        }
      },
      error: (error) => {
        // Keep whatever data we already have (stale beats a lie) and show
        // the load-error state — never render "No videos yet" for a failure.
        this.libraryLoadError.set(describeError(error));
        this.errorSurface.surfaceError('Failed to load library', error);
      }
    });
  }

  /** Retry action for the cascade's load-error empty state. */
  retryLibraryLoad(): void {
    this.libraryLoadError.set(null);
    this.loadCurrentLibrary();
  }

  loadCurrentLibrary() {
    console.log('Loading current library...');
    this.libraryService.getCurrentLibrary().subscribe({
      next: (response) => {
        console.log('Current library response:', response);
        if (response.success && response.data) {
          this.currentLibrary.set(response.data);
          this.loadLibrary(); // Load videos for the current library
        } else {
          console.warn('No current library set, opening manager');
          this.openLibraryManager();
        }
      },
      error: (error) => {
        // A backend/connection fault is NOT "no library configured" — do not
        // open the Library Manager here (that masks a server fault as user
        // misconfiguration; fallback-audit discuss #20). Show the load-error
        // state with retry instead. Only a successful "no current library"
        // response (handled above) opens the manager.
        this.libraryLoadError.set(describeError(error));
        this.errorSurface.surfaceError('Failed to load current library', error);
      }
    });
  }

  loadLibraries() {
    this.libraryService.getLibraries().subscribe({
      next: (response) => {
        if (response.success) {
          this.libraries.set(response.data);
        }
      },
      error: (error) => {
        console.error('Failed to load libraries:', error);
      }
    });
  }

  openLibraryManager() {
    this.loadLibraries(); // Refresh libraries list
    this.libraryManagerOpen.set(true);
  }

  closeLibraryManager() {
    this.libraryManagerOpen.set(false);
  }

  onLibrarySelected(library: Library) {
    this.libraryService.switchLibrary(library.id).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Reload videos for new library
        }
      },
      error: (error) => {
        console.error('Failed to switch library:', error);
        this.notificationService.error('Library Switch Failed', 'Failed to switch library. Please try again.');
      }
    });
  }

  onLibraryCreated(newLibrary: NewLibrary) {
    this.libraryService.createLibrary(newLibrary).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Load videos for new library
          this.loadLibraries(); // Refresh libraries list
        }
      },
      error: (error) => {
        console.error('Failed to create library:', error);
        this.notificationService.error('Library Creation Failed', 'Failed to create library. Please try again.');
      }
    });
  }

  onLibraryOpened(openLib: OpenLibrary) {
    this.libraryService.openLibrary(openLib.path).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Load videos for opened library
          this.loadLibraries(); // Refresh libraries list
        }
      },
      error: (error) => {
        console.error('Failed to open library:', error);
        const message = error.error?.error || 'Failed to open library. Make sure the folder contains a .library.db file.';
        this.notificationService.error('Open Failed', message);
      }
    });
  }

  onFiltersChanged(filters: LibraryFilters) {
    this.currentFilters = filters;
    this.applyFilters();
  }

  applyFilters() {
    if (!this.currentFilters) {
      this.filteredWeeks.set(this.videoWeeks());
      return;
    }

    // Use backend FTS search for search queries
    if (this.currentFilters.searchQuery) {
      const query = this.currentFilters.searchQuery.trim();

      if (query) {
        // Call backend FTS search with searchIn filter and search options
        this.libraryService.searchVideos(query, this.currentFilters.searchIn, this.currentFilters.searchOptions).subscribe({
          next: (response) => {
            if (response.success && response.data) {
              // Group search results by date (same as library grouping)
              const searchResults = response.data;
              const weekMap = new Map<string, VideoItem[]>();
              const now = new Date();

              // Helper to get date key in YYYY-MM-DD format
              const getDateKey = (date: Date): string => {
                const year = date.getFullYear();
                const month = (date.getMonth() + 1).toString().padStart(2, '0');
                const day = date.getDate().toString().padStart(2, '0');
                return `${year}-${month}-${day}`;
              };

              // Group search results by their date
              searchResults.forEach(video => {
                let weekLabel: string;

                // Check if video should be in "New" section (recently processed or added)
                const processedDate = video.lastProcessedDate ? new Date(video.lastProcessedDate) : null;
                const processedHoursDiff = processedDate ? (now.getTime() - processedDate.getTime()) / (1000 * 60 * 60) : Infinity;
                const recentlyProcessed = processedHoursDiff <= 24;

                const addedDate = video.addedAt ? new Date(video.addedAt) : null;
                const addedHoursDiff = addedDate ? (now.getTime() - addedDate.getTime()) / (1000 * 60 * 60) : Infinity;
                const recentlyAdded = addedHoursDiff <= 24;

                if (recentlyProcessed || recentlyAdded) {
                  weekLabel = 'New';
                } else if (video.downloadDate) {
                  weekLabel = getDateKey(new Date(video.downloadDate));
                } else {
                  weekLabel = 'Unknown';
                }

                if (!weekMap.has(weekLabel)) {
                  weekMap.set(weekLabel, []);
                }
                weekMap.get(weekLabel)!.push(video);
              });

              // Convert map to VideoWeek array
              let filtered: VideoWeek[] = [];
              weekMap.forEach((videos, weekLabel) => {
                filtered.push({ weekLabel, videos });
              });

              // Sort by week label (New first, Unknown last, dates descending)
              filtered.sort((a, b) => {
                if (a.weekLabel === 'New') return -1;
                if (b.weekLabel === 'New') return 1;
                if (a.weekLabel === 'Unknown') return 1;
                if (b.weekLabel === 'Unknown') return -1;
                return b.weekLabel.localeCompare(a.weekLabel);
              });

              // Apply non-search filters to search results too
              filtered = this.filterService.applyFilters(filtered, this.currentFilters!);

              // Apply sorting
              this.filterService.sortVideos(filtered, this.currentFilters!);
              this.filteredWeeks.set(filtered);
            } else {
              this.filteredWeeks.set([]);
            }
          },
          error: (error) => {
            // A failed search must not present the whole library as if it
            // matched the query (fallback-audit critical #2). Empty results
            // + a surfaced error; the user can retry or clear the search.
            this.filteredWeeks.set([]);
            this.errorSurface.surfaceError('Search failed', error);
          }
        });
        return;
      }
    }

    // No search query - apply filters and sorting to all videos
    let weeks = this.videoWeeks().map(week => ({
      weekLabel: week.weekLabel,
      videos: [...week.videos]
    }));

    // Apply all filters via service
    weeks = this.filterService.applyFilters(weeks, this.currentFilters);

    // Apply sorting via service
    this.filterService.sortVideos(weeks, this.currentFilters);
    this.filteredWeeks.set(weeks);
  }

  onSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedCount.set(event.count);
    this.selectedVideoIds.set(event.ids);

    // Mirror into the shared SelectionStore so the shell toolbar (and, in
    // Phase 3, the inspector) can react. Read-only projection — this
    // component stays the selection owner.
    this.selectionStore.set(event.ids);

    // If preview modal is open and a single item is selected, update the preview
    if (this.previewModalOpen() && event.count === 1) {
      const itemId = Array.from(event.ids)[0];
      // Extract video ID from itemId format: "weekLabel|videoId"
      const videoId = itemId.split('|')[1];
      if (videoId) {
        // Rebuild previewItems from current filteredWeeks to ensure fresh data
        // This handles cases where the library was reloaded (e.g., after rename)
        this.refreshPreviewItems();
        this.previewSelectedId.set(videoId);
      }
    }
  }

  /**
   * Refresh previewItems from current filteredWeeks data
   * Called when selection changes while preview modal is open to ensure fresh data
   */
  private refreshPreviewItems(): void {
    const allVideos: VideoItem[] = [];
    this.filteredWeeks().forEach(week => {
      week.videos.forEach(v => {
        // Exclude queue items
        if (!v.id.startsWith('queue-')) {
          allVideos.push(v);
        }
      });
    });

    if (allVideos.length === 0) return;

    // Convert to PreviewItem format
    const previewItems: PreviewItem[] = allVideos.map(v => ({
      id: v.id,
      name: v.name,
      videoId: v.id,
      mediaType: v.mediaType || 'video/mp4'
    }));

    this.previewItems.set(previewItems);
  }

  onVideoAction(event: { action: string; videos: VideoItem[] }) {
    const { action, videos } = event;

    // Note: Queue items are now handled by queue-tab.component.ts directly
    // This method only handles library items
    const videosToProcess = videos;

    switch (action) {
      case 'viewDetails':
        // TODO: Open video details/metadata editor modal
        console.log('View details for:', videosToProcess[0]?.name);
        this.notificationService.info('Coming Soon', 'This feature will show video metadata, transcript, and analysis.');
        break;

      case 'addToNewTab':
        // Open new tab dialog directly in library page
        this.openNewTabDialog(videosToProcess.map(v => v.id));
        break;

      case 'addToTab':
        // This shouldn't be called directly anymore (submenu items handle it)
        console.warn('addToTab called without tab ID');
        break;

      case 'removeFromTab':
        // Remove from tab - only works when viewing tabs tab
        if (this.tabsTabComponent) {
          this.tabsTabComponent.removeVideosFromCurrentTab(videosToProcess.map(v => v.id));
        } else {
          console.warn('Cannot remove from tab - not on tabs view');
        }
        break;

      case 'analyze':
        this.analyzeVideos(videosToProcess);
        break;

      case 'analyzeWebpage':
        this.analyzeWebpages(videosToProcess);
        break;

      case 'moveToLibrary':
        // TODO: Open library selector dialog
        console.log('Move to library:', videosToProcess.map(v => v.name));
        this.notificationService.info('Coming Soon', 'This feature will open a dialog to select a target library.');
        break;

      case 'delete':
        this.deleteVideos(videosToProcess, 'everything');
        break;

      case 'openInEditor': {
        // Webpage archives should open in the default browser, not the editor
        const webpages = videosToProcess.filter(v => v.mediaType === 'webpage');
        const nonWebpages = videosToProcess.filter(v => v.mediaType !== 'webpage');
        for (const wp of webpages) {
          if (wp.filePath) {
            this.electronService.openInBrowser(wp.filePath);
          }
        }
        if (nonWebpages.length > 0) {
          this.openInEditor(nonWebpages);
        }
        break;
      }

      case 'reveal':
        // Reveal file in Finder/Explorer
        if (videosToProcess[0]?.filePath) {
          this.electronService.showInFolder(videosToProcess[0].filePath);
        }
        break;

      case 'open': {
        // Webpage archives open in default browser; everything else in default app
        const first = videosToProcess[0];
        if (first?.filePath) {
          if (first.mediaType === 'webpage') {
            this.electronService.openInBrowser(first.filePath);
          } else {
            this.electronService.openFile(first.filePath);
          }
        }
        break;
      }

      case 'configure':
      case 'process':
        // Reveal the inspector's Process config for the current selection,
        // respecting the user's sticky (last-used) steps.
        this.pipelinePresets.enableSteps([]);
        this.workspaceActions.revealProcessConfig();
        break;

      case 'viewTranscript':
        if (videosToProcess.length === 1) {
          const video = videosToProcess[0];
          if (video.hasTranscript) {
            // Navigate to video info page on the transcription tab
            this.router.navigate(['/video', video.id], { queryParams: { tab: 'transcription' } });
          } else {
            // No transcript yet — seed the Transcribe step and reveal Process.
            this.pipelinePresets.enableSteps(['transcribe']);
            this.workspaceActions.revealProcessConfig();
          }
        }
        break;

      case 'refreshThumbnail':
        this.refreshThumbnails(videosToProcess);
        break;

      default:
        // Check for delete:mode pattern
        if (action.startsWith('delete:')) {
          const mode = action.replace('delete:', '') as 'database-only' | 'file-only' | 'everything';
          this.deleteVideos(videosToProcess, mode);
        }
        // Check for addToTab:tabId pattern
        else if (action.startsWith('addToTab:')) {
          const tabId = action.replace('addToTab:', '');
          // Add videos to existing tab directly
          this.addVideosToTab(tabId, videosToProcess.map(v => v.id));
        }
        else {
          console.warn('Unknown video action:', action);
        }
    }
  }

  openInEditor(videos?: VideoItem | VideoItem[]) {
    // Normalize to array
    let videosToOpen: VideoItem[] = [];

    if (videos) {
      videosToOpen = Array.isArray(videos) ? videos : [videos];
    } else {
      // No videos passed, get from selection
      const selectedItemIds = this.selectedVideoIds();

      if (selectedItemIds.size === 0) {
        this.notificationService.warning('No Selection', 'Please select a video first');
        return;
      }

      // Get all available videos
      const allVideos: VideoItem[] = [];
      this.filteredWeeks().forEach(week => {
        allVideos.push(...week.videos);
      });
      this.videoWeeks().forEach(week => {
        week.videos.forEach(v => {
          if (!allVideos.find(existing => existing.id === v.id)) {
            allVideos.push(v);
          }
        });
      });

      // Find videos matching selected IDs
      for (const itemId of selectedItemIds) {
        const parts = itemId.split('|');
        const videoId = parts.length > 1 ? parts[1] : itemId;
        const video = allVideos.find(v => v.id === videoId) || allVideos.find(v => v.id === itemId);
        if (video) {
          videosToOpen.push(video);
        }
      }
    }

    if (videosToOpen.length === 0) {
      console.error('Could not find videos. Selected IDs:', Array.from(this.selectedVideoIds()));
      this.notificationService.error('Video Not Found', 'Could not find selected video(s)');
      return;
    }

    // Open editor - first video creates window, rest become tabs
    if (this.electronService.isElectron) {
      // Open all videos sequentially - Electron handles adding as tabs
      for (const video of videosToOpen) {
        this.electronService.openEditorWindow({
          videoId: video.id,
          videoPath: video.filePath,
          videoTitle: video.name
        });
      }
    } else {
      // Fallback for non-Electron: navigate to editor route with first video
      const firstVideo = videosToOpen[0];
      this.router.navigate(['/editor'], {
        state: {
          videoEditorData: {
            videoId: firstVideo.id,
            videoPath: firstVideo.filePath,
            videoTitle: firstVideo.name
          }
        }
      });
    }
  }

  viewMore() {
    const selectedItemIds = this.selectedVideoIds();

    if (selectedItemIds.size === 0) {
      this.notificationService.warning('No Selection', 'Please select a video first');
      return;
    }

    if (selectedItemIds.size !== 1) {
      this.notificationService.warning('Multiple Selection', 'Please select exactly one video to view details');
      return;
    }

    // Get the video ID from the itemId (format: "weekLabel|videoId")
    const itemId = Array.from(selectedItemIds)[0];
    const parts = itemId.split('|');
    const videoId = parts.length > 1 ? parts[1] : itemId;

    // Navigate to video info page
    this.router.navigate(['/video', videoId]);
  }

  /**
   * "Run Analysis" entry point. Instead of the old right-click modal, this now
   * seeds the inspector's Process config (analyze step, plus transcribe when any
   * selected video still lacks a transcript — the same auto-inject the modal
   * did) and reveals it. AI readiness is handled inside the card's "Set up AI…"
   * affordance, so we reveal even when AI isn't configured yet.
   */
  private analyzeVideos(videos: VideoItem[]) {
    if (videos.length === 0) return;
    this.revealProcessForAnalyze(videos);
  }

  private revealProcessForAnalyze(videos: VideoItem[]): void {
    const steps: PipelineStepType[] = ['ai-analyze'];
    // Any selected video without a transcript needs one first (modal parity).
    if (videos.some(v => v.hasTranscript !== true)) {
      steps.push('transcribe');
    }
    this.pipelinePresets.enableSteps(steps);
    this.workspaceActions.revealProcessConfig();
  }

  /**
   * Queue webpage items for AI title generation.
   * Reuses the user's configured default AI model (library-specific or global).
   */
  private async analyzeWebpages(videos: VideoItem[]) {
    const webpages = videos.filter(v => v.mediaType === 'webpage');
    if (webpages.length === 0) return;

    // Check if AI is configured before proceeding
    const setupStatus = this.aiSetupService.getSetupStatus();
    if (setupStatus.needsSetup) {
      this.pendingAnalysisVideos = webpages;
      this.aiWizardOpen.set(true);
      return;
    }

    // Resolve default AI model (library-specific first, then global)
    const { model: defaultModel, lookupFailed } = await this.resolveDefaultAiModel();

    if (!defaultModel) {
      if (lookupFailed) {
        this.errorSurface.surfaceError(
          "Couldn't look up your default AI model — try again",
          new Error('default-ai-model lookup failed')
        );
      } else {
        this.notificationService.error(
          'No AI Model Configured',
          'Please select a default AI model in Settings or via the video config dialog first.'
        );
      }
      return;
    }

    // Clear selection
    if (this.cascadeComponent) {
      this.cascadeComponent.clearSelection();
    }

    // Create one queue job per webpage
    for (const webpage of webpages) {
      const task = createQueueTask('analyze-webpage', { aiModel: defaultModel });
      this.queueService.addJob({
        videoId: webpage.id,
        title: webpage.name,
        thumbnail: webpage.thumbnailUrl,
        tasks: [task],
        titleResolved: true
      });
    }

    // Switch to Queue tab to show staging items
    this.setActiveTab('queue');
  }

  private deleteVideos(videos: VideoItem[], mode: 'database-only' | 'file-only' | 'everything' = 'everything') {
    if (videos.length === 0) return;

    // Delete each video
    let deletedCount = 0;
    const idsToRemove: string[] = [];

    videos.forEach(video => {
      this.libraryService.deleteVideo(video.id, mode).subscribe({
        next: (response) => {
          if (response.success) {
            deletedCount++;
            idsToRemove.push(video.id);

            // When all deletions complete, update the display
            if (deletedCount === videos.length) {
              if (this.cascadeComponent) {
                this.cascadeComponent.removeVideosFromDisplay(idsToRemove);
              }
              // Also reload to ensure sync
              this.loadLibrary();
            }
          }
        },
        error: (error) => {
          console.error('Failed to delete video:', video.name, error);
          this.notificationService.error('Delete Failed', `Failed to delete: ${video.name}`);
        }
      });
    });
  }

  /**
   * Queue a composed pipeline (from the shell's Process popover) for every
   * selected library video: one job per video, tasks in step order. Replaces
   * the old defaults-based "Add to Queue" — the user now picks the exact
   * steps per selection.
   */
  private async processSelection(
    steps: PipelineStep[],
    opts?: { onlyMissingTranscript?: boolean }
  ) {
    const selected = this.getSelectedLibraryVideos();
    if (selected.length === 0 || steps.length === 0) {
      this.notificationService.warning('Nothing to Process', 'Select at least one video and one step');
      return;
    }

    // All pipeline steps are video/audio operations — filter out documents,
    // images, and webpages (same rule as analyzeVideos).
    let videos = selected.filter(v => this.isProcessableVideo(v));

    // Transcribe-only convenience path: skip items that already have one.
    if (opts?.onlyMissingTranscript) {
      const already = videos.filter(v => v.hasTranscript === true).length;
      videos = videos.filter(v => v.hasTranscript !== true);
      if (videos.length === 0) {
        this.notificationService.info('Already Transcribed', 'All selected videos already have transcripts');
        return;
      }
      if (already > 0) {
        this.notificationService.info(
          'Some Skipped',
          `${already} already-transcribed video${already === 1 ? ' was' : 's were'} skipped`
        );
      }
    }

    if (videos.length === 0) {
      this.notificationService.error(
        'No Videos Selected',
        'Processing steps only work on video files. Please select at least one video.'
      );
      return;
    }
    if (videos.length < selected.length) {
      const skipped = selected.length - videos.length;
      this.notificationService.warning(
        'Non-video Files Excluded',
        `${skipped} item${skipped !== 1 ? 's' : ''} (documents/images/webpages) can't be processed and ${skipped !== 1 ? 'were' : 'was'} skipped.`
      );
    }

    // The AI step runs with the user's default model unless one was chosen.
    let finalSteps = steps;
    const aiStep = steps.find(s => s.type === 'ai-analyze');
    if (aiStep && !aiStep.config['aiModel']) {
      const { model: defaultModel, lookupFailed } = await this.resolveDefaultAiModel();
      if (!defaultModel) {
        if (lookupFailed) {
          this.errorSurface.surfaceError(
            "Couldn't look up your default AI model — try again",
            new Error('default-ai-model lookup failed')
          );
        } else {
          this.notificationService.error(
            'No AI Model Configured',
            'Pick a default AI model in Settings → AI, then try again.'
          );
        }
        return;
      }
      finalSteps = steps.map(s =>
        s.type === 'ai-analyze' ? { ...s, config: { ...s.config, aiModel: defaultModel } } : s
      );
    }

    const createdJobIds = videos.map(video =>
      this.queueService.addJob({
        title: video.name,
        videoId: video.id,
        duration: video.duration,
        thumbnail: video.thumbnailUrl,
        tasks: finalSteps.map(s => createQueueTask(s.type, { ...s.config })),
        titleResolved: true
      }).id
    );

    // Staging-first: adding to the queue NEVER auto-runs. The user starts jobs
    // explicitly from the queue page's Start button (processStagingItems →
    // submitJobs is the one and only submit trigger). The toast reflects exactly
    // what happened — items were staged, not started.
    const count = createdJobIds.length;
    this.notificationService.success(
      'Added to Queue',
      `${count} ${count === 1 ? 'video' : 'videos'} added to the queue`
    );

    this.setActiveTab('queue');
    if (this.cascadeComponent) {
      this.cascadeComponent.clearSelection();
    }
  }

  /**
   * Queue-page inspector Save: rewrite the pipeline steps + trim of already-
   * staged (pending) jobs in place. Non-pipeline tasks (download-import,
   * export-clip, …) are preserved in their original order; only the four
   * pipeline steps are replaced by the edited ones. Reports what actually
   * applied — a job that left the pending set in the meantime is skipped, not
   * faked as updated.
   */
  private updatePendingJobs(
    jobIds: string[],
    steps: PipelineStep[],
    trimStartSeconds: number | null,
    trimEndSeconds: number | null
  ) {
    const pipelineTypes = new Set<string>(PIPELINE_STEPS.map(s => s.type));
    let updated = 0;
    for (const jobId of jobIds) {
      const job = this.queueService.allJobs().find(j => j.id === jobId && j.state === 'pending');
      if (!job) continue;
      const preserved = job.tasks.filter(t => !pipelineTypes.has(t.type));
      const pipelineTasks = steps.map(s => createQueueTask(s.type, { ...s.config }));
      this.queueService.updateJobTasks(jobId, [...preserved, ...pipelineTasks]);
      this.queueService.updateJobTrim(
        jobId,
        trimStartSeconds && trimStartSeconds > 0 ? trimStartSeconds : undefined,
        trimEndSeconds && trimEndSeconds > 0 ? trimEndSeconds : undefined
      );
      updated++;
    }

    if (updated > 0) {
      this.notificationService.success(
        'Queue Updated',
        `Updated ${updated} pending item${updated === 1 ? '' : 's'}`
      );
    } else {
      this.notificationService.info(
        'Nothing Updated',
        'Those items are no longer pending in the queue'
      );
    }
  }

  /**
   * Build a single pipeline step seeded from the user's sticky Process
   * options (last-used), falling back to the step's defaults.
   */
  private stepFromStickyOptions(type: PipelineStepType): PipelineStep {
    const def = PIPELINE_STEPS.find(d => d.type === type);
    const remembered = this.pipelinePresets.lastSteps().find(s => s.type === type);
    return { type, config: { ...(def?.defaultConfig ?? {}), ...(remembered?.config ?? {}) } };
  }

  /** True for items the processing pipeline can operate on (video/audio). */
  private isProcessableVideo(video: VideoItem): boolean {
    const mediaType = video.mediaType?.toLowerCase() || '';
    const ext = video.fileExtension?.toLowerCase() || '';
    const fileName = video.name?.toLowerCase() || '';
    const nonVideoExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.doc', '.docx', '.txt', '.md'];
    const isNonVideo =
      mediaType === 'webpage' ||
      mediaType.startsWith('image/') ||
      mediaType === 'application/pdf' ||
      nonVideoExtensions.some(e => ext === e || fileName.endsWith(e));
    return !isNonVideo;
  }

  /**
   * Resolve the default AI model: library-specific first, then global.
   * Shared by the Process pipeline and webpage analysis.
   */
  /**
   * Resolve the default AI model: library-specific first, then global.
   * `lookupFailed` distinguishes "the lookup errored" from "genuinely no
   * default configured" — a transient fetch failure must not tell the user
   * they haven't configured anything (fallback-audit discuss #24).
   */
  private async resolveDefaultAiModel(): Promise<{ model: string | null; lookupFailed: boolean }> {
    // Prefer the model the user last chose (persisted as `provider:model` by
    // PipelinePresetsService; a picker validated it as installed when written).
    // Kept FIRST so the empty-picker downstream injection AND webpage analysis
    // honor last-used, matching the inspector's Process picker. No installed-
    // model list is available here, so we can't re-validate against the current
    // session — that's intentional: the backend fails loudly if the model is
    // gone, which is correct behavior over silently overriding the user's pick.
    // The library/server defaults below remain the legitimate first-run state.
    const remembered = this.pipelinePresets.lastChosenAiModel();
    if (remembered) return { model: remembered, lookupFailed: false };

    let lookupFailed = false;
    try {
      const libResponse = await firstValueFrom(
        this.http.get<{ success: boolean; aiModel: string | null }>(
          `${getApiBase()}/database/libraries/default-ai-model`
        )
      );
      if (libResponse?.aiModel) return { model: libResponse.aiModel, lookupFailed: false };
    } catch (error) {
      console.error('Failed to fetch library default AI model:', error);
      lookupFailed = true;
    }
    try {
      const configResponse = await firstValueFrom(
        this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
          `${getApiBase()}/config/default-ai`
        )
      );
      if (configResponse?.defaultAI) {
        return {
          model: `${configResponse.defaultAI.provider}:${configResponse.defaultAI.model}`,
          lookupFailed: false
        };
      }
    } catch (error) {
      console.error('Failed to fetch global default AI model:', error);
      lookupFailed = true;
    }
    return { model: null, lookupFailed };
  }

  /**
   * Resolve the current selection ("weekLabel|videoId" item ids) to library
   * VideoItems, skipping queue/staging rows. Shared by the shell-toolbar
   * actions (transcribe/analyze).
   */
  /**
   * Flattened, deduped library items (filtered + unfiltered weeks).
   * Shared by selection resolution and the shell inspector's item lookup.
   */
  allLibraryItems = computed<VideoItem[]>(() => {
    const allVideos: VideoItem[] = [];
    this.filteredWeeks().forEach(week => allVideos.push(...week.videos));
    this.videoWeeks().forEach(week => {
      week.videos.forEach(v => {
        if (!allVideos.find(existing => existing.id === v.id)) {
          allVideos.push(v);
        }
      });
    });
    return allVideos;
  });

  private getSelectedLibraryVideos(): VideoItem[] {
    const allVideos = this.allLibraryItems();

    const videos: VideoItem[] = [];
    const seen = new Set<string>();
    for (const itemId of this.selectedVideoIds()) {
      const parts = itemId.split('|');
      const videoId = parts.length > 1 ? parts[1] : itemId;
      if (videoId.startsWith('queue-') || videoId.startsWith('staging-') || seen.has(videoId)) {
        continue;
      }
      const video = allVideos.find(v => v.id === videoId) || allVideos.find(v => v.id === itemId);
      if (video) {
        seen.add(videoId);
        videos.push(video);
      }
    }
    return videos;
  }

  /**
   * One-click transcribe for the current selection (shell toolbar).
   * Transcription is first-class and never gated on AI setup: jobs are queued
   * immediately with a single transcribe task, skipping items that already
   * have a transcript.
   */
  /**
   * Transcribe the selection (inspector Run / batch action): exactly a
   * single-step Process pipeline — one code path, honoring the user's
   * sticky whisper model/language options. Auto-submits.
   */
  transcribeSelected() {
    void this.processSelection([this.stepFromStickyOptions('transcribe')], {
      onlyMissingTranscript: true
    });
  }

  /**
   * Analyze the selection (inspector Run / batch action): a single-step
   * Process pipeline queued directly with the default AI model + sticky
   * options — no config modal. The old modal stays reachable from
   * queue-item Advanced config only.
   */
  analyzeSelected() {
    void this.processSelection([this.stepFromStickyOptions('ai-analyze')]);
  }

  // Configure selected queue items
  onConfigureSelected() {
    const selectedIds = Array.from(this.selectedVideoIds());
    const queueItemIds = selectedIds.filter(id =>
      id.includes('queue-') || id.endsWith('|queue-')
    );

    if (queueItemIds.length > 0) {
      this.openConfigModal(queueItemIds);
    }
  }

  // Check if selection includes queue items
  get hasQueueItemsSelected(): boolean {
    return Array.from(this.selectedVideoIds()).some(id =>
      id.includes('queue-')
    );
  }

  // Handle configure button click from cascade
  onConfigureItem(video: VideoItem) {
    // Open config modal for this single queue item
    this.openConfigModal([video.id]);
  }

  // ========================================
  // Video Preview Modal Methods
  // ========================================

  /**
   * Toggle preview modal for a video (triggered by spacebar on highlighted item)
   */
  onPreviewRequested(video: VideoItem) {
    // If modal is already open, close it
    if (this.previewModalOpen()) {
      this.previewModalOpen.set(false);
      return;
    }

    // Check if this is a queue item with a videoId
    const isQueueItem = video.id.startsWith('queue-') || video.id.startsWith('staging-') ||
                        video.id.startsWith('processing-') || video.id.startsWith('completed-');

    if (isQueueItem) {
      // For queue items, only allow preview if they have a videoId (video has been downloaded)
      if (!video.videoId) {
        return;
      }

      // Create a single preview item for the queue video
      const previewItems: PreviewItem[] = [{
        id: video.id,
        name: video.name,
        videoId: video.videoId,
        mediaType: video.mediaType || 'video/mp4'
      }];

      this.previewItems.set(previewItems);
      this.previewSelectedId.set(video.videoId);
      this.previewModalOpen.set(true);
      return;
    }

    // Build list of all non-queue videos for navigation
    const allVideos: VideoItem[] = [];
    this.filteredWeeks().forEach(week => {
      week.videos.forEach(v => {
        if (!v.id.startsWith('queue-')) {
          allVideos.push(v);
        }
      });
    });

    if (allVideos.length === 0) return;

    // Convert to PreviewItem format
    const previewItems: PreviewItem[] = allVideos.map(v => ({
      id: v.id,
      name: v.name,
      videoId: v.id,
      mediaType: v.mediaType || 'video/mp4' // Default to video if not specified
    }));

    this.previewItems.set(previewItems);
    // Use videoId for completed queue items (which have prefixed display IDs like "completed-xxx")
    // but store the actual video ID for lookup
    this.previewSelectedId.set(video.videoId || video.id);
    this.previewModalOpen.set(true);
  }

  /**
   * Handle preview modal closed
   */
  onPreviewModalClosed() {
    this.previewModalOpen.set(false);
  }

  /**
   * Handle selection change from preview modal (arrow keys in modal)
   */
  onPreviewSelectionChanged(videoId: string) {
    // Update the preview modal's selected ID
    this.previewSelectedId.set(videoId);

    // Update cascade's selection and scroll to the item
    if (this.cascadeComponent) {
      this.cascadeComponent.highlightAndScrollToVideoId(videoId);
    }
  }

  /**
   * Open a specific connected item in Scout (inspector "Open"). Resolves the id
   * against the same library-items snapshot that feeds the inspector; an
   * unresolved id surfaces an honest error rather than a silent no-op.
   */
  private openConnectedInEditor(videoId: string): void {
    const item = this.allLibraryItems().find(v => v.id === videoId);
    if (!item) {
      this.notificationService.error(
        'Video Not Found',
        'Could not open this connected item — it is no longer in this library.'
      );
      return;
    }
    this.openInEditor([item]);
  }

  /**
   * Reveal a specific item in the library cascade (inspector "Locate").
   *
   * Fast path: if it's in the current view the cascade scrolls to it (expanding
   * a collapsed week itself). Otherwise, if it's not in this library at all,
   * surface an honest toast; if it's merely hidden by the active search/type
   * filter, relax both (only what can hide it) and retry once the cascade has
   * re-rendered — mirroring onViewInLibrary's post-filter scroll sequencing.
   */
  private locateVideo(videoId: string): void {
    const cascade = this.cascadeComponent;
    if (!cascade) return;

    if (cascade.highlightAndScrollToVideoId(videoId)) {
      return; // already in view (collapsed weeks handled inside the cascade)
    }

    if (!this.allLibraryItems().some(v => v.id === videoId)) {
      this.notificationService.warning(
        'Not in this library',
        'This connected item lives in a different library.'
      );
      return;
    }

    // Hidden by search and/or the type filter — relax both, then retry.
    this.searchFilters?.clearFilters();
    this.typeFilter.set('all');
    setTimeout(() => {
      this.cascadeComponent?.highlightAndScrollToVideoId(videoId);
    }, 100);
  }

  // ========================================
  // Processing Queue UI Methods
  // ========================================

  toggleQueueExpanded() {
    this.queueExpanded.update(v => !v);
  }

  isQueueItemSelected(id: string): boolean {
    return this.selectedQueueItems().has(id);
  }

  selectQueueItem(id: string, event: MouseEvent) {
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey) {
      const selected = new Set(this.selectedQueueItems());
      if (selected.has(id)) {
        selected.delete(id);
      } else {
        selected.add(id);
      }
      this.selectedQueueItems.set(selected);
    } else {
      this.selectedQueueItems.set(new Set([id]));
    }
  }

  onQueueContextMenu(item: ProcessingQueueItem, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    // For now, just select the item
    this.selectedQueueItems.set(new Set([item.id]));
  }

  toggleQueueItemExpanded(id: string, event: Event) {
    event.stopPropagation();
    const expanded = new Set(this.expandedQueueItems());
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    this.expandedQueueItems.set(expanded);
  }

  isQueueItemExpanded(id: string): boolean {
    return this.expandedQueueItems().has(id);
  }

  getQueueItemStatus(item: ProcessingQueueItem): string {
    switch (item.status) {
      case 'loading': return 'Loading...';
      case 'pending': return 'Not yet downloaded';
      case 'processing':
        const runningTask = item.tasks.find(t => t.status === 'running');
        return runningTask ? `Processing: ${this.getTaskLabel(runningTask.type)}` : 'Processing...';
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      default: return 'Pending';
    }
  }

  onConfigureQueueItem(item: ProcessingQueueItem, event: Event) {
    event.stopPropagation();
    this.openConfigModal([item.id]);
  }

  getQueueItemProgress(item: ProcessingQueueItem): number {
    if (item.tasks.length === 0) return 0;
    const totalProgress = item.tasks.reduce((sum, task) => sum + task.progress, 0);
    return Math.round(totalProgress / item.tasks.length);
  }

  getTaskIcon(status: string): string {
    switch (status) {
      case 'completed': return '✓';
      case 'running': return '⟳';
      case 'failed': return '✗';
      default: return '○';
    }
  }

  getTaskLabel(type: TaskType): string {
    const taskInfo = AVAILABLE_TASKS.find(t => t.type === type);
    return taskInfo?.label || type;
  }

  // ========================================
  // File Import Methods
  // ========================================

  /**
   * Check if a library is selected, if not open the library manager
   * Returns true if a library is available, false if library manager was opened
   */
  private requireLibrary(): boolean {
    if (!this.currentLibrary()) {
      this.notificationService.info(
        'Library Required',
        'Please create or select a library first'
      );
      this.openLibraryManager();
      return false;
    }
    return true;
  }

  /**
   * Open download dialog for adding videos from URLs
   */
  openDownloadDialog() {
    if (!this.requireLibrary()) return;
    this.downloadDialogOpen.set(true);
  }

  /**
   * Handle download dialog submission - add to staging instantly, then fetch video info asynchronously
   * Now uses QueueService as single source of truth
   */
  async onDownloadSubmit(items: AddDownloadsPayload['items']) {
    this.downloadDialogOpen.set(false);

    const addedJobs: QueueJob[] = [];

    // Add all items to QueueService IMMEDIATELY with placeholder titles
    for (const item of items) {
      // A URL download always begins with download-import (quality rides its
      // options → yt-dlp height cap; 'best'/absent keeps the per-site default).
      // The Add popover's fully-composed pipeline steps follow verbatim, so every
      // option survives — translate, granularity, stripBlackBars,
      // customInstructions — that the old lossy settings→tasks conversion dropped.
      const downloadOptions: Record<string, unknown> =
        item.quality && item.quality !== 'best' ? { quality: item.quality } : {};
      const tasks: QueueTask[] = [
        createQueueTask('download-import', downloadOptions),
        ...item.steps.map(step => createQueueTask(step.type, { ...step.config })),
      ];

      // Add job to QueueService. Per-batch trim amounts (from the Add popover)
      // ride in-band on the job as trimStartTime/trimEndTime; the dispatch-time
      // export-clip conversion (queue.service convertTasksToBackendFormat) then
      // cuts them post-download against the file's real duration.
      const job = this.queueService.addJob({
        url: item.url,
        title: item.name || 'Building title...',
        titleResolved: false,
        tasks,
        trimStartTime: item.trimStartSeconds && item.trimStartSeconds > 0 ? item.trimStartSeconds : undefined,
        trimEndTime: item.trimEndSeconds && item.trimEndSeconds > 0 ? item.trimEndSeconds : undefined
      });

      addedJobs.push(job);
    }

    // Show notification and switch to queue tab IMMEDIATELY
    this.notificationService.success(
      'Videos Added to Staging',
      `Added ${items.length} ${items.length === 1 ? 'video' : 'videos'} to staging queue. Building titles...`
    );

    // Switch to Queue tab immediately
    this.setActiveTab('queue');

    // Now fetch video info asynchronously in the background for each item
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const job = addedJobs[i];

      console.log(`[FETCH INFO] Starting fetch for job ${job.id}: ${item.url}`);

      // Fetch in background (don't await - let them all run in parallel)
      this.http.get<any>(`${getApiBase()}/downloader/info?url=${encodeURIComponent(item.url)}`)
        .subscribe({
          next: (response) => {
            console.log(`[FETCH INFO] Response for job ${job.id}:`, response);

            if (response && response.title) {
              // Update job via QueueService
              this.queueService.updateJobByUrl(item.url, {
                title: response.title,
                duration: this.formatDurationFromSeconds(response.duration),
                thumbnail: response.thumbnail,
                titleResolved: true
              });

              console.log(`[TITLE RESOLVED] job ${job.id}: ${response.title}`);
            } else {
              console.error('[FETCH INFO] No title in response for:', item.url, response);
              this.queueService.updateJobByUrl(item.url, {
                title: 'Failed to load',
                titleResolved: false
              });
            }
          },
          error: (error) => {
            console.error('[FETCH INFO] Failed to fetch video info for:', item.url, error);
            this.queueService.updateJobByUrl(item.url, {
              title: 'Failed to load',
              titleResolved: false
            });
          }
        });
    }
  }

  /**
   * Legacy "Advanced…" download dialog submit. That dialog still emits a
   * VideoJobSettings bag; adapt it to the unified steps-based path (quality +
   * pipeline steps) so both add surfaces stage jobs through one code path. The
   * produced tasks are identical to the old settings→tasks conversion — this is
   * a shape adapter, not a behavior change.
   */
  onAdvancedDownloadSubmit(items: { url: string; name: string; settings: VideoJobSettings }[]): void {
    const adapted: AddDownloadsPayload['items'] = items.map(item => ({
      url: item.url,
      name: item.name,
      quality: item.settings.downloadQuality ?? 'best',
      steps: this.settingsToSteps(item.settings),
    }));
    void this.onDownloadSubmit(adapted);
  }

  /**
   * Reconstruct the pipeline steps a VideoJobSettings bag implies, matching the
   * exact task options the removed convertSettingsToQueueTasks produced (the
   * legacy ai-analyze carries analysisQuality, not analysisGranularity).
   */
  private settingsToSteps(settings: VideoJobSettings): PipelineStep[] {
    const steps: PipelineStep[] = [];
    if (settings.fixAspectRatio) {
      steps.push({ type: 'fix-aspect-ratio', config: { targetRatio: settings.aspectRatio || '16:9' } });
    }
    if (settings.normalizeAudio) {
      steps.push({ type: 'normalize-audio', config: { targetLevel: settings.audioLevel || -16 } });
    }
    if (settings.transcribe) {
      steps.push({ type: 'transcribe', config: { model: settings.whisperModel || 'base', language: settings.whisperLanguage } });
    }
    if (settings.aiAnalysis) {
      steps.push({
        type: 'ai-analyze',
        config: {
          aiModel: settings.aiModel,
          customInstructions: settings.customInstructions,
          analysisQuality: settings.analysisQuality,
        },
      });
    }
    return steps;
  }

  /**
   * Format duration from seconds to hh:mm:ss
   */
  private formatDurationFromSeconds(seconds: number): string {
    if (!seconds || seconds <= 0) return '00:00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Close download dialog
   */
  onDownloadDialogClosed() {
    this.downloadDialogOpen.set(false);
  }

  /**
   * Handle webpage capture from download dialog
   */
  async onCaptureWebpage(urls: string[]) {
    this.downloadDialogOpen.set(false);
    this.setActiveTab('archives');

    for (const url of urls) {
      const result = await this.webArchiveService.captureUrl(url);
      if (result.success) {
        this.notificationService.success('Archived', url);
      } else {
        this.notificationService.error('Archive Failed', result.error || 'Unknown error');
      }
    }

    // Refresh library to show new files
    this.loadLibrary();
  }

  /**
   * Open file picker dialog for importing media files using Electron IPC
   */
  async openImportDialog() {
    if (!this.requireLibrary()) return;
    const filePaths = await this.fileImportService.openFileDialog();
    if (filePaths && filePaths.length > 0) {
      await this.fileImportService.importFilesByPath(filePaths, () => this.loadLibrary());
    }
  }

  /**
   * Handle file drop event
   */
  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);

    if (!this.requireLibrary()) return;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);
    const filePaths = await this.fileImportService.getFilePathsFromFiles(fileArray);

    if (filePaths.length > 0) {
      console.log('Importing dropped files:', filePaths);
      await this.fileImportService.importFilesByPath(filePaths, () => this.loadLibrary());
    } else {
      console.error('Could not get file paths from dropped files');
    }
  }

  /**
   * Handle drag over event
   */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(true);
  }

  /**
   * Handle drag leave event
   */
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);
  }

  /**
   * Navigate to a workspace section. The URL is the source of truth: this
   * pushes the route, and the route.data subscription applies the section.
   * Existing call-sites keep working unchanged.
   */
  setActiveTab(tab: 'library' | 'queue' | 'tabs' | 'archives') {
    const urls: Record<string, string> = {
      library: '/library',
      queue: '/queue',
      tabs: '/collections',
      archives: '/archives',
    };
    this.router.navigate([urls[tab]]);
  }

  /**
   * Apply a section to the view (called by the route.data subscription).
   */
  private applySection(tab: 'library' | 'queue' | 'tabs' | 'archives') {
    this.activeTab.set(tab);
    if (tab === 'queue') {
      // Always refresh from backend so newly-submitted jobs (e.g. export-clip)
      // are visible immediately, even if they were submitted from a popout window
      this.queueService.refreshFromBackend();
      console.log('[LibraryPage] Switching to Queue tab');
      console.log('[LibraryPage] Staging queue:', this.stagingQueue());
      console.log('[LibraryPage] Processing queue:', this.processingQueue());
    } else {
      // Leaving the queue: drop the queue selection so the inspector reverts to
      // the library branch (the queue-tab also clears on destroy, belt-and-braces).
      this.queueSelection.clear();
    }

    // Auto-start tour for this tab if user hasn't seen it (desktop only — the
    // tour is anchored to desktop chrome and just gets in the way on a phone).
    // Use longer delay (800ms) to ensure Angular has rendered the new tab content
    if (!this.isWeb) {
      this.tourService.tryAutoStartTour(tab, 800);
    }
  }

  // ========================================
  // Queue Tab Action Handlers
  // ========================================

  /**
   * Process all staging items - move to processing queue and send to backend
   */
  onQueueProcessAll() {
    const staging = this.stagingQueue();
    if (staging.length === 0) return;

    this.processStagingItems(staging.map(item => item.id));
  }

  /**
   * Process selected staging items
   */
  onQueueProcessSelected(itemIds: string[]) {
    if (itemIds.length === 0) return;
    this.processStagingItems(itemIds);
  }

  /**
   * Move staging items to processing queue and send to backend
   * Waits for titles to be resolved before processing
   */
  private async processStagingItems(itemIds: string[]) {
    const staging = this.stagingQueue();

    // Find items to process
    const itemsToProcess = staging.filter(item => itemIds.includes(item.id));
    if (itemsToProcess.length === 0) return;

    // Check if any items don't have resolved titles
    const unresolvedItems = itemsToProcess.filter(item => !item.titleResolved);

    if (unresolvedItems.length > 0) {
      // Show notification that we're waiting for titles
      this.notificationService.info(
        'Building Titles',
        `Waiting for ${unresolvedItems.length} ${unresolvedItems.length === 1 ? 'title' : 'titles'} to be built before processing...`
      );

      // Wait for all titles to be resolved (poll every 500ms, max 60 seconds)
      const maxWaitTime = 60000; // 60 seconds
      const pollInterval = 500; // 500ms
      let elapsedTime = 0;

      while (elapsedTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;

        // Check if all items now have resolved titles
        const currentStaging = this.stagingQueue();
        const currentItemsToProcess = currentStaging.filter(item => itemIds.includes(item.id));
        const stillUnresolved = currentItemsToProcess.filter(item => !item.titleResolved);

        if (stillUnresolved.length === 0) {
          // All titles resolved!
          break;
        }
      }

      // Check one final time
      const finalStaging = this.stagingQueue();
      const finalUnresolved = finalStaging
        .filter(item => itemIds.includes(item.id))
        .filter(item => !item.titleResolved);

      if (finalUnresolved.length > 0) {
        this.notificationService.error(
          'Title Building Timeout',
          `Failed to build ${finalUnresolved.length} ${finalUnresolved.length === 1 ? 'title' : 'titles'}. Please try again.`
        );
        return;
      }
    }

    // Submit exactly the requested jobs to the backend via QueueService —
    // "Start N" must never sweep along pending items the user parked.
    // QueueService handles state transitions and WebSocket updates.
    this.queueService.submitJobs(itemIds).subscribe({
      next: ({ jobIdMap, warnings }) => {
        const count = jobIdMap.size;
        if (count > 0) {
          this.notificationService.success(
            'Processing Started',
            `Started processing ${count} ${count === 1 ? 'item' : 'items'}`
          );
        }
        // Show explicit warnings for skipped tasks (e.g. AI analysis with no model)
        for (const warning of warnings) {
          this.notificationService.warning('Task Skipped', warning);
        }
      },
      error: (error) => {
        console.error('[ProcessStagingItems] Failed to start processing:', error);
        this.notificationService.error(
          'Processing Failed',
          error.message || 'Failed to start processing. Please try again.'
        );
      }
    });
  }

  /**
   * Configure selected staging (pending) items. The pending-item config now
   * lives in the queue-page inspector, not the modal — so just make the
   * requested items the queue selection and the inspector shows their per-job
   * config. (The modal is retained only for PROCESSING/in-flight items via
   * openConfigModal / onConfigureQueueItem.)
   */
  onQueueConfigureSelected(itemIds: string[]) {
    if (itemIds.length === 0) return;
    const pendingIds = new Set(this.queueService.pendingJobs().map(j => j.id));
    const ids = itemIds.filter(id => pendingIds.has(id));
    if (ids.length === 0) return;
    this.queueSelection.set(ids);
  }

  /**
   * Remove selected staging items
   */
  onQueueRemoveSelected(itemIds: string[]) {
    // Only report what actually got removed — non-staging selections (completed
    // rows, stale ids) match no job, so never fake a "Removed N" success toast.
    const existingIds = new Set(this.queueService.allJobs().map(job => job.id));
    const removedIds = itemIds.filter(id => existingIds.has(id));
    removedIds.forEach(id => this.queueService.removeJob(id));

    if (removedIds.length === 0) {
      this.notificationService.info(
        'Nothing Removed',
        'No staging items were selected to remove'
      );
      return;
    }

    this.notificationService.success(
      'Items Removed',
      `Removed ${removedIds.length} ${removedIds.length === 1 ? 'item' : 'items'} from staging queue`
    );
  }

  /**
   * Cancel processing items
   */
  onCancelProcessing(itemIds: string[]) {
    if (itemIds.length === 0) return;

    // Use QueueService to properly cancel jobs (handles ID translation and cleanup)
    this.queueService.cancelJobs(itemIds);

    this.notificationService.success(
      'Processing Cancelled',
      `Cancelled ${itemIds.length} ${itemIds.length === 1 ? 'item' : 'items'}`
    );
  }

  /**
   * View item in library
   */
  onViewInLibrary(itemId: string) {
    // Find the processing item
    const processingItem = this.processingQueue().find(item => item.id === itemId);
    if (!processingItem?.videoId) {
      this.notificationService.warning(
        'Not Available',
        'This item has not been added to the library yet'
      );
      return;
    }

    // Switch to library tab
    this.setActiveTab('library');

    // Scroll to and highlight the video in the library
    // Wait for tab switch and cascade to render
    setTimeout(() => {
      if (this.cascadeComponent) {
        this.cascadeComponent.highlightAndScrollToVideoId(processingItem.videoId!);
      }
    }, 100);
  }

  /**
   * Open the video editor (Scout) to view analysis for a completed item
   */
  onViewAnalysis(itemId: string) {
    // Find the item in the completed queue
    const completedItem = this.completedQueue().find(item => item.id === itemId);
    if (!completedItem?.videoId) {
      this.notificationService.warning(
        'Not Available',
        'This item does not have an associated video'
      );
      return;
    }

    // Find the video in the library to get full details
    const allVideos = this.videoWeeks().flatMap(w => w.videos);
    const video = allVideos.find(v => v.id === completedItem.videoId);

    if (!video) {
      // Try to open with just the videoId - the editor can load data by ID
      if (this.electronService.isElectron) {
        this.electronService.openEditorWindow({
          videoId: completedItem.videoId,
          videoPath: undefined,
          videoTitle: completedItem.title
        });
      } else {
        this.router.navigate(['/editor'], {
          state: {
            videoEditorData: {
              videoId: completedItem.videoId,
              videoPath: undefined,
              videoTitle: completedItem.title
            }
          }
        });
      }
      return;
    }

    // Open editor with full video details
    if (this.electronService.isElectron) {
      this.electronService.openEditorWindow({
        videoId: video.id,
        videoPath: video.filePath,
        videoTitle: video.name
      });
    } else {
      this.router.navigate(['/editor'], {
        state: {
          videoEditorData: {
            videoId: video.id,
            videoPath: video.filePath,
            videoTitle: video.name
          }
        }
      });
    }
  }

  /**
   * Clear all items from the completed queue
   */
  onClearCompleted() {
    this.queueService.clearCompleted();
  }

  // ========================================
  // Trim Opener Modal Methods
  // ========================================

  onTrimOpenerRequested(video: VideoItem) {
    // Extract job ID from staging-{id} format
    const jobId = video.id.replace('staging-', '');
    const job = this.queueService.allJobs().find(j => j.id === jobId);
    if (!job) return;

    this.trimModalJobId.set(jobId);
    this.trimModalVideoTitle.set(job.title);
    this.trimModalInitialTime.set(job.trimStartTime || 0);
    this.trimModalInitialEndTime.set(job.trimEndTime || 0);
    this.trimModalOpen.set(true);
  }

  onTrimSaved(value: { start: number; end: number }) {
    const jobId = this.trimModalJobId();
    if (jobId) {
      this.queueService.updateJobTrim(
        jobId,
        value.start > 0 ? value.start : undefined,
        value.end > 0 ? value.end : undefined
      );
    }
    this.trimModalOpen.set(false);
    this.trimModalJobId.set(null);
  }

  onTrimCleared() {
    const jobId = this.trimModalJobId();
    if (jobId) {
      this.queueService.updateJobTrim(jobId, undefined, undefined);
    }
    this.trimModalOpen.set(false);
    this.trimModalJobId.set(null);
  }

  onTrimModalClosed() {
    this.trimModalOpen.set(false);
    this.trimModalJobId.set(null);
  }

  // ========================================
  // Queue Tab -> Tab Integration Methods
  // ========================================

  /**
   * Handle adding completed queue items to an existing tab
   */
  onQueueAddToTab(event: { tabId: string; videoIds: string[] }) {
    this.addVideosToTab(event.tabId, event.videoIds);
  }

  /**
   * Handle adding completed queue items to a new tab
   */
  onQueueAddToNewTab(videoIds: string[]) {
    this.openNewTabDialog(videoIds);
  }

  // ========================================
  // New Tab Dialog Methods
  // ========================================

  /**
   * Open new tab dialog with pending videos
   */
  openNewTabDialog(videoIds: string[]) {
    this.newTabPendingVideos.set(videoIds);
    this.newTabDialogOpen.set(true);
  }

  /**
   * Handle creating a new tab and adding pending videos to it
   */
  async onNewTabCreated(tabName: string) {
    try {
      const videoIds = this.newTabPendingVideos();

      // Create the tab
      const result = await firstValueFrom(this.tabsService.createTab(tabName));

      // If there are videos to add, add them to the tab
      if (videoIds.length > 0) {
        await firstValueFrom(this.tabsService.addVideosToTab(result.id, videoIds));

        // Show success notification with video count
        const videoCount = videoIds.length;
        const videoText = videoCount === 1 ? '1 video' : `${videoCount} videos`;
        this.notificationService.success(
          'Tab Created',
          `Created "${tabName}" with ${videoText}`
        );
      } else {
        // Show success notification for empty tab
        this.notificationService.success(
          'Tab Created',
          `Created empty tab "${tabName}"`
        );
      }

      // Clear pending videos
      this.newTabPendingVideos.set([]);
    } catch (error: any) {
      console.error('Failed to create tab:', error);
      this.notificationService.error(
        'Failed to Create Tab',
        error?.message || 'An error occurred while creating the tab'
      );
    }
  }

  /**
   * Close new tab dialog
   */
  onNewTabDialogClosed() {
    this.newTabDialogOpen.set(false);
    this.newTabPendingVideos.set([]);
  }

  /**
   * Add videos to an existing tab
   */
  async addVideosToTab(tabId: string, videoIds: string[]) {
    try {
      const result = await firstValueFrom(this.tabsService.addVideosToTab(tabId, videoIds));

      // Get tab info to show in notification
      const tab = await firstValueFrom(this.tabsService.getTabById(tabId));

      // Show success notification
      const addedCount = result.addedCount || 0;
      const totalCount = result.totalCount || videoIds.length;
      const alreadyInTab = totalCount - addedCount;

      // Only show notification if something was actually added
      if (addedCount > 0) {
        const message = alreadyInTab > 0
          ? `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}". ${alreadyInTab} already in tab.`
          : `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}"`;
        this.notificationService.success('Videos Added to Tab', message);
      }
    } catch (error: any) {
      console.error('Failed to add videos to tab:', error);
      this.notificationService.error(
        'Failed to Add to Tab',
        error?.message || 'An error occurred while adding videos to the tab'
      );
    }
  }

  private async refreshThumbnails(videos: VideoItem[]) {
    const refreshedIds = new Set<string>();
    for (const video of videos) {
      try {
        await firstValueFrom(
          this.http.post(`${getApiBase()}/database/videos/${video.id}/regenerate-thumbnail`, {})
        );
        refreshedIds.add(video.id);
      } catch (error: any) {
        console.error(`Failed to refresh thumbnail for ${video.name}:`, error);
        this.notificationService.error('Error', `Failed to refresh thumbnail for "${video.name}"`);
        return;
      }
    }
    // Bust thumbnail cache in-place without reloading the library (avoids re-sorting)
    const cacheBust = Date.now().toString();
    this.videoWeeks.update(weeks => weeks.map(week => ({
      ...week,
      videos: week.videos.map(v =>
        refreshedIds.has(v.id) && v.thumbnailUrl
          ? { ...v, thumbnailUrl: v.thumbnailUrl.replace(/&t=.*$/, `&t=${cacheBust}`) }
          : v
      )
    })));
    this.notificationService.success('Done', videos.length > 1 ? `Refreshed ${videos.length} thumbnails` : 'Thumbnail refreshed');
  }

}
