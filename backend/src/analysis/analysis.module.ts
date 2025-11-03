import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { OllamaService } from './ollama.service';
import { PythonBridgeService } from './python-bridge.service';
import { AIProviderService } from './ai-provider.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { PathModule } from '../path/path.module';
import { SharedConfigModule } from '../config/shared-config.module';

@Module({
  imports: [FfmpegModule, DownloaderModule, PathModule, SharedConfigModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, OllamaService, PythonBridgeService, AIProviderService],
  exports: [AnalysisService, OllamaService, AIProviderService],
})
export class AnalysisModule {}
