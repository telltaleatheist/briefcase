// Queue Module - Task-based queue system

import { Module, forwardRef } from '@nestjs/common';
import { QueueManagerService } from './queue-manager.service';
import { QueueController } from './queue.controller';
import { MediaModule } from '../media/media.module';
import { LibraryModule } from '../library/library.module';

@Module({
  imports: [forwardRef(() => MediaModule), forwardRef(() => LibraryModule)],
  controllers: [QueueController],
  providers: [QueueManagerService],
  exports: [QueueManagerService],
})
export class QueueModule {}
