// clippy/backend/src/media/media-event.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Subject, Observable } from 'rxjs';

/**
 * Event types for the media event system
 */
export type MediaEventType = 
  // Download events
  | 'download-started'
  | 'download-progress'
  | 'download-completed'
  | 'download-failed'
  | 'download-retry'
  | 'download-cancelled'
  // Processing events
  | 'processing-started'
  | 'processing-progress'
  | 'processing-completed'
  | 'processing-failed'
  // Batch events
  | 'batch-queue-updated'
  | 'batch-completed'
  | 'batch-paused'
  | 'batch-resumed'
  // History events
  | 'download-history-updated'
  // System events
  | 'system-error'
  | 'config-updated';

/**
 * Base interface for all media events
 */
export interface BaseMediaEvent {
  type: MediaEventType;
  timestamp: string;
  jobId?: string;
  data: any;
}

/**
 * Download started event
 */
export interface DownloadStartedEvent extends BaseMediaEvent {
  type: 'download-started';
  data: {
    url: string;
  };
}

/**
 * Download progress event
 */
export interface DownloadProgressEvent extends BaseMediaEvent {
  type: 'download-progress';
  data: {
    progress: number;
    task: string;
    speed?: number;
    eta?: number;
    totalSize?: number;
    downloadedBytes?: number;
  };
}

/**
 * Download completed event
 */
export interface DownloadCompletedEvent extends BaseMediaEvent {
  type: 'download-completed';
  data: {
    outputFile: string;
    url: string;
    isImage?: boolean;
  };
}

/**
 * Download failed event
 */
export interface DownloadFailedEvent extends BaseMediaEvent {
  type: 'download-failed';
  data: {
    url: string;
    error: string;
  };
}

/**
 * Download retry event
 */
export interface DownloadRetryEvent extends BaseMediaEvent {
  type: 'download-retry';
  data: {
    url: string;
    attempt: number;
    maxRetries: number;
    error: string;
  };
}

/**
 * Download cancelled event
 */
export interface DownloadCancelledEvent extends BaseMediaEvent {
  type: 'download-cancelled';
  data: {
    url: string;
  };
}

/**
 * Processing started event
 */
export interface ProcessingStartedEvent extends BaseMediaEvent {
  type: 'processing-started';
  data: {
    inputFile: string;
    options: any;
  };
}

/**
 * Processing progress event
 */
export interface ProcessingProgressEvent extends BaseMediaEvent {
  type: 'processing-progress';
  data: {
    progress: number;
    task: string;
  };
}

/**
 * Processing completed event
 */
export interface ProcessingCompletedEvent extends BaseMediaEvent {
  type: 'processing-completed';
  data: {
    outputFile: string;
    thumbnailFile?: string;
    audioFile?: string;
  };
}

/**
 * Processing failed event
 */
export interface ProcessingFailedEvent extends BaseMediaEvent {
  type: 'processing-failed';
  data: {
    inputFile: string;
    error: string;
  };
}

/**
 * Batch queue updated event
 */
export interface BatchQueueUpdatedEvent extends BaseMediaEvent {
  type: 'batch-queue-updated';
  data: {
    downloadQueue: any[];
    processingQueue: any[];
    completedJobs: any[];
    failedJobs: any[];
    activeDownloads: string[];
    maxConcurrentDownloads: number;
    isProcessing: boolean;
    isPaused: boolean;
  };
}

/**
 * Batch completed event
 */
export interface BatchCompletedEvent extends BaseMediaEvent {
  type: 'batch-completed';
  data: {
    completedJobsCount: number;
    failedJobsCount: number;
  };
}

/**
 * Union type of all media events
 */
export type MediaEvent =
  | DownloadStartedEvent
  | DownloadProgressEvent
  | DownloadCompletedEvent
  | DownloadFailedEvent
  | DownloadRetryEvent
  | DownloadCancelledEvent
  | ProcessingStartedEvent
  | ProcessingProgressEvent
  | ProcessingCompletedEvent
  | ProcessingFailedEvent
  | BatchQueueUpdatedEvent
  | BatchCompletedEvent
  | BaseMediaEvent;

/**
 * Service for handling media events across the application
 */
@WebSocketGateway({ cors: true })
@Injectable()
export class MediaEventService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MediaEventService.name);
  private eventSubject = new Subject<MediaEvent>();
  
  // Observable for subscribing to all events
  events$ = this.eventSubject.asObservable();
  
  /**
   * Emit a media event
   */
  emitEvent(event: MediaEvent): void {
    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }
    
    // Log the event
    this.logger.debug(`Emitting event: ${event.type}`, { 
      jobId: event.jobId, 
      data: event.data 
    });
    
    // Push to the subject
    this.eventSubject.next(event);
    
    // Emit via WebSocket
    this.emitWebSocketEvent(event);
  }
  
  /**
   * Emit an event via WebSocket
   */
  private emitWebSocketEvent(event: MediaEvent): void {
    if (this.server) {
      this.server.emit(event.type, {
        ...event.data,
        jobId: event.jobId,
        timestamp: event.timestamp
      });
    } else {
      this.logger.warn(`Cannot emit WebSocket event: ${event.type} - server not initialized`);
    }
  }
  
  /**
   * Helper methods for common events
   */
  
  // Download events
  
  emitDownloadStarted(url: string, jobId?: string): void {
    this.emitEvent({
      type: 'download-started',
      timestamp: new Date().toISOString(),
      jobId,
      data: { url }
    });
  }
  
  emitDownloadProgress(progress: number, task: string, jobId?: string, additionalData?: object): void {
    this.emitEvent({
      type: 'download-progress',
      timestamp: new Date().toISOString(),
      jobId,
      data: { 
        progress, 
        task,
        ...additionalData
      }
    });
  }
  
  emitDownloadCompleted(outputFile: string, url: string, jobId?: string, isImage: boolean = false): void {
    this.emitEvent({
      type: 'download-completed',
      timestamp: new Date().toISOString(),
      jobId,
      data: { 
        outputFile, 
        url,
        isImage 
      }
    });
  }
  
  emitDownloadFailed(url: string, error: string, jobId?: string): void {
    this.emitEvent({
      type: 'download-failed',
      timestamp: new Date().toISOString(),
      jobId,
      data: { url, error }
    });
  }
  
  emitDownloadRetry(url: string, attempt: number, maxRetries: number, error: string, jobId?: string): void {
    this.emitEvent({
      type: 'download-retry',
      timestamp: new Date().toISOString(),
      jobId,
      data: { 
        url, 
        attempt, 
        maxRetries, 
        error 
      }
    });
  }
  
  emitDownloadCancelled(url: string, jobId?: string): void {
    this.emitEvent({
      type: 'download-cancelled',
      timestamp: new Date().toISOString(),
      jobId,
      data: { url }
    });
  }
  
  // Processing events
  
  emitProcessingStarted(inputFile: string, options: any, jobId?: string): void {
    this.emitEvent({
      type: 'processing-started',
      timestamp: new Date().toISOString(),
      jobId,
      data: { inputFile, options }
    });
  }
  
  emitProcessingProgress(progress: number, task: string, jobId?: string): void {
    this.emitEvent({
      type: 'processing-progress',
      timestamp: new Date().toISOString(),
      jobId,
      data: { progress, task }
    });
  }
  
  emitProcessingCompleted(outputFile: string, jobId?: string, thumbnailFile?: string, audioFile?: string): void {
    this.emitEvent({
      type: 'processing-completed',
      timestamp: new Date().toISOString(),
      jobId,
      data: { 
        outputFile,
        thumbnailFile,
        audioFile
      }
    });
  }
  
  emitProcessingFailed(inputFile: string, error: string, jobId?: string): void {
    this.emitEvent({
      type: 'processing-failed',
      timestamp: new Date().toISOString(),
      jobId,
      data: { inputFile, error }
    });
  }
  
  // Batch events
  
  emitBatchQueueUpdated(queueState: any): void {
    this.emitEvent({
      type: 'batch-queue-updated',
      timestamp: new Date().toISOString(),
      data: queueState
    });
  }
  
  emitBatchCompleted(completedJobsCount: number, failedJobsCount: number): void {
    this.emitEvent({
      type: 'batch-completed',
      timestamp: new Date().toISOString(),
      data: { 
        completedJobsCount, 
        failedJobsCount
      }
    });
  }
  
  /**
   * Filter events by type
   */
  filterByType<T extends MediaEvent>(type: MediaEventType): Observable<T> {
    return new Observable<T>(observer => {
      const subscription = this.events$.subscribe(event => {
        if (event.type === type) {
          observer.next(event as T);
        }
      });
      
      return () => {
        subscription.unsubscribe();
      };
    });
  }
  
  /**
   * Filter events by job ID
   */
  filterByJobId(jobId: string): Observable<MediaEvent> {
    return new Observable<MediaEvent>(observer => {
      const subscription = this.events$.subscribe(event => {
        if (event.jobId === jobId) {
          observer.next(event);
        }
      });
      
      return () => {
        subscription.unsubscribe();
      };
    });
  }
}