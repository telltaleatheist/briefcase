import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { OllamaService } from './ollama.service';
import { PythonBridgeService } from './python-bridge.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { PathModule } from '../path/path.module';

@Module({
  imports: [FfmpegModule, DownloaderModule, PathModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, OllamaService, PythonBridgeService],
  exports: [AnalysisService, OllamaService],
})
export class AnalysisModule {}
