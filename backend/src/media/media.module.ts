// clippy/backend/src/media/media.module.ts
import { Module } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import { MediaProcessingService } from './media-processing.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';

@Module({
  imports: [
    FfmpegModule, // Import the FFmpeg module to use its services
  ],
  providers: [
    MediaEventService,
    MediaProcessingService,
  ],
  exports: [
    // Export these services so they can be used by other modules
    MediaEventService,
    MediaProcessingService,
  ],
})
export class MediaModule {}