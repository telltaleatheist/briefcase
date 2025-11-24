// ClipChimp/backend/src/downloader/downloader.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { DownloaderService } from './downloader.service';
import { DownloaderController } from './downloader.controller';
import { MediaModule } from '../media/media.module';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { PathModule } from '../path/path.module';
import { SharedConfigModule } from '../config/shared-config.module';
import { JobStateManagerModule } from '../common/job-state-manager.module';
import { DatabaseModule } from '../database/database.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [
    forwardRef(() => MediaModule),
    forwardRef(() => FfmpegModule),
    forwardRef(() => DatabaseModule),
    forwardRef(() => AnalysisModule),
    PathModule,
    SharedConfigModule,
    forwardRef(() => JobStateManagerModule)
  ],
  providers: [DownloaderService],
  controllers: [DownloaderController],
  exports: [DownloaderService],
})
export class DownloaderModule {}