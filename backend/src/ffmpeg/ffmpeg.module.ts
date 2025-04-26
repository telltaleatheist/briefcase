// clippy/backend/src/ffmpeg/ffmpeg.module.ts
import { Module } from '@nestjs/common';
import { FfmpegService } from './ffmpeg.service';

@Module({
  providers: [FfmpegService],
  exports: [FfmpegService],
})
export class FfmpegModule {}