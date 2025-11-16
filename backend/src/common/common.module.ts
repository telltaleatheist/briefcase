// Common Module - Shared infrastructure and utilities
import { Global, Module } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { WebSocketService } from './websocket.service';

/**
 * CommonModule provides shared infrastructure used across the application.
 *
 * This module is marked as @Global() so it doesn't need to be imported
 * into every module that needs WebSocket functionality.
 *
 * Exports:
 * - WebSocketService: For emitting WebSocket events from any service
 * - AppGateway: For health checks and monitoring (rarely needed)
 */
@Global()
@Module({
  providers: [AppGateway, WebSocketService],
  exports: [WebSocketService, AppGateway],
})
export class CommonModule {}
