// clippy/backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DownloaderModule } from './downloader/downloader.module';
import { FfmpegModule } from './ffmpeg/ffmpeg.module';
import { ConfigModule } from '@nestjs/config';
import { PathModule } from './path/path.module';
import * as log from 'electron-log';
import { SharedConfigModule } from './config/shared-config.module';

@Module({
  imports: [
    SharedConfigModule,
    // Load environment variables
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env']
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