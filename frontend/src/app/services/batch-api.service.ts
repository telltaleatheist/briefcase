
// clippy/frontend/src/app/services/batch-api.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { BatchConfig, BatchDownloadOptions, BatchQueueStatus, DownloadOptions, VideoInfo } from '../models/download.model';
import { environment } from '../../environment/environment';

// Task types for the new queue system
export interface Task {
  type: 'get-info' | 'download' | 'import' | 'fix-aspect-ratio' | 'normalize-audio' | 'transcribe' | 'analyze';
  options?: any;
}

export interface QueueJob {
  id: string;
  queueType: 'batch' | 'analysis';
  url?: string;
  displayName?: string;
  tasks: Task[];
  currentTaskIndex: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  currentPhase: string;
  error?: string;
  videoPath?: string;
  videoId?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface QueueStatus {
  queueType: 'batch' | 'analysis';
  pendingJobs: QueueJob[];
  processingJobs: QueueJob[];
  completedJobs: QueueJob[];
  failedJobs: QueueJob[];
  activeJobCount: number;
  maxConcurrency: number;
}

@Injectable({
  providedIn: 'root'
})
export class BatchApiService {
    private apiUrl = environment.apiBaseUrl;

    constructor(private http: HttpClient) {}

  /**
   * Add a single job to batch queue
   * Converts old DownloadOptions format to new task-based format
   */
  addToBatchQueue(options: DownloadOptions): Observable<{success: boolean, jobId: string}> {
    // Build task list based on options
    const tasks: Task[] = [
      { type: 'download', options: { quality: options.quality || '720', outputDir: options.outputDir } },
      { type: 'import', options: {} }
    ];

    // Add optional processing tasks
    if (options.fixAspectRatio) {
      tasks.push({ type: 'fix-aspect-ratio', options: {} });
    }
    if (options.useRmsNormalization) {
      tasks.push({
        type: 'normalize-audio',
        options: { level: options.rmsNormalizationLevel || -16 }
      });
    }

    return this.http.post<{success: boolean, jobId: string}>(`${this.apiUrl}/queue/add`, {
      queueType: 'batch',
      url: options.url,
      displayName: options.displayName,
      tasks
    });
  }

  /**
   * Add multiple jobs to batch queue
   */
  addMultipleToBatchQueue(options: DownloadOptions[]): Observable<{success: boolean, jobIds: string[]}> {
    const jobs = options.map(opt => {
      const tasks: Task[] = [
        { type: 'download', options: { quality: opt.quality || '720', outputDir: opt.outputDir } },
        { type: 'import', options: {} }
      ];

      if (opt.fixAspectRatio) {
        tasks.push({ type: 'fix-aspect-ratio', options: {} });
      }
      if (opt.useRmsNormalization) {
        tasks.push({
          type: 'normalize-audio',
          options: { level: opt.rmsNormalizationLevel || -16 }
        });
      }

      return {
        url: opt.url,
        displayName: opt.displayName,
        tasks
      };
    });

    return this.http.post<{success: boolean, jobIds: string[]}>(`${this.apiUrl}/queue/add-bulk`, {
      queueType: 'batch',
      jobs
    });
  }

  /**
   * Get batch queue status
   * Maps new queue format to old BatchQueueStatus format for compatibility
   */
  getBatchStatus(): Observable<BatchQueueStatus> {
    return this.http.get<{success: boolean, status: QueueStatus}>(`${this.apiUrl}/queue/status?type=batch`)
      .pipe(
        map(response => {
          const status = response.status;

          // Map new format to old format for backward compatibility
          return {
            queuedJobs: status.pendingJobs.map(this.mapToLegacyFormat),
            downloadingJobs: status.processingJobs.filter(j => j.currentPhase.includes('download')).map(this.mapToLegacyFormat),
            downloadedJobs: [], // Not used in new system
            processingJobs: status.processingJobs.filter(j => !j.currentPhase.includes('download')).map(this.mapToLegacyFormat),
            transcribingJobs: [], // Not used in new system
            completedJobs: status.completedJobs.map(this.mapToLegacyFormat),
            failedJobs: status.failedJobs.map(this.mapToLegacyFormat),
            activeDownloadCount: status.activeJobCount,
            maxConcurrentDownloads: status.maxConcurrency,
            isProcessing: status.processingJobs.length > 0
          };
        })
      );
  }

  /**
   * Map new QueueJob format to legacy JobResponse format
   */
  private mapToLegacyFormat(job: QueueJob): any {
    return {
      id: job.id,
      url: job.url || '',
      displayName: job.displayName || 'Processing...',
      status: job.status === 'pending' ? 'queued' : job.status,
      progress: job.progress,
      currentTask: job.currentPhase,
      error: job.error,
      createdAt: job.createdAt,
      outputFile: job.videoPath
    };
  }

  updateBatchConfig(config: BatchConfig): Observable<{success: boolean, config: BatchConfig}> {
    // Config updates not supported in new system (concurrency is fixed per queue type)
    return new Observable(observer => {
      observer.next({ success: true, config });
      observer.complete();
    });
  }

  clearBatchQueues(): Observable<{success: boolean, message: string}> {
    return this.http.delete<{success: boolean, message: string}>(`${this.apiUrl}/queue/clear?type=batch`);
  }

  /**
   * Get video info (for displaying filenames before download)
   * Still uses old endpoint - works standalone
   */
  getVideoInfo(url: string): Observable<VideoInfo> {
    return this.http.get<{success: boolean, data: VideoInfo}>(`${this.apiUrl}/media/info?url=${encodeURIComponent(url)}`)
      .pipe(map(response => response.data));
  }

  /**
   * Cancel a running job
   */
  cancelJob(jobId: string): Observable<{success: boolean, message: string}> {
    return this.http.post<{success: boolean, message: string}>(`${this.apiUrl}/queue/job/${jobId}/cancel`, {});
  }

  /**
   * Delete a job from the queue
   */
  deleteJob(jobId: string): Observable<{success: boolean, message: string}> {
    return this.http.delete<{success: boolean, message: string}>(`${this.apiUrl}/queue/job/${jobId}`);
  }

  /**
   * Retry a failed job (not implemented in new system yet)
   */
  retryJob(jobId: string): Observable<{success: boolean, message: string}> {
    // TODO: Implement retry in new queue system
    return new Observable(observer => {
      observer.next({ success: false, message: 'Retry not yet implemented in new queue system' });
      observer.complete();
    });
  }

  /**
   * Skip a job (not applicable in new system)
   */
  skipJob(jobId: string): Observable<{success: boolean, message: string}> {
    // Not applicable in new system - just cancel or delete
    return this.cancelJob(jobId);
  }
}