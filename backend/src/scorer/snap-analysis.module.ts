// backend/src/scorer/snap-analysis.module.ts
import { Module } from '@nestjs/common';
import { SnapFlagRanker } from './flags/snap-flag-ranker.service';
import { SnapAnalysisService } from './snap-analysis.service';

/**
 * The snap engine's analysis stage (chapters + flag ranking in one scorer
 * lease). ScorerModule is @Global, so ScorerServerService injects without an
 * import here. Imported by AnalysisModule; AIAnalysisService takes the service
 * @Optional, so the classic pipeline never depends on it.
 */
@Module({
  providers: [SnapFlagRanker, SnapAnalysisService],
  exports: [SnapAnalysisService],
})
export class SnapAnalysisModule {}
