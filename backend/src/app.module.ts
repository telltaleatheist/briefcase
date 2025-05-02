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
import { SharedConfigModule } from './config/shared-config.module';

function findFrontendDistPath(): string {
  if (!process.env.FRONTEND_PATH) {
    log.error('No FRONTEND_PATH environment variable set');
    const fallbackPath = join(process.cwd(), 'public');
    fs.mkdirSync(fallbackPath, { recursive: true });
    
    return fallbackPath;
  }

  if (!fs.existsSync(process.env.FRONTEND_PATH)) {
    log.warn(`Provided FRONTEND_PATH does not exist: ${process.env.FRONTEND_PATH}`);
    const fallbackPath = join(process.cwd(), 'public');
    fs.mkdirSync(fallbackPath, { recursive: true });
    
    return fallbackPath;
  }

  log.info(`Using frontend path from environment: ${process.env.FRONTEND_PATH}`);
  return process.env.FRONTEND_PATH;
}

@Module({
  imports: [
    SharedConfigModule,
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