// clippy/backend/src/app.module.ts
import { Module, Global } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DownloaderModule } from './downloader/downloader.module';
import { FfmpegModule } from './ffmpeg/ffmpeg.module';
import { PathModule } from './path/path.module';
import { MediaModule } from './media/media.module';
import { AnalysisModule } from './analysis/analysis.module';
import { LibraryModule } from './library/library.module';
import { ConfigModule } from '@nestjs/config';
import { SharedConfigModule } from './config/shared-config.module';
import { environment } from './config/environment';
import { JobStateManagerModule } from './common/job-state-manager.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => environment],
    }),
    EventEmitterModule.forRoot({
      global: true,
    }),
    SharedConfigModule,
    DownloaderModule,
    FfmpegModule,
    PathModule,
    MediaModule,
    AnalysisModule,
    LibraryModule,
    JobStateManagerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
