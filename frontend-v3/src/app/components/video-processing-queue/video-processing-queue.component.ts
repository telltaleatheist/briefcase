import { Component, OnInit, OnDestroy, signal, computed, inject, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { QueueItem, QueueItemTask } from '../../models/queue.model';
import { AVAILABLE_TASKS, TaskType } from '../../models/task.model';
import { QueueItemConfigModalComponent } from '../queue-item-config-modal/queue-item-config-modal.component';
import { VideoConfigDialogComponent } from '../video-config-dialog/video-config-dialog.component';
import { UrlInputComponent, UrlEntry } from '../url-input/url-input.component';
import { VideoProcessingService } from '../../services/video-processing.service';
import { VideoJob, VideoJobSettings } from '../../models/video-processing.model';

@Component({
  selector: 'app-video-processing-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, QueueItemConfigModalComponent, VideoConfigDialogComponent, UrlInputComponent],
  templateUrl: './video-processing-queue.component.html',
  styleUrls: ['./video-processing-queue.component.scss']
})
export class VideoProcessingQueueComponent implements OnInit, OnDestroy, AfterViewInit {
  private videoProcessingService = inject(VideoProcessingService);
  private router = inject(Router);

  @ViewChild(UrlInputComponent) urlInputComponent!: UrlInputComponent;

  // Queue items
  items = signal<QueueItem[]>([]);

  // Expanded item (accordion)
  expandedItemId = signal<string | null>(null);

  // Modal states
  configModalOpen = signal(false);
  addVideoDialogOpen = signal(false);

  // Config modal context
  configItemId = signal<string | null>(null);
  configBulkMode = signal(false);
  configItemSource = signal<'url' | 'library'>('library');
  configExistingTasks = signal<QueueItemTask[]>([]);

  // Accordion
  completedOpen = signal(false);

  // Processing state
  isProcessing = signal(false);

  // Focus URL input flag (set via navigation state)
  private shouldFocusUrlInput = false;

  private destroy$ = new Subject<void>();

  // Computed values
  pendingItems = computed(() =>
    this.items().filter(i => i.status === 'pending' || i.status === 'running')
  );

  completedItems = computed(() =>
    this.items().filter(i => i.status === 'completed' || i.status === 'failed')
  );

  stats = computed(() => ({
    total: this.items().length,
    pending: this.items().filter(i => i.status === 'pending').length,
    running: this.items().filter(i => i.status === 'running').length,
    completed: this.items().filter(i => i.status === 'completed').length,
    failed: this.items().filter(i => i.status === 'failed').length
  }));

  ngOnInit(): void {
    // Subscribe to VideoProcessingService jobs
    this.videoProcessingService.getJobs()
      .pipe(takeUntil(this.destroy$))
      .subscribe(jobs => {
        const queueItems = jobs.map(job => this.convertJobToQueueItem(job));
        console.log('Items updated from jobs subscription:', queueItems.map(q => ({
          id: q.id,
          taskCount: q.tasks.length,
          taskTypes: q.tasks.map(t => t.type)
        })));
        this.items.set(queueItems);
      });

    // Check for navigation state to open config modal or focus URL input
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || history.state;
    if (state?.openConfigForJob) {
      // Delay to ensure items are loaded
      setTimeout(() => {
        this.openConfig(state.openConfigForJob);
      }, 100);
    }
    if (state?.focusUrlInput) {
      this.shouldFocusUrlInput = true;
    }
  }

  ngAfterViewInit(): void {
    // Focus URL input if requested via navigation state
    if (this.shouldFocusUrlInput && this.urlInputComponent) {
      setTimeout(() => {
        this.urlInputComponent.focus();
      }, 100);
    }
  }

  private convertJobToQueueItem(job: VideoJob): QueueItem {
    const tasks: QueueItemTask[] = [];

    // Combine download and import into a single displayed task
    const downloadTask = job.tasks.find(t => t.type === 'download');
    const importTask = job.tasks.find(t => t.type === 'import');

    if (downloadTask || importTask) {
      // Combine progress: download is first half, import is second half
      let combinedProgress = 0;
      let combinedStatus: 'pending' | 'running' | 'completed' | 'failed' = 'pending';

      if (downloadTask && importTask) {
        if (importTask.status === 'completed') {
          combinedProgress = 100;
          combinedStatus = 'completed';
        } else if (importTask.status === 'in-progress') {
          combinedProgress = 50 + (importTask.progress / 2);
          combinedStatus = 'running';
        } else if (downloadTask.status === 'completed') {
          combinedProgress = 50;
          combinedStatus = 'running';
        } else if (downloadTask.status === 'in-progress') {
          combinedProgress = downloadTask.progress / 2;
          combinedStatus = 'running';
        } else if (downloadTask.status === 'failed' || importTask.status === 'failed') {
          combinedStatus = 'failed';
        }
      } else if (downloadTask) {
        combinedProgress = downloadTask.progress;
        combinedStatus = this.mapTaskStatus(downloadTask.status);
      } else if (importTask) {
        combinedProgress = importTask.progress;
        combinedStatus = this.mapTaskStatus(importTask.status);
      }

      tasks.push({
        type: 'download-import',
        status: combinedStatus,
        progress: combinedProgress,
        config: {}
      });
    }

    // Add other tasks (not download/import) with their configs from job.settings
    for (const task of job.tasks) {
      if (task.type === 'download' || task.type === 'import') continue;

      const taskType = this.mapTaskType(task.type);
      const config = this.getConfigForTask(taskType, job.settings);

      tasks.push({
        type: taskType,
        status: this.mapTaskStatus(task.status),
        progress: task.progress,
        config
      });
    }

    return {
      id: job.id,
      source: job.videoUrl ? 'url' : 'library',
      url: job.videoUrl,
      urlTitle: job.videoName,
      tasks,
      status: this.mapJobStatus(job.status),
      overallProgress: job.progress
    };
  }

  private mapTaskType(type: string): TaskType {
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

  private mapTaskStatus(status: string): 'pending' | 'running' | 'completed' | 'failed' {
    const mapping: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = {
      'pending': 'pending',
      'in-progress': 'running',
      'completed': 'completed',
      'failed': 'failed',
      'skipped': 'completed'
    };
    return mapping[status] || 'pending';
  }

  private mapJobStatus(status: string): 'pending' | 'running' | 'completed' | 'failed' {
    const mapping: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = {
      'queued': 'pending',
      'processing': 'running',
      'completed': 'completed',
      'failed': 'failed',
      'paused': 'pending'
    };
    return mapping[status] || 'pending';
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // Accordion
  toggleItemExpanded(id: string): void {
    if (this.expandedItemId() === id) {
      this.expandedItemId.set(null);
    } else {
      this.expandedItemId.set(id);
    }
  }

  isItemExpanded(id: string): boolean {
    return this.expandedItemId() === id;
  }

  // Configuration modal
  openConfig(itemId: string): void {
    const item = this.items().find(i => i.id === itemId);
    console.log('openConfig for item:', itemId);
    console.log('Item tasks:', item?.tasks);
    console.log('Task configs:', item?.tasks?.map(t => ({ type: t.type, config: t.config })));
    this.configItemId.set(itemId);
    this.configBulkMode.set(false);
    this.configItemSource.set(item?.source || 'library');
    this.configExistingTasks.set(item?.tasks || []);
    this.configModalOpen.set(true);
  }


  closeConfig(): void {
    this.configModalOpen.set(false);
    this.configItemId.set(null);
    this.configBulkMode.set(false);
  }

  onConfigSave(tasks: QueueItemTask[]): void {
    const itemId = this.configItemId();
    if (itemId) {
      // Update the VideoProcessingService with task types and configs
      const taskTypes = tasks.map(t => t.type);
      const taskConfigs = new Map<string, any>();
      tasks.forEach(t => {
        if (t.config) {
          taskConfigs.set(t.type, t.config);
        }
      });
      this.videoProcessingService.updateJobFromTaskTypes(itemId, taskTypes, taskConfigs);
    }
    this.closeConfig();
  }

  // Add video dialog
  openAddDialog(): void {
    this.addVideoDialogOpen.set(true);
  }

  closeAddDialog(): void {
    this.addVideoDialogOpen.set(false);
  }

  onAddVideo(configs: { url: string; name: string; settings: any }[]): void {
    // Add all jobs via the service
    configs.forEach(config => {
      this.videoProcessingService.addJob(config.url, config.name, config.settings);
    });
    this.closeAddDialog();
  }

  // URL input handling
  onUrlsAdded(entries: UrlEntry[]): void {
    entries.forEach(entry => {
      if (entry.loading) {
        // New item - add to queue with placeholder title
        const settings: VideoJobSettings = {
          fixAspectRatio: false,
          normalizeAudio: false,
          transcribe: false,
          whisperModel: 'base',
          aiAnalysis: false,
          outputFormat: 'mp4',
          outputQuality: 'high'
        };
        this.videoProcessingService.addJob(entry.url, entry.title, settings);
      } else {
        // Title update - find job by URL and update name
        this.videoProcessingService.updateJobNameByUrl(entry.url, entry.title);
      }
    });
  }

  // Focus URL input (for external calls)
  focusUrlInput(): void {
    if (this.urlInputComponent) {
      this.urlInputComponent.focus();
    }
  }

  // Bulk configuration
  openBulkConfig(): void {
    // Determine source based on pending items
    const hasUrlItems = this.pendingItems().some(item => item.source === 'url');
    this.configItemId.set(null);
    this.configBulkMode.set(true);
    this.configItemSource.set(hasUrlItems ? 'url' : 'library');
    this.configExistingTasks.set([]);
    this.configModalOpen.set(true);
  }

  onBulkConfigSave(tasks: QueueItemTask[]): void {
    console.log('onBulkConfigSave called with tasks:', tasks);

    // Apply tasks to all pending items
    const pendingIds = this.pendingItems()
      .filter(item => item.status === 'pending')
      .map(item => item.id);

    console.log('Pending item IDs:', pendingIds);
    console.log('All pending items:', this.pendingItems());

    // Convert tasks to settings
    const taskTypes = tasks.map(t => t.type);
    const taskConfigs = new Map<string, any>();
    tasks.forEach(t => {
      if (t.config) {
        taskConfigs.set(t.type, t.config);
      }
    });

    console.log('Task types to apply:', taskTypes);

    // Update each pending item
    pendingIds.forEach(id => {
      console.log('Updating job:', id);
      this.videoProcessingService.updateJobFromTaskTypes(id, taskTypes, taskConfigs);
    });

    // Visual feedback: expand first item to show updated tasks
    if (pendingIds.length > 0) {
      this.expandedItemId.set(pendingIds[0]);
    }

    console.log(`Bulk config applied: ${taskTypes.length} tasks to ${pendingIds.length} items`);
    this.closeConfig();
  }

  // Queue actions
  processQueue(): void {
    this.isProcessing.set(true);
    this.videoProcessingService.processQueue();
  }

  removeItem(id: string): void {
    this.videoProcessingService.removeJob(id);
    // Collapse if this was the expanded item
    if (this.expandedItemId() === id) {
      this.expandedItemId.set(null);
    }
  }


  clearCompleted(): void {
    this.videoProcessingService.clearCompleted();
  }

  // Accordion
  toggleCompleted(): void {
    this.completedOpen.set(!this.completedOpen());
  }

  // Helpers
  getTaskIcon(type: TaskType): string {
    const task = AVAILABLE_TASKS.find(t => t.type === type);
    return task?.icon || '📋';
  }

  getTaskLabel(type: TaskType): string {
    const task = AVAILABLE_TASKS.find(t => t.type === type);
    return task?.label || type;
  }

  getItemName(item: QueueItem): string {
    if (item.video) {
      return item.video.name;
    }
    return item.urlTitle || item.url || 'Unknown';
  }

  getItemSource(itemId: string | null): 'url' | 'library' {
    if (!itemId) {
      // Bulk mode: determine source based on pending items
      // If any item is URL-based, return 'url' to show all available tasks
      const hasUrlItems = this.pendingItems().some(item => item.source === 'url');
      return hasUrlItems ? 'url' : 'library';
    }
    const item = this.items().find(i => i.id === itemId);
    return item?.source || 'library';
  }

  getExistingTasks(itemId: string | null): QueueItemTask[] {
    if (!itemId) return [];
    const item = this.items().find(i => i.id === itemId);
    return item?.tasks || [];
  }

  formatProgress(progress: number | undefined): string {
    return `${Math.round(progress || 0)}%`;
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  private getConfigForTask(taskType: TaskType, settings: VideoJobSettings): any {
    switch (taskType) {
      case 'transcribe':
        return {
          model: settings.whisperModel || 'base',
          language: settings.whisperLanguage || '',
          translate: false
        };
      case 'ai-analyze':
        // Reconstruct the full model ID with provider prefix
        console.log('getConfigForTask ai-analyze - settings.aiModel:', settings.aiModel);
        let aiModel = settings.aiModel || 'ollama:qwen2.5:7b';
        // If the model doesn't have a provider prefix, assume ollama
        if (aiModel && !aiModel.includes(':')) {
          aiModel = `ollama:${aiModel}`;
        } else if (aiModel && aiModel.split(':').length === 2) {
          // Model like "qwen2.5:32b" needs ollama prefix
          const parts = aiModel.split(':');
          if (!['ollama', 'claude', 'openai'].includes(parts[0])) {
            aiModel = `ollama:${aiModel}`;
          }
        }
        return {
          aiModel,
          customInstructions: settings.customInstructions || ''
        };
      case 'fix-aspect-ratio':
        return {
          targetRatio: settings.aspectRatio || '16:9',
          cropMode: 'smart'
        };
      case 'normalize-audio':
        return {
          targetLevel: settings.audioLevel || -16,
          peakLevel: -1
        };
      default:
        return {};
    }
  }
}
