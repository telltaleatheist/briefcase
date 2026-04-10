import { Module } from '@nestjs/common';
import { WebArchiveService } from './web-archive.service';
import { WebArchiveController } from './web-archive.controller';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [WebArchiveService],
  controllers: [WebArchiveController],
  exports: [WebArchiveService],
})
export class WebArchiveModule {}
