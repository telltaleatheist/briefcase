// WebSocket Event Type Definitions
// Centralized registry of all WebSocket events and their payloads

import { SavedLink } from '../saved-links/saved-links.service';

/**
 * Analysis & Processing Events (Legacy - kept for backward compatibility)
 */
export interface AnalysisProgressPayload {
  jobId?: string;
  id?: string;
  progress: number;
  status?: string;
  message?: string;
  [key: string]: any;
}

export interface ProcessingProgressPayload {
  jobId: string;
  progress: number;
  task?: string;
  eta?: number;
  [key: string]: any;
}

export interface ProcessingFailedPayload {
  jobId: string;
  error: string;
  task?: string;
  [key: string]: any;
}

/**
 * Unified Queue Events (5+1 Pool Model)
 */
export interface TaskStartedPayload {
  taskId: string;
  jobId: string;
  videoId?: string;
  type: string;
  pool: 'main' | 'ai';
  timestamp: string;
}

export interface TaskProgressPayload {
  taskId: string;
  jobId: string;
  videoId?: string;
  type: string;
  progress: number;
  message?: string;
  timestamp: string;
  // Time estimation fields
  eta?: number;           // Estimated seconds remaining
  elapsedMs?: number;     // Milliseconds elapsed since task started
  taskLabel?: string;     // Human-readable task name (e.g., "Transcribing...")
}

export interface TaskCompletedPayload {
  taskId: string;
  jobId: string;
  videoId?: string;
  type: string;
  result?: any;
  duration?: number;
  timestamp: string;
}

export interface TaskFailedPayload {
  taskId: string;
  jobId: string;
  videoId?: string;
  type: string;
  error: {
    code: string;
    message: string;
  };
  canRetry: boolean;
  timestamp: string;
}

export interface SystemStatusPayload {
  mainPool: {
    active: number;
    maxConcurrent: number;
    tasks: any[];
  };
  aiPool: {
    active: number;
    maxConcurrent: number;
    task: any | null;
  };
  queue: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  timestamp: string;
}

/**
 * Saved Links Events
 */
export interface SavedLinkAddedPayload {
  link: SavedLink;
}

export interface SavedLinkUpdatedPayload {
  link: SavedLink;
}

export interface SavedLinkDeletedPayload {
  id: string;
}

export interface SavedLinksCountPayload {
  count: number;
}

/**
 * Library/Video Events
 */
export interface VideoAddedPayload {
  videoId: string;
  filename: string;
  filepath: string;
  timestamp: string;
}

/**
 * Model Download Events
 */
export interface ModelDownloadProgressPayload {
  modelId: string;
  progress: number;
  downloadedGB: number;
  totalGB: number;
  speed?: string;
  eta?: string;
}

export interface ModelDownloadCompletePayload {
  modelId: string;
}

export interface ModelDownloadErrorPayload {
  modelId: string;
  error: string;
}

export interface ModelDownloadCancelledPayload {
  modelId: string;
}

/**
 * WebSocket Event Names
 * Using const enum for type safety and better autocomplete
 */
export enum WebSocketEvent {
  // Analysis & Processing (Legacy)
  ANALYSIS_PROGRESS = 'analysisProgress',
  PROCESSING_PROGRESS = 'processingProgress',
  PROCESSING_FAILED = 'processing-failed',

  // Unified Queue Events (5+1 Pool Model)
  TASK_STARTED = 'task.started',
  TASK_PROGRESS = 'task.progress',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  SYSTEM_STATUS = 'system.status',

  // Saved Links
  SAVED_LINK_ADDED = 'saved-link-added',
  SAVED_LINK_UPDATED = 'saved-link-updated',
  SAVED_LINK_DELETED = 'saved-link-deleted',
  SAVED_LINKS_COUNT = 'saved-links-count',

  // Library/Video Events
  VIDEO_ADDED = 'video-added',

  // Model Download Events
  MODEL_DOWNLOAD_PROGRESS = 'model.download.progress',
  MODEL_DOWNLOAD_COMPLETE = 'model.download.complete',
  MODEL_DOWNLOAD_ERROR = 'model.download.error',
  MODEL_DOWNLOAD_CANCELLED = 'model.download.cancelled',

  // Connection Management
  CONNECTION = 'connection',
  DISCONNECT = 'disconnect',
}

/**
 * Event Emitter Internal Event Names
 * These are used with @OnEvent decorators
 */
export enum InternalEvent {
  // Legacy events
  ANALYSIS_PROGRESS = 'analysis.progress',
  PROCESSING_PROGRESS = 'processing.progress',
  PROCESSING_FAILED = 'processing.failed',

  // Unified queue events
  TASK_STARTED = 'task.started',
  TASK_PROGRESS = 'task.progress',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  SYSTEM_STATUS = 'system.status',

  // Model download events
  MODEL_DOWNLOAD_PROGRESS = 'model.download.progress',
  MODEL_DOWNLOAD_COMPLETE = 'model.download.complete',
  MODEL_DOWNLOAD_ERROR = 'model.download.error',
  MODEL_DOWNLOAD_CANCELLED = 'model.download.cancelled',
}

/**
 * Type-safe event payload mapping
 * Maps WebSocket events to their expected payload types
 */
export interface WebSocketEventMap {
  // Legacy events
  [WebSocketEvent.ANALYSIS_PROGRESS]: AnalysisProgressPayload;
  [WebSocketEvent.PROCESSING_PROGRESS]: ProcessingProgressPayload;
  [WebSocketEvent.PROCESSING_FAILED]: ProcessingFailedPayload;

  // Unified queue events
  [WebSocketEvent.TASK_STARTED]: TaskStartedPayload;
  [WebSocketEvent.TASK_PROGRESS]: TaskProgressPayload;
  [WebSocketEvent.TASK_COMPLETED]: TaskCompletedPayload;
  [WebSocketEvent.TASK_FAILED]: TaskFailedPayload;
  [WebSocketEvent.SYSTEM_STATUS]: SystemStatusPayload;

  // Saved links events
  [WebSocketEvent.SAVED_LINK_ADDED]: SavedLinkAddedPayload;
  [WebSocketEvent.SAVED_LINK_UPDATED]: SavedLinkUpdatedPayload;
  [WebSocketEvent.SAVED_LINK_DELETED]: SavedLinkDeletedPayload;
  [WebSocketEvent.SAVED_LINKS_COUNT]: SavedLinksCountPayload;

  // Library/Video events
  [WebSocketEvent.VIDEO_ADDED]: VideoAddedPayload;

  // Model download events
  [WebSocketEvent.MODEL_DOWNLOAD_PROGRESS]: ModelDownloadProgressPayload;
  [WebSocketEvent.MODEL_DOWNLOAD_COMPLETE]: ModelDownloadCompletePayload;
  [WebSocketEvent.MODEL_DOWNLOAD_ERROR]: ModelDownloadErrorPayload;
  [WebSocketEvent.MODEL_DOWNLOAD_CANCELLED]: ModelDownloadCancelledPayload;
}
