import { Component, signal, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AVAILABLE_TASKS,
  Task,
  TaskType,
  DownloadImportConfig,
  TranscribeConfig,
  AIAnalyzeConfig,
  FixAspectRatioConfig,
  NormalizeAudioConfig
} from '../../models/task.model';
import { QueueItemTask } from '../../models/queue.model';

@Component({
  selector: 'app-queue-item-config-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './queue-item-config-modal.component.html',
  styleUrls: ['./queue-item-config-modal.component.scss']
})
export class QueueItemConfigModalComponent {
  // Inputs
  isOpen = input<boolean>(false);
  itemSource = input<'url' | 'library'>('url');
  existingTasks = input<QueueItemTask[]>([]);

  // Outputs
  close = output<void>();
  save = output<QueueItemTask[]>();

  // State
  tasks = signal<Map<TaskType, QueueItemTask>>(new Map());
  expandedTask = signal<TaskType | null>(null);

  ngOnInit() {
    this.initializeTasks();
  }

  initializeTasks() {
    const taskMap = new Map<TaskType, QueueItemTask>();

    // Initialize from existing tasks or defaults
    const existing = this.existingTasks();
    if (existing && existing.length > 0) {
      existing.forEach(task => {
        taskMap.set(task.type, { ...task });
      });
    }

    this.tasks.set(taskMap);
  }

  getAvailableTasks(): Task[] {
    const source = this.itemSource();
    return AVAILABLE_TASKS.filter(task => {
      if (source === 'url') {
        return task.requiresUrl || task.requiresFile;
      } else {
        return task.requiresFile;
      }
    });
  }

  isTaskSelected(taskType: TaskType): boolean {
    return this.tasks().has(taskType);
  }

  toggleTask(task: Task) {
    const currentTasks = new Map(this.tasks());

    if (currentTasks.has(task.type)) {
      currentTasks.delete(task.type);
    } else {
      currentTasks.set(task.type, {
        type: task.type,
        status: 'pending',
        progress: 0,
        config: this.getDefaultConfig(task.type)
      });
    }

    this.tasks.set(currentTasks);
  }

  toggleExpanded(taskType: TaskType) {
    if (this.expandedTask() === taskType) {
      this.expandedTask.set(null);
    } else {
      this.expandedTask.set(taskType);
    }
  }

  getDefaultConfig(taskType: TaskType): any {
    switch (taskType) {
      case 'download-import':
        return { quality: 'best', format: 'mp4' } as DownloadImportConfig;
      case 'transcribe':
        return { model: 'large', translate: false } as TranscribeConfig;
      case 'ai-analyze':
        return {
          aiModel: 'gpt-4-turbo',
          generateSummary: true,
          extractKeyPoints: true
        } as AIAnalyzeConfig;
      case 'fix-aspect-ratio':
        return { targetRatio: '16:9', cropMode: 'smart' } as FixAspectRatioConfig;
      case 'normalize-audio':
        return { targetLevel: -16, peakLevel: -1 } as NormalizeAudioConfig;
      default:
        return {};
    }
  }

  updateTaskConfig(taskType: TaskType, config: any) {
    const currentTasks = new Map(this.tasks());
    const task = currentTasks.get(taskType);
    if (task) {
      task.config = { ...task.config, ...config };
      currentTasks.set(taskType, task);
      this.tasks.set(currentTasks);
    }
  }

  getTaskConfig(taskType: TaskType): any {
    return this.tasks().get(taskType)?.config || this.getDefaultConfig(taskType);
  }

  onSave() {
    const tasksArray = Array.from(this.tasks().values());
    this.save.emit(tasksArray);
  }

  onClose() {
    this.close.emit();
  }

  onBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.onClose();
    }
  }
}
