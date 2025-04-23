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
  downloadResult?: DownloadResult;
  error?: string;
}

@WebSocketGateway({ cors: true })
@Injectable()
export class BatchDownloaderService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(BatchDownloaderService.name);
  private downloadQueue: BatchJob[] = [];
  private processingQueue: BatchJob[] = [];
  private activeDownloads: Set<string> = new Set();
  private maxConcurrentDownloads: number = 2; // Default value, can be configured
  private isProcessing: boolean = false;

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly ffmpegService: FfmpegService,
  ) {}

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
      status: 'queued'
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
      this.logger.log('Download queue is empty, nothing to process');
      
      // If all downloads are complete, start processing the videos
      if (this.activeDownloads.size === 0 && this.processingQueue.length > 0 && !this.isProcessing) {
        this.processVideos();
      }
      
      return;
    }
    
    // Check if we can start more downloads
    while (this.activeDownloads.size < this.maxConcurrentDownloads && this.downloadQueue.length > 0) {
      const job = this.downloadQueue.shift();
      
      if (!job) continue;
      
      // Mark as downloading
      job.status = 'downloading';
      this.activeDownloads.add(job.id);
      
      // Emit queue update
      this.emitQueueUpdate();
      
      // Start download
      this.logger.log(`Starting download for job ${job.id}`);
      
      try {
        const result = await this.downloaderService.downloadVideo(job.options, job.id);
        
        if (result.success) {
          this.logger.log(`Download completed successfully for job ${job.id}`);
          job.downloadResult = result;
          job.status = 'processing';
          
          // Add to processing queue
          this.processingQueue.push(job);
        } else {
          this.logger.error(`Download failed for job ${job.id}: ${result.error}`);
          job.status = 'failed';
          job.error = result.error;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Exception in download for job ${job.id}: ${errorMessage}`);
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
      
      // Remove from active downloads
      this.activeDownloads.delete(job.id);
      
      // Emit queue update
      this.emitQueueUpdate();
      
      // Continue processing the queue
      this.processDownloadQueue();
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
      const job = this.processingQueue.shift();
      
      if (!job || !job.downloadResult || !job.downloadResult.outputFile) {
        continue;
      }
      
      try {
        // Check if the result is an image
        const isImage = job.downloadResult.isImage === true;
        
        if (isImage) {
          // Skip processing for images
          this.logger.log(`Skipping processing for image: ${job.downloadResult.outputFile}`);
          job.status = 'completed';
          this.emitQueueUpdate();
          continue;
        }
        
        this.logger.log(`Processing video for job ${job.id}: ${job.downloadResult.outputFile}`);
        this.emitEvent('processing-progress', { 
          progress: 0, 
          task: 'Processing video...',
          jobId: job.id
        });
        
        // Apply processing based on options
        let processedFile = job.downloadResult.outputFile;
        
        if (job.options.fixAspectRatio) {
          this.emitEvent('processing-progress', { 
            progress: 20, 
            task: 'Fixing aspect ratio...',
            jobId: job.id
          });
          
          const fixedFile = await this.ffmpegService.fixAspectRatio(processedFile);
          if (fixedFile) {
            processedFile = fixedFile;
          }
        }
        
        // Emit processing completed
        this.emitEvent('processing-progress', { 
          progress: 100, 
          task: 'Processing completed',
          jobId: job.id
        });
        
        job.status = 'completed';
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Error processing video for job ${job.id}: ${errorMessage}`);
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Unknown error';
        
        this.emitEvent('processing-failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          jobId: job.id
        });
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
  
  getBatchStatus(): any {
    return {
      downloadQueue: this.downloadQueue.length,
      processingQueue: this.processingQueue.length,
      activeDownloads: Array.from(this.activeDownloads),
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing
    };
  }

  clearQueues(): void {
    this.downloadQueue = [];
    this.processingQueue = [];
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
      downloadQueue: this.downloadQueue.map(job => ({
        id: job.id,
        url: job.options.url,
        status: job.status,
        error: job.error
      })),
      processingQueue: this.processingQueue.map(job => ({
        id: job.id,
        url: job.options.url,
        status: job.status,
        error: job.error
      })),
      activeDownloads: Array.from(this.activeDownloads),
      maxConcurrentDownloads: this.maxConcurrentDownloads,
      isProcessing: this.isProcessing
    };
    
    this.emitEvent('batch-queue-updated', queueStatus);
  }
}