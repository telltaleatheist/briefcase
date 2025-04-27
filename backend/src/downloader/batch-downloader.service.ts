// clippy/backend/src/downloader/batch-downloader.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { DownloaderService } from './downloader.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { DownloadOptions, DownloadResult } from '../common/interfaces/download.interface';

interface BatchJob {
  id: string;
  options: DownloadOptions;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed';
  progress: number;
  currentTask: string;
  downloadResult?: DownloadResult;
  error?: string;
  // Use strings for dates to match frontend expectations
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
}

@WebSocketGateway({ cors: true })
@Injectable()
export class BatchDownloaderService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(BatchDownloaderService.name);
  private downloadQueue: BatchJob[] = [];
  private processingQueue: BatchJob[] = [];
  private completedJobs: BatchJob[] = []; // New array to track completed jobs
  private failedJobs: BatchJob[] = []; // New array to track failed jobs
  private activeDownloads: Set<string> = new Set();
  private maxConcurrentDownloads: number = 2; // Default value, can be configured
  private isProcessing: boolean = false;

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly ffmpegService: FfmpegService,
  ) {
    // Set up listeners for downloader service events
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // This will be implemented after downloader service is modified
    // to emit more detailed progress events
  }

  setMaxConcurrentDownloads(max: number): void {
    this.maxConcurrentDownloads = max;
    this.logger.log(`Max concurrent downloads set to: ${max}`);
  }

  getMaxConcurrentDownloads(): number {
    return this.maxConcurrentDownloads;
  }

  addToBatchQueue(options: DownloadOptions): string {
    const jobId = `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    const job: BatchJob = {
      id: jobId,
      options,
      status: 'queued',
      progress: 0,
      currentTask: 'Waiting in queue...'
    };
    
    this.downloadQueue.push(job);
    this.logger.log(`Added job ${jobId} to batch queue. Queue size: ${this.downloadQueue.length}`);
    
    // Emit queue update event
    this.emitQueueUpdate();
    
    // Start processing the queue if not already processing
    this.processDownloadQueue();
    
    return jobId;
  }

  private async processDownloadQueue(): Promise<void> {
    if (this.downloadQueue.length === 0) {
      this.logger.log('Download queue is empty, checking for processing');
      
      // Only start processing if ALL active downloads are complete
      if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
        this.logger.log('All downloads complete. Starting video processing.');
        await this.processVideos();
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
      
      // Start download
      this.logger.log(`Starting download for job ${job.id}`);
      
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
      }
      
      // Remove from active downloads
      this.activeDownloads.delete(job.id);
      
      // Emit queue update
      this.emitQueueUpdate();
      
      // Continue processing the queue
      await this.processDownloadQueue();
    }
  
    // If no more active downloads, check if we can process
    if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
      this.logger.log('All downloads complete. Starting video processing.');
      await this.processVideos();
    }
  }  

  private async processVideos(): Promise<void> {
    if (this.processingQueue.length === 0 || this.isProcessing) {
      return;
    }
    
    this.isProcessing = true;
    this.logger.log(`Starting to process ${this.processingQueue.length} videos`);
    
    // Process each video in the queue
    while (this.processingQueue.length > 0) {
      const job = this.processingQueue[0]; // Keep the job in the queue until processing is done
      
      if (!job || !job.downloadResult || !job.downloadResult.outputFile) {
        this.processingQueue.shift(); // Remove invalid job
        continue;
      }
      
      job.processingStartTime = new Date().toISOString();
      job.progress = 0;
      job.currentTask = 'Starting processing...';
      this.emitQueueUpdate();
      
      try {
        // Check if the result is an image
        const isImage = job.downloadResult.isImage === true;
        
        if (isImage) {
          // Skip processing for images
          this.logger.log(`Skipping processing for image: ${job.downloadResult.outputFile}`);
          job.status = 'completed';
          job.progress = 100;
          job.currentTask = 'Image download completed';
          job.processingEndTime = new Date().toISOString();
  
          // Move to completed jobs
          this.completedJobs.push(job);
          this.processingQueue.shift();
          
          this.emitQueueUpdate();
          continue;
        }
        
        this.logger.log(`Processing video for job ${job.id}: ${job.downloadResult.outputFile}`);
        job.currentTask = 'Processing video...';
        job.progress = 0;
        this.emitQueueUpdate();
        
        // Apply aspect ratio correction only if needed
        // The audio and video should already be combined from the downloader service
        let processedFile = job.downloadResult.outputFile;
        
        if (job.options.fixAspectRatio) {
          job.currentTask = 'Fixing aspect ratio...';
          job.progress = 10;
          this.emitQueueUpdate();
          
          const fixedFile = await this.ffmpegService.fixAspectRatio(processedFile, job.id);
          if (fixedFile) {
            processedFile = fixedFile;
          }
        }
        
        // Processing completed
        job.status = 'completed';
        job.progress = 100;
        job.currentTask = 'Processing completed';
        job.processingEndTime = new Date().toISOString();
  
        // Move to completed jobs array
        this.completedJobs.push(job);
        this.processingQueue.shift();
        
      } catch (error) {
        // Error handling...
      }
      
      // Emit queue update
      this.emitQueueUpdate();
    }
    
    this.isProcessing = false;
    this.logger.log('All videos processed');
    
    // Emit batch completed event
    this.emitEvent('batch-completed', {
      timestamp: new Date().toISOString()
    });
  }
    
  // Update job progress from events
  updateJobProgress(jobId: string, progress: number, task: string): void {
    // Search for the job in all queues
    let job = this.findJobById(jobId);
    
    if (job) {
      job.progress = progress;
      job.currentTask = task;
      this.emitQueueUpdate();
    }
  }
  
  // Helper to find a job by ID across all queues
  private findJobById(jobId: string): BatchJob | null {
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
  
  getBatchStatus(): any {
    return {
      downloadQueue: this.downloadQueue.map(this.formatJobForResponse),
      processingQueue: this.processingQueue.map(this.formatJobForResponse),
      completedJobs: this.completedJobs.map(this.formatJobForResponse),
      failedJobs: this.failedJobs.map(this.formatJobForResponse),
      activeDownloads: Array.from(this.activeDownloads),
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing
    };
  }
  
  // Format job for API response
  private formatJobForResponse(job: BatchJob) {
    return {
      id: job.id,
      url: job.options.url,
      status: job.status,
      progress: job.progress,
      currentTask: job.currentTask,
      error: job.error,
      downloadStartTime: job.downloadStartTime,
      downloadEndTime: job.downloadEndTime,
      processingStartTime: job.processingStartTime,
      processingEndTime: job.processingEndTime
    };
  }

  clearQueues(): void {
    this.downloadQueue = [];
    this.processingQueue = [];
    this.completedJobs = [];
    this.failedJobs = [];
    this.logger.log('All queues cleared');
    this.emitQueueUpdate();
  }

  private emitEvent(event: string, data: any): void {
    if (this.server) {
      this.server.emit(event, data);
    } else {
      this.logger.warn(`Cannot emit ${event} - WebSocket server not initialized`);
    }
  }

  private emitQueueUpdate(): void {
    const queueStatus = {
      downloadQueue: this.downloadQueue.map(this.formatJobForResponse),
      processingQueue: this.processingQueue.map(this.formatJobForResponse),
      completedJobs: this.completedJobs.map(this.formatJobForResponse),
      failedJobs: this.failedJobs.map(this.formatJobForResponse),
      activeDownloads: Array.from(this.activeDownloads),
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing
    };
    
    this.emitEvent('batch-queue-updated', queueStatus);
  }
}