import { Component, EventEmitter, Input, Output, signal, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { QueueItem, QueueItemTask } from '../../models/queue.model';
import { AVAILABLE_TASKS, Task, TaskType } from '../../models/task.model';
import { QueueItemConfigModalComponent } from '../queue-item-config-modal/queue-item-config-modal.component';

@Component({
  selector: 'app-processing-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, QueueItemConfigModalComponent],
  templateUrl: './processing-queue.component.html',
  styleUrls: ['./processing-queue.component.scss']
})
export class ProcessingQueueComponent {
  @Input() items: QueueItem[] = [];
  @Input() expanded = true;

  @Output() close = new EventEmitter<void>();
  @Output() removeItem = new EventEmitter<string>();
  @Output() clearQueue = new EventEmitter<void>();
  @Output() processQueue = new EventEmitter<void>();
  @Output() urlAdded = new EventEmitter<string>();
  @Output() toggleExpanded = new EventEmitter<void>();
  @Output() itemTasksUpdated = new EventEmitter<{ itemId: string, tasks: QueueItemTask[] }>();

  @ViewChild('urlInputEl') urlInputEl?: ElementRef<HTMLInputElement>;

  urlInput = signal('');
  showUrlInput = signal(false);

  /**
   * Focus the URL input field - called from parent component
   */
  focusUrlInput(): void {
    this.showUrlInput.set(true);
    // Use setTimeout to ensure the input is rendered before focusing
    setTimeout(() => {
      this.urlInputEl?.nativeElement?.focus();
    }, 0);
  }

  // Config modal state
  configModalOpen = signal(false);
  configModalItemId = signal<string | null>(null);
  configModalSource = signal<'url' | 'library'>('url');
  configModalTasks = signal<QueueItemTask[]>([]);

  onUrlInputPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text') || '';

    // Split by newlines and filter out empty lines
    const urls = pastedText
      .split(/\r?\n/)
      .map(url => url.trim())
      .filter(url => url.length > 0);

    if (urls.length > 1) {
      // Multiple URLs pasted - add each one
      urls.forEach(url => this.urlAdded.emit(url));
      this.urlInput.set('');
    } else if (urls.length === 1) {
      // Single URL - put it in the input
      this.urlInput.set(urls[0]);
    }
  }

  onUrlInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const url = this.urlInput().trim();
      if (url) {
        this.urlAdded.emit(url);
        this.urlInput.set('');
      }
    } else if (event.key === 'Escape') {
      this.showUrlInput.set(false);
      this.urlInput.set('');
    }
  }

  addUrlClick(): void {
    const url = this.urlInput().trim();
    if (url) {
      this.urlAdded.emit(url);
      this.urlInput.set('');
    }
  }

  getItemDisplayName(item: QueueItem): string {
    if (item.source === 'library' && item.video) {
      return item.video.name;
    } else if (item.source === 'url') {
      return item.urlTitle || item.url || 'URL';
    }
    return 'Unknown';
  }

  getTaskIcon(taskType: TaskType): string {
    const task = AVAILABLE_TASKS.find(t => t.type === taskType);
    return task?.icon || '⚙️';
  }

  getTaskLabel(taskType: TaskType): string {
    const task = AVAILABLE_TASKS.find(t => t.type === taskType);
    return task?.label || taskType;
  }

  getTotalTaskCount(): number {
    return this.items.reduce((sum, item) => sum + item.tasks.length, 0);
  }

  canProcess(): boolean {
    return this.items.length > 0 && this.getTotalTaskCount() > 0;
  }

  getItemProgress(item: QueueItem): number {
    return item.overallProgress || 0;
  }

  getItemStatusClass(item: QueueItem): string {
    switch (item.status) {
      case 'running': return 'status-running';
      case 'completed': return 'status-completed';
      case 'failed': return 'status-failed';
      default: return 'status-pending';
    }
  }

  openConfigModal(item: QueueItem): void {
    this.configModalItemId.set(item.id);
    this.configModalSource.set(item.source);
    this.configModalTasks.set([...item.tasks]);
    this.configModalOpen.set(true);
  }

  closeConfigModal(): void {
    this.configModalOpen.set(false);
    this.configModalItemId.set(null);
  }

  saveConfigModal(tasks: QueueItemTask[]): void {
    const itemId = this.configModalItemId();
    if (itemId) {
      this.itemTasksUpdated.emit({ itemId, tasks });
    }
    this.closeConfigModal();
  }

  // Calculate progress bar segments for visualizing task pipeline
  getTaskSegments(item: QueueItem): Array<{ task: QueueItemTask, width: string, label: string }> {
    if (item.tasks.length === 0) return [];

    const segmentWidth = 100 / item.tasks.length;

    return item.tasks.map(task => ({
      task,
      width: `${segmentWidth}%`,
      label: this.getTaskLabel(task.type)
    }));
  }

  getTaskProgress(task: QueueItemTask): number {
    return task.progress || 0;
  }

  getTaskStatus(task: QueueItemTask): string {
    return task.status || 'pending';
  }
}
