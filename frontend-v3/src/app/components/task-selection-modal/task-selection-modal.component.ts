import { Component, EventEmitter, Input, OnInit, Output, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AVAILABLE_TASKS, JobRequest, Task, TaskType } from '../../models/task.model';

@Component({
  selector: 'app-task-selection-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './task-selection-modal.component.html',
  styleUrls: ['./task-selection-modal.component.scss']
})
export class TaskSelectionModalComponent implements OnInit {
  @Input() visible = false;
  @Input() inputType: 'url' | 'files' = 'files';
  @Input() selectedFileCount = 0;

  @Output() close = new EventEmitter<void>();
  @Output() submit = new EventEmitter<JobRequest>();

  url = signal('');
  availableTasks = signal<Task[]>([]);
  selectedTasks = signal<Set<TaskType>>(new Set());

  ngOnInit() {
    this.updateAvailableTasks();
  }

  ngOnChanges() {
    this.updateAvailableTasks();
    if (this.inputType === 'url') {
      // Pre-select download-import for URL inputs
      this.selectedTasks.set(new Set(['download-import']));
    } else {
      this.selectedTasks.set(new Set());
    }
  }

  updateAvailableTasks() {
    const tasks = AVAILABLE_TASKS.filter(task => {
      if (this.inputType === 'url') {
        return task.requiresUrl || !task.requiresFile;
      } else {
        return task.requiresFile;
      }
    });
    this.availableTasks.set(tasks);
  }

  isTaskSelected(taskType: TaskType): boolean {
    return this.selectedTasks().has(taskType);
  }

  toggleTask(taskType: TaskType) {
    const selected = new Set(this.selectedTasks());
    if (selected.has(taskType)) {
      selected.delete(taskType);
    } else {
      selected.add(taskType);
    }
    this.selectedTasks.set(selected);
  }

  canSubmit(): boolean {
    if (this.inputType === 'url') {
      return this.url().trim().length > 0 && this.selectedTasks().size > 0;
    } else {
      return this.selectedFileCount > 0 && this.selectedTasks().size > 0;
    }
  }

  onSubmit() {
    if (!this.canSubmit()) return;

    const request: JobRequest = {
      inputType: this.inputType,
      tasks: Array.from(this.selectedTasks())
    };

    if (this.inputType === 'url') {
      request.url = this.url();
    }

    this.submit.emit(request);
    this.onClose();
  }

  @HostListener('document:keydown.escape')
  onEscapeKey() {
    if (this.visible) {
      this.onClose();
    }
  }

  onClose() {
    this.url.set('');
    this.selectedTasks.set(new Set());
    this.close.emit();
  }

  onBackdropClick(event: MouseEvent) {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.onClose();
    }
  }
}
