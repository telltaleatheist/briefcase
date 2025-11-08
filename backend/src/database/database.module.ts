import { Module, Global, forwardRef } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { MigrationService } from './migration.service';
import { BatchAnalysisService } from './batch-analysis.service';
import { LibraryManagerService } from './library-manager.service';
import { DatabaseController } from './database.controller';
import { AnalysisModule } from '../analysis/analysis.module';

/**
 * DatabaseModule - Global module providing database services
 *
 * This is a global module, so services can be injected anywhere
 * without importing the module explicitly.
 */
@Global()
@Module({
  imports: [forwardRef(() => AnalysisModule)],
  controllers: [DatabaseController],
  providers: [
    DatabaseService,
    LibraryManagerService,
    FileScannerService,
    MigrationService,
    BatchAnalysisService,
  ],
  exports: [
    DatabaseService,
    LibraryManagerService,
    FileScannerService,
    MigrationService,
    BatchAnalysisService,
  ],
})
export class DatabaseModule {}
