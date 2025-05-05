// clippy/backend/src/downloader/downloader.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { DownloaderService } from './downloader.service';
import { DownloaderController } from './downloader.controller';
import { BatchDownloaderService } from './batch-downloader.service';
import { MediaModule } from '../media/media.module';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { PathModule } from '../path/path.module';
import { SharedConfigModule } from '../config/shared-config.module';

@Module({
  imports: [
    forwardRef(() => MediaModule), // Using forwardRef to handle circular dependencies
    forwardRef(() => FfmpegModule),
    PathModule,
    SharedConfigModule
  ],
  providers: [DownloaderService, BatchDownloaderService],
  controllers: [DownloaderController],
  exports: [DownloaderService, BatchDownloaderService],
})
export class DownloaderModule {}