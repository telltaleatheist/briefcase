// clippy/backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DownloaderModule } from './downloader/downloader.module';
import { FfmpegModule } from './ffmpeg/ffmpeg.module';
import { ConfigModule } from '@nestjs/config';
import { PathModule } from './path/path.module';
import { SharedConfigModule } from './config/shared-config.module';
import { MediaModule } from './media/media.module';

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
    MediaModule, 
    FfmpegModule,
    PathModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}