import { Module } from '@nestjs/common';
import { ComponentManagerService } from './component-manager.service';
import { ComponentManagerController } from './component-manager.controller';

@Module({
  providers: [ComponentManagerService],
  controllers: [ComponentManagerController],
  exports: [ComponentManagerService],
})
export class ComponentManagerModule {}
