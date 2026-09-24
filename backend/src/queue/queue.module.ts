// Queue Module - Task-based queue system

import { Module, forwardRef } from '@nestjs/common';
import { QueueManagerService } from './queue-manager.service';
import { QueueController } from './queue.controller';
import { MediaModule } from '../media/media.module';
import { LibraryModule } from '../library/library.module';
import { CrucibleModule } from '../crucible/crucible.module';
import { CrucibleLlmModule } from '../crucible/llm/crucible-llm.module';
import { CrucibleLanesService } from './crucible-lanes';

@Module({
  imports: [forwardRef(() => MediaModule), forwardRef(() => LibraryModule), CrucibleModule, CrucibleLlmModule],
  controllers: [QueueController],
  // P4: the Crucible lanes (admission, parking, the ledger sweeps).
  providers: [QueueManagerService, CrucibleLanesService],
  exports: [QueueManagerService],
})
export class QueueModule {}
