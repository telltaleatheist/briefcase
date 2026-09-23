// backend/src/scorer/chapters/snap-chapters.module.ts
import { Module } from '@nestjs/common';
import { SnapChapterService } from './snap-chapter.service';

/**
 * Snap chaptering. ScorerModule is @Global, so ScorerServerService injects
 * without importing it here. Not yet imported by AppModule (integration phase).
 */
@Module({
  providers: [SnapChapterService],
  exports: [SnapChapterService],
})
export class SnapChaptersModule {}
