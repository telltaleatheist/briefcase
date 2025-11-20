import { Component, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy, computed, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { LibrarySearchFiltersComponent, LibraryFilters } from '../../components/library-search-filters/library-search-filters.component';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { UrlInputComponent, UrlEntry } from '../../components/url-input/url-input.component';
import { QueueItemConfigModalComponent } from '../../components/queue-item-config-modal/queue-item-config-modal.component';
import { AiSetupWizardComponent } from '../../components/ai-setup-wizard/ai-setup-wizard.component';
import { VideoWeek, VideoItem, ChildrenConfig, VideoChild, ItemProgress } from '../../models/video.model';
import { Library, NewLibrary, RelinkLibrary } from '../../models/library.model';
import { QueueItemTask } from '../../models/queue.model';
import { TaskType, AVAILABLE_TASKS } from '../../models/task.model';
import { LibraryService } from '../../services/library.service';
import { WebsocketService, TaskCompleted, TaskProgress } from '../../services/websocket.service';
import { VideoProcessingService } from '../../services/video-processing.service';
import { AiSetupService } from '../../services/ai-setup.service';
import { VideoJobSettings } from '../../models/video-processing.model';

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
    AiSetupWizardComponent
  ],
  templateUrl: './library-page.component.html',
  styleUrls: ['./library-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LibraryPageComponent implements OnInit, OnDestroy {
  private libraryService = inject(LibraryService);
  private router = inject(Router);
  private websocketService = inject(WebsocketService);
  private videoProcessingService = inject(VideoProcessingService);
  private aiSetupService = inject(AiSetupService);

  @ViewChild(CascadeComponent) private cascadeComponent?: CascadeComponent;
  @ViewChild(UrlInputComponent) private urlInputComponent?: UrlInputComponent;

  // AI Setup wizard state
  aiWizardOpen = signal(false);

  videoWeeks = signal<VideoWeek[]>([]);
  filteredWeeks = signal<VideoWeek[]>([]);

  // Processing queue state (local, not yet sent to backend)
  processingQueue = signal<ProcessingQueueItem[]>([]);

  // Queue UI state
  queueExpanded = signal(true);
  expandedQueueItems = signal<Set<string>>(new Set());
  selectedQueueItems = signal<Set<string>>(new Set());

  // Queue videos for template
  queueVideos = computed(() => this.processingQueue());

  // Combined weeks including processing section
  combinedWeeks = computed(() => {
    const queue = this.processingQueue();
    const library = this.filteredWeeks();

    if (queue.length === 0) {
      return library;
    }

    // Convert queue items to VideoItem format for the cascade
    const processingVideos: VideoItem[] = queue.map(item => {
      // Get status text for display
      let statusText = 'Queued';
      if (item.status === 'processing') {
        const runningTask = item.tasks.find(t => t.status === 'running');
        if (runningTask) {
          statusText = `${runningTask.type}: ${runningTask.progress}%`;
        } else {
          statusText = 'Processing...';
        }
      } else if (item.status === 'completed') {
        statusText = 'Completed';
      } else if (item.status === 'failed') {
        statusText = 'Failed';
      } else if (item.status === 'pending') {
        statusText = 'Queued';
      }

      // Calculate overall progress for change detection
      const totalProgress = item.tasks.reduce((sum, t) => sum + t.progress, 0);
      const avgProgress = item.tasks.length > 0 ? Math.round(totalProgress / item.tasks.length) : 0;

      return {
        id: `queue-${item.id}`,
        name: item.title,
        duration: item.duration,
        thumbnailUrl: item.thumbnail,
        sourceUrl: item.url,
        // Use suggestedTitle to display status (shows in cascade with special styling)
        suggestedTitle: statusText,
        // Store queue data in a way we can retrieve it
        // Include progress in tags to trigger re-renders when progress changes
        tags: [`queue:${item.id}`, `status:${item.status}`, `progress:${avgProgress}`]
      };
    });

    // Create processing queue section with header
    const processingWeek: VideoWeek = {
      weekLabel: 'Processing Queue',
      videos: processingVideos
    };

    return [processingWeek, ...library];
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
    // Only provide progress for queue items
    const queueTag = video.tags?.find(t => t.startsWith('queue:'));
    if (!queueTag) return null;

    const queueId = queueTag.replace('queue:', '');
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

  // Filters
  currentFilters: LibraryFilters | null = null;

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
  }

  async ngOnInit() {
    // Load processing queue from localStorage first
    this.loadProcessingQueueFromStorage();
    this.isLoadingQueue = false;

    this.loadDefaultTaskSettings();

    // Subscribe to websocket events
    this.websocketService.connect();

    // Check for first-time setup
    await this.checkFirstTimeSetup();

    // Task completion - refresh library and update queue
    this.websocketService.onTaskCompleted((event: TaskCompleted) => {
      console.log('Task completed:', event);

      // Translate backend job ID to frontend job ID
      const frontendJobId = this.videoProcessingService.getFrontendJobId(event.jobId) || event.jobId;

      // Update queue item task status first
      this.updateQueueTaskStatus(frontendJobId, event.type, 'completed', 100);

      // Refresh library when a task completes
      if (event.type === 'analyze' || event.type === 'transcribe' || event.type === 'import' || event.type === 'download') {
        this.loadCurrentLibrary();
      }

      // Check if all tasks are complete and remove from queue
      const queue = this.processingQueue();
      // Find item by frontend job ID, backend job ID, or via localStorage mapping
      let item = queue.find(q => q.jobId === frontendJobId);
      if (!item) {
        item = queue.find(q => q.backendJobId === event.jobId);
      }
      if (!item) {
        // Try localStorage mapping
        try {
          const mapping = localStorage.getItem('clippy-job-id-mapping');
          if (mapping) {
            const jobIdMap: Record<string, string> = JSON.parse(mapping);
            const mappedFrontendId = jobIdMap[event.jobId];
            if (mappedFrontendId) {
              item = queue.find(q => q.jobId === mappedFrontendId);
            }
          }
        } catch (e) {
          // Ignore errors
        }
      }

      if (item) {
        // Only remove if ALL tasks are completed and NONE are pending/running
        const allTasksComplete = item.tasks.length > 0 &&
          item.tasks.every(t => t.status === 'completed') &&
          !item.tasks.some(t => t.status === 'pending' || t.status === 'running');

        console.log('Completion check for', item.title, ':',
          item.tasks.map(t => `${t.type}:${t.status}`).join(', '),
          '- all complete:', allTasksComplete);

        if (allTasksComplete) {
          // Remove after brief delay to show completion
          setTimeout(() => {
            this.removeFromQueue(item!.id);
          }, 1500);
        }
      }
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
    const saved = localStorage.getItem('clippy-task-defaults');
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
      localStorage.removeItem('clippy-task-defaults');
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
    localStorage.setItem('clippy-task-defaults', JSON.stringify({
      tasks,
      savedAt: new Date().toISOString()
    }));
    this.defaultTaskSettings = tasks;
  }

  // Save processing queue to localStorage
  private saveProcessingQueueToStorage(queue: ProcessingQueueItem[]) {
    try {
      localStorage.setItem('clippy-processing-queue', JSON.stringify(queue));

      // Also save the processing flags (video IDs that are in queue)
      const processingVideoIds = queue
        .filter(item => item.videoId)
        .map(item => item.videoId!);
      localStorage.setItem('clippy-processing-flags', JSON.stringify(processingVideoIds));

      // Save the backend-to-frontend job ID mapping for items that have started processing
      const jobIdMapping: Record<string, string> = {};
      queue.forEach(item => {
        if (item.jobId && item.backendJobId) {
          jobIdMapping[item.backendJobId] = item.jobId;
        }
      });
      localStorage.setItem('clippy-job-id-mapping', JSON.stringify(jobIdMapping));
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
      const saved = localStorage.getItem('clippy-processing-flags');
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
      const saved = localStorage.getItem('clippy-processing-queue');
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
      localStorage.removeItem('clippy-processing-queue');
    }
  }

  // Generate task children for a queue item
  private generateTaskChildren(video: VideoItem): VideoChild[] {
    // Check if this is a queue item
    const queueTag = video.tags?.find(t => t.startsWith('queue:'));
    if (!queueTag) return [];

    const queueId = queueTag.replace('queue:', '');
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
    const queueTag = video.tags?.find(t => t.startsWith('queue:'));
    if (!queueTag) return 0;

    const queueId = queueTag.replace('queue:', '');
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
        const mapping = localStorage.getItem('clippy-job-id-mapping');
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

  // Handle URLs added from input
  onUrlsAdded(entries: UrlEntry[]) {
    // Create a new array to avoid mutating the original
    const queue = [...this.processingQueue()];

    for (const entry of entries) {
      if (entry.loading) {
        // New URL - add to queue with default tasks
        const id = `url-${++this.queueIdCounter}`;
        const tasks = this.defaultTaskSettings.map(t => ({
          type: t.type,
          options: t.config || {},
          status: 'pending' as const,
          progress: 0
        }));

        queue.push({
          id,
          url: entry.url,
          title: entry.title,
          status: 'pending',
          tasks
        });
      } else {
        // Title update - find and update existing item
        const itemIndex = queue.findIndex(q => q.url === entry.url);
        if (itemIndex !== -1) {
          queue[itemIndex] = { ...queue[itemIndex], title: entry.title };
        }
      }
    }

    this.processingQueue.set(queue);
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
    const queue = [...this.processingQueue()];

    if (pendingVideos.length > 0) {
      // Adding new videos from analyzeVideos - create queue items
      for (const video of pendingVideos) {
        const id = `lib-${++this.queueIdCounter}`;

        queue.push({
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
          }))
        });
      }

      // Clear pending videos
      this.pendingConfigVideos.set([]);
    } else {
      // Updating existing queue items
      for (const id of itemIds) {
        const item = queue.find(q => q.id === id);
        if (item) {
          item.tasks = tasks.map(t => ({
            type: t.type,
            options: t.config || {},
            status: 'pending' as const,
            progress: 0
          }));
        }
      }
    }

    this.processingQueue.set(queue);

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

  // Check if there are pending queue items
  get hasPendingItems(): boolean {
    return this.processingQueue().some(q => q.status === 'pending');
  }

  // Get queue stats
  get queueStats() {
    const queue = this.processingQueue();
    return {
      total: queue.length,
      pending: queue.filter(q => q.status === 'pending').length,
      processing: queue.filter(q => q.status === 'processing').length
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
    this.libraryService.getVideosByWeek().subscribe({
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
        // Open library manager if no library is set
        this.openLibraryManager();
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
        alert('Failed to switch library. Please try again.');
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
        alert('Failed to create library. Please try again.');
      }
    });
  }

  onLibraryRelinked(relink: RelinkLibrary) {
    this.libraryService.importLibrary(relink.path).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Load videos for imported library
          this.loadLibraries(); // Refresh libraries list
        }
      },
      error: (error) => {
        console.error('Failed to import library:', error);
        const message = error.error?.error || 'Failed to import library. Make sure the folder contains a .library.db file.';
        alert(message);
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

    // No search query - apply sorting to all videos
    const weeks = this.videoWeeks().map(week => ({
      weekLabel: week.weekLabel,
      videos: [...week.videos]
    }));
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
        if (a.weekLabel === 'Past 24 Hours') return ascending ? 1 : -1;
        if (b.weekLabel === 'Past 24 Hours') return ascending ? -1 : 1;
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
  }

  onVideoAction(event: { action: string; videos: VideoItem[] }) {
    const { action, videos } = event;

    // Check if these are queue items
    const queueVideos = videos.filter(v => v.id.startsWith('queue-'));
    const libraryVideos = videos.filter(v => !v.id.startsWith('queue-'));

    // Handle queue items differently
    if (queueVideos.length > 0) {
      switch (action) {
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
        alert(`View details: ${videosToProcess[0]?.name}\n\nThis feature will show video metadata, transcript, and analysis.`);
        break;

      case 'addToTab':
        // TODO: Open tab selector dialog
        console.log('Add to tab:', videosToProcess.map(v => v.name));
        alert(`Add ${videosToProcess.length} video(s) to tab\n\nThis feature will open a dialog to select or create a tab.`);
        break;

      case 'analyze':
        this.analyzeVideos(videosToProcess);
        break;

      case 'moveToLibrary':
        // TODO: Open library selector dialog
        console.log('Move to library:', videosToProcess.map(v => v.name));
        alert(`Move ${videosToProcess.length} video(s) to another library\n\nThis feature will open a dialog to select a target library.`);
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
        } else {
          console.warn('Unknown video action:', action);
        }
    }
  }

  openInEditor(video?: VideoItem) {
    // If no video passed, get first selected video
    if (!video) {
      const selectedItemIds = this.selectedVideoIds();

      if (selectedItemIds.size === 0) {
        alert('Please select a video first');
        return;
      }

      if (selectedItemIds.size !== 1) {
        alert('Please select exactly one video to open in editor');
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
      alert('Could not find selected video');
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
      alert('Please select a video first');
      return;
    }

    if (selectedItemIds.size !== 1) {
      alert('Please select exactly one video to view details');
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

    // Store videos pending configuration (not added to queue yet)
    this.pendingConfigVideos.set(videos);

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
          alert(`Failed to delete: ${video.name}`);
        }
      });
    });
  }

  onAddSelectedToQueue() {
    if (this.selectedCount() === 0) {
      alert('Please select at least one video');
      return;
    }

    // Get selected videos and add them to queue
    const allVideos: VideoItem[] = [];
    this.videoWeeks().forEach(week => {
      allVideos.push(...week.videos);
    });

    const selectedItemIds = this.selectedVideoIds();

    // Extract unique video IDs from itemIds (format: "weekLabel|videoId")
    const uniqueVideoIds = new Set<string>();
    selectedItemIds.forEach(itemId => {
      const parts = itemId.split('|');
      const videoId = parts.length > 1 ? parts[1] : itemId;
      // Skip queue items
      if (!videoId.startsWith('queue-')) {
        uniqueVideoIds.add(videoId);
      }
    });

    if (uniqueVideoIds.size === 0) return;

    // Add to local queue with default tasks
    const queue = this.processingQueue();

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

        queue.push({
          id,
          videoId: video.id,
          title: video.name,
          duration: video.duration,
          status: 'pending',
          tasks
        });
      }
    });

    this.processingQueue.set([...queue]);

    // Clear selection
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
}
