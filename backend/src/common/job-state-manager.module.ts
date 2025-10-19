// backend/src/common/job-state-manager.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { JobStateManagerService } from './job-state-manager.service';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [forwardRef(() => MediaModule)],
  providers: [JobStateManagerService],
  exports: [JobStateManagerService],
})
export class JobStateManagerModule {}
