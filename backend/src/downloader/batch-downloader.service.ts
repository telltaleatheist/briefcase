// clippy/backend/src/downloader/batch-downloader.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DownloaderService } from './downloader.service';
import { MediaEventService } from '../media/media-event.service';
import { MediaProcessingService, ProcessingOptions } from '../media/media-processing.service';
import { 
  DownloadOptions, 
  DownloadResult,
  Job,
  JobResponse,
  JobStatus,
  BatchQueueStatus
} from '../common/interfaces/download.interface';
import { JobStateManagerService } from '../common/job-state-manager.service';

@Injectable()
export class BatchDownloaderService {
  private readonly logger = new Logger(BatchDownloaderService.name);
  
  // Single collection of all jobs
  private jobs: Map<string, Job> = new Map();
  
  // Processing state
  private maxConcurrentDownloads: number = 5;
  private maxConcurrentProcessing: number = 5;
  private isProcessing: boolean = false;
  private allDownloadsComplete: boolean = false;

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly mediaProcessingService: MediaProcessingService,
    private readonly eventService: MediaEventService,
    private readonly jobStateManager: JobStateManagerService
  ) {
    this.eventService.server?.on('job-status-updated', (data: {jobId: string, status: string, task: string}) => {
      const job = this.jobs.get(data.jobId);
      if (job) {
        this.jobStateManager.updateJobStatus(job, data.status as JobStatus, data.task);
      } else {
        this.logger.warn(`Job with ID ${data.jobId} not found for status update`);
      }
    });
    this.eventService.server?.on('transcription-completed', (data: {jobId?: string, outputFile: string}) => {
      if (data.jobId) {
        const job = this.jobs.get(data.jobId);
        if (job && job.status === 'transcribing') {
          this.jobStateManager.updateJobStatus(job, 'completed', 'Transcription completed');
          this.logger.log(`Transcription completed for job ${data.jobId}, setting to completed`);
          this.emitQueueUpdate();
        }
      }
    });
  }

  private transitionJobState(job: Job, newStatus: JobStatus, task: string): void {
    this.updateJobState(job, newStatus, task);
    this.emitQueueUpdate(); // Centralized update method
  }

  updateJobState(job: Job, newStatus: JobStatus, task: string): void {
    const result = this.jobStateManager.updateJobStatus(job, newStatus, task);
    
    if (result.success) {
      // Emit event or log successful transition
      this.eventService.emitJobStatusUpdate(job.id, newStatus, task);
    } else {
      // Log or handle invalid transition
      this.logger.warn(`State transition failed: ${result.error}`);
    }
  }

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
    
    this.logger.log(`Processing queue: 
      - Queued: ${queuedCount}
      - Downloading: ${downloadingCount}
      - Downloaded: ${downloadedCount}
      - Processing: ${processingCount}
      - Completed: ${completedCount}
      - Failed: ${failedCount}`
    );
    
    // Early exit if no work to do
    if (queuedCount === 0 && downloadingCount === 0 && downloadedCount === 0) {
      this.logger.log('No work to do in queue');
      return;
    }
    
    // Process downloads within concurrency limit
    if (downloadingCount < this.maxConcurrentDownloads && queuedCount > 0) {
      const queuedJobs = this.getJobsByStatus('queued')
        .slice(0, this.maxConcurrentDownloads - downloadingCount);
      
      this.logger.log(`Starting download for ${queuedJobs.length} jobs`);
      
      for (const job of queuedJobs) {
        this.startDownload(job);
      }
    }
    
    // Check if ALL downloads are complete
    if (queuedCount === 0 && downloadingCount === 0 && downloadedCount > 0) {
      this.allDownloadsComplete = true;
      this.logger.log('All downloads complete. Preparing to process videos.');
      
      // Start processing videos
      await this.processVideos();
    }
  }
      
  // Start a download for a job
  private async startDownload(job: Job): Promise<void> {
    // Update job state
    this.jobStateManager.updateJobStatus(job, 'downloading', 'Initializing download...');
    
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
          this.jobStateManager.updateJobStatus(job, 'completed', 'Image download completed');
          this.logger.log(`Image download completed for job ${job.id}`);
        } else {
          // Mark videos as downloaded but not yet processed
          this.jobStateManager.updateJobStatus(job, 'downloaded', 'Download complete, waiting for processing...');
          this.logger.log(`Video download completed, waiting for processing: ${job.id}`);
        }
      } else {
        this.jobStateManager.updateJobStatus(job, 'failed', 'Download failed');
      }
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = error instanceof Error 
        ? error.message 
        : 'Unknown error during download';
      
      this.jobStateManager.updateJobStatus(job, 'failed', 'Download failed');
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
    // Ensure we only process once and only when all downloads are complete
    if (!this.allDownloadsComplete || this.isProcessing) {
      this.logger.log('Processing already in progress or downloads not complete');
      return;
    }

    const downloadedJobs = this.getJobsByStatus('downloaded');
    
    if (downloadedJobs.length === 0) {
      this.logger.log('No jobs to process');
      return;
    }
    
    this.isProcessing = true;
    this.logger.log(`Starting to process ${downloadedJobs.length} videos`);
    
    // Process videos concurrently, respecting maxConcurrentProcessing
    const processQueue = async () => {
      // Get jobs that are ready for processing but not yet started
      const processingJobs = this.getJobsByStatus('downloaded');
      
      // Stop if no more jobs to process
      if (processingJobs.length === 0) {
        this.isProcessing = false;
        this.allDownloadsComplete = false;
        
        // Emit batch completed event
        const completedCount = this.getJobsByStatus('completed').length;
        const failedCount = this.getJobsByStatus('failed').length;
        this.eventService.emitBatchCompleted(completedCount, failedCount);
        
        return;
      }
      
      // Determine how many jobs we can start processing
      const availableProcessingSlots = this.maxConcurrentProcessing - 
        this.getJobsByStatus('processing').length;
      
      // Start processing jobs
      const jobsToProcess = processingJobs.slice(0, availableProcessingSlots);
      
      const processPromises = jobsToProcess.map(async (job) => {
        // Explicitly set status to processing
        this.jobStateManager.updateJobStatus(job, 'processing', 'Preparing video processing');
        
        try {
          const outputFile = job.outputFile || 
            (job.options as any).outputFile || 
            (() => {
              this.logger.error(`No output file found for job ${job.id}`);
              throw new Error(`No output file for job ${job.id}`);
            })();

          const processingOptions: ProcessingOptions = {
            fixAspectRatio: job.options.fixAspectRatio ?? true,
          };
          
          try {
            const outputFile = job.outputFile || (() => {
              this.logger.error(`No output file found for job ${job.id}`);
              throw new Error(`No output file for job ${job.id}`);
            })();
    
            const processingOptions: ProcessingOptions = {
              fixAspectRatio: job.options.fixAspectRatio ?? true,
              useRmsNormalization: job.options.useRmsNormalization ?? false,
              rmsNormalizationLevel: job.options.rmsNormalizationLevel ?? 0,
              useCompression: job.options.useCompression ?? false,
              compressionLevel: job.options.compressionLevel ?? 5,
              transcribeVideo: job.options.transcribeVideo ?? false
            };
            
            const processingResult = await this.mediaProcessingService.processMedia(
              outputFile, 
              processingOptions, 
              job.id
            );
            
            if (processingResult.success) {
              if (processingResult.outputFile && processingResult.outputFile !== outputFile) {
                job.outputFile = processingResult.outputFile;
              }
            
              if (processingResult.transcriptFile) {
                job.transcriptFile = processingResult.transcriptFile;
              }
              
              if (job.status !== 'transcribing') {
                this.jobStateManager.updateJobStatus(job, 'completed', 'Processing completed');
                this.logger.log(`Processing completed for job ${job.id}`);
              } else {
                this.logger.log(`Job ${job.id} is in transcribing state, waiting for transcription to complete`);
              }
            } else {
              this.jobStateManager.updateJobStatus(job, 'failed', 'Unknown processing error');
              this.logger.error(`Processing failed for job ${job.id}: ${job.error}`);
                        }
          } catch (error) {
            this.jobStateManager.updateJobStatus(job, 'failed', 'Unexpected processing error');
            this.logger.error(`Unexpected error processing job ${job.id}`, error);
          }

          this.emitQueueUpdate();
        } catch {
          this.logger.error(`Unexpected error processing job ${job.id}`);
        }
      });
        
      // Wait for current batch of jobs to complete
      await Promise.all(processPromises);
      
      // Continue processing remaining jobs
      await processQueue();
    };
      
    // Start processing
    await processQueue();
  }
    
  // Update job progress from events
  updateJobProgress(jobId: string, progress: number, task: string): void {
    const job = this.jobs.get(jobId);
    
    if (job) {
      this.jobStateManager.updateJobProgress(job, progress, task);
      this.emitQueueUpdate();
    }
  }
  
  // Cancel a job
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    
    // Handle different job states
    if (job.status === 'queued') {
      this.jobStateManager.updateJobStatus(job, 'failed', 'Canceled by user');
      return true;
    }
    
    if (job.status === 'downloading') {
      if (this.downloaderService.cancelDownload(jobId)) {
        this.jobStateManager.updateJobStatus(job, 'failed', 'Canceled by user');
        return true;
      }
    }
    
    if (job.status === 'downloaded' || job.status === 'processing') {
      this.jobStateManager.updateJobStatus(job, 'failed', 'Canceled by user');
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
      this.jobStateManager.updateJobStatus(job, 'downloaded', 'Waiting for processing...');
    } else {
      this.jobStateManager.updateJobStatus(job, 'queued', 'Waiting in queue...');
    }

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
    const transcribingJobs = this.getJobsByStatus('transcribing').map(job => this.formatJobForResponse(job));
    const completedJobs = this.getJobsByStatus('completed').map(job => this.formatJobForResponse(job));
    const failedJobs = this.getJobsByStatus('failed').map(job => this.formatJobForResponse(job));
    
    return {
      queuedJobs,
      downloadingJobs,
      downloadedJobs,
      processingJobs,
      transcribingJobs,
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
      thumbnail: job.thumbnail,
      transcriptFile: job.transcriptFile
    };
  }
  
  // Clear active jobs
  clearQueues(): void {
    // Find all active jobs
    const activeJobs = Array.from(this.jobs.values())
      .filter(job => ['queued', 'downloading', 'downloaded', 'processing'].includes(job.status));
    
    // Mark them as failed
    for (const job of activeJobs) {
      this.jobStateManager.updateJobStatus(job, 'failed', 'Canceled by user');
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