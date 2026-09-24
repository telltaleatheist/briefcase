// backend/src/scorer/snap-analysis.module.ts
import { Module } from '@nestjs/common';
import { CrucibleModule } from '../crucible/crucible.module';
import { CrucibleLlmModule } from '../crucible/llm/crucible-llm.module';
import { CrucibleScorerService } from './crucible-scorer.service';
import { SnapFlagRanker } from './flags/snap-flag-ranker.service';
import { SnapAnalysisService } from './snap-analysis.service';

/**
 * The snap engine's analysis stage (chapters + flag ranking in one scorer
 * lease). ScorerModule is @Global, so ScorerServerService injects without an
 * import here. Imported by AnalysisModule; AIAnalysisService takes the service
 * @Optional, so the classic pipeline never depends on it.
 */
@Module({
  // P6: under aiVia crucible the scorer is Crucible's decision door (CrucibleScorerService).
  imports: [CrucibleModule, CrucibleLlmModule],
  providers: [SnapFlagRanker, CrucibleScorerService, SnapAnalysisService],
  exports: [SnapAnalysisService],
})
export class SnapAnalysisModule {}
