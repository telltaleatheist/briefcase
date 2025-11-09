// clippy/backend/src/saved-links/saved-links.module.ts
import { Module } from '@nestjs/common';
import { SavedLinksService } from './saved-links.service';
import { SavedLinksController } from './saved-links.controller';
import { WebController } from './web.controller';
import { SavedLinksGateway } from './saved-links.gateway';
import { DatabaseModule } from '../database/database.module';
import { DownloaderModule } from '../downloader/downloader.module';

@Module({
  imports: [DatabaseModule, DownloaderModule],
  providers: [SavedLinksService, SavedLinksGateway],
  controllers: [SavedLinksController, WebController],
  exports: [SavedLinksService],
})
export class SavedLinksModule {}
