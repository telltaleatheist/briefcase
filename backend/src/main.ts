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
        logger: ['error', 'warn', 'log', 'debug', 'verbose'],
        abortOnError: false
      }
    );

    // Add this block to enable CORS for HTTP requests
    // Build CORS origins dynamically based on actual running ports
    const port = environment.port || process.env.PORT || 3000;
    const corsOrigins = [
      `http://localhost:${port}`,  // Backend port (self)
      'http://localhost:8080',     // Default Electron frontend port
      'http://localhost:3000',     // Fallback backend port
      'http://localhost:3001',     // Alternative backend port
      'http://localhost:4200',     // Angular dev server
      '*'                          // Allow all origins as fallback
    ];

    app.enableCors({
      origin: corsOrigins,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: true,
      allowedHeaders: 'Content-Type, Accept, Authorization'
    });

    app.useWebSocketAdapter(new ExtendedIoAdapter(app));
    
    app.setGlobalPrefix(environment.apiPrefix);

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