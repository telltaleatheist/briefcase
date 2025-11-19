import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { environment } from './config/environment';
import { IoAdapter } from '@nestjs/platform-socket.io';
import * as log from 'electron-log';
import { ServerOptions } from 'socket.io';
import * as express from 'express';  // Explicitly import express

class ExtendedIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      path: environment.socket.path,
      cors: {
        origin: environment.cors.origins,
        methods: environment.cors.methods,
        credentials: environment.socket.credentials
      }
    });
    return server;
  }
}

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
        // Reduce log verbosity - only show errors, warnings, and important logs
        // This removes verbose RouterExplorer route mapping logs
        logger: ['error', 'warn', 'log'],
        abortOnError: false
      }
    );

    // Add this block to enable CORS for HTTP requests
    // Allow any localhost port for development
    const port = environment.port || process.env.PORT || 3000;

    app.enableCors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, etc.)
        if (!origin) {
          callback(null, true);
          return;
        }

        // Allow any localhost port
        if (origin.match(/^http:\/\/localhost:\d+$/)) {
          callback(null, true);
          return;
        }

        // Allow 127.0.0.1 as well
        if (origin.match(/^http:\/\/127\.0\.0\.1:\d+$/)) {
          callback(null, true);
          return;
        }

        // Block other origins
        callback(new Error('Not allowed by CORS'), false);
      },
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: true,
      allowedHeaders: 'Content-Type, Accept, Authorization, Range',
      exposedHeaders: 'Content-Range, Accept-Ranges, Content-Length'
    });

    app.useWebSocketAdapter(new ExtendedIoAdapter(app));

    // Increase body parser limit for large payloads (e.g., console logs)
    app.useBodyParser('json', { limit: '10mb' });
    app.useBodyParser('urlencoded', { limit: '10mb', extended: true });

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

    // Port was already declared above for CORS configuration
    await app.listen(port);
    log.info(`=== APPLICATION STARTED ===`);
    log.info(`Server running on port ${port}`);
    log.info(`API endpoint: http://localhost:${port}/${environment.apiPrefix}`);
    log.info('Note: Library initialization happens automatically via onModuleInit');
  } catch (error) {
    log.error('=== BOOTSTRAP ERROR ===');
    log.error('Error during application startup:', error);
    console.error(error);  // Additional console logging
  }
}

bootstrap();