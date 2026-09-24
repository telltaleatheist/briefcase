import { Injectable, signal, OnDestroy, NgZone } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { getBackendOrigin } from '../core/runtime-url';
import type { CrucibleServersChangedPayload } from '@crucible-wire/settings-wire';
import type { CrucibleInstallProgress } from '@crucible-wire/install-wire';
import type { CrucibleCoordinationState } from '@crucible-wire/coordinate-wire';
import type { CrucibleInstallDoorEvent } from '@crucible-wire/install-door-wire';
import { CRUCIBLE_READINESS_EVENT, type CrucibleReadinessView } from '@crucible-wire/readiness-wire';
import type { LanesStatus } from '../models/queue-lanes.model';

export type CrucibleServersChanged = CrucibleServersChangedPayload;

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
  lane?: string;          // 'gpu:<server>' | 'cloud' (Crucible admission)
  venue?: string;         // server name the task was admitted to
}

/** A backend job is parked: waiting for admission (NOT failed). */
export interface TaskParked {
  jobId: string;
  videoId?: string;
  type?: string;
  reason: string;
  server: string | null;
  timestamp: string;
}

/** A parked backend job was admitted; its waiting reason no longer applies. */
export interface TaskUnparked {
  jobId: string;
  videoId?: string;
  timestamp: string;
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
  private taskParkedCallbacks: ((event: TaskParked) => void)[] = [];
  private taskUnparkedCallbacks: ((event: TaskUnparked) => void)[] = [];
  private queueLanesCallbacks: ((event: LanesStatus) => void)[] = [];
  private videoRenamedCallbacks: ((event: VideoRenamed) => void)[] = [];
  private videoPathUpdatedCallbacks: ((event: VideoPathUpdated) => void)[] = [];
  private analysisCompletedCallbacks: ((event: AnalysisCompleted) => void)[] = [];
  private suggestionRejectedCallbacks: ((event: SuggestionRejected) => void)[] = [];
  private videoAddedCallbacks: ((event: VideoAdded) => void)[] = [];
  private componentDownloadProgressCallbacks: ((event: ComponentDownloadProgress) => void)[] = [];
  private componentDownloadCompleteCallbacks: ((event: ComponentDownloadComplete) => void)[] = [];
  private componentDownloadErrorCallbacks: ((event: ComponentDownloadError) => void)[] = [];
  private componentDownloadCancelledCallbacks: ((event: ComponentDownloadCancelled) => void)[] = [];
  private crucibleServersChangedCallbacks: ((event: CrucibleServersChanged) => void)[] = [];
  private crucibleInstallProgressCallbacks: ((event: CrucibleInstallProgress) => void)[] = [];
  private crucibleCoordinationCallbacks: ((event: CrucibleCoordinationState) => void)[] = [];
  private crucibleInstallDoorCallbacks: ((event: CrucibleInstallDoorEvent) => void)[] = [];
  private crucibleReadinessCallbacks: ((event: CrucibleReadinessView) => void)[] = [];

  constructor(private ngZone: NgZone) {}

  /**
   * Guarded dispatch to a list of subscriber callbacks. Each callback runs in
   * its own try/catch so one throwing consumer can't abort the forEach and
   * starve the remaining subscribers (or bubble the exception into socket.io's
   * event dispatch, which would freeze queue updates).
   *
   * The whole forEach runs inside NgZone.run so any state a subscriber updates
   * re-enters Angular's zone and triggers change detection — socket.io callbacks
   * fire outside the zone, so without this the UI would stay stale until the
   * next click or a full reload.
   */
  private dispatch<T>(callbacks: ((event: T) => void)[], event: T): void {
    this.ngZone.run(() => {
      callbacks.forEach(cb => {
        try {
          cb(event);
        } catch (error) {
          console.error('[WebsocketService] Subscriber callback threw:', error);
        }
      });
    });
  }

  connect(): void {
    if (this.socket) {
      return;
    }

    this.socket = io(this.SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 5000
    });

    this.socket.on('connect', () => {
      this.ngZone.run(() => {
        console.log('✅ WebSocket connected to', this.SOCKET_URL);
        this.connected.set(true);
      });
    });

    this.socket.on('disconnect', () => {
      this.ngZone.run(() => {
        console.log('❌ WebSocket disconnected');
        this.connected.set(false);
      });
    });

    this.socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error);
    });

    // Belt-and-suspenders: if socket.io ever gives up reconnecting, tear down
    // the dead socket and schedule a fresh connect so recovery is always possible.
    this.socket.on('reconnect_failed', () => {
      this.ngZone.run(() => {
        console.error('❌ WebSocket reconnect failed — scheduling fresh connect');
        this.connected.set(false);
        this.socket?.close();
        this.socket = null;
        setTimeout(() => this.connect(), 5000);
      });
    });

    // Connection confirmation from server
    this.socket.on('connected', (data) => {
      console.log('✅ Server confirmed connection:', data);
    });

    // Task events
    this.socket.on('task.started', (event: TaskStarted) => {
      console.log('WS task.started received:', event);
      this.dispatch(this.taskStartedCallbacks, event);
    });

    this.socket.on('task.progress', (event: TaskProgress) => {
      console.log('WS task.progress received:', event);
      this.dispatch(this.taskProgressCallbacks, event);
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
      this.dispatch(this.taskProgressCallbacks, progress);
    });

    this.socket.on('task.completed', (event: TaskCompleted) => {
      console.log('WS task.completed received:', event);
      this.dispatch(this.taskCompletedCallbacks, event);
    });

    this.socket.on('task.failed', (event: TaskFailed) => {
      console.log('WS task.failed received:', event);
      this.dispatch(this.taskFailedCallbacks, event);
    });

    // Queue admission (Crucible lanes)
    this.socket.on('task.parked', (event: TaskParked) => {
      this.dispatch(this.taskParkedCallbacks, event);
    });

    this.socket.on('task.unparked', (event: TaskUnparked) => {
      this.dispatch(this.taskUnparkedCallbacks, event);
    });

    this.socket.on('queue.lanes', (event: LanesStatus) => {
      this.dispatch(this.queueLanesCallbacks, event);
    });

    // System status
    this.socket.on('system.status', (status: SystemStatus) => {
      this.ngZone.run(() => {
        this.systemStatus.set(status);
      });
    });

    // Video events
    this.socket.on('video-renamed', (event: VideoRenamed) => {
      console.log('WS video-renamed received:', event);
      this.dispatch(this.videoRenamedCallbacks, event);
    });

    this.socket.on('video-path-updated', (event: VideoPathUpdated) => {
      console.log('WS video-path-updated received:', event);
      this.dispatch(this.videoPathUpdatedCallbacks, event);
    });

    // Analysis events
    this.socket.on('analysis-completed', (event: AnalysisCompleted) => {
      console.log('WS analysis-completed received:', event);
      this.dispatch(this.analysisCompletedCallbacks, event);
    });

    // Suggestion events
    this.socket.on('suggestion-rejected', (event: SuggestionRejected) => {
      console.log('WS suggestion-rejected received:', event);
      this.dispatch(this.suggestionRejectedCallbacks, event);
    });




    // Library/Video events
    this.socket.on('video-added', (event: VideoAdded) => {
      console.log('WS video-added received:', event);
      this.dispatch(this.videoAddedCallbacks, event);
    });


    // Component (binary/model) download events
    this.socket.on('component.download.progress', (event: ComponentDownloadProgress) => {
      this.dispatch(this.componentDownloadProgressCallbacks, event);
    });

    this.socket.on('component.download.complete', (event: ComponentDownloadComplete) => {
      console.log('WS component.download.complete received:', event);
      this.dispatch(this.componentDownloadCompleteCallbacks, event);
    });

    this.socket.on('component.download.error', (event: ComponentDownloadError) => {
      console.log('WS component.download.error received:', event);
      this.dispatch(this.componentDownloadErrorCallbacks, event);
    });

    this.socket.on('component.download.cancelled', (event: ComponentDownloadCancelled) => {
      console.log('WS component.download.cancelled received:', event);
      this.dispatch(this.componentDownloadCancelledCallbacks, event);
    });

    // Legacy events for backward compatibility
    this.socket.on('crucible.servers-changed', (event: CrucibleServersChanged) => {
      this.dispatch(this.crucibleServersChangedCallbacks, event);
    });

    this.socket.on('crucible.install-progress', (event: CrucibleInstallProgress) => {
      this.dispatch(this.crucibleInstallProgressCallbacks, event);
    });

    this.socket.on('crucible.coordination', (event: CrucibleCoordinationState) => {
      this.dispatch(this.crucibleCoordinationCallbacks, event);
    });

    this.socket.on('crucible.install-door', (event: CrucibleInstallDoorEvent) => {
      this.dispatch(this.crucibleInstallDoorCallbacks, event);
    });

    this.socket.on(CRUCIBLE_READINESS_EVENT, (event: CrucibleReadinessView) => {
      this.dispatch(this.crucibleReadinessCallbacks, event);
    });

    this.socket.on('analysisProgress', (event: any) => {
      const progress: TaskProgress = {
        taskId: event.taskId || event.id,
        jobId: event.jobId || event.id,
        progress: event.progress,
        message: event.status || event.message,
        type: 'analyze'
      };
      this.dispatch(this.taskProgressCallbacks, progress);
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

  onTaskParked(callback: (event: TaskParked) => void): () => void {
    this.taskParkedCallbacks.push(callback);
    return () => {
      this.taskParkedCallbacks = this.taskParkedCallbacks.filter(cb => cb !== callback);
    };
  }

  onTaskUnparked(callback: (event: TaskUnparked) => void): () => void {
    this.taskUnparkedCallbacks.push(callback);
    return () => {
      this.taskUnparkedCallbacks = this.taskUnparkedCallbacks.filter(cb => cb !== callback);
    };
  }

  onQueueLanes(callback: (event: LanesStatus) => void): () => void {
    this.queueLanesCallbacks.push(callback);
    return () => {
      this.queueLanesCallbacks = this.queueLanesCallbacks.filter(cb => cb !== callback);
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

  /** The Crucible server registry or its rank/pause record changed. */
  onCrucibleServersChanged(callback: (event: CrucibleServersChanged) => void): () => void {
    this.crucibleServersChangedCallbacks.push(callback);
    return () => {
      this.crucibleServersChangedCallbacks = this.crucibleServersChangedCallbacks.filter(cb => cb !== callback);
    };
  }

  /** One event of a local Crucible install. */
  onCrucibleInstallProgress(callback: (event: CrucibleInstallProgress) => void): () => void {
    this.crucibleInstallProgressCallbacks.push(callback);
    return () => {
      this.crucibleInstallProgressCallbacks = this.crucibleInstallProgressCallbacks.filter(cb => cb !== callback);
    };
  }

  /** A server's coordination state (does it have what Briefcase needs). */
  onCrucibleCoordination(callback: (event: CrucibleCoordinationState) => void): () => void {
    this.crucibleCoordinationCallbacks.push(callback);
    return () => {
      this.crucibleCoordinationCallbacks = this.crucibleCoordinationCallbacks.filter(cb => cb !== callback);
    };
  }

  /** The Windows host's own engine move (WSL), as its install door reports it. */
  onCrucibleInstallDoor(callback: (event: CrucibleInstallDoorEvent) => void): () => void {
    this.crucibleInstallDoorCallbacks.push(callback);
    return () => {
      this.crucibleInstallDoorCallbacks = this.crucibleInstallDoorCallbacks.filter(cb => cb !== callback);
    };
  }

  /** Whether Crucible is there for AI work, on every change (P7). */
  onCrucibleReadiness(callback: (event: CrucibleReadinessView) => void): () => void {
    this.crucibleReadinessCallbacks.push(callback);
    return () => {
      this.crucibleReadinessCallbacks = this.crucibleReadinessCallbacks.filter(cb => cb !== callback);
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
