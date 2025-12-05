// WebSocket Service - Clean API for emitting WebSocket events
import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { WebSocketEvent, WebSocketEventMap } from './websocket.types';
import { SavedLink } from '../saved-links/saved-links.service';

/**
 * WebSocketService provides a clean, type-safe API for emitting WebSocket events.
 * This service should be injected into any service that needs to broadcast events to clients.
 *
 * Benefits:
 * - Type safety: Event names and payloads are validated at compile time
 * - Single responsibility: Services don't need to know about Socket.IO internals
 * - Testability: Easy to mock for unit tests
 * - Centralized logging and error handling
 */
@Injectable()
export class WebSocketService {
  private server: Server | null = null;
  private readonly logger = new Logger(WebSocketService.name);

  /**
   * Set the Socket.IO server instance
   * Called by AppGateway during initialization
   */
  setServer(server: Server): void {
    this.server = server;
    this.logger.log('WebSocket server instance registered');
  }

  /**
   * Get the Socket.IO server instance
   * Used by services that need direct access (e.g., MediaEventService for legacy events)
   */
  getServer(): Server | null {
    return this.server;
  }

  /**
   * Get current connection count
   */
  getConnectionCount(): number {
    return this.server?.sockets.sockets.size ?? 0;
  }

  /**
   * Generic emit method with type safety
   */
  private emit<K extends keyof WebSocketEventMap>(
    event: K,
    payload: WebSocketEventMap[K],
  ): void {
    if (!this.server) {
      this.logger.warn(`Cannot emit ${event}: WebSocket server not initialized`);
      return;
    }

    try {
      this.server.emit(event, payload);
      this.logger.debug(`Emitted ${event} to ${this.getConnectionCount()} clients`);
    } catch (error) {
      this.logger.error(`Error emitting ${event}:`, error);
    }
  }

  /**
   * Emit to a specific room
   */
  private emitToRoom<K extends keyof WebSocketEventMap>(
    room: string,
    event: K,
    payload: WebSocketEventMap[K],
  ): void {
    if (!this.server) {
      this.logger.warn(`Cannot emit ${event}: WebSocket server not initialized`);
      return;
    }

    try {
      this.server.to(room).emit(event, payload);
      this.logger.debug(`Emitted ${event} to room ${room}`);
    } catch (error) {
      this.logger.error(`Error emitting ${event} to room ${room}:`, error);
    }
  }

  /**
   * Analysis & Processing Events (Legacy - kept for backward compatibility)
   */
  emitAnalysisProgress(payload: WebSocketEventMap[WebSocketEvent.ANALYSIS_PROGRESS]): void {
    const jobId = payload.jobId || payload.id;
    const progress = payload.progress;
    this.logger.log(`Broadcasting analysis progress: jobId=${jobId}, progress=${progress}`);
    this.emit(WebSocketEvent.ANALYSIS_PROGRESS, payload);
  }

  emitProcessingProgress(payload: WebSocketEventMap[WebSocketEvent.PROCESSING_PROGRESS]): void {
    this.emit(WebSocketEvent.PROCESSING_PROGRESS, payload);
  }

  emitProcessingFailed(payload: WebSocketEventMap[WebSocketEvent.PROCESSING_FAILED]): void {
    this.logger.warn(`Processing failed: jobId=${payload.jobId}, error=${payload.error}`);
    this.emit(WebSocketEvent.PROCESSING_FAILED, payload);
  }

  /**
   * Unified Queue Events (5+1 Pool Model)
   */
  emitTaskStarted(payload: WebSocketEventMap[WebSocketEvent.TASK_STARTED]): void {
    this.logger.log(
      `Task started: taskId=${payload.taskId}, jobId=${payload.jobId}, type=${payload.type}, pool=${payload.pool}`,
    );
    this.emit(WebSocketEvent.TASK_STARTED, payload);
  }

  emitTaskProgress(payload: WebSocketEventMap[WebSocketEvent.TASK_PROGRESS]): void {
    this.logger.debug(
      `Task progress: taskId=${payload.taskId}, progress=${payload.progress}%, message=${payload.message}`,
    );
    this.emit(WebSocketEvent.TASK_PROGRESS, payload);
  }

  emitTaskCompleted(payload: WebSocketEventMap[WebSocketEvent.TASK_COMPLETED]): void {
    this.logger.log(
      `Task completed: taskId=${payload.taskId}, jobId=${payload.jobId}, type=${payload.type}, duration=${payload.duration}s`,
    );
    this.emit(WebSocketEvent.TASK_COMPLETED, payload);
  }

  emitTaskFailed(payload: WebSocketEventMap[WebSocketEvent.TASK_FAILED]): void {
    this.logger.error(
      `Task failed: taskId=${payload.taskId}, jobId=${payload.jobId}, error=${payload.error.message}`,
    );
    this.emit(WebSocketEvent.TASK_FAILED, payload);
  }

  emitSystemStatus(payload: WebSocketEventMap[WebSocketEvent.SYSTEM_STATUS]): void {
    this.logger.debug(
      `System status: mainPool=${payload.mainPool.active}/${payload.mainPool.maxConcurrent}, aiPool=${payload.aiPool.active}/${payload.aiPool.maxConcurrent}, queue=${payload.queue.total}`,
    );
    this.emit(WebSocketEvent.SYSTEM_STATUS, payload);
  }

  /**
   * Saved Links Events
   */
  emitSavedLinkAdded(link: SavedLink): void {
    this.logger.log(`Emitted saved-link-added event for: ${link.url}`);
    this.emit(WebSocketEvent.SAVED_LINK_ADDED, { link });
  }

  /**
   * Library/Video Events
   */
  emitVideoAdded(payload: WebSocketEventMap[WebSocketEvent.VIDEO_ADDED]): void {
    this.logger.log(`Emitted video-added event for: ${payload.filename} (${payload.videoId})`);
    this.emit(WebSocketEvent.VIDEO_ADDED, payload);
  }

  emitSavedLinkUpdated(link: SavedLink): void {
    this.logger.log(`Emitted saved-link-updated event for: ${link.id}`);
    this.emit(WebSocketEvent.SAVED_LINK_UPDATED, { link });
  }

  emitSavedLinkDeleted(id: string): void {
    this.logger.log(`Emitted saved-link-deleted event for: ${id}`);
    this.emit(WebSocketEvent.SAVED_LINK_DELETED, { id });
  }

  emitSavedLinksCount(count: number): void {
    this.logger.log(`Emitted saved-links-count event: ${count}`);
    this.emit(WebSocketEvent.SAVED_LINKS_COUNT, { count });
  }

  /**
   * Advanced Methods for Future Use
   */

  /**
   * Broadcast to all clients except sender
   */
  broadcast<K extends keyof WebSocketEventMap>(
    event: K,
    payload: WebSocketEventMap[K],
    excludeSocketId?: string,
  ): void {
    if (!this.server) {
      this.logger.warn(`Cannot broadcast ${event}: WebSocket server not initialized`);
      return;
    }

    try {
      if (excludeSocketId) {
        this.server.sockets.sockets.forEach((socket) => {
          if (socket.id !== excludeSocketId) {
            socket.emit(event, payload);
          }
        });
      } else {
        this.server.emit(event, payload);
      }
      this.logger.debug(`Broadcasted ${event}`);
    } catch (error) {
      this.logger.error(`Error broadcasting ${event}:`, error);
    }
  }

  /**
   * Emit to specific client by socket ID
   */
  emitToClient<K extends keyof WebSocketEventMap>(
    socketId: string,
    event: K,
    payload: WebSocketEventMap[K],
  ): void {
    if (!this.server) {
      this.logger.warn(`Cannot emit ${event}: WebSocket server not initialized`);
      return;
    }

    try {
      const socket = this.server.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit(event, payload);
        this.logger.debug(`Emitted ${event} to client ${socketId}`);
      } else {
        this.logger.warn(`Socket ${socketId} not found`);
      }
    } catch (error) {
      this.logger.error(`Error emitting ${event} to client ${socketId}:`, error);
    }
  }
}
