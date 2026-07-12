import { Injectable, signal, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { getBackendOrigin } from '../core/runtime-url';

export interface TaskProgress {
  taskId: string;
  jobId: string;
  progress: number;
  message?: string;
  type?: string;
  eta?: number;           // Estimated seconds remaining
  elapsedMs?: number;     // Milliseconds elapsed since task started
  taskLabel?: string;     // Human-readable task name (e.g., "Transcribing...")
}

export interface TaskStarted {
  taskId: string;
  jobId: string;
  type: string;
  pool: string;
  displayName?: string;
}

export interface TaskCompleted {
  taskId: string;
  jobId: string;
  videoId?: string;
  type: string;
  duration: number;
  result?: any;
}

export interface TaskFailed {
  taskId: string;
  jobId: string;
  type: string;
  error: { message: string; code?: string };
}

export interface SystemStatus {
  mainPool: { active: number; maxConcurrent: number; pending: number };
  aiPool: { active: number; maxConcurrent: number; pending: number };
  queue: { total: number; waiting: number; completed: number; failed: number };
}

export interface VideoRenamed {
  videoId: string;
  oldFilename: string;
  newFilename: string;
  newPath: string;
  uploadDate?: string | null;
  timestamp: string;
}

export interface VideoPathUpdated {
  videoId: string;
  newPath: string;
  oldPath?: string;
  timestamp: string;
}

export interface AnalysisCompleted {
  videoId: string;
  suggestedTitle: string;
  aiDescription: string;
  timestamp: string;
}

export interface SuggestionRejected {
  videoId: string;
  timestamp: string;
}


export interface VideoAdded {
  videoId: string;
  filename: string;
  filepath: string;
  timestamp: string;
}

export interface ModelDownloadProgress {
  modelId: string;
  progress: number;
  downloadedGB: number;
  totalGB: number;
  speed?: string;
  eta?: string;
}

export interface ModelDownloadComplete {
  modelId: string;
}

export interface ModelDownloadError {
  modelId: string;
  error: string;
}

export interface ModelDownloadCancelled {
  modelId: string;
}

// Component (binary/model) download events — download-on-demand
export interface ComponentDownloadProgress {
  componentId: string;
  phase: 'download' | 'verify' | 'extract' | 'install';
  progress: number;
  downloadedMB: number;
  totalMB: number;
  speed?: string;
  eta?: string;
}

export interface ComponentDownloadComplete {
  componentId: string;
}

export interface ComponentDownloadError {
  componentId: string;
  error: string;
}

export interface ComponentDownloadCancelled {
  componentId: string;
}

@Injectable({
  providedIn: 'root'
})
export class WebsocketService implements OnDestroy {
  private socket: Socket | null = null;
  // Same origin that served the page — works in Electron (loopback) and from a
  // LAN browser (http://<host>.local:<port>). See core/runtime-url.ts.
  private readonly SOCKET_URL = getBackendOrigin();

  // Signals for reactive updates
  connected = signal(false);
  systemStatus = signal<SystemStatus | null>(null);

  // Callbacks for task events
  private taskStartedCallbacks: ((event: TaskStarted) => void)[] = [];
  private taskProgressCallbacks: ((event: TaskProgress) => void)[] = [];
  private taskCompletedCallbacks: ((event: TaskCompleted) => void)[] = [];
  private taskFailedCallbacks: ((event: TaskFailed) => void)[] = [];
  private videoRenamedCallbacks: ((event: VideoRenamed) => void)[] = [];
  private videoPathUpdatedCallbacks: ((event: VideoPathUpdated) => void)[] = [];
  private analysisCompletedCallbacks: ((event: AnalysisCompleted) => void)[] = [];
  private suggestionRejectedCallbacks: ((event: SuggestionRejected) => void)[] = [];
  private videoAddedCallbacks: ((event: VideoAdded) => void)[] = [];
  private modelDownloadProgressCallbacks: ((event: ModelDownloadProgress) => void)[] = [];
  private modelDownloadCompleteCallbacks: ((event: ModelDownloadComplete) => void)[] = [];
  private modelDownloadErrorCallbacks: ((event: ModelDownloadError) => void)[] = [];
  private modelDownloadCancelledCallbacks: ((event: ModelDownloadCancelled) => void)[] = [];
  private componentDownloadProgressCallbacks: ((event: ComponentDownloadProgress) => void)[] = [];
  private componentDownloadCompleteCallbacks: ((event: ComponentDownloadComplete) => void)[] = [];
  private componentDownloadErrorCallbacks: ((event: ComponentDownloadError) => void)[] = [];
  private componentDownloadCancelledCallbacks: ((event: ComponentDownloadCancelled) => void)[] = [];

  connect(): void {
    if (this.socket) {
      return;
    }

    this.socket = io(this.SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 2000,
      timeout: 5000
    });

    this.socket.on('connect', () => {
      console.log('✅ WebSocket connected to', this.SOCKET_URL);
      this.connected.set(true);
    });

    this.socket.on('disconnect', () => {
      console.log('❌ WebSocket disconnected');
      this.connected.set(false);
    });

    this.socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error);
    });

    // Connection confirmation from server
    this.socket.on('connected', (data) => {
      console.log('✅ Server confirmed connection:', data);
    });

    // Task events
    this.socket.on('task.started', (event: TaskStarted) => {
      console.log('WS task.started received:', event);
      this.taskStartedCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('task.progress', (event: TaskProgress) => {
      console.log('WS task.progress received:', event);
      this.taskProgressCallbacks.forEach(cb => cb(event));
    });

    // Also listen for legacy 'task-progress' event (with hyphen)
    this.socket.on('task-progress', (event: any) => {
      const progress: TaskProgress = {
        taskId: event.taskId || '',
        jobId: event.jobId,
        progress: event.progress,
        message: event.message,
        type: event.taskType || event.type,
        eta: event.eta,
        elapsedMs: event.elapsedMs,
        taskLabel: event.taskLabel
      };
      this.taskProgressCallbacks.forEach(cb => cb(progress));
    });

    this.socket.on('task.completed', (event: TaskCompleted) => {
      console.log('WS task.completed received:', event);
      this.taskCompletedCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('task.failed', (event: TaskFailed) => {
      console.log('WS task.failed received:', event);
      this.taskFailedCallbacks.forEach(cb => cb(event));
    });

    // System status
    this.socket.on('system.status', (status: SystemStatus) => {
      this.systemStatus.set(status);
    });

    // Video events
    this.socket.on('video-renamed', (event: VideoRenamed) => {
      console.log('WS video-renamed received:', event);
      this.videoRenamedCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('video-path-updated', (event: VideoPathUpdated) => {
      console.log('WS video-path-updated received:', event);
      this.videoPathUpdatedCallbacks.forEach(cb => cb(event));
    });

    // Analysis events
    this.socket.on('analysis-completed', (event: AnalysisCompleted) => {
      console.log('WS analysis-completed received:', event);
      this.analysisCompletedCallbacks.forEach(cb => cb(event));
    });

    // Suggestion events
    this.socket.on('suggestion-rejected', (event: SuggestionRejected) => {
      console.log('WS suggestion-rejected received:', event);
      this.suggestionRejectedCallbacks.forEach(cb => cb(event));
    });




    // Library/Video events
    this.socket.on('video-added', (event: VideoAdded) => {
      console.log('WS video-added received:', event);
      this.videoAddedCallbacks.forEach(cb => cb(event));
    });

    // Model download events
    this.socket.on('model.download.progress', (event: ModelDownloadProgress) => {
      this.modelDownloadProgressCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('model.download.complete', (event: ModelDownloadComplete) => {
      console.log('WS model.download.complete received:', event);
      this.modelDownloadCompleteCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('model.download.error', (event: ModelDownloadError) => {
      console.log('WS model.download.error received:', event);
      this.modelDownloadErrorCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('model.download.cancelled', (event: ModelDownloadCancelled) => {
      console.log('WS model.download.cancelled received:', event);
      this.modelDownloadCancelledCallbacks.forEach(cb => cb(event));
    });

    // Component (binary/model) download events
    this.socket.on('component.download.progress', (event: ComponentDownloadProgress) => {
      this.componentDownloadProgressCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('component.download.complete', (event: ComponentDownloadComplete) => {
      console.log('WS component.download.complete received:', event);
      this.componentDownloadCompleteCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('component.download.error', (event: ComponentDownloadError) => {
      console.log('WS component.download.error received:', event);
      this.componentDownloadErrorCallbacks.forEach(cb => cb(event));
    });

    this.socket.on('component.download.cancelled', (event: ComponentDownloadCancelled) => {
      console.log('WS component.download.cancelled received:', event);
      this.componentDownloadCancelledCallbacks.forEach(cb => cb(event));
    });

    // Legacy events for backward compatibility
    this.socket.on('analysisProgress', (event: any) => {
      const progress: TaskProgress = {
        taskId: event.taskId || event.id,
        jobId: event.jobId || event.id,
        progress: event.progress,
        message: event.status || event.message,
        type: 'analyze'
      };
      this.taskProgressCallbacks.forEach(cb => cb(progress));
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected.set(false);
    }
  }

  // Subscribe to task events
  onTaskStarted(callback: (event: TaskStarted) => void): () => void {
    this.taskStartedCallbacks.push(callback);
    return () => {
      this.taskStartedCallbacks = this.taskStartedCallbacks.filter(cb => cb !== callback);
    };
  }

  onTaskProgress(callback: (event: TaskProgress) => void): () => void {
    this.taskProgressCallbacks.push(callback);
    return () => {
      this.taskProgressCallbacks = this.taskProgressCallbacks.filter(cb => cb !== callback);
    };
  }

  onTaskCompleted(callback: (event: TaskCompleted) => void): () => void {
    this.taskCompletedCallbacks.push(callback);
    return () => {
      this.taskCompletedCallbacks = this.taskCompletedCallbacks.filter(cb => cb !== callback);
    };
  }

  onTaskFailed(callback: (event: TaskFailed) => void): () => void {
    this.taskFailedCallbacks.push(callback);
    return () => {
      this.taskFailedCallbacks = this.taskFailedCallbacks.filter(cb => cb !== callback);
    };
  }

  onVideoRenamed(callback: (event: VideoRenamed) => void): () => void {
    this.videoRenamedCallbacks.push(callback);
    return () => {
      this.videoRenamedCallbacks = this.videoRenamedCallbacks.filter(cb => cb !== callback);
    };
  }

  onVideoPathUpdated(callback: (event: VideoPathUpdated) => void): () => void {
    this.videoPathUpdatedCallbacks.push(callback);
    return () => {
      this.videoPathUpdatedCallbacks = this.videoPathUpdatedCallbacks.filter(cb => cb !== callback);
    };
  }

  onAnalysisCompleted(callback: (event: AnalysisCompleted) => void): () => void {
    this.analysisCompletedCallbacks.push(callback);
    return () => {
      this.analysisCompletedCallbacks = this.analysisCompletedCallbacks.filter(cb => cb !== callback);
    };
  }

  onSuggestionRejected(callback: (event: SuggestionRejected) => void): () => void {
    this.suggestionRejectedCallbacks.push(callback);
    return () => {
      this.suggestionRejectedCallbacks = this.suggestionRejectedCallbacks.filter(cb => cb !== callback);
    };
  }




  onVideoAdded(callback: (event: VideoAdded) => void): () => void {
    this.videoAddedCallbacks.push(callback);
    return () => {
      this.videoAddedCallbacks = this.videoAddedCallbacks.filter(cb => cb !== callback);
    };
  }

  // Model download event subscriptions
  onModelDownloadProgress(callback: (event: ModelDownloadProgress) => void): () => void {
    this.modelDownloadProgressCallbacks.push(callback);
    return () => {
      this.modelDownloadProgressCallbacks = this.modelDownloadProgressCallbacks.filter(cb => cb !== callback);
    };
  }

  onModelDownloadComplete(callback: (event: ModelDownloadComplete) => void): () => void {
    this.modelDownloadCompleteCallbacks.push(callback);
    return () => {
      this.modelDownloadCompleteCallbacks = this.modelDownloadCompleteCallbacks.filter(cb => cb !== callback);
    };
  }

  onModelDownloadError(callback: (event: ModelDownloadError) => void): () => void {
    this.modelDownloadErrorCallbacks.push(callback);
    return () => {
      this.modelDownloadErrorCallbacks = this.modelDownloadErrorCallbacks.filter(cb => cb !== callback);
    };
  }

  onModelDownloadCancelled(callback: (event: ModelDownloadCancelled) => void): () => void {
    this.modelDownloadCancelledCallbacks.push(callback);
    return () => {
      this.modelDownloadCancelledCallbacks = this.modelDownloadCancelledCallbacks.filter(cb => cb !== callback);
    };
  }

  // Component download event subscriptions
  onComponentDownloadProgress(callback: (event: ComponentDownloadProgress) => void): () => void {
    this.componentDownloadProgressCallbacks.push(callback);
    return () => {
      this.componentDownloadProgressCallbacks = this.componentDownloadProgressCallbacks.filter(cb => cb !== callback);
    };
  }

  onComponentDownloadComplete(callback: (event: ComponentDownloadComplete) => void): () => void {
    this.componentDownloadCompleteCallbacks.push(callback);
    return () => {
      this.componentDownloadCompleteCallbacks = this.componentDownloadCompleteCallbacks.filter(cb => cb !== callback);
    };
  }

  onComponentDownloadError(callback: (event: ComponentDownloadError) => void): () => void {
    this.componentDownloadErrorCallbacks.push(callback);
    return () => {
      this.componentDownloadErrorCallbacks = this.componentDownloadErrorCallbacks.filter(cb => cb !== callback);
    };
  }

  onComponentDownloadCancelled(callback: (event: ComponentDownloadCancelled) => void): () => void {
    this.componentDownloadCancelledCallbacks.push(callback);
    return () => {
      this.componentDownloadCancelledCallbacks = this.componentDownloadCancelledCallbacks.filter(cb => cb !== callback);
    };
  }

  ngOnDestroy(): void {
    this.disconnect();
  }
}
