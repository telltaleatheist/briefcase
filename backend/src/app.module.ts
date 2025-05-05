// clippy/backend/src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DownloaderModule } from './downloader/downloader.module';
import { FfmpegModule } from './ffmpeg/ffmpeg.module';
import { PathModule } from './path/path.module';
import { MediaModule } from './media/media.module';
import { ConfigModule } from '@nestjs/config';
import { SharedConfigModule } from './config/shared-config.module';
import { environment } from './config/environment';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => environment],
    }),
    SharedConfigModule,
    DownloaderModule,
    FfmpegModule,
    PathModule,
    MediaModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}