import { Component, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy, ChangeDetectorRef, computed, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LibrarySearchFiltersComponent, LibraryFilters } from '../../components/library-search-filters/library-search-filters.component';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { UrlInputComponent, UrlEntry } from '../../components/url-input/url-input.component';
import { QueueItemConfigModalComponent } from '../../components/queue-item-config-modal/queue-item-config-modal.component';
import { AiSetupWizardComponent } from '../../components/ai-setup-wizard/ai-setup-wizard.component';
import { VideoPreviewModalComponent, PreviewItem } from '../../components/video-preview-modal/video-preview-modal.component';
import { VideoConfigDialogComponent } from '../../components/video-config-dialog/video-config-dialog.component';
import { ManagerTabComponent } from '../../components/manager-tab/manager-tab.component';
import { TabsTabComponent } from '../../components/tabs-tab/tabs-tab.component';
import { NewTabDialogComponent } from '../../components/new-tab-dialog/new-tab-dialog.component';
import { QueueTabComponent } from '../../components/queue-tab/queue-tab.component';
import { SaveForLaterTabComponent } from '../../components/save-for-later-tab/save-for-later-tab.component';
import { SettingsPageComponent } from '../settings/settings-page.component';
import { VideoWeek, VideoItem, ChildrenConfig, VideoChild, ItemProgress } from '../../models/video.model';
import { Library, NewLibrary, OpenLibrary } from '../../models/library.model';
import { QueueItemTask } from '../../models/queue.model';
import { TaskType, AVAILABLE_TASKS } from '../../models/task.model';
import { LibraryService } from '../../services/library.service';
import { WebsocketService, TaskStarted, TaskCompleted, TaskProgress, TaskFailed, AnalysisCompleted } from '../../services/websocket.service';
import { AiSetupService } from '../../services/ai-setup.service';
import { VideoJobSettings } from '../../models/video-processing.model';
import { NotificationService } from '../../services/notification.service';
import { TabsService } from '../../services/tabs.service';
import { FileImportService } from '../../services/file-import.service';
import { ElectronService } from '../../services/electron.service';
import { TourService } from '../../services/tour.service';
import { QueueService } from '../../services/queue.service';
import { QueueJob, QueueTask, createQueueJob, createQueueTask } from '../../models/queue-job.model';

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
    UrlInputComponent,
    QueueItemConfigModalComponent,
    AiSetupWizardComponent,
    VideoPreviewModalComponent,
    VideoConfigDialogComponent,
    ManagerTabComponent,
    TabsTabComponent,
    NewTabDialogComponent,
    QueueTabComponent,
    SaveForLaterTabComponent,
    SettingsPageComponent
  ],
  templateUrl: './library-page.component.html',
  styleUrls: ['./library-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LibraryPageComponent implements OnInit, OnDestroy {
  private libraryService = inject(LibraryService);
  private router = inject(Router);
  private http = inject(HttpClient);
  private websocketService = inject(WebsocketService);
  private aiSetupService = inject(AiSetupService);
  private notificationService = inject(NotificationService);
  private tabsService = inject(TabsService);
  private fileImportService = inject(FileImportService);
  private electronService = inject(ElectronService);
  private tourService = inject(TourService);
  private queueService = inject(QueueService);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild(CascadeComponent) private cascadeComponent?: CascadeComponent;
  @ViewChild(UrlInputComponent) private urlInputComponent?: UrlInputComponent;
  @ViewChild(TabsTabComponent) private tabsTabComponent?: TabsTabComponent;

  // File input for import button
  private fileInput?: HTMLInputElement;

  // Track videos with pending renames to avoid race conditions
  private pendingRenames = new Set<string>();

  // Track videos pending analysis (waiting for AI wizard to complete)
  private pendingAnalysisVideos: VideoItem[] = [];

  // Drag and drop state
  isDraggingOver = signal(false);

  // AI Setup wizard state
  aiWizardOpen = signal(false);

  videoWeeks = signal<VideoWeek[]>([]);
  filteredWeeks = signal<VideoWeek[]>([]);

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
  combinedWeeks = computed(() => this.filteredWeeks());

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

  // Filters
  currentFilters: LibraryFilters | null = null;

  // Tab State
  activeTab = signal<'library' | 'queue' | 'tabs' | 'manager' | 'saved' | 'settings'>('library');

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
  }

  async ngOnInit() {
    // Note: Queue state is managed by QueueService (single source of truth)
    // No need to load from localStorage here - QueueService handles persistence

    this.loadDefaultTaskSettings();

    // Subscribe to websocket events (for library refresh only - queue updates handled by QueueService)
    this.websocketService.connect();

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
      const refreshTaskTypes = ['analyze', 'transcribe', 'import', 'download', 'fix-aspect-ratio', 'normalize-audio', 'process-video'];
      if (refreshTaskTypes.includes(event.type)) {
        if (event.videoId && this.pendingRenames.has(event.videoId)) {
          console.log('Skipping library refresh - pending rename for videoId:', event.videoId);
        } else {
          this.loadCurrentLibrary();
        }
      }
    });

    // Task started - logged for debugging (queue updates handled by QueueService)
    this.websocketService.onTaskStarted((event: TaskStarted) => {
      console.log('Task started:', event);
    });

    // Task progress - logged for debugging (queue updates handled by QueueService)
    this.websocketService.onTaskProgress((event: TaskProgress) => {
      console.log('Task progress:', event);
    });

    // Task failed - show notification (queue updates handled by QueueService)
    this.websocketService.onTaskFailed((event: TaskFailed) => {
      console.log('Task failed:', event);

      // Get error message
      const errorMessage = event.error?.message || 'Unknown error';

      // Show notification to user
      this.notificationService.error(
        `Task failed: ${event.type}`,
        errorMessage,
        true  // showToast
      );
    });

    // Video renamed - update video list (including upload date)
    this.websocketService.onVideoRenamed((event) => {
      console.log('Video renamed event received:', event);
      this.updateVideoName(event.videoId, event.newFilename, event.uploadDate);
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

    // Auto-start welcome tour on first app visit, then chain to tab-specific tour
    if (!this.tourService.isTourCompleted('welcome')) {
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

    // Libraries exist - now check AI availability
    const availability = await this.aiSetupService.checkAIAvailability();
    const setupStatus = this.aiSetupService.getSetupStatus();

    if (setupStatus.needsSetup) {
      // AI not configured - show wizard
      this.aiWizardOpen.set(true);
    } else {
      // AI is configured and libraries exist - load them
      this.loadCurrentLibrary();
    }
  }

  // Handle AI wizard completion
  onAiWizardCompleted() {
    this.aiWizardOpen.set(false);

    // Refresh AI availability after setup
    this.aiSetupService.checkAIAvailability();

    // If there were videos pending analysis, continue with them
    if (this.pendingAnalysisVideos.length > 0) {
      const videos = [...this.pendingAnalysisVideos];
      this.pendingAnalysisVideos = [];
      // Use setTimeout to let wizard close fully before starting analysis
      setTimeout(() => this.analyzeVideos(videos), 100);
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
    } else if (tab === 'settings') {
      tourId = 'settings';
    } else if (tab === 'library') {
      tourId = 'library';
    }

    this.tourService.startTour(tourId);
  }

  // Load default task settings from localStorage
  private loadDefaultTaskSettings() {
    const saved = localStorage.getItem('clipchimp-task-defaults');
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
      localStorage.removeItem('clipchimp-task-defaults');
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
    localStorage.setItem('clipchimp-task-defaults', JSON.stringify({
      tasks,
      savedAt: new Date().toISOString()
    }));
    this.defaultTaskSettings = tasks;
  }

  // Save processing queue to localStorage
  private saveProcessingQueueToStorage(queue: ProcessingQueueItem[]) {
    try {
      localStorage.setItem('clipchimp-processing-queue', JSON.stringify(queue));

      // Also save the processing flags (video IDs that are in queue)
      const processingVideoIds = queue
        .filter(item => item.videoId)
        .map(item => item.videoId!);
      localStorage.setItem('clipchimp-processing-flags', JSON.stringify(processingVideoIds));

      // Save the backend-to-frontend job ID mapping for items that have started processing
      const jobIdMapping: Record<string, string> = {};
      queue.forEach(item => {
        if (item.jobId && item.backendJobId) {
          jobIdMapping[item.backendJobId] = item.jobId;
        }
      });
      localStorage.setItem('clipchimp-job-id-mapping', JSON.stringify(jobIdMapping));
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
      const saved = localStorage.getItem('clipchimp-processing-flags');
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
      const saved = localStorage.getItem('clipchimp-processing-queue');
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
      localStorage.removeItem('clipchimp-processing-queue');
    }
  }

  // Save completed queue to sessionStorage (temporary, clears when app restarts)
  private saveCompletedQueueToStorage(queue: ProcessingQueueItem[]) {
    try {
      sessionStorage.setItem('clipchimp-completed-queue', JSON.stringify(queue));
    } catch (e) {
      console.error('Failed to save completed queue:', e);
    }
  }

  // Load completed queue from sessionStorage (for navigation within session)
  private loadCompletedQueueFromStorage() {
    try {
      const saved = sessionStorage.getItem('clipchimp-completed-queue');
      if (saved) {
        const queue: ProcessingQueueItem[] = JSON.parse(saved);
        if (Array.isArray(queue) && queue.length > 0) {
          this.completedQueue.set(queue);
          console.log(`Restored ${queue.length} items from completed queue`);
        }
      }
    } catch (e) {
      console.error('Failed to load completed queue:', e);
      sessionStorage.removeItem('clipchimp-completed-queue');
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
  private updateVideoName(videoId: string, newFilename: string, uploadDate?: string | null) {
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
        const mapping = localStorage.getItem('clipchimp-job-id-mapping');
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
      titleResolved: job.titleResolved
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
        const mapping = localStorage.getItem('clipchimp-job-id-mapping');
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

  // Handle URLs added from input - uses QueueService as single source of truth
  onUrlsAdded(entries: UrlEntry[]) {
    let addedNew = false;

    for (const entry of entries) {
      if (entry.loading) {
        // New URL - add via QueueService with default tasks
        const tasks: QueueTask[] = this.defaultTaskSettings.map(t =>
          createQueueTask(t.type, t.config || {})
        );

        this.queueService.addJob({
          url: entry.url,
          title: entry.title,
          titleResolved: false, // Title is still being fetched
          tasks
        });
        addedNew = true;
      } else {
        // Metadata update - update via QueueService
        this.queueService.updateJobByUrl(entry.url, {
          title: entry.title,
          duration: entry.duration,
          thumbnail: entry.thumbnail,
          titleResolved: true
        });
      }
    }

    // Switch to Queue tab to show newly added items
    if (addedNew) {
      this.setActiveTab('queue');
    }
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
          this.videoWeeks.set(response.data);
          this.filteredWeeks.set(response.data);
        } else {
          console.warn('Response not successful:', response);
        }
      },
      error: (error) => {
        console.error('Failed to load library:', error);
        this.videoWeeks.set([]);
        this.filteredWeeks.set([]);
      }
    });
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
        console.error('Failed to load current library:', error);

        // Check if it's a connection refused error
        if (error.status === 0) {
          console.error('Backend server appears to be unavailable. Please check if it\'s running.');
          this.notificationService.error(
            'Connection Error',
            'Cannot connect to backend server. Please ensure the server is running on port 3000.'
          );
        } else {
          // Open library manager if no library is set
          this.openLibraryManager();
        }
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
        // Call backend FTS search with searchIn filter
        this.libraryService.searchVideos(query, this.currentFilters.searchIn).subscribe({
          next: (response) => {
            if (response.success && response.data) {
              // Group search results by week
              const searchResults = response.data;
              const weekMap = new Map<string, VideoItem[]>();

              // Get week labels from original data for grouping
              const originalWeeks = this.videoWeeks();
              const videoWeekMap = new Map<string, string>();

              originalWeeks.forEach(week => {
                week.videos.forEach(video => {
                  videoWeekMap.set(video.id, week.weekLabel);
                });
              });

              // Group search results by week
              searchResults.forEach(video => {
                const weekLabel = videoWeekMap.get(video.id) || 'Search Results';
                if (!weekMap.has(weekLabel)) {
                  weekMap.set(weekLabel, []);
                }
                weekMap.get(weekLabel)!.push(video);
              });

              // Convert map to VideoWeek array
              const filtered: VideoWeek[] = [];
              weekMap.forEach((videos, weekLabel) => {
                filtered.push({ weekLabel, videos });
              });

              // Sort by week label (most recent first)
              filtered.sort((a, b) => b.weekLabel.localeCompare(a.weekLabel));

              // Apply sorting to videos within each week
              this.sortFilteredWeeks(filtered);
              this.filteredWeeks.set(filtered);
            } else {
              this.filteredWeeks.set([]);
            }
          },
          error: (error) => {
            console.error('Search failed:', error);
            // Fall back to showing all videos on error
            this.filteredWeeks.set(this.videoWeeks());
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

    // Apply hasSuggestions filter
    if (this.currentFilters.hasSuggestions !== null) {
      const wantsSuggestions = this.currentFilters.hasSuggestions;
      weeks = weeks.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video =>
          wantsSuggestions ? !!video.suggestedTitle : !video.suggestedTitle
        )
      })).filter(week => week.videos.length > 0);
    }

    // Apply hasTranscript filter
    if (this.currentFilters.hasTranscript !== null) {
      const wantsTranscript = this.currentFilters.hasTranscript;
      weeks = weeks.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video =>
          wantsTranscript ? video.hasTranscript : !video.hasTranscript
        )
      })).filter(week => week.videos.length > 0);
    }

    // Apply hasAnalysis filter
    if (this.currentFilters.hasAnalysis !== null) {
      const wantsAnalysis = this.currentFilters.hasAnalysis;
      weeks = weeks.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video =>
          wantsAnalysis ? video.hasAnalysis : !video.hasAnalysis
        )
      })).filter(week => week.videos.length > 0);
    }

    // Apply mediaType filter
    if (this.currentFilters.mediaType && this.currentFilters.mediaType !== 'all') {
      const targetType = this.currentFilters.mediaType;
      weeks = weeks.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video => {
          const videoMediaType = video.mediaType?.toLowerCase() || 'video';
          return videoMediaType === targetType;
        })
      })).filter(week => week.videos.length > 0);
    }

    this.sortFilteredWeeks(weeks);
    this.filteredWeeks.set(weeks);
  }

  /**
   * Sort videos based on current filter settings
   * For date sorting: reorders sections
   * For other sorts: flattens into single group and sorts all videos
   */
  private sortFilteredWeeks(weeks: VideoWeek[]): void {
    if (!this.currentFilters) return;

    const { sortBy, sortOrder } = this.currentFilters;
    const ascending = sortOrder === 'asc';

    // For date sorting, reorder the sections themselves
    if (sortBy === 'date') {
      // Sort sections by their date (weekLabel is in format YYYY-MM-DD)
      weeks.sort((a, b) => {
        // Handle special labels
        if (a.weekLabel === 'New') return ascending ? 1 : -1;
        if (b.weekLabel === 'New') return ascending ? -1 : 1;
        if (a.weekLabel === 'Unknown') return 1;
        if (b.weekLabel === 'Unknown') return -1;

        const comparison = a.weekLabel.localeCompare(b.weekLabel);
        return ascending ? comparison : -comparison;
      });

      // Also sort videos within each section by date
      for (const week of weeks) {
        week.videos.sort((a, b) => {
          const dateA = a.downloadDate ? new Date(a.downloadDate).getTime() : 0;
          const dateB = b.downloadDate ? new Date(b.downloadDate).getTime() : 0;
          return ascending ? dateA - dateB : dateB - dateA;
        });
      }
      return;
    }

    // For other sort criteria, flatten all videos into a single group
    const allVideos: VideoItem[] = [];
    for (const week of weeks) {
      allVideos.push(...week.videos);
    }

    // Sort all videos
    allVideos.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'name':
          comparison = (a.name || '').localeCompare(b.name || '');
          break;

        case 'duration':
          const durA = this.parseDuration(a.duration);
          const durB = this.parseDuration(b.duration);
          comparison = durA - durB;
          break;

        case 'suggestions':
          // Sort by whether video has a suggested title
          const hasSugA = a.suggestedTitle ? 1 : 0;
          const hasSugB = b.suggestedTitle ? 1 : 0;
          comparison = hasSugA - hasSugB;
          break;

        case 'no-analysis':
          // Sort by whether video is MISSING analysis (no analysis = 1, has analysis = 0)
          const missingAnalysisA = a.hasAnalysis ? 0 : 1;
          const missingAnalysisB = b.hasAnalysis ? 0 : 1;
          comparison = missingAnalysisA - missingAnalysisB;
          break;

        case 'no-transcript':
          // Sort by whether video is MISSING transcript
          const missingTranscriptA = a.hasTranscript ? 0 : 1;
          const missingTranscriptB = b.hasTranscript ? 0 : 1;
          comparison = missingTranscriptA - missingTranscriptB;
          break;
      }

      // Apply sort order
      return ascending ? comparison : -comparison;
    });

    // Replace weeks array content with single flattened group
    weeks.length = 0;
    weeks.push({
      weekLabel: `Sorted by ${this.getSortLabel(sortBy)}`,
      videos: allVideos
    });
  }

  /**
   * Get human-readable label for sort type
   */
  private getSortLabel(sortBy: string): string {
    switch (sortBy) {
      case 'name': return 'Name';
      case 'duration': return 'Duration';
      case 'suggestions': return 'AI Suggestions';
      case 'no-analysis': return 'Missing Analysis';
      case 'no-transcript': return 'Missing Transcript';
      default: return sortBy;
    }
  }

  /**
   * Parse duration string (e.g., "1:23:45" or "23:45") to seconds
   */
  private parseDuration(duration?: string): number {
    if (!duration) return 0;
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }

  onSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedCount.set(event.count);
    this.selectedVideoIds.set(event.ids);

    // If preview modal is open and a single item is selected, update the preview
    if (this.previewModalOpen() && event.count === 1) {
      const itemId = Array.from(event.ids)[0];
      // Extract video ID from itemId format: "weekLabel|videoId"
      const videoId = itemId.split('|')[1];
      if (videoId) {
        this.previewSelectedId.set(videoId);
      }
    }
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

      case 'moveToLibrary':
        // TODO: Open library selector dialog
        console.log('Move to library:', videosToProcess.map(v => v.name));
        this.notificationService.info('Coming Soon', 'This feature will open a dialog to select a target library.');
        break;

      case 'delete':
        this.deleteVideos(videosToProcess, 'everything');
        break;

      case 'openInEditor':
        this.openInEditor(videosToProcess[0]);
        break;

      case 'reveal':
        // Reveal file in Finder/Explorer
        if (videosToProcess[0]?.filePath) {
          this.electronService.showInFolder(videosToProcess[0].filePath);
        }
        break;

      case 'open':
        // Open video file in default video player
        if (videosToProcess[0]?.filePath) {
          this.electronService.openFile(videosToProcess[0].filePath);
        }
        break;

      case 'configure':
        // Open the processing configuration modal for this video
        this.analyzeVideos(videosToProcess);
        break;

      case 'process':
        // Add to processing queue with AI analysis
        this.analyzeVideos(videosToProcess);
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

  openInEditor(video?: VideoItem) {
    // If no video passed, get first selected video
    if (!video) {
      const selectedItemIds = this.selectedVideoIds();

      if (selectedItemIds.size === 0) {
        this.notificationService.warning('No Selection', 'Please select a video first');
        return;
      }

      if (selectedItemIds.size !== 1) {
        this.notificationService.warning('Multiple Selection', 'Please select exactly one video to open in editor');
        return;
      }

      // Get the video from selected ID - check both filtered and all weeks
      const allVideos: VideoItem[] = [];
      // First check filtered weeks (what's currently visible)
      this.filteredWeeks().forEach(week => {
        allVideos.push(...week.videos);
      });
      // Also add from all weeks in case selection came from unfiltered view
      this.videoWeeks().forEach(week => {
        week.videos.forEach(v => {
          if (!allVideos.find(existing => existing.id === v.id)) {
            allVideos.push(v);
          }
        });
      });

      // The itemId format is "weekLabel|videoId"
      const itemId = Array.from(selectedItemIds)[0];
      const parts = itemId.split('|');
      const videoId = parts.length > 1 ? parts[1] : itemId;

      // Try to find by extracted videoId first
      video = allVideos.find(v => v.id === videoId);

      // If not found, try matching the full itemId as videoId (in case format changed)
      if (!video) {
        video = allVideos.find(v => v.id === itemId);
      }
    }

    if (!video) {
      console.error('Could not find video. Selected IDs:', Array.from(this.selectedVideoIds()));
      this.notificationService.error('Video Not Found', 'Could not find selected video');
      return;
    }

    // Open editor in a new window via Electron
    // videoPath is optional - the editor can stream by videoId if path is missing
    if (this.electronService.isElectron) {
      this.electronService.openEditorWindow({
        videoId: video.id,
        videoPath: video.filePath,
        videoTitle: video.name
      });
    } else {
      // Fallback for non-Electron: navigate to editor route
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

  private async analyzeVideos(videos: VideoItem[]) {
    if (videos.length === 0) return;

    // Check if AI is configured before proceeding
    const setupStatus = this.aiSetupService.getSetupStatus();
    if (setupStatus.needsSetup) {
      // Store the videos to analyze after wizard completes
      this.pendingAnalysisVideos = videos;
      this.aiWizardOpen.set(true);
      return;
    }

    // Filter out non-video files (images, PDFs, etc.)
    // Transcribe and AI analysis only work on video/audio files
    const videoOnlyItems = videos.filter(video => {
      const mediaType = video.mediaType?.toLowerCase() || '';
      const ext = video.fileExtension?.toLowerCase() || '';
      const fileName = video.name?.toLowerCase() || '';

      // List of non-video extensions to exclude
      const nonVideoExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.doc', '.docx', '.txt', '.md'];

      // Check if it's a non-video file
      const isNonVideo = mediaType.startsWith('image/') ||
                         mediaType === 'application/pdf' ||
                         nonVideoExtensions.some(e => ext === e || fileName.endsWith(e));

      return !isNonVideo;
    });

    // Show notification if some items were filtered out
    if (videoOnlyItems.length < videos.length) {
      const filtered = videos.length - videoOnlyItems.length;
      this.notificationService.warning(
        'Non-video Files Excluded',
        `${filtered} image${filtered !== 1 ? 's' : ''} or document${filtered !== 1 ? 's' : ''} cannot be transcribed or analyzed. Only video files were added.`
      );
    }

    // If all items were filtered out, don't proceed
    if (videoOnlyItems.length === 0) {
      this.notificationService.error(
        'No Videos Selected',
        'Transcription and analysis only work on video files. Please select at least one video.'
      );
      return;
    }

    // Store videos pending configuration (not added to queue yet)
    this.pendingConfigVideos.set(videoOnlyItems);

    // Clear selection
    if (this.cascadeComponent) {
      this.cascadeComponent.clearSelection();
    }

    // Check if all videos already have transcripts
    // For bulk mode, only set hasTranscript to true if ALL videos have transcripts
    const allHaveTranscripts = videoOnlyItems.every(v => v.hasTranscript === true);

    // Open config modal with default tasks (transcribe + ai-analyze)
    // Note: transcribe will be auto-added on save if AI analysis is selected but no transcript exists
    const defaultTasks: QueueItemTask[] = [
      {
        type: 'transcribe',
        status: 'pending',
        progress: 0,
        config: { model: 'base', language: 'en' }
      },
      {
        type: 'ai-analyze',
        status: 'pending',
        progress: 0,
        config: {}
      }
    ];

    this.configItemIds.set([]); // No existing queue items
    this.configBulkMode.set(videos.length > 1);
    this.configItemSource.set('library');
    this.configExistingTasks.set(defaultTasks);
    this.configHasTranscript.set(allHaveTranscripts);
    this.configModalOpen.set(true);
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

  onAddSelectedToQueue() {
    console.log('[ADD TO QUEUE] Starting...');

    if (this.selectedCount() === 0) {
      this.notificationService.warning('No Selection', 'Please select at least one video');
      return;
    }

    // Get selected videos and add them to staging queue
    const allVideos: VideoItem[] = [];
    this.videoWeeks().forEach(week => {
      allVideos.push(...week.videos);
    });

    const selectedItemIds = this.selectedVideoIds();
    console.log('[ADD TO QUEUE] Selected item IDs:', selectedItemIds);

    // Extract unique video IDs from itemIds (format: "weekLabel|videoId")
    const uniqueVideoIds = new Set<string>();
    selectedItemIds.forEach(itemId => {
      const parts = itemId.split('|');
      const videoId = parts.length > 1 ? parts[1] : itemId;
      // Skip queue/staging items
      if (!videoId.startsWith('queue-') && !videoId.startsWith('staging-')) {
        uniqueVideoIds.add(videoId);
      }
    });

    console.log('[ADD TO QUEUE] Unique video IDs:', Array.from(uniqueVideoIds));

    if (uniqueVideoIds.size === 0) return;

    // Add jobs to QueueService (single source of truth)
    uniqueVideoIds.forEach(videoId => {
      const video = allVideos.find(v => v.id === videoId);
      if (video) {
        const tasks: QueueTask[] = this.defaultTaskSettings
          .filter(t => t.type !== 'download-import') // Library items don't need download
          .map(t => createQueueTask(t.type, t.config || {}));

        this.queueService.addJob({
          title: video.name,
          videoId: video.id,
          duration: video.duration,
          thumbnail: video.thumbnailUrl,
          tasks,
          titleResolved: true // Library videos already have resolved titles
        });
      }
    });

    console.log('[ADD TO QUEUE] Jobs added to QueueService');

    // Switch to Queue tab using the proper method
    console.log('[ADD TO QUEUE] Current tab before switch:', this.activeTab());
    this.setActiveTab('queue');
    console.log('[ADD TO QUEUE] Current tab after switch:', this.activeTab());

    // Show notification
    this.notificationService.success(
      'Added to Staging',
      `Added ${uniqueVideoIds.size} ${uniqueVideoIds.size === 1 ? 'video' : 'videos'} to staging queue`
    );

    // Clear selection (Angular will handle this reactively)
    if (this.cascadeComponent) {
      this.cascadeComponent.clearSelection();
    }
  }

  onPasteUrls() {
    // Focus the URL input
    if (this.urlInputComponent) {
      this.urlInputComponent.focus();
    }
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
  async onDownloadSubmit(items: { url: string; name: string; settings: VideoJobSettings }[]) {
    this.downloadDialogOpen.set(false);

    const addedJobs: QueueJob[] = [];

    // Add all items to QueueService IMMEDIATELY with placeholder titles
    for (const item of items) {
      // Convert settings to QueueTask array
      const tasks = this.convertSettingsToQueueTasks(item.settings);

      // Add job to QueueService
      const job = this.queueService.addJob({
        url: item.url,
        title: item.name || 'Building title...',
        titleResolved: false,
        tasks
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
      this.http.get<any>(`http://localhost:3000/api/downloader/info?url=${encodeURIComponent(item.url)}`)
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
   * Convert VideoJobSettings to QueueTask array for URL downloads
   */
  private convertSettingsToQueueTasks(settings: VideoJobSettings): QueueTask[] {
    const tasks: QueueTask[] = [];

    // Always add download-import task first for URL downloads
    tasks.push(createQueueTask('download-import', {}));

    if (settings.fixAspectRatio) {
      tasks.push(createQueueTask('fix-aspect-ratio', {
        targetRatio: settings.aspectRatio || '16:9'
      }));
    }

    if (settings.normalizeAudio) {
      tasks.push(createQueueTask('normalize-audio', {
        targetLevel: settings.audioLevel || -16
      }));
    }

    if (settings.transcribe) {
      tasks.push(createQueueTask('transcribe', {
        model: settings.whisperModel || 'base',
        language: settings.whisperLanguage
      }));
    }

    if (settings.aiAnalysis) {
      tasks.push(createQueueTask('ai-analyze', {
        aiModel: settings.aiModel,
        customInstructions: settings.customInstructions,
        analysisQuality: settings.analysisQuality
      }));
    }

    return tasks;
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
   * Switch between Library, Queue, Tabs, Manager, Saved, and Settings tabs
   */
  setActiveTab(tab: 'library' | 'queue' | 'tabs' | 'manager' | 'saved' | 'settings') {
    this.activeTab.set(tab);
    if (tab === 'queue') {
      console.log('[LibraryPage] Switching to Queue tab');
      console.log('[LibraryPage] Staging queue:', this.stagingQueue());
      console.log('[LibraryPage] Processing queue:', this.processingQueue());
    }

    // Auto-start tour for this tab if user hasn't seen it
    // Use longer delay (800ms) to ensure Angular has rendered the new tab content
    this.tourService.tryAutoStartTour(tab, 800);
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

    // Submit pending jobs to backend via QueueService
    // QueueService handles state transitions and WebSocket updates
    this.queueService.submitPendingJobs().subscribe({
      next: (jobIdMap) => {
        const count = jobIdMap.size;
        console.log('[ProcessStagingItems] Processing started for', count, 'items');
        if (count > 0) {
          this.notificationService.success(
            'Processing Started',
            `Started processing ${count} ${count === 1 ? 'item' : 'items'}`
          );
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
   * Open config modal for selected staging items
   */
  onQueueConfigureSelected(itemIds: string[]) {
    if (itemIds.length === 0) return;

    // Find staging items by ID
    const stagingItems = this.stagingQueue().filter(item =>
      itemIds.includes(item.id)
    );

    if (stagingItems.length === 0) return;

    // Get existing tasks from first item
    const firstItem = stagingItems[0];
    const existingTasks: QueueItemTask[] = firstItem.tasks?.map(t => ({
      type: t.type as any,
      status: 'pending' as const,
      progress: 0,
      config: t.options
    })) || [];

    // Check if items have transcripts (for library items)
    // URL items don't have transcripts yet
    let hasTranscript = false;
    if (!firstItem.url && firstItem.videoId) {
      const allVideos = this.videoWeeks().flatMap(week => week.videos);
      const videosInStaging = stagingItems
        .filter(item => item.videoId)
        .map(item => allVideos.find(v => v.id === item.videoId))
        .filter((v): v is VideoItem => v !== undefined);

      // Only true if ALL videos have transcripts
      hasTranscript = videosInStaging.length > 0 && videosInStaging.every(v => v.hasTranscript === true);
    }

    this.configItemIds.set(stagingItems.map(item => item.id));
    this.configBulkMode.set(stagingItems.length > 1);
    this.configItemSource.set(firstItem.url ? 'url' : 'library');
    this.configExistingTasks.set(existingTasks);
    this.configHasTranscript.set(hasTranscript);
    this.configModalOpen.set(true);
  }

  /**
   * Remove selected staging items
   */
  onQueueRemoveSelected(itemIds: string[]) {
    // Remove each item via QueueService
    itemIds.forEach(id => this.queueService.removeJob(id));

    this.notificationService.success(
      'Items Removed',
      `Removed ${itemIds.length} ${itemIds.length === 1 ? 'item' : 'items'} from staging queue`
    );
  }

  /**
   * Cancel processing items
   */
  async onCancelProcessing(itemIds: string[]) {
    if (itemIds.length === 0) return;

    try {
      // Cancel each item
      for (const itemId of itemIds) {
        await firstValueFrom(
          this.http.post(`http://localhost:3000/api/processing/cancel/${itemId}`, {})
        );
      }

      this.notificationService.success(
        'Processing Cancelled',
        `Cancelled ${itemIds.length} ${itemIds.length === 1 ? 'item' : 'items'}`
      );

      // The processing queue will update automatically via EventSource
      // But we can optimistically remove the cancelled items for immediate feedback
      const queue = this.processingQueue();
      const remaining = queue.filter(item => !itemIds.includes(item.id));
      this.processingQueue.set(remaining);
    } catch (error) {
      console.error('Failed to cancel processing:', error);
      this.notificationService.error(
        'Cancellation Failed',
        'Failed to cancel processing items'
      );
    }
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
   * Open RippleCut (video editor) to view analysis for a completed item
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

      let message = '';
      if (addedCount > 0 && alreadyInTab > 0) {
        message = `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}". ${alreadyInTab} already in tab.`;
      } else if (addedCount > 0) {
        message = `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}"`;
      } else {
        message = `All videos already in "${tab.name}"`;
      }

      this.notificationService.success('Videos Added to Tab', message);
    } catch (error: any) {
      console.error('Failed to add videos to tab:', error);
      this.notificationService.error(
        'Failed to Add to Tab',
        error?.message || 'An error occurred while adding videos to the tab'
      );
    }
  }
}
