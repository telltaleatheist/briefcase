import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BackendUrlService } from './backend-url.service';
import { NotificationService } from './notification.service';

export interface ExportJob {
  id: string;
  videoId: string;
  videoPath?: string | null;
  videoTitle: string;
  sectionDescription: string;
  startTime: number | null;
  endTime: number | null;
  category?: string;
  customDirectory?: string;
  reEncode: boolean;
  muteSections?: Array<{ startSeconds: number; endSeconds: number }>;
  outputSuffix?: string;
  isOverwrite?: boolean;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ExportQueueService {
  private http = inject(HttpClient);
  private backendUrlService = inject(BackendUrlService);
  private notificationService = inject(NotificationService);

  // Queue state
  private queue = signal<ExportJob[]>([]);
  private currentJobId = signal<string | null>(null);
  private isProcessing = signal(false);

  // Public computed signals
  readonly jobs = computed(() => this.queue());
  readonly currentJob = computed(() => {
    const id = this.currentJobId();
    return id ? this.queue().find(j => j.id === id) : null;
  });
  readonly pendingCount = computed(() =>
    this.queue().filter(j => j.status === 'pending').length
  );
  readonly hasActiveExports = computed(() =>
    this.queue().some(j => j.status === 'pending' || j.status === 'processing')
  );
  readonly completedCount = computed(() =>
    this.queue().filter(j => j.status === 'completed').length
  );
  readonly failedCount = computed(() =>
    this.queue().filter(j => j.status === 'failed').length
  );

  /**
   * Add export jobs to the queue and start processing
   */
  addJobs(jobs: Omit<ExportJob, 'id' | 'status' | 'progress'>[]): void {
    const newJobs: ExportJob[] = jobs.map(job => ({
      ...job,
      id: crypto.randomUUID(),
      status: 'pending' as const,
      progress: 0
    }));

    this.queue.update(q => [...q, ...newJobs]);

    // Start processing if not already
    if (!this.isProcessing()) {
      this.processQueue();
    }
  }

  /**
   * Add a single overwrite job (special case)
   */
  addOverwriteJob(job: Omit<ExportJob, 'id' | 'status' | 'progress' | 'isOverwrite'>): void {
    const newJob: ExportJob = {
      ...job,
      id: crypto.randomUUID(),
      status: 'pending',
      progress: 0,
      isOverwrite: true
    };

    this.queue.update(q => [...q, newJob]);

    if (!this.isProcessing()) {
      this.processQueue();
    }
  }

  /**
   * Clear completed/failed jobs from the queue
   */
  clearCompleted(): void {
    this.queue.update(q => q.filter(j => j.status === 'pending' || j.status === 'processing'));
  }

  /**
   * Cancel a pending job
   */
  cancelJob(jobId: string): void {
    this.queue.update(q => q.filter(j => j.id !== jobId || j.status === 'processing'));
  }

  /**
   * Process the export queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing()) return;

    this.isProcessing.set(true);

    while (true) {
      const pendingJob = this.queue().find(j => j.status === 'pending');
      if (!pendingJob) break;

      this.currentJobId.set(pendingJob.id);
      this.updateJobStatus(pendingJob.id, 'processing', 10);

      try {
        if (pendingJob.isOverwrite) {
          await this.executeOverwrite(pendingJob);
        } else {
          await this.executeExport(pendingJob);
        }
        this.updateJobStatus(pendingJob.id, 'completed', 100);
      } catch (error) {
        console.error('Export failed:', error);
        this.updateJobStatus(pendingJob.id, 'failed', 0, String(error));
      }
    }

    this.currentJobId.set(null);
    this.isProcessing.set(false);

    // Show summary notification
    const completed = this.completedCount();
    const failed = this.failedCount();

    if (completed > 0 || failed > 0) {
      if (failed === 0) {
        this.notificationService.success(
          'Export Complete',
          `${completed} clip${completed !== 1 ? 's' : ''} exported successfully`
        );
      } else if (completed === 0) {
        this.notificationService.error(
          'Export Failed',
          `${failed} clip${failed !== 1 ? 's' : ''} failed to export`
        );
      } else {
        this.notificationService.warning(
          'Export Finished',
          `${completed} succeeded, ${failed} failed`
        );
      }
    }
  }

  private updateJobStatus(
    jobId: string,
    status: ExportJob['status'],
    progress: number,
    error?: string
  ): void {
    this.queue.update(q => q.map(j =>
      j.id === jobId ? { ...j, status, progress, error } : j
    ));
  }

  private async executeExport(job: ExportJob): Promise<void> {
    const url = await this.backendUrlService.getApiUrl('/library/extract-clip');

    this.updateJobStatus(job.id, 'processing', 50);

    await firstValueFrom(
      this.http.post(url, {
        videoPath: job.videoPath,
        startTime: job.startTime,
        endTime: job.endTime,
        category: job.category,
        title: job.sectionDescription,
        customDirectory: job.customDirectory,
        reEncode: job.reEncode,
        muteSections: job.muteSections,
        outputSuffix: job.outputSuffix,
      })
    );
  }

  private async executeOverwrite(job: ExportJob): Promise<void> {
    const url = await this.backendUrlService.getApiUrl('/library/overwrite-with-clip');

    this.updateJobStatus(job.id, 'processing', 50);

    await firstValueFrom(
      this.http.post(url, {
        videoId: job.videoId,
        videoPath: job.videoPath,
        startTime: job.startTime,
        endTime: job.endTime,
        reEncode: job.reEncode,
        muteSections: job.muteSections,
      })
    );
  }
}
