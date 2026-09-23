// backend/src/scorer/chapters/snap-chapters.module.ts
import { Module } from '@nestjs/common';
import { SnapChapterService } from './snap-chapter.service';

/**
 * Snap chaptering. ScorerModule is @Global, so ScorerServerService injects
 * without importing it here. The analysis pipeline uses SnapAnalysisModule
 * (scorer/snap-analysis.module.ts) instead; this module is for standalone use.
 */
@Module({
  providers: [SnapChapterService],
  exports: [SnapChapterService],
})
export class SnapChaptersModule {}
