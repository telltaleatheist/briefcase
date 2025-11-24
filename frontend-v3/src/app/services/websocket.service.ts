import { Injectable, signal, OnDestroy } from '@angular/core';
import { io, Socket } from 'socket.io-client';

export interface TaskProgress {
  taskId: string;
  jobId: string;
  progress: number;
  message?: string;
  type?: string;
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
  timestamp: string;
}

export interface AnalysisCompleted {
  videoId: string;
  suggestedTitle: string;
  aiDescription: string;
  timestamp: string;
}

@Injectable({
  providedIn: 'root'
})
export class WebsocketService implements OnDestroy {
  private socket: Socket | null = null;
  private readonly SOCKET_URL = 'http://localhost:3000';

  // Signals for reactive updates
  connected = signal(false);
  systemStatus = signal<SystemStatus | null>(null);

  // Callbacks for task events
  private taskStartedCallbacks: ((event: TaskStarted) => void)[] = [];
  private taskProgressCallbacks: ((event: TaskProgress) => void)[] = [];
  private taskCompletedCallbacks: ((event: TaskCompleted) => void)[] = [];
  private taskFailedCallbacks: ((event: TaskFailed) => void)[] = [];
  private videoRenamedCallbacks: ((event: VideoRenamed) => void)[] = [];
  private analysisCompletedCallbacks: ((event: AnalysisCompleted) => void)[] = [];

  connect(): void {
    if (this.socket?.connected) {
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

    // Listen for all events for debugging
    this.socket.onAny((event, ...args) => {
      console.log(`📨 WS Event: ${event}`, args);
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
      console.log('WS task-progress received:', event);
      const progress: TaskProgress = {
        taskId: event.taskId || '',
        jobId: event.jobId,
        progress: event.progress,
        message: event.message,
        type: event.taskType || event.type
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

    // Analysis events
    this.socket.on('analysis-completed', (event: AnalysisCompleted) => {
      console.log('WS analysis-completed received:', event);
      this.analysisCompletedCallbacks.forEach(cb => cb(event));
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

  onAnalysisCompleted(callback: (event: AnalysisCompleted) => void): () => void {
    this.analysisCompletedCallbacks.push(callback);
    return () => {
      this.analysisCompletedCallbacks = this.analysisCompletedCallbacks.filter(cb => cb !== callback);
    };
  }

  ngOnDestroy(): void {
    this.disconnect();
  }
}
