import { Component, Input, Output, EventEmitter, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CascadeComponent } from '../cascade/cascade.component';
import { VideoWeek, VideoItem, ItemProgress, ChildrenConfig } from '../../models/video.model';
import { ProcessingQueueItem } from '../../pages/library/library-page.component';

@Component({
  selector: 'app-queue-tab',
  standalone: true,
  imports: [CommonModule, CascadeComponent],
  templateUrl: './queue-tab.component.html',
  styleUrls: ['./queue-tab.component.scss']
})
export class QueueTabComponent {
  constructor() {
    console.log('[QueueTab] Component created');
  }

  // Use signals for reactive inputs
  private _stagingQueue = signal<ProcessingQueueItem[]>([]);
  private _processingQueue = signal<ProcessingQueueItem[]>([]);
  private _completedQueue = signal<ProcessingQueueItem[]>([]);

  @Input() set stagingQueue(value: ProcessingQueueItem[]) {
    console.log('[QueueTab] Staging queue INPUT setter called with:', value?.length, 'items');
    this._stagingQueue.set(value);
  }
  get stagingQueue(): ProcessingQueueItem[] {
    return this._stagingQueue();
  }

  @Input() set processingQueue(value: ProcessingQueueItem[]) {
    console.log('[QueueTab] Processing queue INPUT setter called with:', value?.length, 'items');
    this._processingQueue.set(value);
  }
  get processingQueue(): ProcessingQueueItem[] {
    return this._processingQueue();
  }

  @Input() set completedQueue(value: ProcessingQueueItem[]) {
    console.log('[QueueTab] Completed queue INPUT setter called with:', value?.length, 'items');
    this._completedQueue.set(value);
  }
  get completedQueue(): ProcessingQueueItem[] {
    return this._completedQueue();
  }

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

  // Combine staging, processing, and completed queues into a single weeks array for cascade
  allQueueWeeks = computed(() => {
    const weeks: VideoWeek[] = [];

    // Add staging section if there are items
    const stagingQueue = this._stagingQueue();
    console.log('[QueueTab] Staging queue length:', stagingQueue.length);
    if (stagingQueue.length > 0) {
      const stagingVideos: VideoItem[] = stagingQueue.map(item => ({
        id: `staging-${item.id}`,
        name: item.title,
        duration: item.duration,
        thumbnailUrl: item.thumbnail,
        sourceUrl: item.url,
        tags: [`staging:${item.id}`],
        titleLoading: item.titleResolved === false // Show spinner if title not yet resolved
      }));

      weeks.push({
        weekLabel: '⏸️ Staging',
        videos: stagingVideos
      });
    }

    // Add processing section if there are items
    const processingQueue = this._processingQueue();
    console.log('[QueueTab] Processing queue length:', processingQueue.length);
    if (processingQueue.length > 0) {
      const processingVideos: VideoItem[] = processingQueue.map(item => {
        // Get error message from any failed task
        const failedTask = item.tasks?.find(t => t.status === 'failed' && t.errorMessage);
        const errorMessage = failedTask?.errorMessage;

        return {
          id: `processing-${item.id}`,
          name: item.title,
          duration: item.duration,
          thumbnailUrl: item.thumbnail,
          sourceUrl: item.url,
          tags: [`processing:${item.id}`, `status:${item.status}`],
          titleLoading: item.titleResolved === false, // Show spinner if title not yet resolved
          errorMessage: errorMessage
        };
      });

      weeks.push({
        weekLabel: '⚡ Processing',
        videos: processingVideos
      });
    }

    // Add completed section if there are items
    const completedQueue = this._completedQueue();
    console.log('[QueueTab] Completed queue length:', completedQueue.length);
    if (completedQueue.length > 0) {
      const completedVideos: VideoItem[] = completedQueue.map(item => {
        // Determine if any task failed
        const hasFailed = item.tasks?.some(t => t.status === 'failed');
        const failedTask = item.tasks?.find(t => t.status === 'failed' && t.errorMessage);
        const errorMessage = failedTask?.errorMessage;

        return {
          id: `completed-${item.id}`,
          name: item.title,
          duration: item.duration,
          thumbnailUrl: item.thumbnail,
          sourceUrl: item.url,
          tags: [`completed:${item.id}`, hasFailed ? 'status:failed' : 'status:completed'],
          errorMessage: errorMessage
        };
      });

      weeks.push({
        weekLabel: '✅ Completed',
        videos: completedVideos
      });
    }

    console.log('[QueueTab] All queue weeks:', weeks);
    console.log('[QueueTab] Total weeks count:', weeks.length);
    return weeks;
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
        // For staging items, remove them
        const stagingIds = videos
          .filter((v: VideoItem) => v.id.startsWith('staging-'))
          .map((v: VideoItem) => v.id.replace('staging-', ''));
        if (stagingIds.length > 0) {
          this.removeSelected.emit(stagingIds);
        }
        break;
    }
  }

  onProcessAll() {
    this.processAll.emit();
  }

  onProcessSelected() {
    // Extract staging item IDs from selected IDs (format: "staging-{id}")
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
}
