// clippy/backend/src/media/media.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import { MediaProcessingService } from './media-processing.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';

@Module({
  imports: [forwardRef(() => FfmpegModule)], // Use forwardRef to resolve circular dependency
  providers: [MediaEventService, MediaProcessingService],
  exports: [MediaEventService, MediaProcessingService],
})
export class MediaModule {}