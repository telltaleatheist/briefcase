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
import { WebsocketService, TaskCompleted, TaskProgress, TaskFailed, AnalysisCompleted } from '../../services/websocket.service';
import { VideoProcessingService } from '../../services/video-processing.service';
import { AiSetupService } from '../../services/ai-setup.service';
import { VideoJobSettings } from '../../models/video-processing.model';
import { NotificationService } from '../../services/notification.service';
import { TabsService } from '../../services/tabs.service';
import { FileImportService } from '../../services/file-import.service';

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
  private videoProcessingService = inject(VideoProcessingService);
  private aiSetupService = inject(AiSetupService);
  private notificationService = inject(NotificationService);
  private tabsService = inject(TabsService);
  private fileImportService = inject(FileImportService);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild(CascadeComponent) private cascadeComponent?: CascadeComponent;
  @ViewChild(UrlInputComponent) private urlInputComponent?: UrlInputComponent;
  @ViewChild(TabsTabComponent) private tabsTabComponent?: TabsTabComponent;

  // File input for import button
  private fileInput?: HTMLInputElement;

  // Track videos with pending renames to avoid race conditions
  private pendingRenames = new Set<string>();

  // Drag and drop state
  isDraggingOver = signal(false);

  // AI Setup wizard state
  aiWizardOpen = signal(false);

  videoWeeks = signal<VideoWeek[]>([]);
  filteredWeeks = signal<VideoWeek[]>([]);

  // Queue state - split into staging (not yet sent to backend) and processing (actively being processed)
  stagingQueue = signal<ProcessingQueueItem[]>([]);  // Items waiting to be processed
  processingQueue = signal<ProcessingQueueItem[]>([]); // Items actively being processed by backend

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
  queueProgressMapper = (video: VideoItem): ItemProgress | null => {
    // Handle both queue: and processing: tags
    const queueTag = video.tags?.find(t => t.startsWith('queue:') || t.startsWith('processing:'));
    if (!queueTag) return null;

    const queueId = queueTag.replace(/^(queue:|processing:)/, '');
    const queueItem = this.processingQueue().find(q => q.id === queueId);
    if (!queueItem) return null;

    // Calculate overall progress
    if (queueItem.tasks.length === 0) return null;

    const totalProgress = queueItem.tasks.reduce((sum, task) => sum + task.progress, 0);
    const overallProgress = Math.round(totalProgress / queueItem.tasks.length);

    // Only show progress bar when processing
    if (queueItem.status === 'pending') {
      return null;
    }

    // Determine color based on status
    let color = 'var(--primary-orange)';
    if (queueItem.status === 'completed') {
      color = 'var(--status-complete)';
    } else if (queueItem.status === 'failed') {
      color = 'var(--status-error)';
    }

    return {
      value: overallProgress,
      color,
      indeterminate: queueItem.status === 'loading'
    };
  };

  // Config modal state
  configModalOpen = signal(false);
  configItemIds = signal<string[]>([]);
  configBulkMode = signal(false);
  configItemSource = signal<'url' | 'library'>('url');
  configExistingTasks = signal<QueueItemTask[]>([]);

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
    // Auto-save processing queue to localStorage when it changes
    effect(() => {
      const queue = this.processingQueue();
      if (!this.isLoadingQueue) {
        this.saveProcessingQueueToStorage(queue);
      }
    });

    // Auto-remove completed/failed items from processing queue
    effect(() => {
      const queue = this.processingQueue();

      // Find items where all tasks are done (completed or failed)
      const doneItems = queue.filter(item => {
        return item.tasks.length > 0 &&
          item.tasks.every(t => t.status === 'completed' || t.status === 'failed') &&
          !item.tasks.some(t => t.status === 'pending' || t.status === 'running');
      });

      // Remove done items after a brief delay to show final state
      if (doneItems.length > 0) {
        console.log('Found', doneItems.length, 'done items to remove:', doneItems.map(i => i.title));
        setTimeout(() => {
          const currentQueue = this.processingQueue();
          const remainingQueue = currentQueue.filter(item => {
            const isDone = item.tasks.length > 0 &&
              item.tasks.every(t => t.status === 'completed' || t.status === 'failed') &&
              !item.tasks.some(t => t.status === 'pending' || t.status === 'running');
            return !isDone;
          });

          if (remainingQueue.length !== currentQueue.length) {
            console.log('Removing', currentQueue.length - remainingQueue.length, 'done items from queue');
            this.processingQueue.set(remainingQueue);
            this.loadLibrary(); // Refresh library to show newly completed items
          }
        }, 1500);
      }
    });
  }

  async ngOnInit() {
    // Load processing queue from localStorage first
    this.loadProcessingQueueFromStorage();
    this.isLoadingQueue = false;

    this.loadDefaultTaskSettings();

    // Subscribe to websocket events
    this.websocketService.connect();

    // Subscribe to VideoProcessingService to restore queue from backend
    this.videoProcessingService.getJobs().subscribe(jobs => {
      console.log('[LibraryPage] Received jobs from VideoProcessingService:', jobs);
      console.log('[LibraryPage] Jobs count:', jobs.length);

      // Filter out completed and failed jobs - they should not be in the processing queue
      const activeJobs = jobs.filter(job =>
        job.status !== 'completed' && job.status !== 'failed'
      );
      console.log('[LibraryPage] Active jobs (filtered):', activeJobs.length);

      // Convert VideoJob[] to ProcessingQueueItem[] format
      const queueItems: ProcessingQueueItem[] = activeJobs.map(job => ({
        id: job.id,
        jobId: job.id,
        backendJobId: job.id,
        videoId: job.videoId,
        url: job.videoUrl,
        title: job.videoName,
        status: job.status === 'queued' ? 'pending' as const :
                job.status === 'processing' ? 'processing' as const :
                job.status === 'completed' ? 'completed' as const : 'failed' as const,
        tasks: job.tasks.map(task => ({
          type: this.mapVideoTaskTypeToQueueTaskType(task.type),
          options: {}, // Add empty options object
          status: task.status === 'pending' ? 'pending' as const :
                  task.status === 'in-progress' ? 'running' as const :
                  task.status === 'completed' ? 'completed' as const : 'failed' as const,
          progress: task.progress
        }))
      }));
      console.log('[LibraryPage] Converted to queue items:', queueItems);
      console.log('[LibraryPage] Setting processingQueue with', queueItems.length, 'items');
      this.processingQueue.set(queueItems);
      console.log('[LibraryPage] After set, processingQueue():', this.processingQueue());
    });

    // Check for first-time setup with error handling
    try {
      await this.checkFirstTimeSetup();
    } catch (error) {
      console.error('Error during first-time setup check:', error);
      // If setup check fails, still try to load library directly
      this.loadCurrentLibrary();
    }

    // Task completion - refresh library and update queue
    this.websocketService.onTaskCompleted((event: TaskCompleted) => {
      console.log('Task completed:', event);

      // Translate backend job ID to frontend job ID
      const frontendJobId = this.videoProcessingService.getFrontendJobId(event.jobId) || event.jobId;

      // Update queue item task status first
      this.updateQueueTaskStatus(frontendJobId, event.type, 'completed', 100);

      // Store videoId in queue item if available (download/import tasks)
      if (event.videoId) {
        this.storeVideoIdInQueueItem(frontendJobId, event.jobId, event.videoId);
      }

      // Refresh library when a task completes
      // Skip if there's a pending rename for this video to avoid race conditions
      if (event.type === 'analyze' || event.type === 'transcribe' || event.type === 'import' || event.type === 'download') {
        if (event.videoId && this.pendingRenames.has(event.videoId)) {
          console.log('Skipping library refresh - pending rename for videoId:', event.videoId);
        } else {
          this.loadCurrentLibrary();
        }
      }

      // Note: Completed items are automatically removed by the effect in constructor
    });

    // Task progress - update queue item progress
    this.websocketService.onTaskProgress((event: TaskProgress) => {
      console.log('Task progress:', event);
      if (event.type) {
        // Translate backend job ID to frontend job ID
        const frontendJobId = this.videoProcessingService.getFrontendJobId(event.jobId) || event.jobId;
        this.updateQueueTaskStatus(frontendJobId, event.type, 'running', event.progress);
      }
    });

    // Task failed - show notification and mark as failed
    this.websocketService.onTaskFailed((event: TaskFailed) => {
      console.log('Task failed:', event);

      // Translate backend job ID to frontend job ID
      const frontendJobId = this.videoProcessingService.getFrontendJobId(event.jobId) || event.jobId;

      // Update queue item task status to failed
      if (event.type) {
        this.updateQueueTaskStatus(frontendJobId, event.type, 'failed', 0);
      }

      // Show notification to user
      const errorMessage = event.error?.message || 'Unknown error';
      this.notificationService.error(
        `Task failed: ${event.type}`,
        errorMessage,
        true  // showToast
      );

      // Note: Failed items are automatically removed by the effect in constructor
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
  }

  // Check for first-time setup (AI config and library)
  private async checkFirstTimeSetup() {
    // Check AI availability
    const availability = await this.aiSetupService.checkAIAvailability();
    const setupStatus = this.aiSetupService.getSetupStatus();

    if (setupStatus.needsSetup) {
      // AI not configured - show wizard
      this.aiWizardOpen.set(true);
    } else {
      // AI is configured - load libraries
      this.loadCurrentLibrary();
      this.loadLibraries();
    }
  }

  // Handle AI wizard completion
  onAiWizardCompleted() {
    this.aiWizardOpen.set(false);

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

  // Generate task children for a queue item
  private generateTaskChildren(video: VideoItem): VideoChild[] {
    // Check if this is a queue or processing item
    const queueTag = video.tags?.find(t => t.startsWith('queue:') || t.startsWith('processing:'));
    if (!queueTag) return [];

    const queueId = queueTag.replace(/^(queue:|processing:)/, '');
    const queueItem = this.processingQueue().find(q => q.id === queueId);
    if (!queueItem) return [];

    return queueItem.tasks.map(task => {
      const taskInfo = AVAILABLE_TASKS.find(t => t.type === task.type);
      return {
        id: `${queueId}-${task.type}`,
        parentId: video.id,
        label: taskInfo?.label || task.type,
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
    const queueTag = video.tags?.find(t => t.startsWith('queue:') || t.startsWith('processing:'));
    if (!queueTag) return 0;

    const queueId = queueTag.replace(/^(queue:|processing:)/, '');
    const queueItem = this.processingQueue().find(q => q.id === queueId);
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

  // Update queue task status from websocket events
  private updateQueueTaskStatus(jobId: string, taskType: string, status: 'pending' | 'running' | 'completed' | 'failed', progress: number) {
    const queue = this.processingQueue();

    // First try to find by frontend jobId
    let itemIndex = queue.findIndex(q => q.jobId === jobId);

    // If not found, try to find by backendJobId
    if (itemIndex === -1) {
      itemIndex = queue.findIndex(q => q.backendJobId === jobId);
    }

    // If still not found, check localStorage mapping
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

    if (itemIndex === -1) {
      console.log('Queue item not found for jobId:', jobId, '- available jobIds:', queue.map(q => q.jobId).join(', '));
      return;
    }

    const item = queue[itemIndex];

    // Map backend task type to frontend task type
    const mappedType = this.mapBackendTaskType(taskType);
    const taskIndex = item.tasks.findIndex(t => t.type === mappedType);
    if (taskIndex === -1) {
      console.log('Task not found for type:', taskType, 'mapped to:', mappedType,
        '- available tasks:', item.tasks.map(t => t.type).join(', '));
      return;
    }

    // Create new task object to trigger change detection
    const updatedTask = { ...item.tasks[taskIndex], status, progress };
    const updatedTasks = [...item.tasks];
    updatedTasks[taskIndex] = updatedTask;

    // Determine new item status
    let newStatus = item.status;
    if (updatedTasks.every(t => t.status === 'completed')) {
      newStatus = 'completed';
    } else if (updatedTasks.some(t => t.status === 'failed')) {
      newStatus = 'failed';
    } else if (updatedTasks.some(t => t.status === 'running')) {
      newStatus = 'processing';
    }

    // Create new item object
    const updatedItem: ProcessingQueueItem = {
      ...item,
      tasks: updatedTasks,
      status: newStatus
    };

    // Create new queue array
    const newQueue = [...queue];
    newQueue[itemIndex] = updatedItem;

    console.log('Updating queue item:', updatedItem.title, 'task:', taskType, '→', mappedType, 'progress:', progress, '%');

    // Trigger update with new array
    this.processingQueue.set(newQueue);
  }

  // Map backend task types to frontend types
  private mapBackendTaskType(type: string): TaskType {
    const mapping: Record<string, TaskType> = {
      'download': 'download-import',
      'import': 'download-import',
      'transcribe': 'transcribe',
      'analyze': 'ai-analyze',
      'fix-aspect-ratio': 'fix-aspect-ratio',
      'normalize-audio': 'normalize-audio'
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

  // Handle URLs added from input
  onUrlsAdded(entries: UrlEntry[]) {
    // Items should go to stagingQueue first, then move to processingQueue when user clicks "Start"
    const staging = [...this.stagingQueue()];
    const processing = [...this.processingQueue()];

    for (const entry of entries) {
      if (entry.loading) {
        // New URL - add to STAGING queue with default tasks
        const id = `url-${++this.queueIdCounter}`;
        const tasks = this.defaultTaskSettings.map(t => ({
          type: t.type,
          options: t.config || {},
          status: 'pending' as const,
          progress: 0
        }));

        staging.push({
          id,
          url: entry.url,
          title: entry.title,
          status: 'pending',
          tasks,
          titleResolved: false // Title is still being fetched
        });
      } else {
        // Metadata update - find and update existing item in EITHER queue
        let itemIndex = staging.findIndex(q => q.url === entry.url);
        if (itemIndex !== -1) {
          const item = staging[itemIndex];
          // Update all metadata fields
          staging[itemIndex] = {
            ...item,
            title: entry.title,
            duration: entry.duration || item.duration,
            thumbnail: entry.thumbnail || item.thumbnail,
            titleResolved: true // Title has been fetched
          };
        } else {
          // Also check processing queue (item might have been moved there already)
          itemIndex = processing.findIndex(q => q.url === entry.url);
          if (itemIndex !== -1) {
            const item = processing[itemIndex];
            // Update all metadata fields
            processing[itemIndex] = {
              ...item,
              title: entry.title,
              duration: entry.duration || item.duration,
              thumbnail: entry.thumbnail || item.thumbnail,
              titleResolved: true // Title has been fetched
            };

            // If download already completed (videoId exists), rename the file
            if (item.videoId && entry.title !== item.title) {
              console.log('Title updated after download - renaming file:', item.videoId, 'to:', entry.title);
              this.renameDownloadedVideo(item.videoId, entry.title);
            }
          }
        }
      }
    }

    this.stagingQueue.set(staging);
    this.processingQueue.set(processing);

    // Switch to Queue tab to show newly added items
    if (entries.some(e => e.loading)) {
      this.setActiveTab('queue');
    }
  }

  // Remove item from queue
  removeFromQueue(id: string) {
    const queue = this.processingQueue().filter(q => q.id !== id);
    this.processingQueue.set(queue);
  }

  // Start processing the queue
  startProcessing() {
    const queue = this.processingQueue();
    const pendingItems = queue.filter(q => q.status === 'pending');

    if (pendingItems.length === 0) return;

    console.log('Starting processing for', pendingItems.length, 'items');

    // Create new queue with updated items
    const newQueue = queue.map(item => {
      if (item.status !== 'pending') return item;

      const settings: VideoJobSettings = this.convertTasksToSettings(item.tasks);
      let jobId: string | undefined;

      if (item.url) {
        // URL download job
        const job = this.videoProcessingService.addJob(item.url, item.title, settings);
        jobId = job.id;
        console.log('Added URL job:', item.title, 'jobId:', jobId);
      } else if (item.videoId) {
        // Library video job
        const job = this.videoProcessingService.addJob('', item.title, settings, item.videoId);
        jobId = job.id;
        console.log('Added library job:', item.title, 'jobId:', jobId);
      }

      // Return new item object with updated status
      return {
        ...item,
        jobId,
        status: 'processing' as const
      };
    });

    this.processingQueue.set(newQueue);

    // Start processing and capture backend job IDs
    this.videoProcessingService.processQueue().subscribe({
      next: (frontendToBackend) => {
        if (frontendToBackend.size > 0) {
          // Update queue items with backend job IDs
          const updatedQueue = this.processingQueue().map(item => {
            if (item.jobId && frontendToBackend.has(item.jobId)) {
              return {
                ...item,
                backendJobId: frontendToBackend.get(item.jobId)
              };
            }
            return item;
          });
          this.processingQueue.set(updatedQueue);
          console.log('Updated queue items with backend job IDs');
        }
      },
      error: (error) => {
        console.error('Failed to start processing:', error);
      }
    });

    console.log('Queue processing started');
  }

  // Convert frontend tasks to backend settings
  private convertTasksToSettings(tasks: ProcessingTask[]): VideoJobSettings {
    const settings: VideoJobSettings = {
      fixAspectRatio: false,
      normalizeAudio: false,
      transcribe: false,
      whisperModel: 'base',
      aiAnalysis: false,
      outputFormat: 'mp4',
      outputQuality: 'high'
    };

    for (const task of tasks) {
      switch (task.type) {
        case 'fix-aspect-ratio':
          settings.fixAspectRatio = true;
          break;
        case 'normalize-audio':
          settings.normalizeAudio = true;
          if (task.options?.targetLevel) {
            settings.audioLevel = task.options.targetLevel;
          }
          break;
        case 'transcribe':
          settings.transcribe = true;
          if (task.options?.model) {
            settings.whisperModel = task.options.model;
          }
          break;
        case 'ai-analyze':
          settings.aiAnalysis = true;
          if (task.options?.aiModel) {
            settings.aiModel = task.options.aiModel;
          }
          if (task.options?.customInstructions) {
            settings.customInstructions = task.options.customInstructions;
          }
          break;
      }
    }

    return settings;
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

    this.configItemIds.set(queueItems.map(q => q.id));
    this.configBulkMode.set(queueItems.length > 1);
    this.configItemSource.set(firstItem.url ? 'url' : 'library');
    this.configExistingTasks.set(existingTasks);
    this.configModalOpen.set(true);
  }

  // Close config modal
  closeConfigModal() {
    this.configModalOpen.set(false);
    this.configItemIds.set([]);
    // Clear any pending videos (user cancelled)
    this.pendingConfigVideos.set([]);
  }

  // Handle config save
  onConfigSave(tasks: QueueItemTask[]) {
    const pendingVideos = this.pendingConfigVideos();
    const itemIds = this.configItemIds();

    if (pendingVideos.length > 0) {
      // Adding new videos from analyzeVideos - add to STAGING queue
      const staging = [...this.stagingQueue()];

      for (const video of pendingVideos) {
        const id = `lib-${++this.queueIdCounter}`;

        staging.push({
          id,
          videoId: video.id,
          title: video.name,
          duration: video.duration,
          thumbnail: video.thumbnailUrl,
          status: 'pending',
          tasks: tasks.map(t => ({
            type: t.type,
            options: t.config || {},
            status: 'pending' as const,
            progress: 0
          })),
          titleResolved: true // Library videos already have resolved titles
        });
      }

      this.stagingQueue.set(staging);

      // Clear pending videos
      this.pendingConfigVideos.set([]);

      // Switch to Queue tab to show staging items
      this.setActiveTab('queue');
    } else {
      // Updating existing staging items
      const staging = [...this.stagingQueue()];
      for (const id of itemIds) {
        const item = staging.find(q => q.id === id);
        if (item) {
          item.tasks = tasks.map(t => ({
            type: t.type,
            options: t.config || {},
            status: 'pending' as const,
            progress: 0
          }));
        }
      }
      this.stagingQueue.set(staging);
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
        // Call backend FTS search
        this.libraryService.searchVideos(query).subscribe({
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

    // Check if these are queue items
    const queueVideos = videos.filter(v => v.id.startsWith('queue-'));
    const libraryVideos = videos.filter(v => !v.id.startsWith('queue-'));

    // Handle queue items differently
    if (queueVideos.length > 0) {
      switch (action) {
        case 'processing':
        case 'analyze':
          // Open config modal for queue items
          const queueIds = queueVideos.map(v => v.id);
          this.openConfigModal(queueIds);
          return;

        case 'delete':
        case 'removeFromQueue':
          // Remove from queue
          queueVideos.forEach(v => {
            const queueTag = v.tags?.find(t => t.startsWith('queue:'));
            if (queueTag) {
              const queueId = queueTag.replace('queue:', '');
              this.removeFromQueue(queueId);
            }
          });
          // If there are also library videos, continue to delete them
          if (libraryVideos.length === 0) return;
          break;

        default:
          // For other actions on queue items, just return (not supported)
          if (libraryVideos.length === 0) return;
      }
    }

    // Handle library items
    const videosToProcess = libraryVideos.length > 0 ? libraryVideos : videos;

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

    // Navigate to editor with video data
    // VideoPlayerComponent expects data wrapped in 'videoEditorData'
    // videoPath is optional - the editor can stream by videoId if path is missing
    this.router.navigate(['/editor'], {
      state: {
        videoEditorData: {
          videoId: video.id,
          videoPath: video.filePath, // May be undefined, editor will use videoId to stream
          videoTitle: video.name
        }
      }
    });
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

  private analyzeVideos(videos: VideoItem[]) {
    if (videos.length === 0) return;

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

    // Open config modal with default tasks (transcribe + ai-analyze)
    const defaultTasks: QueueItemTask[] = [
      {
        type: 'transcribe',
        status: 'pending',
        progress: 0,
        config: { model: 'base' }
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

    // Add to staging queue with default tasks
    const staging = [...this.stagingQueue()];

    uniqueVideoIds.forEach(videoId => {
      const video = allVideos.find(v => v.id === videoId);
      if (video) {
        const id = `lib-${++this.queueIdCounter}`;
        const tasks = this.defaultTaskSettings
          .filter(t => t.type !== 'download-import') // Library items don't need download
          .map(t => ({
            type: t.type,
            options: t.config || {},
            status: 'pending' as const,
            progress: 0
          }));

        staging.push({
          id,
          videoId: video.id,
          title: video.name,
          duration: video.duration,
          thumbnail: video.thumbnailUrl,
          status: 'pending',
          tasks,
          titleResolved: true // Library videos already have resolved titles
        });
      }
    });

    console.log('[ADD TO QUEUE] New staging queue:', staging);
    this.stagingQueue.set(staging);
    console.log('[ADD TO QUEUE] Staging queue after set:', this.stagingQueue());

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
    this.previewSelectedId.set(video.id);
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
   * Open download dialog for adding videos from URLs
   */
  openDownloadDialog() {
    this.downloadDialogOpen.set(true);
  }

  /**
   * Handle download dialog submission - add to staging instantly, then fetch video info asynchronously
   */
  async onDownloadSubmit(items: { url: string; name: string; settings: VideoJobSettings }[]) {
    this.downloadDialogOpen.set(false);

    const staging = [...this.stagingQueue()];
    const queueIds: string[] = [];

    // Add all items to staging IMMEDIATELY with placeholder titles
    for (const item of items) {
      const queueId = `staging-${++this.queueIdCounter}`;
      queueIds.push(queueId);

      // Convert settings to tasks
      const tasks = this.convertSettingsToTasks(item.settings);

      // Add to staging queue with placeholder (title will be resolved asynchronously)
      staging.push({
        id: queueId,
        url: item.url,
        title: item.name || 'Building title...',
        status: 'loading',
        tasks,
        titleResolved: false
      });
    }

    this.stagingQueue.set(staging);

    // Show notification and switch to queue tab IMMEDIATELY
    this.notificationService.success(
      'Videos Added to Staging',
      `Added ${items.length} ${items.length === 1 ? 'video' : 'videos'} to staging queue. Building titles...`
    );

    // Switch to Queue tab immediately
    this.setActiveTab('queue');

    // Now fetch video info asynchronously in the background for each item
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const queueId = queueIds[i];

      console.log(`[FETCH INFO] Starting fetch for ${queueId}: ${item.url}`);

      // Fetch in background (don't await - let them all run in parallel)
      this.http.get<any>(`http://localhost:3000/api/downloader/info?url=${encodeURIComponent(item.url)}`)
        .subscribe({
          next: (response) => {
            console.log(`[FETCH INFO] Response for ${queueId}:`, response);

            if (response && response.title) {
              // Update the staging item with real title
              const currentStaging = this.stagingQueue();
              const itemIndex = currentStaging.findIndex(s => s.id === queueId);

              console.log(`[TITLE UPDATE] Current staging:`, currentStaging);
              console.log(`[TITLE UPDATE] Found item at index ${itemIndex} for queueId ${queueId}`);

              if (itemIndex !== -1) {
                const updatedItem = {
                  ...currentStaging[itemIndex],
                  title: response.title, // Always use fetched title from API
                  duration: this.formatDurationFromSeconds(response.duration),
                  thumbnail: response.thumbnail,
                  status: 'pending' as const,
                  titleResolved: true
                };

                console.log(`[TITLE UPDATE] Updated item:`, updatedItem);

                const updatedStaging = [...currentStaging];
                updatedStaging[itemIndex] = updatedItem;
                this.stagingQueue.set(updatedStaging);

                console.log(`[TITLE UPDATE] Staging queue after update:`, this.stagingQueue());

                successCount++;
                console.log(`[TITLE RESOLVED] ${queueId}: ${updatedItem.title}`);
              } else {
                console.error(`[TITLE UPDATE] Could not find item with queueId ${queueId} in staging`);
              }
            } else {
              console.error('[FETCH INFO] No title in response for:', item.url, response);
              this.updateStagingItemWithError(queueId, 'Failed to fetch video info');
              failCount++;
            }
          },
          error: (error) => {
            console.error('[FETCH INFO] Failed to fetch video info for:', item.url, error);
            this.updateStagingItemWithError(queueId, 'Failed to fetch video info');
            failCount++;
          }
        });
    }
  }

  /**
   * Update a staging item to show an error state
   */
  private updateStagingItemWithError(queueId: string, _errorMessage: string) {
    const currentStaging = this.stagingQueue();
    const itemIndex = currentStaging.findIndex(s => s.id === queueId);

    if (itemIndex !== -1) {
      const updatedItem = {
        ...currentStaging[itemIndex],
        title: currentStaging[itemIndex].title === 'Building title...'
          ? 'Failed to load'
          : currentStaging[itemIndex].title,
        status: 'failed' as const,
        titleResolved: false
      };

      const updatedStaging = [...currentStaging];
      updatedStaging[itemIndex] = updatedItem;
      this.stagingQueue.set(updatedStaging);
    }
  }

  /**
   * Convert VideoJobSettings to ProcessingTask array
   */
  private convertSettingsToTasks(settings: VideoJobSettings): ProcessingTask[] {
    const tasks: ProcessingTask[] = [];

    // Always add download task first
    tasks.push({
      type: 'download-import',
      options: {},
      status: 'pending',
      progress: 0
    });

    if (settings.transcribe) {
      tasks.push({
        type: 'transcribe',
        options: {},
        status: 'pending',
        progress: 0
      });
    }

    if (settings.aiAnalysis) {
      tasks.push({
        type: 'ai-analyze',
        options: { model: settings.aiModel || 'claude-3.5-sonnet' },
        status: 'pending',
        progress: 0
      });
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
      const finalItemsToProcess = finalStaging.filter(item => itemIds.includes(item.id));
      const finalUnresolved = finalItemsToProcess.filter(item => !item.titleResolved);

      if (finalUnresolved.length > 0) {
        this.notificationService.error(
          'Title Building Timeout',
          `Failed to build ${finalUnresolved.length} ${finalUnresolved.length === 1 ? 'title' : 'titles'}. Please try again.`
        );
        return;
      }

      // Update itemsToProcess with the latest data
      const processing = [...this.processingQueue()];

      // Add jobs to video processing service and collect job IDs
      for (const item of finalItemsToProcess) {
        if (item.url) {
          // URL-based item
          const settings = this.convertTasksToSettings(item.tasks);
          this.videoProcessingService.addJob(item.url, item.title, settings);
        } else if (item.videoId) {
          // Library video item
          const settings = this.convertTasksToSettings(item.tasks);
          this.videoProcessingService.addJob('', item.title, settings, item.videoId);
        }

        // Add to processing queue
        processing.push({
          ...item,
          status: 'processing'
        });
      }

      // Send all queued jobs to backend
      this.videoProcessingService.processQueue().subscribe({
        next: () => {
          console.log('Processing started for', finalItemsToProcess.length, 'items');
        },
        error: (error) => {
          console.error('Failed to start processing:', error);
          this.notificationService.error(
            'Processing Failed',
            'Failed to start processing. Please try again.'
          );
        }
      });

      // Remove from staging
      const remainingStaging = finalStaging.filter(item => !itemIds.includes(item.id));
      this.stagingQueue.set(remainingStaging);
      this.processingQueue.set(processing);

      this.notificationService.success(
        'Processing Started',
        `Started processing ${finalItemsToProcess.length} ${finalItemsToProcess.length === 1 ? 'item' : 'items'}`
      );
    } else {
      // All titles already resolved, proceed immediately
      const processing = [...this.processingQueue()];

      // Add jobs to video processing service and collect job IDs
      for (const item of itemsToProcess) {
        if (item.url) {
          // URL-based item
          const settings = this.convertTasksToSettings(item.tasks);
          this.videoProcessingService.addJob(item.url, item.title, settings);
        } else if (item.videoId) {
          // Library video item
          const settings = this.convertTasksToSettings(item.tasks);
          this.videoProcessingService.addJob('', item.title, settings, item.videoId);
        }

        // Add to processing queue
        processing.push({
          ...item,
          status: 'processing'
        });
      }

      // Send all queued jobs to backend
      this.videoProcessingService.processQueue().subscribe({
        next: () => {
          console.log('Processing started for', itemsToProcess.length, 'items');
        },
        error: (error) => {
          console.error('Failed to start processing:', error);
          this.notificationService.error(
            'Processing Failed',
            'Failed to start processing. Please try again.'
          );
        }
      });

      // Remove from staging
      const remainingStaging = staging.filter(item => !itemIds.includes(item.id));
      this.stagingQueue.set(remainingStaging);
      this.processingQueue.set(processing);

      this.notificationService.success(
        'Processing Started',
        `Started processing ${itemsToProcess.length} ${itemsToProcess.length === 1 ? 'item' : 'items'}`
      );
    }
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

    this.configItemIds.set(stagingItems.map(item => item.id));
    this.configBulkMode.set(stagingItems.length > 1);
    this.configItemSource.set(firstItem.url ? 'url' : 'library');
    this.configExistingTasks.set(existingTasks);
    this.configModalOpen.set(true);
  }

  /**
   * Remove selected staging items
   */
  onQueueRemoveSelected(itemIds: string[]) {
    const staging = this.stagingQueue();
    const remaining = staging.filter(item => !itemIds.includes(item.id));
    this.stagingQueue.set(remaining);

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
