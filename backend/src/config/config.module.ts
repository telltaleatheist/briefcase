// backend/src/config/config.module.ts
import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { ModelManagerService } from './model-manager.service';

@Module({
  providers: [ApiKeysService, ModelManagerService],
  controllers: [ApiKeysController],
  exports: [ApiKeysService, ModelManagerService],
})
export class ApiKeysModule {}
