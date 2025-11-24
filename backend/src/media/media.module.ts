// ClipChimp/backend/src/media/media.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import { MediaProcessingService } from './media-processing.service';
import { MediaRelationshipService } from './media-relationship.service';
import { MediaOperationsService } from './media-operations.service';
import { MediaController } from './media.controller';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { WhisperService } from './whisper.service';
import { WhisperManager } from './whisper-manager';
import { JobStateManagerModule } from '../common/job-state-manager.module';
import { DatabaseModule } from '../database/database.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [
    forwardRef(() => FfmpegModule),
    forwardRef(() => JobStateManagerModule),
    forwardRef(() => DatabaseModule),
    forwardRef(() => DownloaderModule),
    forwardRef(() => AnalysisModule),
  ],
  controllers: [MediaController],
  providers: [
    MediaEventService,
    MediaProcessingService,
    MediaRelationshipService,
    MediaOperationsService,
    WhisperService,
    WhisperManager,
  ],
  exports: [
    MediaEventService,
    MediaProcessingService,
    MediaRelationshipService,
    MediaOperationsService,
    WhisperService,
  ],
})
export class MediaModule {}