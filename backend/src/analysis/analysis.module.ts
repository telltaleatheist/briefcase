import { Module, forwardRef } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AIProviderService } from './ai-provider.service';
import { AIAnalysisService } from './ai-analysis.service';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { PathModule } from '../path/path.module';
import { SharedConfigModule } from '../config/shared-config.module';
import { LibraryModule } from '../library/library.module';
import { DatabaseModule } from '../database/database.module';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { SnapAnalysisModule } from '../scorer/snap-analysis.module';
import { CrucibleLlmModule } from '../crucible/llm/crucible-llm.module';

@Module({
  imports: [
    FfmpegModule,
    forwardRef(() => DownloaderModule),
    PathModule,
    SharedConfigModule,
    LibraryModule,
    forwardRef(() => DatabaseModule),
    forwardRef(() => MediaModule),
    forwardRef(() => QueueModule),
    // The snap engine's scorer stage: the analysis engine.
    SnapAnalysisModule,
    // Every LLM call goes through Crucible (P3; the only road since P7).
    CrucibleLlmModule,
  ],
  controllers: [
    AnalysisController,
  ],
  providers: [AnalysisService, AIProviderService, AIAnalysisService],
  exports: [AnalysisService, AIProviderService, AIAnalysisService],
})
export class AnalysisModule {}
