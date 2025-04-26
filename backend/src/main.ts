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

log.info('✅ Backend is starting...');

async function bootstrap() {
  try {
    // Log startup with clear separation for debugging
    console.log('====================================');
    console.log('BACKEND SERVICE STARTING');
    console.log('Process ID:', process.pid);
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('FRONTEND_PATH:', process.env.FRONTEND_PATH);
    console.log('Current directory:', process.cwd());
    console.log('====================================');

    // Create the NestJS app
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
      abortOnError: false
    });

    app.useWebSocketAdapter(new IoAdapter(app));

    app.enableCors({
      origin: [
        'http://localhost:8080',
        'http://localhost:4200',
        'http://localhost:3000'
      ],
      methods: ['GET', 'POST'],
      credentials: true
    });
    
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
    let frontendDistPath: string | null = null;

    if (frontendPathFromEnv && fs.existsSync(frontendPathFromEnv)) {
      console.log(`Using frontend path from environment: ${frontendPathFromEnv}`);
      frontendDistPath = frontendPathFromEnv;
    } else {
      // Fall back to checking multiple paths
      const possiblePaths = [
        path.join(process.cwd(), 'frontend', 'dist', 'clippy-frontend', 'browser'),
        path.join(process.cwd(), '..', 'frontend', 'dist', 'clippy-frontend', 'browser'),
      ];
    
      for (const potentialPath of possiblePaths) {
        console.log(`Checking frontend path: ${potentialPath} (exists: ${fs.existsSync(potentialPath)})`);
        if (fs.existsSync(potentialPath)) {
          frontendDistPath = potentialPath;
          break;
        }
      }
    }
    
    if (!frontendDistPath) {
      console.error('❌ Could not find frontend dist directory. Exiting.');
      process.exit(1);
    } else {
      console.log(`✅ Frontend dist path: ${frontendDistPath}`);

      // Serve static files
      expressApp.use(express.static(frontendDistPath, {
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
      
        const indexPath = path.join(frontendDistPath!, 'index.html');
      
        if (!fs.existsSync(indexPath)) {
          console.error(`[ERROR] index.html not found at: ${indexPath}`);
          return res.status(500).send('Frontend application not found');
        }
      
        console.log(`[Fallback] Serving index.html for route: ${req.url}`);
        res.sendFile(indexPath);
      });
    }

    const port = environment.port || process.env.PORT || 3000;
    
    try {
      await app.listen(port);
      console.log(`=== APPLICATION STARTED ===`);
      console.log(`Server running on port ${port}`);
      console.log(`API endpoint: http://localhost:${port}/${environment.apiPrefix}`);
    } catch (error) {
      if ((error as any).code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Please make sure no other instance of the application is running.`);
        console.error(`You can kill the process using port ${port} with: lsof -i :${port} -t | xargs kill -9`);
      }
      throw error; // Re-throw the error to be caught by the outer try/catch
    }
  } catch (error) {
    console.error('=== BOOTSTRAP ERROR ===');
    console.error('Error during application startup:');
    
    if (error instanceof Error) {
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('Error Stack:', error.stack);
    } else {
      console.error(error);
    }
    
    process.exit(1);
  }
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

bootstrap();