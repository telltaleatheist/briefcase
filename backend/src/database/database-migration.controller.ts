import {
  Controller,
  Post,
  Get,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DatabaseMigrationService, MigrationOptions, MigrationProgress } from './database-migration.service';
import { PathMappingService } from './path-mapping.service';
import { SharedDatabaseService } from './shared-database.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Controller('database/migration')
export class DatabaseMigrationController {
  private readonly logger = new Logger(DatabaseMigrationController.name);
  private migrationInProgress: boolean = false;

  constructor(
    private migrationService: DatabaseMigrationService,
    private pathMappingService: PathMappingService,
    private sharedDatabaseService: SharedDatabaseService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Check if path mapping is configured
   */
  @Get('status')
  async getMigrationStatus() {
    return {
      isConfigured: this.pathMappingService.isConfigured(),
      isSharedMode: this.sharedDatabaseService.isShared(),
      migrationInProgress: this.migrationInProgress,
      config: this.pathMappingService.isConfigured()
        ? this.pathMappingService.loadConfig()
        : null,
    };
  }

  /**
   * Start database migration
   *
   * Body:
   * {
   *   computerName: "Mac Studio",
   *   nasRoot: "/Volumes/Callisto",
   *   clipsFolder: "/Volumes/Callisto/clips",
   *   downloadsFolder: "/Volumes/Callisto/downloads",
   *   librariesFolder: "/Volumes/Callisto/libraries",
   *   moveClipsTo: "/Volumes/Callisto/new-clips", // optional
   *   dryRun: true // optional
   * }
   */
  @Post('migrate')
  async migrate(@Body() body: MigrationOptions) {
    if (this.migrationInProgress) {
      throw new HttpException(
        'Migration already in progress',
        HttpStatus.CONFLICT
      );
    }

    try {
      this.migrationInProgress = true;
      this.logger.log('=== Starting Migration ===');

      const result = await this.migrationService.migrate(
        body,
        (progress: MigrationProgress) => {
          // Emit progress events to frontend
          this.eventEmitter.emit('migration.progress', progress);
        }
      );

      this.logger.log('=== Migration Complete ===');
      this.migrationInProgress = false;

      // If successful and not dry run, initialize shared mode
      if (result.success && !body.dryRun) {
        this.logger.log('Initializing shared database mode...');
        await this.sharedDatabaseService.initializeShared();
        this.logger.log('✓ Shared database mode activated');
      }

      return {
        success: true,
        result,
        message: body.dryRun
          ? 'Dry run completed successfully. No changes were made.'
          : 'Migration completed successfully. Database is now in shared mode.',
      };

    } catch (error: any) {
      this.migrationInProgress = false;
      this.logger.error(`Migration failed: ${error.message}`, error.stack);

      throw new HttpException(
        {
          success: false,
          message: `Migration failed: ${error.message}`,
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Run migration in dry-run mode (preview changes without making them)
   */
  @Post('preview')
  async previewMigration(@Body() body: MigrationOptions) {
    return this.migrate({
      ...body,
      dryRun: true,
    });
  }

  /**
   * Configure path mapping without running full migration
   * (For setting up additional computers that will connect to existing shared database)
   */
  @Post('configure')
  async configurePaths(@Body() body: {
    computerName: string;
    nasRoot: string;
    clipsFolder: string;
    downloadsFolder?: string;
    librariesFolder?: string;
  }) {
    try {
      this.logger.log(`Configuring path mapping for: ${body.computerName}`);

      const config = PathMappingService.createConfig(body);
      this.pathMappingService.saveConfig(config);

      // Initialize shared mode with new config
      await this.sharedDatabaseService.initializeShared();

      return {
        success: true,
        config,
        message: 'Path mapping configured successfully',
      };

    } catch (error: any) {
      throw new HttpException(
        {
          success: false,
          message: `Failed to configure paths: ${error.message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Restore database from backup
   */
  @Post('restore')
  async restoreFromBackup(@Body() body: { backupPath: string }) {
    try {
      this.logger.log(`Restoring from backup: ${body.backupPath}`);

      await this.migrationService.restoreFromBackup(body.backupPath);

      return {
        success: true,
        message: 'Database restored successfully from backup',
      };

    } catch (error: any) {
      throw new HttpException(
        {
          success: false,
          message: `Failed to restore backup: ${error.message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Test path translation
   */
  @Post('test-path')
  async testPath(@Body() body: { path: string; direction: 'toRelative' | 'toAbsolute' }) {
    try {
      if (!this.pathMappingService.isConfigured()) {
        throw new Error('Path mapping not configured');
      }

      const result = body.direction === 'toRelative'
        ? this.pathMappingService.toRelativePath(body.path)
        : this.pathMappingService.toAbsolutePath(body.path);

      const exists = body.direction === 'toAbsolute'
        ? this.pathMappingService.exists(body.path)
        : null;

      return {
        success: true,
        input: body.path,
        output: result,
        exists,
      };

    } catch (error: any) {
      return {
        success: false,
        input: body.path,
        error: error.message,
      };
    }
  }

  /**
   * Get migration instructions/help
   */
  @Get('instructions')
  getInstructions() {
    return {
      title: 'Database Migration to Shared Mode',
      description: 'Migrate your database to support multiple computers sharing the same library via NAS',
      steps: [
        {
          step: 1,
          title: 'Backup',
          description: 'The migration will automatically create a backup of your current database',
        },
        {
          step: 2,
          title: 'Configure Paths',
          description: 'Provide information about how this computer accesses the NAS',
          fields: [
            { name: 'computerName', description: 'A friendly name for this computer (e.g., "Mac Studio")' },
            { name: 'nasRoot', description: 'Where the NAS is mounted (e.g., "/Volumes/Callisto")' },
            { name: 'clipsFolder', description: 'Where your video clips are stored' },
          ],
        },
        {
          step: 3,
          title: 'Dry Run (Optional)',
          description: 'Preview the migration without making any changes',
        },
        {
          step: 4,
          title: 'Run Migration',
          description: 'Convert database paths and enable shared mode',
        },
        {
          step: 5,
          title: 'Setup Other Computers',
          description: 'On each additional computer, use "Configure Paths" to connect to the shared database',
        },
      ],
      warnings: [
        'Ensure all video files are accessible from the NAS before migrating',
        'Close the application on all other computers during initial migration',
        'The migration can take several minutes for large libraries (5000+ videos)',
      ],
    };
  }
}
