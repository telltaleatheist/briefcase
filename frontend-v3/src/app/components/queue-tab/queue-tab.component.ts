import { Component, Input, Output, EventEmitter, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CascadeComponent } from '../cascade/cascade.component';
import { VideoWeek, VideoItem, ItemProgress, ChildrenConfig } from '../../models/video.model';
import { QueueService } from '../../services/queue.service';
import { QueueJob } from '../../models/queue-job.model';

@Component({
  selector: 'app-queue-tab',
  standalone: true,
  imports: [CommonModule, CascadeComponent],
  templateUrl: './queue-tab.component.html',
  styleUrls: ['./queue-tab.component.scss']
})
export class QueueTabComponent {
  private queueService = inject(QueueService);

  // Keep inputs for backward compatibility during migration
  // These are now optional - if not provided, we use QueueService directly
  @Input() progressMapper?: (video: VideoItem) => ItemProgress | null;
  @Input() childrenConfig?: ChildrenConfig;
  @Input() aiProcessingVideoId?: string | null;

  @Output() processAll = new EventEmitter<void>();
  @Output() processSelected = new EventEmitter<string[]>();
  @Output() configureSelected = new EventEmitter<string[]>();
  @Output() removeSelected = new EventEmitter<string[]>();
  @Output() cancelProcessing = new EventEmitter<string[]>();
  @Output() viewInLibrary = new EventEmitter<string>();
  @Output() configureItem = new EventEmitter<VideoItem>();
  @Output() previewRequested = new EventEmitter<VideoItem>();
  @Output() viewAnalysis = new EventEmitter<string>();
  @Output() clearCompleted = new EventEmitter<void>();

  selectedStagingIds = signal<Set<string>>(new Set());
  selectedProcessingIds = signal<Set<string>>(new Set());

  // Computed counts for template
  pendingCount = computed(() => this.queueService.pendingJobs().length);
  processingCount = computed(() => this.queueService.processingJobs().length);
  completedCount = computed(() => this.queueService.completedJobs().length);

  // Combine staging, processing, and completed queues into a single weeks array for cascade
  // Now uses QueueService directly as source of truth
  allQueueWeeks = computed(() => {
    const weeks: VideoWeek[] = [];

    // Add staging section (pending jobs)
    const allJobs = this.queueService.allJobs();
    const pendingJobs = this.queueService.pendingJobs();
    console.log('[QueueTab] allQueueWeeks computed:');
    console.log('  - All jobs:', allJobs.length, allJobs.map(j => ({ id: j.id, state: j.state, title: j.title })));
    console.log('  - Pending jobs:', pendingJobs.length);
    if (pendingJobs.length > 0) {
      const stagingVideos: VideoItem[] = pendingJobs.map(job => ({
        id: `staging-${job.id}`,
        name: job.title,
        duration: job.duration,
        thumbnailUrl: job.thumbnail,
        sourceUrl: job.url,
        tags: [`staging:${job.id}`],
        titleLoading: job.titleResolved === false
      }));

      weeks.push({
        weekLabel: '⏸️ Pending',
        videos: stagingVideos
      });
    }

    // Add processing section
    const processingJobs = this.queueService.processingJobs();
    if (processingJobs.length > 0) {
      const processingVideos: VideoItem[] = processingJobs.map(job => {
        const failedTask = job.tasks?.find(t => t.state === 'failed' && t.errorMessage);
        const errorMessage = failedTask?.errorMessage;

        return {
          id: `processing-${job.id}`,
          name: job.title,
          duration: job.duration,
          thumbnailUrl: job.thumbnail,
          sourceUrl: job.url,
          tags: [`processing:${job.id}`, `status:${job.state}`],
          titleLoading: job.titleResolved === false,
          errorMessage: errorMessage
        };
      });

      weeks.push({
        weekLabel: '⚡ Processing',
        videos: processingVideos
      });
    }

    // Add completed section
    const completedJobs = this.queueService.completedJobs();
    if (completedJobs.length > 0) {
      const completedVideos: VideoItem[] = completedJobs.map(job => {
        const hasFailed = job.tasks?.some(t => t.state === 'failed');
        const failedTask = job.tasks?.find(t => t.state === 'failed' && t.errorMessage);
        const errorMessage = failedTask?.errorMessage;

        // Derive hasTranscript/hasAnalysis from completed tasks
        const hasTranscript = job.tasks?.some(t => t.type === 'transcribe' && t.state === 'completed');
        const hasAnalysis = job.tasks?.some(t => t.type === 'ai-analyze' && t.state === 'completed');

        return {
          id: `completed-${job.id}`,
          name: job.title,
          duration: job.duration,
          thumbnailUrl: job.thumbnail,
          sourceUrl: job.url,
          tags: [`completed:${job.id}`, hasFailed ? 'status:failed' : 'status:completed'],
          errorMessage: errorMessage,
          hasTranscript,
          hasAnalysis,
          // Store actual video ID for navigation to video info page
          videoId: job.videoId
        };
      });

      weeks.push({
        weekLabel: '✅ Completed',
        videos: completedVideos
      });
    }

    return weeks;
  });

  // Computed property for AI processing queue item ID
  aiProcessingQueueItemId = computed(() => {
    const processingJobs = this.queueService.processingJobs();
    const processingItem = processingJobs.find(job => {
      if (job.state !== 'processing') return false;
      return job.tasks.some(task =>
        (task.type === 'transcribe' || task.type === 'ai-analyze') &&
        task.state === 'running'
      );
    });
    return processingItem ? `processing-${processingItem.id}` : null;
  });

  onStagingSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedStagingIds.set(event.ids);
  }

  onProcessingSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedProcessingIds.set(event.ids);
  }

  onVideoAction(event: any) {
    console.log('Video action:', event);

    const { action, videos } = event;

    // Extract IDs from video items, handling staging, processing, and completed prefixes
    const videoIds = videos.map((v: VideoItem) => {
      if (v.id.startsWith('staging-')) {
        return v.id.replace('staging-', '');
      } else if (v.id.startsWith('processing-')) {
        return v.id.replace('processing-', '');
      } else if (v.id.startsWith('completed-')) {
        return v.id.replace('completed-', '');
      }
      return v.id;
    });

    switch (action) {
      case 'processing':
        // Processing config action for staging items
        const configIds = videos
          .filter((v: VideoItem) => v.id.startsWith('staging-'))
          .map((v: VideoItem) => v.id.replace('staging-', ''));
        if (configIds.length > 0) {
          this.configureSelected.emit(configIds);
        }
        break;
      case 'cancel':
        this.cancelProcessing.emit(videoIds);
        break;
      case 'view-in-library':
        if (videoIds.length === 1) {
          this.viewInLibrary.emit(videoIds[0]);
        }
        break;
      case 'view-analysis':
      case 'openInEditor':
        // For completed items, open in RippleCut (video editor)
        const completedIds = videos
          .filter((v: VideoItem) => v.id.startsWith('completed-'))
          .map((v: VideoItem) => v.id.replace('completed-', ''));
        if (completedIds.length === 1) {
          this.viewAnalysis.emit(completedIds[0]);
        }
        break;
      case 'delete':
      case 'remove':
      case 'removeFromQueue':
        // For staging items, remove them directly via QueueService
        const stagingIds = videos
          .filter((v: VideoItem) => v.id.startsWith('staging-'))
          .map((v: VideoItem) => v.id.replace('staging-', ''));
        if (stagingIds.length > 0) {
          // Can remove directly via QueueService, or emit for parent to handle
          this.removeSelected.emit(stagingIds);
        }

        // For completed items, remove them from the queue
        const completedIdsToRemove = videos
          .filter((v: VideoItem) => v.id.startsWith('completed-'))
          .map((v: VideoItem) => v.id.replace('completed-', ''));
        for (const id of completedIdsToRemove) {
          this.queueService.removeJob(id);
        }
        break;
    }
  }

  onProcessAll() {
    this.processAll.emit();
  }

  onProcessSelected() {
    const stagingIds = Array.from(this.selectedStagingIds()).map(id => {
      return id.replace(/^.*staging-/, '');
    });
    this.processSelected.emit(stagingIds);
  }

  onConfigureSelected() {
    const stagingIds = Array.from(this.selectedStagingIds()).map(id => {
      return id.replace(/^.*staging-/, '');
    });
    this.configureSelected.emit(stagingIds);
  }

  onRemoveSelected() {
    const stagingIds = Array.from(this.selectedStagingIds()).map(id => {
      return id.replace(/^.*staging-/, '');
    });
    this.removeSelected.emit(stagingIds);
  }

  onClearCompleted() {
    // Can clear directly via QueueService
    this.queueService.clearCompleted();
    this.clearCompleted.emit();
  }

  onClearPending() {
    // Clear all pending jobs directly via QueueService
    this.queueService.clearPending();
    // Clear any selection
    this.selectedStagingIds.set(new Set());
  }

  onStopProcessing() {
    // Stop all processing and move jobs back to pending
    this.queueService.stopProcessing().subscribe({
      next: () => {
        console.log('[QueueTab] Processing stopped');
      },
      error: (err) => {
        console.error('[QueueTab] Failed to stop processing:', err);
      }
    });
  }
}
