// clippy/backend/src/media/media-event.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({ cors: true })
@Injectable()
export class MediaEventService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MediaEventService.name);
  
  /**
   * Base method to emit any event with data
   */
  public emitEvent(eventType: string, data: any): void {
    if (!this.server) {
      this.logger.warn(`Cannot emit event: ${eventType} - WebSocket server not initialized`);
      return;
    }
    
    this.server.emit(eventType, data);
  }
  
  /**
   * Helper to ensure progress is within valid range (0-100)
   */
  private normalizeProgress(progress: number): number {
    return Math.max(0, Math.min(100, progress));
  }
  
  /**
   * Helper to create a timestamp
   */
  private getTimestamp(): string {
    return new Date().toISOString();
  }
  
  emitJobStatusUpdate(jobId: string, status: string, task: string): void {
    this.logger.log(`Emitting job status update for ${jobId}: ${status} - ${task}`);
    this.emitEvent('job-status-updated', {
      jobId,
      status,
      task,
      timestamp: this.getTimestamp()
    });
  }
    
  /** 
   * transcription methods
  */
  emitTranscriptionStarted(inputFile: string, jobId?: string): void {
    this.emitEvent('transcription-started', {
      inputFile,
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  emitTranscriptionProgress(progress: number, task: string, jobId?: string): void {
    // Send the progress event
    this.emitEvent('transcription-progress', {
      progress: this.normalizeProgress(progress),
      task,
      jobId
    });
  }
    
  emitTranscriptionCompleted(outputFile: string, jobId?: string): void {
    this.emitEvent('transcription-completed', {
      outputFile,
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  emitTranscriptionFailed(inputFile: string, error: string, jobId?: string): void {
    this.emitEvent('transcription-failed', {
      inputFile,
      error,
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  /**
   * Download events
   */
  emitDownloadStarted(url: string, jobId?: string): void {
    this.emitEvent('download-started', { 
      url, 
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  emitDownloadProgress(progress: number, task: string, jobId?: string, additionalInfo?: any): void {
    this.emitEvent('download-progress', {
      progress: this.normalizeProgress(progress),
      task,
      jobId,
      ...additionalInfo
    });
  }
  
  emitDownloadCompleted(outputFile: string, url: string, jobId?: string, isImage: boolean = false): void {
    this.emitEvent('download-completed', { 
      outputFile, 
      url,
      jobId,
      isImage,
      timestamp: this.getTimestamp()
    });
  }
  
  emitDownloadFailed(url: string, error: string, jobId?: string): void {
    this.emitEvent('download-failed', { 
      url, 
      error,
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  /**
   * Processing events
   */
  emitProcessingStarted(inputFile: string, options: any, jobId?: string): void {
    this.emitEvent('processing-started', { 
      inputFile, 
      options,
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  emitProcessingProgress(progress: number, task: string, jobId?: string, additionalInfo?: any): void {
    this.emitEvent('processing-progress', {
      progress: this.normalizeProgress(progress),
      task,
      jobId,
      ...additionalInfo
    });
  }
    
  emitProcessingCompleted(
    outputFile: string, 
    jobId?: string, 
    thumbnailFile?: string, 
    audioFile?: string,
    transcriptFile?: string
  ): void {
    this.emitEvent('processing-completed', { 
      outputFile,
      jobId,
      thumbnailFile,
      audioFile,
      transcriptFile, // Added this parameter
      timestamp: this.getTimestamp()
    });
  }
  
  emitProcessingFailed(inputFile: string, error: string, jobId?: string): void {
    this.emitEvent('processing-failed', { 
      inputFile, 
      error,
      jobId,
      timestamp: this.getTimestamp()
    });
  }
  
  /**
   * Batch events
   */
  emitBatchQueueUpdated(queueState: any): void {
    this.emitEvent('batch-queue-updated', queueState);
  }
  
  emitBatchCompleted(completedJobsCount: number, failedJobsCount: number): void {
    this.emitEvent('batch-completed', {
      completedJobsCount,
      failedJobsCount,
      timestamp: this.getTimestamp()
    });
  }
  
  /**
   * Combined job progress event
   */
  emitJobProgress(jobId: string, progress: number, status: string, task: string): void {
    this.emitEvent('job-progress-updated', {
      jobId,
      progress: this.normalizeProgress(progress),
      status,
      task,
      timestamp: this.getTimestamp()
    });
  }
}