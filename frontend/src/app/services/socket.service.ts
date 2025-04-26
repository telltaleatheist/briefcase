// clippy/frontend/src/app/services/socket.service.ts
import { Injectable } from '@angular/core';
import { Socket } from 'ngx-socket-io';
import { Observable } from 'rxjs';
import { DownloadProgress, HistoryItem, BatchQueueStatus } from '../models/download.model';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  constructor(private socket: Socket) {}

  /**
   * Listen for socket connection
   */
  onConnect(): Observable<void> {
    return this.socket.fromEvent<void, any>('connect');
  }

  /**
   * Listen for socket disconnection
   */
  onDisconnect(): Observable<void> {
    return this.socket.fromEvent<void, any>('disconnect');
  }

  /**
   * Listen for download progress updates
   */
  onDownloadProgress(): Observable<DownloadProgress> {
    return this.socket.fromEvent<DownloadProgress, any>('download-progress');
  }

  /**
   * Listen for processing progress updates
   */
  onProcessingProgress(): Observable<DownloadProgress> {
    return this.socket.fromEvent<DownloadProgress, any>('processing-progress');
  }

  /**
   * Listen for download history updates
   */
  onDownloadHistoryUpdated(): Observable<HistoryItem[]> {
    return this.socket.fromEvent<HistoryItem[], any>('download-history-updated');
  }

  /**
   * Listen for download started event
   */
  onDownloadStarted(): Observable<{url: string, jobId?: string}> {
    return this.socket.fromEvent<{url: string, jobId?: string}, any>('download-started');
  }

  /**
   * Listen for download completed event
   */
  onDownloadCompleted(): Observable<{outputFile: string, url: string, jobId?: string}> {
    return this.socket.fromEvent<{outputFile: string, url: string, jobId?: string}, any>('download-completed');
  }

  /**
   * Listen for download failed event
   */
  onDownloadFailed(): Observable<{error: string, url: string, jobId?: string}> {
    return this.socket.fromEvent<{error: string, url: string, jobId?: string}, any>('download-failed');
  }

  /**
   * Listen for batch queue updates
   */
  onBatchQueueUpdated(): Observable<BatchQueueStatus> {
    return this.socket.fromEvent<BatchQueueStatus, any>('batch-queue-updated');
  }

  /**
   * Listen for batch completion
   */
  onBatchCompleted(): Observable<{timestamp: string}> {
    return this.socket.fromEvent<{timestamp: string}, any>('batch-completed');
  }

  /**
   * Listen for processing failures
   */
  onProcessingFailed(): Observable<{error: string, jobId: string}> {
    return this.socket.fromEvent<{error: string, jobId: string}, any>('processing-failed');
  }
}