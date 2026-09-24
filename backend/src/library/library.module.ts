// Briefcase/backend/src/library/library.module.ts
import { CrucibleModule } from '../crucible/crucible.module';
import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { LibraryService } from './library.service';
import { RelinkService } from './relink.service';
import { ClipExtractorService } from './clip-extractor.service';
import { LibraryController } from './library.controller';
import { AnalysisModule } from '../analysis/analysis.module';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';

@Module({
  // CrucibleModule: the readiness gate of the one AI endpoint here (library insights).
  imports: [forwardRef(() => AnalysisModule), FfmpegModule, CrucibleModule],
  providers: [LibraryService, RelinkService, ClipExtractorService],
  controllers: [LibraryController],
  exports: [LibraryService, RelinkService, ClipExtractorService],
})
export class LibraryModule implements OnModuleInit {
  constructor(private libraryService: LibraryService) {}

  async onModuleInit() {
    // Initialize library on module startup
    await this.libraryService.initialize();
  }
}
