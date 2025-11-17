// clippy/backend/src/saved-links/saved-links.module.ts
import { Module } from '@nestjs/common';
import { SavedLinksService } from './saved-links.service';
import { SavedLinksController } from './saved-links.controller';
import { WebController } from './web.controller';
import { DatabaseModule } from '../database/database.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [DatabaseModule, DownloaderModule, MediaModule, QueueModule],
  providers: [SavedLinksService],
  controllers: [SavedLinksController, WebController],
  exports: [SavedLinksService],
})
export class SavedLinksModule {}
