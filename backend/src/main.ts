// At the top of your file
process.stderr.write('====== BACKEND PROCESS STARTING - EARLY DEBUG ======\n');
process.stderr.write(`Process environment keys: ${Object.keys(process.env).join(', ')}\n`);
process.stderr.write(`FRONTEND_PATH value: ${process.env.FRONTEND_PATH}\n`);

// clippy/backend/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { environment } from './config/environment';
import { IoAdapter } from '@nestjs/platform-socket.io';
import * as log from 'electron-log';
import { ServerOptions } from 'socket.io';

process.stderr.write('✅ After imports');

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

process.stderr.write('✅ Before bootstrap...');

async function bootstrap() {
  // Log startup with clear separation for debugging
  log.info('====================================');
  log.info('BACKEND SERVICE STARTING');
  log.info('Process ID:', process.pid);
  log.info('Environment:', process.env.NODE_ENV || 'development');
  process.stderr.write(`FRONTEND_PATH value after bootstrap called: ${process.env.FRONTEND_PATH}\n`);
  log.info('Current directory:', process.cwd());
  log.info('====================================');
    
  try {
    // Create the NestJS app
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
      abortOnError: false
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

    // Get the express adapter
    const expressApp = app.getHttpAdapter().getInstance();
    const frontendPathFromEnv = process.env.FRONTEND_PATH;

    if (!frontendPathFromEnv) {
      log.error('❌ process environment variables empty. exiting from main.ts bootstrap function.');
      process.exit(1);
    } else {
      log.info(`✅ Frontend dist path: ${frontendPathFromEnv}`);

      // Serve static files
      expressApp.use(express.static(frontendPathFromEnv, {
        index: 'index.html',
        extensions: ['html']
      }));

      // Fallback route to support client-side routing
      expressApp.use((req, res, next) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/socket.io/')) {
          return next();
        }
        
        // Only handle GET requests
        if (req.method !== 'GET') return next();
      
        // If the request has a file extension (like .js, .css, etc), skip it
        if (path.extname(req.url)) return next();
      
        const indexPath = path.join(frontendPathFromEnv!, 'index.html');
      
        if (!fs.existsSync(indexPath)) {
          log.error(`[ERROR] index.html not found at: ${indexPath}`);
          return res.status(500).send('Frontend application not found');
        }
      
        log.info(`[Fallback] Serving index.html for route: ${req.url}`);
        res.sendFile(indexPath);
      });
    }

    const port = environment.port || process.env.PORT || 3000;
    
    try {
      await app.listen(port);
      log.info(`=== APPLICATION STARTED ===`);
      log.info(`Server running on port ${port}`);
      log.info(`API endpoint: http://localhost:${port}/${environment.apiPrefix}`);
    } catch (error) {
      if ((error as any).code === 'EADDRINUSE') {
        log.error(`Port ${port} is already in use. Please make sure no other instance of the application is running.`);
        log.error(`You can kill the process using port ${port} with: lsof -i :${port} -t | xargs kill -9`);
      }
      throw error; // Re-throw the error to be caught by the outer try/catch
    }
  } catch (error) {
    log.error('=== BOOTSTRAP ERROR ===');
    log.error('Error during application startup:');
    
    if (error instanceof Error) {
      log.error('Error Name:', error.name);
      log.error('Error Message:', error.message);
      log.error('Error Stack:', error.stack);
    } else {
      log.error(error);
    }
    
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  log.error('💥 Fatal error during backend startup:');
  log.error(err);
  process.exit(1);
});

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
});
