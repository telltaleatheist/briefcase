// clippy/backend/src/ffmpeg/ffmpeg.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { FfmpegService } from './ffmpeg.service';
import { FfmpegController } from './ffmpeg.controller';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [forwardRef(() => MediaModule)], // Use forwardRef to resolve circular dependency
  providers: [FfmpegService],
  controllers: [FfmpegController],
  exports: [FfmpegService],
})
export class FfmpegModule {}