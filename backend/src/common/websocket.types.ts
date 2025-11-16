// WebSocket Event Type Definitions
// Centralized registry of all WebSocket events and their payloads

import { SavedLink } from '../saved-links/saved-links.service';

/**
 * Analysis & Processing Events
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
 * WebSocket Event Names
 * Using const enum for type safety and better autocomplete
 */
export enum WebSocketEvent {
  // Analysis & Processing
  ANALYSIS_PROGRESS = 'analysisProgress',
  PROCESSING_PROGRESS = 'processingProgress',
  PROCESSING_FAILED = 'processing-failed',

  // Saved Links
  SAVED_LINK_ADDED = 'saved-link-added',
  SAVED_LINK_UPDATED = 'saved-link-updated',
  SAVED_LINK_DELETED = 'saved-link-deleted',
  SAVED_LINKS_COUNT = 'saved-links-count',

  // Connection Management
  CONNECTION = 'connection',
  DISCONNECT = 'disconnect',
}

/**
 * Event Emitter Internal Event Names
 * These are used with @OnEvent decorators
 */
export enum InternalEvent {
  ANALYSIS_PROGRESS = 'analysis.progress',
  PROCESSING_PROGRESS = 'processing.progress',
  PROCESSING_FAILED = 'processing.failed',
}

/**
 * Type-safe event payload mapping
 * Maps WebSocket events to their expected payload types
 */
export interface WebSocketEventMap {
  [WebSocketEvent.ANALYSIS_PROGRESS]: AnalysisProgressPayload;
  [WebSocketEvent.PROCESSING_PROGRESS]: ProcessingProgressPayload;
  [WebSocketEvent.PROCESSING_FAILED]: ProcessingFailedPayload;
  [WebSocketEvent.SAVED_LINK_ADDED]: SavedLinkAddedPayload;
  [WebSocketEvent.SAVED_LINK_UPDATED]: SavedLinkUpdatedPayload;
  [WebSocketEvent.SAVED_LINK_DELETED]: SavedLinkDeletedPayload;
  [WebSocketEvent.SAVED_LINKS_COUNT]: SavedLinksCountPayload;
}
