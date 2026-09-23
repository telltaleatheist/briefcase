// backend/src/scorer/scorer.module.ts
import { Global, Module } from '@nestjs/common';
import { ScorerServerService } from './scorer-server.service';

/**
 * Scorer Module - the logit decision engine (a port of snap) and the lifecycle
 * of its own llama-server. Global so chaptering and flag detection can inject
 * ScorerServerService without import cycles. Nothing starts at boot.
 */
@Global()
@Module({
  providers: [ScorerServerService],
  exports: [ScorerServerService],
})
export class ScorerModule {}
