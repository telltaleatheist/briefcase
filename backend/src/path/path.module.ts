// ClipChimp/backend/src/path/path.module.ts
import { Module } from '@nestjs/common';
import { PathService } from './path.service';
import { PathController } from './path.controller';

@Module({
  providers: [PathService],
  controllers: [PathController],
  exports: [PathService]
})
export class PathModule {}