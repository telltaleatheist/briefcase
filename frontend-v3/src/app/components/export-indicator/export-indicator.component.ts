import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ExportQueueService } from '../../services/export-queue.service';

@Component({
  selector: 'app-export-indicator',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './export-indicator.component.html',
  styleUrls: ['./export-indicator.component.scss']
})
export class ExportIndicatorComponent {
  private exportQueue = inject(ExportQueueService);

  isExpanded = signal(false);

  // Expose queue service signals
  readonly jobs = this.exportQueue.jobs;
  readonly currentJob = this.exportQueue.currentJob;
  readonly hasActiveExports = this.exportQueue.hasActiveExports;
  readonly pendingCount = this.exportQueue.pendingCount;
  readonly completedCount = this.exportQueue.completedCount;
  readonly failedCount = this.exportQueue.failedCount;

  // Computed for display
  readonly processingJob = computed(() => {
    return this.jobs().find(j => j.status === 'processing');
  });

  readonly totalJobs = computed(() => this.jobs().length);

  readonly activeCount = computed(() => {
    return this.jobs().filter(j => j.status === 'pending' || j.status === 'processing').length;
  });

  readonly showIndicator = computed(() => {
    // Show if there are active exports OR if there are recent completed/failed
    return this.hasActiveExports() || this.completedCount() > 0 || this.failedCount() > 0;
  });

  toggleExpanded() {
    this.isExpanded.update(v => !v);
  }

  clearCompleted() {
    this.exportQueue.clearCompleted();
  }

  cancelJob(jobId: string) {
    this.exportQueue.cancelJob(jobId);
  }

  // Truncate long titles
  truncateTitle(title: string, maxLength = 30): string {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + '...';
  }
}
