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

function findFrontendDistPath(): string {
  const possiblePaths = [
    join(process.cwd(), 'frontend', 'dist', 'clippy-frontend', 'browser'),
    join(process.cwd(), '..', 'frontend', 'dist', 'clippy-frontend', 'browser')
  ];

  for (const potentialPath of possiblePaths) {
    if (fs.existsSync(potentialPath)) {
      console.log(`Found frontend dist path: ${potentialPath}`);
      return potentialPath;
    }
  }

  console.error('❌ Could not find frontend dist directory. Exiting.');
  process.exit(1); // ⬅ exits cleanly instead of returning ''
}

@Module({
  imports: [
    // Load environment variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env']
    }),
    // Serve static files from frontend
    ServeStaticModule.forRoot({
      rootPath: findFrontendDistPath(),
      exclude: ['/api*'],
      serveRoot: '/'
    }),
    // Import custom modules
    DownloaderModule,
    FfmpegModule,
    PathModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}