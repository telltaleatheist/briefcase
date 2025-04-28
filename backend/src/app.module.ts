// clippy/backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DownloaderModule } from './downloader/downloader.module';
import { FfmpegModule } from './ffmpeg/ffmpeg.module';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import * as fs from 'fs';
import { PathModule } from './path/path.module';
import * as log from 'electron-log';

function findFrontendDistPath(): string {
  // First check if path is provided via environment variable
  if (process.env.FRONTEND_PATH && fs.existsSync(process.env.FRONTEND_PATH)) {
    log.info(`Using frontend path from environment: ${process.env.FRONTEND_PATH}`);
    return process.env.FRONTEND_PATH;
  }
  
  // Fallback to checking common locations
  const possiblePaths = [
    join(process.cwd(), 'frontend', 'dist', 'clippy-frontend', 'browser'),
    join(process.cwd(), '..', 'frontend', 'dist', 'clippy-frontend', 'browser')
  ];

  for (const potentialPath of possiblePaths) {
    if (fs.existsSync(potentialPath)) {
      log.info(`Found frontend dist path: ${potentialPath}`);
      return potentialPath;
    }
  }

  log.error('❌ Could not find frontend dist directory. Will serve API only - app.module.ts.');
  // Instead of exiting, return a default path for API-only mode
  return join(process.cwd(), 'public');
}

@Module({
  imports: [
    // Load environment variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env']
    }),
    
    // Conditionally serve static files from frontend
    ...((() => {
      const frontendPath = findFrontendDistPath();
      // Only include ServeStaticModule if the path exists
      return fs.existsSync(frontendPath) ? 
        [ServeStaticModule.forRoot({
          rootPath: frontendPath,
          exclude: ['/api*'],
          serveRoot: '/'
        })] : 
        [];
    })()),
    
    // Import custom modules
    DownloaderModule,
    FfmpegModule,
    PathModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}