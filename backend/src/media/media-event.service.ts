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
  
  emitJobStatusUpdate(jobId: string, status: string, task: string, extraData?: { videoId?: string, videoPath?: string }): void {
    this.logger.log(`Emitting job status update for ${jobId}: ${status} - ${task}`);
    this.emitEvent('job-status-updated', {
      jobId,
      status,
      task,
      timestamp: this.getTimestamp(),
      ...extraData
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

  emitDownloadSkipped(url: string, reason: string, videoId?: string, jobId?: string): void {
    this.emitEvent('download-skipped', {
      url,
      reason,
      videoId,
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

  /**
   * Library download duplicate detection
   */
  emitLibraryDownloadDuplicate(jobId: string, videoId: string, filename: string): void {
    this.emitEvent('library-download-duplicate', {
      jobId,
      videoId,
      filename,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Library download action response (after user chooses to replace or cancel)
   */
  emitLibraryDownloadActionReceived(jobId: string, action: 'replace' | 'cancel'): void {
    this.emitEvent('library-download-action-received', {
      jobId,
      action,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Video renamed event (notify frontend when a video's filename changes)
   */
  emitVideoRenamed(videoId: string, oldFilename: string, newFilename: string, newPath: string): void {
    this.emitEvent('video-renamed', {
      videoId,
      oldFilename,
      newFilename,
      newPath,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Video path updated event (notify frontend when a video's path changes, e.g., after relinking)
   */
  emitVideoPathUpdated(videoId: string, newPath: string, oldPath?: string): void {
    this.emitEvent('video-path-updated', {
      videoId,
      newPath,
      oldPath,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Video imported event (notify frontend when a new video is added to the library)
   */
  emitVideoImported(videoId: string, filename: string, filePath: string): void {
    this.logger.log(`Emitting video-imported event for ${videoId}: ${filename}`);
    this.emitEvent('video-imported', {
      videoId,
      filename,
      filePath,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Import complete event (notify frontend when batch import finishes)
   */
  emitImportComplete(importedCount: number, skippedCount: number, errorCount: number): void {
    this.logger.log(`Emitting import-complete event: ${importedCount} imported, ${skippedCount} skipped, ${errorCount} errors`);
    this.emitEvent('import-complete', {
      importedCount,
      skippedCount,
      errorCount,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Suggestion accepted event (notify frontend when a video name suggestion is accepted)
   */
  emitSuggestionAccepted(videoId: string, oldFilename: string, newFilename: string): void {
    this.logger.log(`Emitting suggestion-accepted event for ${videoId}: ${oldFilename} -> ${newFilename}`);
    this.emitEvent('suggestion-accepted', {
      videoId,
      oldFilename,
      newFilename,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Suggestion rejected event (notify frontend when a video name suggestion is rejected)
   */
  emitSuggestionRejected(videoId: string): void {
    this.logger.log(`Emitting suggestion-rejected event for ${videoId}`);
    this.emitEvent('suggestion-rejected', {
      videoId,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Analysis events
   */
  emitAnalysisProgress(videoId: string, progress: number, message: string, jobId?: string): void {
    this.emitEvent('analysisProgress', {
      videoId,
      jobId: jobId || `analyze-${videoId}`,  // Use provided jobId or fallback
      progress: this.normalizeProgress(progress),
      message,
      timestamp: this.getTimestamp()
    });
  }

  emitAnalysisCompleted(videoId: string, suggestedTitle: string, aiDescription: string): void {
    this.emitEvent('analysis-completed', {
      videoId,
      suggestedTitle,
      aiDescription,
      timestamp: this.getTimestamp()
    });
  }

  emitAnalysisFailed(videoId: string, error: string): void {
    this.emitEvent('analysis-failed', {
      videoId,
      error,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Task progress event (for queue system)
   */
  emitTaskProgress(jobId: string, taskType: string, progress: number, message: string): void {
    this.emitEvent('task-progress', {
      jobId,
      taskType,
      progress: this.normalizeProgress(progress),
      message,
      timestamp: this.getTimestamp()
    });
  }

  /**
   * Queue status updated event
   */
  emitQueueStatusUpdated(queueType: 'batch' | 'analysis', status: any): void {
    this.emitEvent('queue-status-updated', {
      queueType,
      status,
      timestamp: this.getTimestamp()
    });
  }
}