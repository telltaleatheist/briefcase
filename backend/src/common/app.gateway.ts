// App Gateway - Core WebSocket Infrastructure
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebSocketService } from './websocket.service';
import { InternalEvent } from './websocket.types';

/**
 * AppGateway is the core WebSocket infrastructure for the entire application.
 *
 * Responsibilities:
 * - Manage the Socket.IO server lifecycle
 * - Handle client connections and disconnections
 * - Listen to internal event emitter events and broadcast them via WebSocket
 * - Connection monitoring and health checks
 *
 * This is a singleton gateway that all WebSocket communication flows through.
 * Services should use WebSocketService to emit events, not inject this gateway directly.
 */
@Injectable()
@WebSocketGateway({
  cors: true,
  // Performance optimizations for handling many connections
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class AppGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppGateway.name);
  private connectionCount = 0;

  constructor(private readonly websocketService: WebSocketService) {}

  /**
   * Gateway Lifecycle: Initialization
   */
  afterInit(server: Server): void {
    // Register server with WebSocketService
    this.websocketService.setServer(server);

    this.logger.log('='.repeat(60));
    this.logger.log('AppGateway initialized successfully');
    this.logger.log(`Server instance: ${server ? 'ACTIVE' : 'NULL'}`);
    this.logger.log(`CORS enabled: true`);
    this.logger.log(`Transports: websocket, polling`);
    this.logger.log('='.repeat(60));
  }

  /**
   * Gateway Lifecycle: Client Connection
   */
  handleConnection(client: Socket): void {
    this.connectionCount++;
    this.logger.log(
      `Client connected: ${client.id} | Total connections: ${this.connectionCount}`,
    );

    // Send connection confirmation
    client.emit('connected', {
      socketId: client.id,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Gateway Lifecycle: Client Disconnection
   */
  handleDisconnect(client: Socket): void {
    this.connectionCount--;
    this.logger.log(
      `Client disconnected: ${client.id} | Total connections: ${this.connectionCount}`,
    );
  }

  /**
   * Event Handlers
   * These listen to internal event emitter events and broadcast them via WebSocket
   */

  /**
   * Analysis progress updates (from AnalysisService)
   */
  @OnEvent(InternalEvent.ANALYSIS_PROGRESS)
  handleAnalysisProgress(payload: any): void {
    this.websocketService.emitAnalysisProgress(payload);
  }

  /**
   * Processing progress updates (FFmpeg, etc.)
   */
  @OnEvent(InternalEvent.PROCESSING_PROGRESS)
  handleProcessingProgress(payload: any): void {
    this.websocketService.emitProcessingProgress(payload);
  }

  /**
   * Processing failure notifications
   */
  @OnEvent(InternalEvent.PROCESSING_FAILED)
  handleProcessingFailed(payload: any): void {
    this.websocketService.emitProcessingFailed(payload);
  }

  /**
   * Health Check Methods
   */

  /**
   * Get current connection count
   */
  getConnectionCount(): number {
    return this.server?.sockets.sockets.size ?? 0;
  }

  /**
   * Check if server is healthy
   */
  isHealthy(): boolean {
    return this.server !== null && this.server !== undefined;
  }

  /**
   * Get detailed status
   */
  getStatus(): {
    healthy: boolean;
    connections: number;
    uptime: number;
  } {
    return {
      healthy: this.isHealthy(),
      connections: this.getConnectionCount(),
      uptime: process.uptime(),
    };
  }
}
