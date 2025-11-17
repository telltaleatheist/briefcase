// Queue Module - Task-based queue system

import { Module, forwardRef } from '@nestjs/common';
import { QueueManagerService } from './queue-manager.service';
import { QueueController } from './queue.controller';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [forwardRef(() => MediaModule)],
  controllers: [QueueController],
  providers: [QueueManagerService],
  exports: [QueueManagerService],
})
export class QueueModule {}
