// clippy/backend/src/downloader/batch-downloader.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { DownloaderService } from './downloader.service';
import { MediaProcessingService, ProcessingOptions } from '../media/media-processing.service';
import { 
  DownloadOptions, 
  DownloadResult 
} from '../common/interfaces/download.interface';

// Updated DownloadOptions to include processing options
export interface ExtendedDownloadOptions extends DownloadOptions {
  createThumbnail?: boolean;
  extractAudio?: boolean;
  qualityPreset?: 'low' | 'medium' | 'high';
  customOptions?: Record<string, any>;
}

export type JobPriority = 'low' | 'normal' | 'high';

export interface BatchJob {
  id: string;
  options: ExtendedDownloadOptions; // Use ExtendedDownloadOptions instead of DownloadOptions
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed' | 'paused';
  progress: number;
  currentTask: string;
  downloadResult?: DownloadResult;
  error?: string;
  // Timestamps using ISO strings
  createdAt: string;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  // New fields
  priority: JobPriority;
  retryCount: number;
}

// Separate interface for API responses
export interface BatchJobResponse {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed' | 'paused';
  progress: number;
  currentTask: string;
  error?: string;
  priority: JobPriority;
  retryCount: number;
  createdAt: string;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  outputFile?: string;
}

export interface BatchQueueState {
  downloadQueue: BatchJobResponse[];
  processingQueue: BatchJobResponse[];
  completedJobs: BatchJobResponse[];
  failedJobs: BatchJobResponse[];
  activeDownloads: string[];
  maxConcurrentDownloads: number;
  isProcessing: boolean;
  isPaused: boolean;
}

@WebSocketGateway({ cors: true })
@Injectable()
export class BatchDownloaderService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(BatchDownloaderService.name);
  private downloadQueue: BatchJob[] = [];
  private processingQueue: BatchJob[] = [];
  private completedJobs: BatchJob[] = [];
  private failedJobs: BatchJob[] = [];
  private activeDownloads: Set<string> = new Set();
  private maxConcurrentDownloads: number = 2;
  private isProcessing: boolean = false;
  private isPaused: boolean = false;
  
  // Maintain a map of currently processing jobs for quick access
  private processingJobs: Map<string, BatchJob> = new Map();

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly mediaProcessingService: MediaProcessingService,
  ) {
    // Set up event listeners for real-time progress updates
    this.setupEventListeners();
  }

  /**
   * Set up event listeners for the downloader and media processing services
   */
  private setupEventListeners(): void {
    // Nothing needed here for now - we'll implement proper event handling
    // in the DownloaderService and MediaProcessingService
  }

  /**
   * Set the maximum number of concurrent downloads
   */
  setMaxConcurrentDownloads(max: number): void {
    if (max < 1) {
      throw new Error('Maximum concurrent downloads must be at least 1');
    }
    
    this.maxConcurrentDownloads = max;
    this.logger.log(`Max concurrent downloads set to: ${max}`);
    
    // If we've increased the limit, try to start more downloads
    this.processDownloadQueue();
  }

  /**
   * Get the current maximum concurrent downloads setting
   */
  getMaxConcurrentDownloads(): number {
    return this.maxConcurrentDownloads;
  }

  /**
   * Add a new job to the download queue
   */
  addToBatchQueue(options: ExtendedDownloadOptions & { priority?: JobPriority }): string {
    const jobId = `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    const job: BatchJob = {
      id: jobId,
      options,
      status: 'queued',
      progress: 0,
      currentTask: 'Waiting in queue...',
      createdAt: new Date().toISOString(),
      priority: options.priority || 'normal',
      retryCount: 0
    };
    
    // Insert based on priority
    this.insertJobByPriority(job);
    
    this.logger.log(`Added job ${jobId} to batch queue. Queue size: ${this.downloadQueue.length}`);
    
    // Emit queue update event
    this.emitQueueUpdate();
    
    // Start processing the queue if not already processing and not paused
    if (!this.isPaused) {
      this.processDownloadQueue();
    }
    
    return jobId;
  }

  /**
   * Insert a job into the queue based on its priority
   */
  private insertJobByPriority(job: BatchJob): void {
    // Find the position to insert based on priority
    const index = this.downloadQueue.findIndex(queued => 
      this.getPriorityValue(queued.priority) < this.getPriorityValue(job.priority)
    );
    
    if (index === -1) {
      // No higher priority job found, add to end
      this.downloadQueue.push(job);
    } else {
      // Insert at the found position
      this.downloadQueue.splice(index, 0, job);
    }
  }

  /**
   * Convert priority string to numeric value for comparison
   */
  private getPriorityValue(priority: JobPriority): number {
    switch (priority) {
      case 'high': return 3;
      case 'normal': return 2;
      case 'low': return 1;
      default: return 2; // Default to normal
    }
  }

  /**
   * Process the download queue, starting as many downloads as allowed
   * by the concurrency limit
   */
  private async processDownloadQueue(): Promise<void> {
    if (this.isPaused) {
      this.logger.log('Queue is paused, not processing');
      return;
    }
    
    if (this.downloadQueue.length === 0) {
      this.logger.log('Download queue is empty, checking for processing');
      
      // Only start processing if ALL active downloads are complete
      if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
        this.logger.log('All downloads complete. Starting media processing.');
        await this.processMediaQueue();
      }
      
      return;
    }
    
    // Check if we can start more downloads
    while (this.activeDownloads.size < this.maxConcurrentDownloads && this.downloadQueue.length > 0) {
      const job = this.downloadQueue.shift();
      
      if (!job) continue;
      
      // Mark as downloading
      job.status = 'downloading';
      job.progress = 0;
      job.currentTask = 'Starting download...';
      job.downloadStartTime = new Date().toISOString();
      this.activeDownloads.add(job.id);
            
      // Emit queue update
      this.emitQueueUpdate();
      
      // Start download in a non-blocking way
      this.logger.log(`Starting download for job ${job.id}`);
      
      this.downloadJob(job)
        .then(() => {
          // Process queue again after job completes
          this.processDownloadQueue();
        })
        .catch(error => {
          this.logger.error(`Unexpected error in downloadJob: ${error instanceof Error ? error.message : String(error)}`);
          // Process queue again even on error
          this.processDownloadQueue();
        });
    }
  }
  
  /**
   * Handle the downloading of a single job
   */
  private async downloadJob(job: BatchJob): Promise<void> {
    try {
      const result = await this.downloaderService.downloadVideo(job.options, job.id);
      
      job.downloadEndTime = new Date().toISOString();
      
      if (result.success) {
        this.logger.log(`Download completed successfully for job ${job.id}`);
        job.downloadResult = result;
        job.status = 'processing';
        job.progress = 0;
        job.currentTask = 'Download complete, queued for processing...';
        
        // Add to processing queue ONLY if download was successful
        this.processingQueue.push(job);
      } else {
        // Handle download failure
        this.logger.error(`Download failed for job ${job.id}: ${result.error}`);
        job.status = 'failed';
        job.error = result.error;
        job.progress = 0;
        job.currentTask = `Failed: ${result.error}`;
        
        this.failedJobs.push(job);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Exception in download for job ${job.id}: ${errorMessage}`);
      job.status = 'failed';
      job.error = errorMessage;
      job.progress = 0;
      job.currentTask = `Failed: ${job.error}`;
      
      this.failedJobs.push(job);
    } finally {
      // Remove from active downloads regardless of outcome
      this.activeDownloads.delete(job.id);
      
      // Emit queue update
      this.emitQueueUpdate();
      
      // Check if we can start processing
      if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
        this.logger.log('All downloads complete. Starting media processing.');
        await this.processMediaQueue();
      }
    }
  }

  /**
   * Process the media processing queue sequentially
   */
  private async processMediaQueue(): Promise<void> {
    if (this.processingQueue.length === 0 || this.isProcessing) {
      return;
    }
    
    this.isProcessing = true;
    this.logger.log(`Starting to process ${this.processingQueue.length} media items`);
    
    while (this.processingQueue.length > 0) {
      const job = this.processingQueue[0]; // Keep the job in the queue until processing is done
      
      if (!job || !job.downloadResult || !job.downloadResult.outputFile) {
        this.processingQueue.shift(); // Remove invalid job
        continue;
      }
      
      // Add to processing jobs map
      this.processingJobs.set(job.id, job);
      
      // Update job state
      job.processingStartTime = new Date().toISOString();
      job.progress = 0;
      job.currentTask = 'Starting processing...';
      this.emitQueueUpdate();
      
      try {
        // Convert download options to processing options
        const processingOptions: ProcessingOptions = {
          fixAspectRatio: job.options.fixAspectRatio || false,
          createThumbnail: job.options.createThumbnail || false,
          extractAudio: job.options.extractAudio || false,
          qualityPreset: job.options.qualityPreset || 'medium',
          customOptions: job.options.customOptions
        };
        
        // Process the media
        const processingResult = await this.mediaProcessingService.processMedia(
          job.downloadResult.outputFile,
          processingOptions,
          job.id
        );
        
        // Update job with processing results
        if (processingResult.success) {
          // Processing completed successfully
          job.status = 'completed';
          job.progress = 100;
          job.currentTask = 'Processing completed';
          job.processingEndTime = new Date().toISOString();
          
          // Update output file with processed file
          if (processingResult.outputFile) {
            job.downloadResult.outputFile = processingResult.outputFile;
          }
          
          // Move to completed jobs array
          this.completedJobs.push(job);
        } else {
          // Processing failed
          job.status = 'failed';
          job.error = processingResult.error || 'Unknown processing error';
          job.progress = 0;
          job.currentTask = `Processing failed: ${job.error}`;
          
          this.failedJobs.push(job);
        }
      } catch (error) {
        // Error handling logic
        this.logger.error(`Error processing media: ${error instanceof Error ? error.message : String(error)}`);
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Unknown error';
        job.progress = 0;
        job.currentTask = `Processing failed: ${job.error}`;
        
        this.failedJobs.push(job);
      } finally {
        // Remove from processing jobs map and queue
        this.processingJobs.delete(job.id);
        this.processingQueue.shift();
        
        // Emit queue update
        this.emitQueueUpdate();
      }
    }
    
    this.isProcessing = false;
    this.logger.log('All media processed');
    
    // Emit batch completed event
    this.emitEvent('batch-completed', {
      timestamp: new Date().toISOString(),
      completedJobsCount: this.completedJobs.length,
      failedJobsCount: this.failedJobs.length
    });
  }

  /**
   * Update job progress from events
   */
  updateJobProgress(jobId: string, progress: number, task: string): void {
    // Search for the job in all queues
    let job = this.findJobById(jobId);
    
    if (job) {
      job.progress = progress;
      job.currentTask = task;
      this.emitQueueUpdate();
    }
  }
  
  /**
   * Pause the queue - prevent processing new items
   */
  pauseQueue(): boolean {
    if (this.isPaused) {
      return false; // Already paused
    }
    
    this.isPaused = true;
    this.logger.log('Queue paused');
    this.emitQueueUpdate();
    return true;
  }
  
  /**
   * Resume the queue - continue processing
   */
  resumeQueue(): boolean {
    if (!this.isPaused) {
      return false; // Already running
    }
    
    this.isPaused = false;
    this.logger.log('Queue resumed');
    this.emitQueueUpdate();
    
    // Start processing
    this.processDownloadQueue();
    return true;
  }
  
  /**
   * Change the priority of a queued job
   */
  changeJobPriority(jobId: string, priority: JobPriority): boolean {
    const jobIndex = this.downloadQueue.findIndex(job => job.id === jobId);
    
    if (jobIndex === -1) {
      return false; // Job not found in queue
    }
    
    // Remove job from queue
    const job = this.downloadQueue.splice(jobIndex, 1)[0];
    
    // Update priority
    job.priority = priority;
    
    // Reinsert based on new priority
    this.insertJobByPriority(job);
    
    this.logger.log(`Changed job ${jobId} priority to ${priority}`);
    this.emitQueueUpdate();
    
    return true;
  }
  
  /**
   * Move a job to the top of the queue
   */
  moveToTop(jobId: string): boolean {
    const jobIndex = this.downloadQueue.findIndex(job => job.id === jobId);
    
    if (jobIndex === -1) {
      return false; // Job not found in queue
    }
    
    // Remove job from queue
    const job = this.downloadQueue.splice(jobIndex, 1)[0];
    
    // Change priority to high
    job.priority = 'high';
    
    // Add to beginning of queue
    this.downloadQueue.unshift(job);
    
    this.logger.log(`Moved job ${jobId} to top of queue`);
    this.emitQueueUpdate();
    
    return true;
  }
  
  /**
   * Cancel a queued or active job
   */
  cancelJob(jobId: string): boolean {
    // First, check if the job is in the download queue
    const queuedIndex = this.downloadQueue.findIndex(job => job.id === jobId);
    
    if (queuedIndex !== -1) {
      // Simply remove from queue
      const job = this.downloadQueue.splice(queuedIndex, 1)[0];
      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.currentTask = 'Cancelled';
      
      this.failedJobs.push(job);
      this.emitQueueUpdate();
      
      return true;
    }
    
    // Check if job is actively downloading
    if (this.activeDownloads.has(jobId)) {
      // TODO: Implement cancellation of active downloads
      // This would require modifications to the DownloaderService
      
      this.logger.log(`Attempted to cancel active download ${jobId} - not yet implemented`);
      return false;
    }
    
    // Check if job is in processing queue
    const processingIndex = this.processingQueue.findIndex(job => job.id === jobId);
    
    if (processingIndex !== -1) {
      // Can only cancel if it's not the currently processing job (first in queue)
      if (processingIndex > 0) {
        const job = this.processingQueue.splice(processingIndex, 1)[0];
        job.status = 'failed';
        job.error = 'Cancelled by user';
        job.currentTask = 'Cancelled';
        
        this.failedJobs.push(job);
        this.emitQueueUpdate();
        
        return true;
      } else {
        // TODO: Implement cancellation of active processing
        // This would require modifications to the MediaProcessingService
        
        this.logger.log(`Attempted to cancel active processing ${jobId} - not yet implemented`);
        return false;
      }
    }
    
    return false; // Job not found in any queue
  }
  
  /**
   * Retry a failed job
   */
  retryJob(jobId: string): boolean {
    const failedIndex = this.failedJobs.findIndex(job => job.id === jobId);
    
    if (failedIndex === -1) {
      return false; // Job not found in failed jobs
    }
    
    // Remove from failed jobs
    const job = this.failedJobs.splice(failedIndex, 1)[0];
    
    // Reset job state
    job.status = 'queued';
    job.progress = 0;
    job.error = undefined;
    job.currentTask = 'Retrying...';
    job.retryCount += 1;
    
    // Add back to download queue with high priority
    job.priority = 'high';
    this.downloadQueue.unshift(job);
    
    this.logger.log(`Retrying failed job ${jobId}`);
    this.emitQueueUpdate();
    
    // Start processing if paused
    if (!this.isPaused) {
      this.processDownloadQueue();
    }
    
    return true;
  }
  
  /**
   * Helper to find a job by ID across all queues
   */
  private findJobById(jobId: string): BatchJob | null {
    // Check processing jobs map first (fastest)
    if (this.processingJobs.has(jobId)) {
      return this.processingJobs.get(jobId) || null;
    }
    
    // Check download queue
    const downloadJob = this.downloadQueue.find(job => job.id === jobId);
    if (downloadJob) return downloadJob;
    
    // Check processing queue
    const processingJob = this.processingQueue.find(job => job.id === jobId);
    if (processingJob) return processingJob;
    
    // Check completed jobs
    const completedJob = this.completedJobs.find(job => job.id === jobId);
    if (completedJob) return completedJob;
    
    // Check failed jobs
    const failedJob = this.failedJobs.find(job => job.id === jobId);
    if (failedJob) return failedJob;
    
    return null;
  }
  
  /**
   * Get the current status of all queues
   */
  getBatchStatus(): BatchQueueState {
    return {
      downloadQueue: this.downloadQueue.map(job => this.formatJobForResponse(job)),
      processingQueue: this.processingQueue.map(job => this.formatJobForResponse(job)),
      completedJobs: this.completedJobs.map(job => this.formatJobForResponse(job)),
      failedJobs: this.failedJobs.map(job => this.formatJobForResponse(job)),
      activeDownloads: Array.from(this.activeDownloads),
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing,
      isPaused: this.isPaused
    };
  }
  
  /**
   * Format job for API response
   */
  private formatJobForResponse(job: BatchJob): BatchJobResponse {
    return {
      id: job.id,
      url: job.options.url,
      status: job.status,
      progress: job.progress,
      currentTask: job.currentTask,
      error: job.error,
      priority: job.priority,
      retryCount: job.retryCount,
      createdAt: job.createdAt,
      downloadStartTime: job.downloadStartTime,
      downloadEndTime: job.downloadEndTime,
      processingStartTime: job.processingStartTime,
      processingEndTime: job.processingEndTime,
      outputFile: job.downloadResult?.outputFile
    };
  }

  /**
   * Clear all queues
   */
  clearQueues(): void {
    this.downloadQueue = [];
    this.processingQueue = [];
    this.completedJobs = [];
    this.failedJobs = [];
    this.processingJobs.clear();
    this.logger.log('All queues cleared');
    this.emitQueueUpdate();
  }
  
  /**
   * Clear only completed jobs
   */
  clearCompletedJobs(): void {
    this.completedJobs = [];
    this.logger.log('Completed jobs cleared');
    this.emitQueueUpdate();
  }
  
  /**
   * Clear only failed jobs
   */
  clearFailedJobs(): void {
    this.failedJobs = [];
    this.logger.log('Failed jobs cleared');
    this.emitQueueUpdate();
  }

  /**
   * Emit a websocket event
   */
  private emitEvent(event: string, data: any): void {
    if (this.server) {
      this.server.emit(event, data);
    } else {
      this.logger.warn(`Cannot emit ${event} - WebSocket server not initialized`);
    }
  }

  /**
   * Emit queue update event
   */
  private emitQueueUpdate(): void {
    const queueStatus = this.getBatchStatus();
    this.emitEvent('batch-queue-updated', queueStatus);
  }
}