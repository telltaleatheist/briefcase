// clippy/backend/src/downloader/batch-downloader.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DownloaderService } from './downloader.service';
import { MediaEventService } from '../media/media-event.service';
import { MediaProcessingService } from '../media/media-processing.service';
import { 
  DownloadOptions, 
  DownloadResult 
} from '../common/interfaces/download.interface';

// Unified job status type
export type JobStatus = 'queued' | 'downloading' | 'processing' | 'completed' | 'failed';

// Interface for batch jobs
export interface BatchJob {
  id: string;
  options: DownloadOptions;
  status: JobStatus;
  progress: number;
  currentTask: string;
  downloadResult?: DownloadResult;
  error?: string;
  createdAt: string;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  isActive: boolean;
  queueType: 'download' | 'process';
  displayName?: string;
}

// Response interface for batch jobs
export interface BatchJobResponse {
  id: string;
  url: string;
  status: JobStatus;
  progress: number;
  currentTask: string;
  error?: string;
  createdAt: string;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  outputFile?: string;
  isActive?: boolean;
  queueType?: 'download' | 'process';
  displayName?: string;
}

// Status interface for batch queue
export interface BatchQueueStatus {
  downloadQueue: BatchJobResponse[];
  processingQueue: BatchJobResponse[];
  completedJobs: BatchJobResponse[];
  failedJobs: BatchJobResponse[];
  activeDownloads: string[];
  maxConcurrentDownloads: number;
  isProcessing: boolean;
}

@Injectable()
export class BatchDownloaderService {
  private readonly logger = new Logger(BatchDownloaderService.name);
  
  // Single collection of all jobs
  private allJobs: Map<string, BatchJob> = new Map();
  
  // Queue tracking collections
  private downloadQueue: string[] = [];
  private processingQueue: string[] = [];
  private completedJobIds: string[] = [];
  private failedJobIds: string[] = [];
  
  // Active job tracking
  private activeDownloads: Set<string> = new Set();
  private maxConcurrentDownloads: number = 2;
  private isProcessing: boolean = false;
  
  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly mediaProcessingService: MediaProcessingService,
    private readonly eventService: MediaEventService,
  ) {}

  // Set max concurrent downloads
  setMaxConcurrentDownloads(max: number): void {
    if (max < 1) {
      throw new Error('Maximum concurrent downloads must be at least 1');
    }
    
    this.maxConcurrentDownloads = max;
    this.logger.log(`Max concurrent downloads set to: ${max}`);
    
    // Process queue with new limit
    this.processDownloadQueue();
  }

  getMaxConcurrentDownloads(): number {
    return this.maxConcurrentDownloads;
  }

  // Add a new job to the queue
  addToBatchQueue(options: DownloadOptions): string {
    const jobId = `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // Use the displayName from options directly (it should already be sanitized by the frontend)
    const displayName = options.displayName || options.url;
    
    // Create the job
    const job: BatchJob = {
      id: jobId,
      options,
      status: 'queued',
      progress: 0,
      currentTask: 'Waiting in queue...',
      createdAt: new Date().toISOString(),
      isActive: false,
      queueType: 'download',
      displayName // Use the display name directly
    };
    
    // Add to collections
    this.allJobs.set(jobId, job);
    this.downloadQueue.push(jobId);
    
    this.logger.log(`Added job ${jobId} to batch queue. Queue size: ${this.downloadQueue.length}`);
    
    // Update UI and start processing
    this.emitQueueUpdate();
    this.processDownloadQueue();
    
    return jobId;
  }  
  // Add multiple jobs
  addMultipleToBatchQueue(optionsArray: DownloadOptions[]): string[] {
    return optionsArray.map(options => this.addToBatchQueue(options));
  }

  // Process download queue
  private async processDownloadQueue(): Promise<void> {
    // If queue is empty, check for processing
    if (this.downloadQueue.length === 0) {
      if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
        this.logger.log('All downloads complete. Starting video processing.');
        await this.processVideos();
      }
      return;
    }
    
    // Process downloads within concurrency limit
    while (this.activeDownloads.size < this.maxConcurrentDownloads && this.downloadQueue.length > 0) {
      const jobId = this.downloadQueue.shift();
      if (!jobId) continue;
      
      const job = this.allJobs.get(jobId);
      if (!job) continue;
      
      // Mark as downloading
      this.updateJobState(job, 'downloading', 'Starting download...', true);
      job.downloadStartTime = new Date().toISOString();
      this.activeDownloads.add(job.id);
      
      this.emitQueueUpdate();
      
      try {
        // Start download
        this.logger.log(`Starting download for job ${job.id}`);
        const result = await this.downloaderService.downloadVideo(job.options, job.id);
        
        job.downloadEndTime = new Date().toISOString();
        
        if (result.success) {
          job.downloadResult = result;
          
          if (result.isImage) {
            // Images require no processing
            this.moveJobToCompleted(job);
            job.processingEndTime = job.downloadEndTime;
            job.currentTask = 'Image download completed';
          } else {
            // Videos need processing
            this.moveJobToProcessing(job);
          }
        } else {
          // Handle download failure
          this.moveJobToFailed(job, result.error || 'Download failed');
        }
      } catch (error) {
        // Handle exceptions
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.moveJobToFailed(job, errorMessage);
      }
      
      // Remove from active downloads
      this.activeDownloads.delete(job.id);
      this.emitQueueUpdate();
    }
  
    // Check if we can process videos
    if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
      await this.processVideos();
    }
  }

  // Process videos in queue
  private async processVideos(): Promise<void> {
    if (this.processingQueue.length === 0 || this.isProcessing) {
      return;
    }
    
    this.isProcessing = true;
    this.logger.log(`Starting to process ${this.processingQueue.length} videos`);
    
    while (this.processingQueue.length > 0) {
      const jobId = this.processingQueue[0];
      const job = this.allJobs.get(jobId);
      
      if (!job || !job.downloadResult?.outputFile) {
        this.processingQueue.shift();
        continue;
      }
      
      // Mark as processing
      job.processingStartTime = new Date().toISOString();
      this.updateJobState(job, 'processing', 'Starting processing...', true);
      this.emitQueueUpdate();
      
      try {
        // Check if image (shouldn't happen, but just in case)
        if (job.downloadResult.isImage) {
          this.moveJobToCompleted(job);
          this.processingQueue.shift();
          continue;
        }
        
        // Process video if needed
        let processedFile = job.downloadResult.outputFile;
        
        if (job.options.fixAspectRatio) {
          this.updateJobState(job, 'processing', 'Processing video...', true);
          
          const result = await this.mediaProcessingService.processMedia(
            processedFile,
            { fixAspectRatio: job.options.fixAspectRatio },
            job.id
          );
          
          if (result.success && result.outputFile) {
            processedFile = result.outputFile;
          }
        }
        
        // Update job with processed file
        job.downloadResult.outputFile = processedFile;
        
        // Mark as completed
        this.moveJobToCompleted(job);
        job.processingEndTime = new Date().toISOString();
        
      } catch (error) {
        // Handle processing error
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.moveJobToFailed(job, errorMsg);
      }
      
      // Remove from processing queue
      this.processingQueue.shift();
      this.emitQueueUpdate();
    }
    
    this.isProcessing = false;
    this.logger.log('All videos processed');
    
    // Emit batch completed event
    this.eventService.emitBatchCompleted(
      this.completedJobIds.length,
      this.failedJobIds.length
    );
  }

  // Helper methods for job state management
  
  private updateJobState(job: BatchJob, status: JobStatus, task: string, isActive: boolean): void {
    job.status = status;
    job.currentTask = task;
    job.isActive = isActive;
  }
  
  private moveJobToCompleted(job: BatchJob): void {
    this.updateJobState(job, 'completed', 'Processing completed', false);
    job.progress = 100;
    this.completedJobIds.push(job.id);
  }
  
  private moveJobToFailed(job: BatchJob, error: string): void {
    this.updateJobState(job, 'failed', `Failed: ${error}`, false);
    job.error = error;
    job.progress = 0;
    this.failedJobIds.push(job.id);
  }
  
  private moveJobToProcessing(job: BatchJob): void {
    this.updateJobState(job, 'processing', 'Download complete, queued for processing...', false);
    job.progress = 0;
    job.queueType = 'process';
    this.processingQueue.push(job.id);
  }

  // Update job progress from events
  updateJobProgress(jobId: string, progress: number, task: string): void {
    const job = this.allJobs.get(jobId);
    
    if (job) {
      job.progress = progress;
      job.currentTask = task;
      this.emitQueueUpdate();
    }
  }
  
  // Cancel a job
  cancelJob(jobId: string): boolean {
    const job = this.allJobs.get(jobId);
    if (!job) return false;
    
    // Handle different queue types
    if (this.removeFromQueue(this.downloadQueue, jobId)) {
      this.moveJobToFailed(job, 'Cancelled by user');
      return true;
    }
    
    if (this.activeDownloads.has(jobId)) {
      if (this.downloaderService.cancelDownload(jobId)) {
        this.activeDownloads.delete(jobId);
        this.moveJobToFailed(job, 'Cancelled by user');
        return true;
      }
    }
    
    if (this.removeFromQueue(this.processingQueue, jobId)) {
      this.moveJobToFailed(job, 'Cancelled by user');
      return true;
    }
    
    return false;
  }
  
  // Helper to remove a job from a queue
  private removeFromQueue(queue: string[], jobId: string): boolean {
    const index = queue.indexOf(jobId);
    if (index >= 0) {
      queue.splice(index, 1);
      return true;
    }
    return false;
  }
  
  // Retry a failed job
  retryJob(jobId: string): boolean {
    const job = this.allJobs.get(jobId);
    if (!job || job.status !== 'failed') {
      return false;
    }
    
    // Remove from failed jobs
    this.removeFromQueue(this.failedJobIds, jobId);
    
    // Reset job state
    this.updateJobState(job, 'queued', 'Waiting in queue...', false);
    job.progress = 0;
    job.error = undefined;
    
    // Add to appropriate queue
    if (job.downloadResult) {
      job.queueType = 'process';
      this.processingQueue.push(jobId);
      
      if (this.activeDownloads.size === 0 && !this.isProcessing) {
        this.processVideos();
      }
    } else {
      job.queueType = 'download';
      this.downloadQueue.unshift(jobId);
      this.processDownloadQueue();
    }
    
    this.emitQueueUpdate();
    return true;
  }
  
  // Get current queue status
  getBatchStatus(): BatchQueueStatus {
    return {
      downloadQueue: this.getJobsFromQueue(this.downloadQueue),
      processingQueue: this.getJobsFromQueue(this.processingQueue),
      completedJobs: this.getJobsFromQueue(this.completedJobIds),
      failedJobs: this.getJobsFromQueue(this.failedJobIds),
      activeDownloads: Array.from(this.activeDownloads),
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing
    };
  }
  
  // Helper to get job responses from queue IDs
  private getJobsFromQueue(queue: string[]): BatchJobResponse[] {
    return queue.map(id => this.formatJobForResponse(id));
  }
  
  // Format job for API response
  private formatJobForResponse(jobId: string): BatchJobResponse {
    const job = this.allJobs.get(jobId);
    
    if (!job) {
      return {
        id: jobId,
        url: 'Unknown URL',
        status: 'failed',
        progress: 0,
        currentTask: 'Job not found',
        createdAt: new Date().toISOString()
      };
    }
    
    return {
      id: job.id,
      url: job.options.url,
      status: job.status,
      progress: job.progress,
      currentTask: job.currentTask,
      error: job.error,
      createdAt: job.createdAt,
      downloadStartTime: job.downloadStartTime,
      downloadEndTime: job.downloadEndTime,
      processingStartTime: job.processingStartTime,
      processingEndTime: job.processingEndTime,
      outputFile: job.downloadResult?.outputFile,
      isActive: job.isActive,
      queueType: job.queueType,
      displayName: job.displayName || job.options.displayName
    };
  }
  
  // Clear active queues
  clearQueues(): void {
    // Move active jobs to failed
    [...this.downloadQueue, ...this.processingQueue].forEach(jobId => {
      const job = this.allJobs.get(jobId);
      if (job) {
        this.moveJobToFailed(job, 'Cancelled by user');
      }
    });
    
    // Clear queues
    this.downloadQueue = [];
    this.processingQueue = [];
    
    this.logger.log('All active queues cleared');
    this.emitQueueUpdate();
  }

  // Clear completed jobs
  clearCompletedJobs(): void {
    this.completedJobIds.forEach(jobId => {
      this.allJobs.delete(jobId);
    });
    
    this.completedJobIds = [];
    this.logger.log('Completed jobs cleared');
    this.emitQueueUpdate();
  }

  // Clear failed jobs
  clearFailedJobs(): void {
    this.failedJobIds.forEach(jobId => {
      this.allJobs.delete(jobId);
    });
    
    this.failedJobIds = [];
    this.logger.log('Failed jobs cleared');
    this.emitQueueUpdate();
  }

  // Emit queue update event
  private emitQueueUpdate(): void {
    this.eventService.emitBatchQueueUpdated(this.getBatchStatus());
  }
}