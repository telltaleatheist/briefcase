import { Module, forwardRef } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { SimpleTranscribeController } from './simple-transcribe.controller';
import { SimpleAnalyzeController } from './simple-analyze.controller';
import { OllamaService } from './ollama.service';
import { PythonBridgeService } from './python-bridge.service';
import { AIProviderService } from './ai-provider.service';
import { TextExtractionService } from './text-extraction.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { PathModule } from '../path/path.module';
import { SharedConfigModule } from '../config/shared-config.module';
import { LibraryModule } from '../library/library.module';
import { DatabaseModule } from '../database/database.module';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [
    FfmpegModule,
    forwardRef(() => DownloaderModule),
    PathModule,
    SharedConfigModule,
    LibraryModule,
    forwardRef(() => DatabaseModule),
    forwardRef(() => MediaModule),
  ],
  controllers: [
    AnalysisController,
    SimpleTranscribeController,
    SimpleAnalyzeController,
  ],
  providers: [AnalysisService, OllamaService, PythonBridgeService, AIProviderService, TextExtractionService],
  exports: [AnalysisService, OllamaService, AIProviderService, PythonBridgeService, TextExtractionService],
})
export class AnalysisModule {}
