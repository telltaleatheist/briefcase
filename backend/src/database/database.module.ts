import { Module, Global, forwardRef } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { MigrationService } from './migration.service';
import { LibraryManagerService } from './library-manager.service';
import { LibraryMigrationService } from './library-migration.service';
import { DatabaseController } from './database.controller';
import { PathMappingService } from './path-mapping.service';
import { SharedDatabaseService } from './shared-database.service';
import { DatabaseConflictService } from './database-conflict.service';
import { RelinkingService } from './relinking.service';
import { RelinkingController } from './relinking.controller';
import { TabsController } from './tabs.controller';
import { IgnoreService } from './ignore.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { MediaModule } from '../media/media.module';

/**
 * DatabaseModule - Global module providing database services
 *
 * This is a global module, so services can be injected anywhere
 * without importing the module explicitly.
 *
 * New services for shared database support:
 * - PathMappingService: Translates paths between NAS-relative and absolute
 * - SharedDatabaseService: Pull-before-push pattern for multi-computer access
 * - DatabaseConflictService: Detects and handles conflicts (delete vs update)
 */
@Global()
@Module({
  imports: [
    forwardRef(() => AnalysisModule),
    FfmpegModule,
    forwardRef(() => MediaModule),
  ],
  controllers: [
    DatabaseController,
    RelinkingController,
    TabsController,
  ],
  providers: [
    DatabaseService,
    LibraryManagerService,
    LibraryMigrationService,
    FileScannerService,
    MigrationService,
    PathMappingService,
    DatabaseConflictService,
    SharedDatabaseService,
    RelinkingService,
    IgnoreService,
  ],
  exports: [
    DatabaseService,
    LibraryManagerService,
    FileScannerService,
    MigrationService,
    PathMappingService,
    DatabaseConflictService,
    SharedDatabaseService,
    IgnoreService,
  ],
})
export class DatabaseModule {}
