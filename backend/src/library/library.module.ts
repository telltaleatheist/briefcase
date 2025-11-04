// clippy/backend/src/library/library.module.ts
import { Module, OnModuleInit } from '@nestjs/common';
import { LibraryService } from './library.service';
import { RelinkService } from './relink.service';
import { ClipExtractorService } from './clip-extractor.service';
import { LibraryController } from './library.controller';

@Module({
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
