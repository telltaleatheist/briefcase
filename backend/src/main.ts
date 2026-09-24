import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { environment } from './config/environment';
import { log } from './common/logger';
import * as express from 'express';  // Explicitly import express
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { installGracefulShutdown } from './common/graceful-shutdown';
import { applyAppOriginPolicy } from './common/app-origin.setup';

async function bootstrap() {
  log.info('====================================');
  log.info('BACKEND SERVICE STARTING');
  log.info('Process ID:', process.pid);
  log.info('Environment:', process.env.NODE_ENV || 'development');
  log.info('Current directory:', process.cwd());
  log.info('====================================');
    
  try {
    // Create an express instance explicitly
    const expressApp = express();
    
    const app = await NestFactory.create<NestExpressApplication>(
      AppModule,
      new ExpressAdapter(expressApp),
      {
        // Show errors, warnings, and log-level messages (skips verbose debug/verbose levels)
        // This includes important service messages like download status and livestream detection
        logger: ['error', 'warn', 'log'],
        abortOnError: false
      }
    );

    const port = environment.port || process.env.PORT || 3000;

    // Only the app's own origins (common/app-origin.ts, via config/environment.ts):
    // CORS keeps other pages from reading answers, and the write guard refuses
    // their state-changing requests, which CORS cannot (a form POST needs no
    // preflight).
    applyAppOriginPolicy(app, {
      policy: environment.originPolicy,
      credentials: environment.cors.credentials,
      socketPath: environment.socket.path,
    });

    // Increase body parser limit for large payloads (e.g., console logs)
    app.useBodyParser('json', { limit: '50mb' });
    app.useBodyParser('urlencoded', { limit: '50mb', extended: true });

    // Set global prefix but exclude certain routes
    app.setGlobalPrefix(environment.apiPrefix, {
      exclude: ['saved'] // Exclude /saved route from the API prefix
    });

    // Global validation pipe
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: false,
      })
    );

    // Global exception filter: sanitizes all error responses so no raw
    // filesystem paths or Node fs error codes leak to clients.
    app.useGlobalFilters(new AllExceptionsFilter());

    // Port was already declared above for CORS configuration.
    // SECURITY (A2): bind to loopback by default; only bind all interfaces when
    // LAN mode is explicitly opted in (BRIEFCASE_LAN=1). host resolves in
    // config/environment.ts.
    const host = environment.host;

    // Graceful shutdown. The Electron parent sends SIGTERM and SIGKILLs 12 s
    // later; without a handler here the backend was ALWAYS force-killed, so
    // nothing ever got a chance to clean up (the Crucible quit sweep gives
    // back what Briefcase holds on a server's card).
    //
    // ONE path (graceful-shutdown.ts): NOT `app.enableShutdownHooks()` as
    // well, whose own listener ran every hook, the 8 s Crucible quit sweep
    // included, a second time beside ours.
    installGracefulShutdown({
      close: () => app.close(),
      exit: (code) => process.exit(code),
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    });

    await app.listen(port, host);
    log.info(`=== APPLICATION STARTED ===`);
    log.info(`Server running on ${host}:${port}${environment.lanMode ? ' (LAN mode — no auth)' : ' (loopback only)'}`);
    log.info(`API endpoint: http://localhost:${port}/${environment.apiPrefix}`);
    log.info('Note: Library initialization happens automatically via onModuleInit');
  } catch (error) {
    log.error('=== BOOTSTRAP ERROR ===');
    log.error('Error during application startup:', error);
    console.error(error);  // Additional console logging
    // A9: exit non-zero so the Electron parent's health check fails fast and
    // its retry/error path triggers, rather than hanging on a dead process.
    process.exit(1);
  }
}

bootstrap();