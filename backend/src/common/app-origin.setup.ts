/**
 * Wires the app-origin policy (app-origin.ts) into a Nest app: HTTP CORS, the
 * write guard, and a Socket.IO adapter whose CORS and handshake check use the
 * same policy. main.ts calls this; the tests call it with a LAN or loopback
 * policy to exercise exactly what ships.
 */
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { IncomingMessage } from 'http';
import { ServerOptions } from 'socket.io';
import { OriginPolicy, appOriginWriteGuard, corsOriginFor, socketHandshakeAllowed } from './app-origin';

export interface AppOriginSetup {
  policy: OriginPolicy;
  /** Credentialed CORS (loopback only; LAN mode drops it). */
  credentials: boolean;
  socketPath: string;
}

export class AppIoAdapter extends IoAdapter {
  constructor(app: INestApplication, private readonly setup: AppOriginSetup) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    return super.createIOServer(port, {
      ...options,
      path: this.setup.socketPath,
      cors: {
        origin: corsOriginFor(this.setup.policy),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
        credentials: this.setup.credentials,
      },
      // CORS does not cover the WebSocket upgrade, so its Origin is checked here.
      allowRequest: (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) =>
        callback(null, socketHandshakeAllowed(req, this.setup.policy)),
    });
  }
}

export function applyAppOriginPolicy(app: INestApplication, setup: AppOriginSetup): void {
  app.enableCors({
    origin: corsOriginFor(setup.policy),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: setup.credentials,
    allowedHeaders: 'Content-Type, Accept, Authorization, Range',
    exposedHeaders: 'Content-Range, Accept-Ranges, Content-Length',
  });
  app.use(appOriginWriteGuard(setup.policy));
  app.useWebSocketAdapter(new AppIoAdapter(app, setup));
}
