// clippy/backend/src/media/media.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import { MediaProcessingService } from './media-processing.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { WhisperService } from './whisper.service';
import { WhisperManager } from './whisper-manager';

@Module({
  imports: [forwardRef(() => FfmpegModule)], // Use forwardRef to resolve circular dependency
  providers: [
    MediaEventService,
    MediaProcessingService,
    WhisperService,
    WhisperManager
  ],
  exports: [
    MediaEventService,
    MediaProcessingService,
    WhisperService
  ],
})
export class MediaModule {}