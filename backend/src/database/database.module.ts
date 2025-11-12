import { Module, Global, forwardRef } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { MigrationService } from './migration.service';
import { LibraryManagerService } from './library-manager.service';
import { DatabaseController } from './database.controller';
import { AnalysisModule } from '../analysis/analysis.module';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { MediaModule } from '../media/media.module';

/**
 * DatabaseModule - Global module providing database services
 *
 * This is a global module, so services can be injected anywhere
 * without importing the module explicitly.
 */
@Global()
@Module({
  imports: [
    forwardRef(() => AnalysisModule),
    FfmpegModule,
    forwardRef(() => MediaModule),
  ],
  controllers: [DatabaseController],
  providers: [
    DatabaseService,
    LibraryManagerService,
    FileScannerService,
    MigrationService,
  ],
  exports: [
    DatabaseService,
    LibraryManagerService,
    FileScannerService,
    MigrationService,
  ],
})
export class DatabaseModule {}
