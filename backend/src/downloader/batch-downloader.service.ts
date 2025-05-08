// clippy/backend/src/downloader/batch-downloader.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DownloaderService } from './downloader.service';
import { MediaEventService } from '../media/media-event.service';
import { MediaProcessingService } from '../media/media-processing.service';
import { 
  DownloadOptions, 
  DownloadResult,
  Job,
  JobResponse,
  JobStatus,
  BatchQueueStatus
} from '../common/interfaces/download.interface';

@Injectable()
export class BatchDownloaderService {
  private readonly logger = new Logger(BatchDownloaderService.name);
  
  // Single collection of all jobs
  private jobs: Map<string, Job> = new Map();
  
  // Processing state
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
    this.processQueue();
  }

  getMaxConcurrentDownloads(): number {
    return this.maxConcurrentDownloads;
  }

  // Add a new job to the system
  addToBatchQueue(options: DownloadOptions): string {
    const jobId = `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // Use the displayName from options directly
    const displayName = options.displayName || options.url;
    
    // Create the job
    const job: Job = {
      id: jobId,
      url: options.url,
      displayName: displayName,
      status: 'queued',
      progress: 0,
      currentTask: 'Waiting in queue...',
      createdAt: new Date().toISOString(),
      options: options
    };
    
    // Add to jobs collection
    this.jobs.set(jobId, job);
    
    this.logger.log(`Added job ${jobId} to batch queue. Total jobs: ${this.jobs.size}`);
    
    // Update UI and start processing
    this.emitQueueUpdate();
    this.processQueue();
    
    return jobId;
  }

  // Add multiple jobs
  addMultipleToBatchQueue(optionsArray: DownloadOptions[]): string[] {
    return optionsArray.map(options => this.addToBatchQueue(options));
  }

  // Get jobs by status
  private getJobsByStatus(status: JobStatus): Job[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === status);
  }

  // Process the download and processing queues
  private async processQueue(): Promise<void> {
    // Get job counts for logging
    const queuedCount = this.getJobsByStatus('queued').length;
    const downloadingCount = this.getJobsByStatus('downloading').length;
    const downloadedCount = this.getJobsByStatus('downloaded').length;
    const processingCount = this.getJobsByStatus('processing').length;
    const completedCount = this.getJobsByStatus('completed').length;
    const failedCount = this.getJobsByStatus('failed').length;
    
    // Comprehensive logging
    this.logger.log(`Processing queue: 
      - Queued: ${queuedCount}
      - Downloading: ${downloadingCount}
      - Downloaded: ${downloadedCount}
      - Processing: ${processingCount}
      - Completed: ${completedCount}
      - Failed: ${failedCount}
      - Total jobs: ${this.jobs.size}`
    );
    
    // Early exit if no work to do
    if (queuedCount === 0 && downloadingCount === 0 && downloadedCount === 0) {
      this.logger.log('No work to do in queue');
      return;
    }
    
    // Process downloads within concurrency limit
    if (downloadingCount < this.maxConcurrentDownloads && queuedCount > 0) {
      // Get queued jobs up to the concurrency limit
      const queuedJobs = this.getJobsByStatus('queued')
        .slice(0, this.maxConcurrentDownloads - downloadingCount);
      
      this.logger.log(`Starting download for ${queuedJobs.length} jobs`);
      
      // Start downloads for queued jobs
      for (const job of queuedJobs) {
        this.startDownload(job);
      }
    }
    
    // Only process videos when no active downloads
    if (downloadingCount === 0 && downloadedCount > 0 && !this.isProcessing) {
      this.logger.log('All downloads complete. Starting video processing.');
      await this.processVideos();
    }
  }
  
  // Start a download for a job
  private async startDownload(job: Job): Promise<void> {
    // Update job state
    job.status = 'downloading';
    job.currentTask = 'Initializing download...';
    job.downloadStartTime = new Date().toISOString();
    this.emitQueueUpdate();
    
    try {
      // Start download with downloaderService
      this.logger.log(`Starting download for job ${job.id}: ${job.url}`);
      
      const result = await this.downloaderService.downloadVideo(job.options, job.id);
      
      // Mark download end time
      job.downloadEndTime = new Date().toISOString();
      
      // Process download result
      if (result.success) {
        job.outputFile = result.outputFile;
        
        if (result.isImage) {
          // Images don't need processing
          job.status = 'completed';
          job.processingEndTime = job.downloadEndTime;
          job.currentTask = 'Image download completed';
          job.progress = 100;
          this.logger.log(`Image download completed for job ${job.id}`);
        } else {
          // Mark videos as downloaded but not yet processed
          job.status = 'downloaded';
          job.currentTask = 'Download complete, waiting for processing...';
          job.progress = 100; // Download is 100% complete
          this.logger.log(`Video download completed, waiting for processing: ${job.id}`);
        }
      } else {
        // Handle download failure
        job.status = 'failed';
        job.error = result.error || 'Download failed';
        job.currentTask = `Failed: ${job.error}`;
        job.progress = 0;
        this.logger.error(`Download failed for job ${job.id}`, { error: result.error });
      }
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = error instanceof Error 
        ? error.message 
        : 'Unknown error during download';
      
      job.status = 'failed';
      job.error = errorMessage;
      job.currentTask = `Failed: ${errorMessage}`;
      job.progress = 0;
      
      this.logger.error(`Unexpected error during download for job ${job.id}`, { 
        error: errorMessage,
        jobDetails: job 
      });
    } finally {
      // Always update UI and process queue again
      this.emitQueueUpdate();
      this.processQueue();
    }
  }
  
  // Process downloaded videos
  private async processVideos(): Promise<void> {
    const downloadedJobs = this.getJobsByStatus('downloaded');
    
    if (downloadedJobs.length === 0 || this.isProcessing) {
      return;
    }
    
    this.isProcessing = true;
    this.logger.log(`Starting to process ${downloadedJobs.length} videos`);
    
    for (const job of downloadedJobs) {
      // Skip jobs without output files
      if (!job.outputFile) {
        job.status = 'failed';
        job.error = 'Missing output file for processing';
        job.currentTask = 'Failed: Missing output file';
        this.emitQueueUpdate();
        continue;
      }
      job.status = 'completed';
      job.processingEndTime = new Date().toISOString();
      job.currentTask = 'Processing completed';
      job.progress = 100;
      
      this.logger.log(`Processing completed for job ${job.id}`);
      
      this.emitQueueUpdate();
    }
    
    this.isProcessing = false;
    this.logger.log('All videos processed');
    
    // Emit batch completed event with counts
    const completedCount = this.getJobsByStatus('completed').length;
    const failedCount = this.getJobsByStatus('failed').length;
    this.eventService.emitBatchCompleted(completedCount, failedCount);
  }

  // Update job progress from events
  updateJobProgress(jobId: string, progress: number, task: string): void {
    const job = this.jobs.get(jobId);
    
    if (job) {
      job.progress = progress;
      job.currentTask = task;
      this.emitQueueUpdate();
    }
  }
  
  // Cancel a job
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    
    // Handle different job states
    if (job.status === 'queued') {
      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.currentTask = 'Cancelled by user';
      job.progress = 0;
      this.emitQueueUpdate();
      return true;
    }
    
    if (job.status === 'downloading') {
      if (this.downloaderService.cancelDownload(jobId)) {
        job.status = 'failed';
        job.error = 'Cancelled by user';
        job.currentTask = 'Cancelled by user';
        job.progress = 0;
        this.emitQueueUpdate();
        return true;
      }
    }
    
    if (job.status === 'downloaded' || job.status === 'processing') {
      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.currentTask = 'Cancelled by user';
      job.progress = 0;
      this.emitQueueUpdate();
      return true;
    }
    
    return false;
  }
  
  // Retry a failed job
  retryJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'failed') {
      return false;
    }
    
    // Reset job state
    if (job.outputFile) {
      // If we have an output file, we can retry from processing
      job.status = 'downloaded';
      job.error = undefined;
      job.currentTask = 'Waiting for processing...';
      job.progress = 100; // Download was complete
    } else {
      // Otherwise retry from the beginning
      job.status = 'queued';
      job.error = undefined;
      job.currentTask = 'Waiting in queue...';
      job.progress = 0;
    }
    
    this.emitQueueUpdate();
    this.processQueue();
    return true;
  }
  
  // Get current queue status
  getBatchStatus(): BatchQueueStatus {
    // Get jobs by state
    const queuedJobs = this.getJobsByStatus('queued').map(job => this.formatJobForResponse(job));
    const downloadingJobs = this.getJobsByStatus('downloading').map(job => this.formatJobForResponse(job));
    const downloadedJobs = this.getJobsByStatus('downloaded').map(job => this.formatJobForResponse(job));
    const processingJobs = this.getJobsByStatus('processing').map(job => this.formatJobForResponse(job));
    const completedJobs = this.getJobsByStatus('completed').map(job => this.formatJobForResponse(job));
    const failedJobs = this.getJobsByStatus('failed').map(job => this.formatJobForResponse(job));
    
    return {
      queuedJobs,
      downloadingJobs,
      downloadedJobs,
      processingJobs,
      completedJobs,
      failedJobs,
      activeDownloadCount: downloadingJobs.length,
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing
    };
  }
    
  // Format job for API response
  private formatJobForResponse(job: Job): JobResponse {
    return {
      id: job.id,
      url: job.url,
      displayName: job.displayName,
      status: job.status,
      progress: job.progress,
      currentTask: job.currentTask,
      error: job.error,
      createdAt: job.createdAt,
      downloadStartTime: job.downloadStartTime,
      downloadEndTime: job.downloadEndTime,
      processingStartTime: job.processingStartTime,
      processingEndTime: job.processingEndTime,
      outputFile: job.outputFile,
      thumbnail: job.thumbnail
    };
  }
  
  // Clear active jobs
  clearQueues(): void {
    // Find all active jobs
    const activeJobs = Array.from(this.jobs.values())
      .filter(job => ['queued', 'downloading', 'downloaded', 'processing'].includes(job.status));
    
    // Mark them as failed
    for (const job of activeJobs) {
      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.currentTask = 'Cancelled by user';
      job.progress = 0;
    }
    
    // Cancel any active downloads
    this.getJobsByStatus('downloading').forEach(job => {
      this.downloaderService.cancelDownload(job.id);
    });
    
    this.logger.log('All active queues cleared');
    this.emitQueueUpdate();
  }

  // Clear completed jobs
  clearCompletedJobs(): void {
    // Get completed job IDs
    const completedJobIds = this.getJobsByStatus('completed').map(job => job.id);
    
    // Remove from jobs collection
    completedJobIds.forEach(id => {
      this.jobs.delete(id);
    });
    
    this.logger.log(`Cleared ${completedJobIds.length} completed jobs`);
    this.emitQueueUpdate();
  }

  // Clear failed jobs
  clearFailedJobs(): void {
    // Get failed job IDs
    const failedJobIds = this.getJobsByStatus('failed').map(job => job.id);
    
    // Remove from jobs collection
    failedJobIds.forEach(id => {
      this.jobs.delete(id);
    });
    
    this.logger.log(`Cleared ${failedJobIds.length} failed jobs`);
    this.emitQueueUpdate();
  }

  // Emit queue update event
  private emitQueueUpdate(): void {
    this.eventService.emitBatchQueueUpdated(this.getBatchStatus());
  }
}