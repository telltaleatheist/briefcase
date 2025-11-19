import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { QueueItem, QueueItemTask } from '../../models/queue.model';
import { AVAILABLE_TASKS, TaskType } from '../../models/task.model';
import { QueueItemConfigModalComponent } from '../queue-item-config-modal/queue-item-config-modal.component';
import { VideoConfigDialogComponent } from '../video-config-dialog/video-config-dialog.component';
import { VideoProcessingService } from '../../services/video-processing.service';
import { VideoJob } from '../../models/video-processing.model';

@Component({
  selector: 'app-video-processing-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, QueueItemConfigModalComponent, VideoConfigDialogComponent],
  templateUrl: './video-processing-queue.component.html',
  styleUrls: ['./video-processing-queue.component.scss']
})
export class VideoProcessingQueueComponent implements OnInit, OnDestroy {
  private videoProcessingService = inject(VideoProcessingService);
  private router = inject(Router);

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

  // Accordion
  completedOpen = signal(false);

  // Processing state
  isProcessing = signal(false);

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
        this.items.set(queueItems);
      });

    // Check for navigation state to open config modal
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || history.state;
    if (state?.openConfigForJob) {
      // Delay to ensure items are loaded
      setTimeout(() => {
        this.openConfig(state.openConfigForJob);
      }, 100);
    }
  }

  private convertJobToQueueItem(job: VideoJob): QueueItem {
    const tasks: QueueItemTask[] = job.tasks.map(task => ({
      type: this.mapTaskType(task.type),
      status: this.mapTaskStatus(task.status),
      progress: task.progress,
      config: {}
    }));

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
    this.configItemId.set(itemId);
    this.configBulkMode.set(false);
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
    if (!itemId) return 'library';
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
}
