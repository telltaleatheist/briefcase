// backend/src/config/shared-config.module.ts
import { Global, Module } from '@nestjs/common';
import { SharedConfigService } from './shared-config.service';
import { ConfigController } from './config.controller';

@Global() // Make this module global so it can be accessed anywhere
@Module({
  controllers: [ConfigController],
  providers: [
    {
      provide: SharedConfigService,
      useFactory: () => {
        return SharedConfigService.getInstance();
      }
    }
  ],
  exports: [SharedConfigService]
})
export class SharedConfigModule {}
