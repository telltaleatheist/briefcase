// clippy/frontend/src/app/services/socket.service.ts
import { Injectable } from '@angular/core';
import { Socket } from 'ngx-socket-io';
import { Observable, BehaviorSubject } from 'rxjs';
import { DownloadProgress, HistoryItem, BatchQueueStatus, JobStatus } from '../models/download.model';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private connectionStatus = new BehaviorSubject<boolean>(false);
  
  // Cache for last known progress to restore state if needed
  private progressCache = new Map<string, DownloadProgress>();
  
  constructor(private socket: Socket) {
    // Set up connection monitoring
    this.setupConnectionListeners();
  }
  
  private setupConnectionListeners(): void {
    this.socket.on('connect', () => {
      this.connectionStatus.next(true);
    });
    
    this.socket.on('disconnect', () => {
      this.connectionStatus.next(false);
    });
    
    this.socket.on('error', (error) => {
      console.error('Socket error:', error);
    });
  }
  
  /**
   * Get connection status as observable
   */
  getConnectionStatus(): Observable<boolean> {
    return this.connectionStatus.asObservable();
  }
  
  /**
   * Manual reconnection method
   */
  reconnect(): void {
    if (!this.connectionStatus.value) {
      this.socket.connect();
    }
  }

  /**
   * Generic event listener
   */
  listenTo<T>(eventName: string): Observable<T> {
    return this.socket.fromEvent<T, any>(eventName);
  }

  /**
   * Listen for socket connection
   */
  onConnect(): Observable<void> {
    return this.listenTo<void>('connect');
  }

  /**
   * Listen for socket disconnection
   */
  onDisconnect(): Observable<void> {
    return this.listenTo<void>('disconnect');
  }

  /**
   * Listen for download progress updates
   */
  onDownloadProgress(): Observable<DownloadProgress> {
    return new Observable<DownloadProgress>(observer => {
      this.socket.on('download-progress', (data: DownloadProgress) => {
        // Store in cache
        if (data.jobId) {
          this.progressCache.set(data.jobId, data);
        }
        
        observer.next(data);
      });
      
      return () => {
        this.socket.off('download-progress');
      };
    });
  }

  /**
   * Listen for processing progress updates
   */
  onProcessingProgress(): Observable<DownloadProgress> {
    return new Observable<DownloadProgress>(observer => {
      this.socket.on('processing-progress', (data: DownloadProgress) => {
        // Store in cache
        if (data.jobId) {
          this.progressCache.set(data.jobId, data);
        }
        
        observer.next(data);
      });
      
      return () => {
        this.socket.off('processing-progress');
      };
    });
  }

  /**
   * Listen for transcription started event
   */
  onTranscriptionStarted(): Observable<{inputFile: string, jobId?: string}> {
    return this.listenTo<{inputFile: string, jobId?: string}>('transcription-started');
  }

  /**
   * Listen for transcription progress updates
   */
  onTranscriptionProgress(): Observable<DownloadProgress> {
    return new Observable<DownloadProgress>(observer => {
      this.socket.on('transcription-progress', (data: DownloadProgress) => {
        console.log(`Received transcription progress: ${data.progress}% - ${data.task}`);
        // Store in cache
        if (data.jobId) {
          this.progressCache.set(data.jobId, data);
        }
        
        observer.next(data);
      });
      
      return () => {
        this.socket.off('transcription-progress');
      };
    });
  }
  
  /**
   * Listen for transcription completed event
   */
  onTranscriptionCompleted(): Observable<{outputFile: string, jobId?: string}> {
    return this.listenTo<{outputFile: string, jobId?: string}>('transcription-completed');
  }

  /**
   * Listen for transcription failed event
   */
  onTranscriptionFailed(): Observable<{error: string, jobId?: string, inputFile?: string}> {
    return this.listenTo<{error: string, jobId?: string, inputFile?: string}>('transcription-failed');
  }

  /**
   * Get the last known progress for a job
   */
  getLastKnownProgress(jobId: string): DownloadProgress | undefined {
    return this.progressCache.get(jobId);
  }

  /**
   * Listen for download history updates
   */
  onDownloadHistoryUpdated(): Observable<HistoryItem[]> {
    return this.listenTo<HistoryItem[]>('download-history-updated');
  }

  /**
   * Listen for download started event
   */
  onDownloadStarted(): Observable<{url: string, jobId?: string}> {
    return this.listenTo<{url: string, jobId?: string}>('download-started');
  }

  /**
   * Listen for download completed event
   */
  onDownloadCompleted(): Observable<{outputFile: string, url: string, jobId?: string, isImage?: boolean}> {
    return this.listenTo<{outputFile: string, url: string, jobId?: string, isImage?: boolean}>('download-completed');
  }

  /**
   * Listen for download failed event
   */
  onDownloadFailed(): Observable<{error: string, url: string, jobId?: string}> {
    return this.listenTo<{error: string, url: string, jobId?: string}>('download-failed');
  }

  /**
   * Listen for batch queue updates
   */
  onBatchQueueUpdated(): Observable<BatchQueueStatus> {
    return this.listenTo<BatchQueueStatus>('batch-queue-updated');
  }
  
  onJobStatusUpdated(): Observable<{jobId: string, status: JobStatus, task: string}> {
    return this.listenTo<{jobId: string, status: JobStatus, task: string}>('job-status-updated');
  }
    
  /**
   * Listen for batch completion
   */
  onBatchCompleted(): Observable<{completedJobsCount: number, failedJobsCount: number, timestamp: string}> {
    return this.listenTo<{completedJobsCount: number, failedJobsCount: number, timestamp: string}>('batch-completed');
  }

  /**
   * Listen for processing failures
   */
  onProcessingFailed(): Observable<{error: string, jobId?: string, inputFile?: string}> {
    return this.listenTo<{error: string, jobId?: string, inputFile?: string}>('processing-failed');
  }
  
  /**
   * Send an event to the server
   */
  emitEvent(eventName: string, data: any): void {
    this.socket.emit(eventName, data);
  }
}