// clippy/backend/src/saved-links/saved-links.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';
import { SavedLink } from './saved-links.service';

@WebSocketGateway({ cors: true })
export class SavedLinksGateway {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SavedLinksGateway.name);

  /**
   * Emit when a new link is added
   */
  emitLinkAdded(savedLink: SavedLink): void {
    this.server.emit('saved-link-added', savedLink);
    this.logger.log(`Emitted saved-link-added event for: ${savedLink.url}`);
  }

  /**
   * Emit when a link is updated
   */
  emitLinkUpdated(savedLink: SavedLink): void {
    this.server.emit('saved-link-updated', savedLink);
    this.logger.log(`Emitted saved-link-updated event for: ${savedLink.id}`);
  }

  /**
   * Emit when a link is deleted
   */
  emitLinkDeleted(id: string): void {
    this.server.emit('saved-link-deleted', { id });
    this.logger.log(`Emitted saved-link-deleted event for: ${id}`);
  }

  /**
   * Emit count update (for tray badge)
   */
  emitCountUpdate(count: number): void {
    this.server.emit('saved-links-count', { count });
    this.logger.log(`Emitted saved-links-count event: ${count}`);
  }
}
