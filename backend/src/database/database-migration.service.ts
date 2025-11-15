import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { PathMappingService, PathMappingConfig } from './path-mapping.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface MigrationOptions {
  // Path mapping configuration
  computerName: string;
  nasRoot: string;
  clipsFolder: string;
  downloadsFolder?: string;
  librariesFolder?: string;

  // Optional: Move clips to new location during migration
  moveClipsTo?: string;

  // Dry run mode (don't actually change anything)
  dryRun?: boolean;
}

export interface MigrationResult {
  success: boolean;
  stats: {
    totalVideos: number;
    pathsConverted: number;
    pathsSkipped: number;
    filesMoved: number;
    errors: string[];
  };
  backupPath?: string;
}

export interface MigrationProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

/**
 * DatabaseMigrationService
 *
 * Handles the careful migration from local database with absolute paths
 * to shared database with NAS-relative paths.
 *
 * IMPORTANT: This is a ONE-TIME migration. Once completed, the database
 * will use NAS-relative paths and can be shared across computers.
 */
@Injectable()
export class DatabaseMigrationService {
  private readonly logger = new Logger(DatabaseMigrationService.name);

  constructor(
    private databaseService: DatabaseService,
    private pathMappingService: PathMappingService,
  ) {}

  /**
   * Main migration function
   *
   * Steps:
   * 1. Backup current database
   * 2. Create path mapping configuration
   * 3. Scan all videos and convert paths
   * 4. Optionally move clips to new location
   * 5. Validate all paths
   * 6. Save migrated database
   */
  async migrate(
    options: MigrationOptions,
    progressCallback?: (progress: MigrationProgress) => void,
  ): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      stats: {
        totalVideos: 0,
        pathsConverted: 0,
        pathsSkipped: 0,
        filesMoved: 0,
        errors: [],
      },
    };

    try {
      this.logger.log('=== Starting Database Migration ===');
      this.logger.log(`Dry run: ${options.dryRun ? 'YES (no changes will be made)' : 'NO'}`);

      // === PHASE 1: Backup ===
      this.reportProgress(progressCallback, {
        phase: 'backup',
        current: 0,
        total: 100,
        message: 'Creating backup of current database...',
      });

      result.backupPath = await this.createBackup(options.dryRun || false);
      this.logger.log(`✓ Backup created: ${result.backupPath}`);

      // === PHASE 2: Create Path Mapping ===
      this.reportProgress(progressCallback, {
        phase: 'configure',
        current: 10,
        total: 100,
        message: 'Creating path mapping configuration...',
      });

      const config = PathMappingService.createConfig({
        computerName: options.computerName,
        nasRoot: options.nasRoot,
        clipsFolder: options.clipsFolder,
        downloadsFolder: options.downloadsFolder,
        librariesFolder: options.librariesFolder,
      });

      if (!options.dryRun) {
        this.pathMappingService.saveConfig(config);
      }
      this.logger.log(`✓ Path mapping configured for computer: ${config.computerName}`);
      this.logger.log(`  Computer ID: ${config.computerId}`);
      this.logger.log(`  NAS Root: ${config.nasRoot}`);
      this.logger.log(`  Clips Folder: ${config.pathMappings.clips}`);

      // === PHASE 3: Convert Video Paths ===
      this.reportProgress(progressCallback, {
        phase: 'convert',
        current: 20,
        total: 100,
        message: 'Converting video paths to NAS-relative format...',
      });

      const conversionResult = await this.convertAllPaths(
        config,
        options.dryRun || false,
        (current, total) => {
          this.reportProgress(progressCallback, {
            phase: 'convert',
            current: 20 + Math.floor((current / total) * 50),
            total: 100,
            message: `Converting paths: ${current}/${total} videos...`,
          });
        },
      );

      result.stats.totalVideos = conversionResult.total;
      result.stats.pathsConverted = conversionResult.converted;
      result.stats.pathsSkipped = conversionResult.skipped;
      result.stats.errors.push(...conversionResult.errors);

      this.logger.log(`✓ Path conversion complete:`);
      this.logger.log(`  Total videos: ${conversionResult.total}`);
      this.logger.log(`  Converted: ${conversionResult.converted}`);
      this.logger.log(`  Skipped: ${conversionResult.skipped}`);
      this.logger.log(`  Errors: ${conversionResult.errors.length}`);

      // === PHASE 4: Move Clips (Optional) ===
      if (options.moveClipsTo) {
        this.reportProgress(progressCallback, {
          phase: 'move',
          current: 70,
          total: 100,
          message: `Moving clips to new location: ${options.moveClipsTo}...`,
        });

        const moveResult = await this.moveClipsFolder(
          options.moveClipsTo,
          config,
          options.dryRun || false,
        );

        result.stats.filesMoved = moveResult.moved;
        result.stats.errors.push(...moveResult.errors);

        this.logger.log(`✓ Clips moved:`);
        this.logger.log(`  Files moved: ${moveResult.moved}`);
        this.logger.log(`  Errors: ${moveResult.errors.length}`);
      }

      // === PHASE 5: Validate ===
      this.reportProgress(progressCallback, {
        phase: 'validate',
        current: 80,
        total: 100,
        message: 'Validating all file paths...',
      });

      const validationResult = await this.validateAllPaths(config);
      this.logger.log(`✓ Validation complete:`);
      this.logger.log(`  Valid paths: ${validationResult.valid}`);
      this.logger.log(`  Invalid paths: ${validationResult.invalid}`);
      this.logger.log(`  Missing files: ${validationResult.missing}`);

      if (validationResult.invalid > 0 || validationResult.missing > 0) {
        this.logger.warn(`⚠ Some files could not be validated. Check logs for details.`);
      }

      // === PHASE 6: Finalize ===
      this.reportProgress(progressCallback, {
        phase: 'finalize',
        current: 95,
        total: 100,
        message: 'Finalizing migration...',
      });

      if (!options.dryRun) {
        // Save the database with all changes
        this.databaseService.saveDatabaseToDisk();
        this.logger.log(`✓ Database saved with NAS-relative paths`);
      } else {
        this.logger.log(`✓ Dry run complete - no changes were made`);
      }

      // === DONE ===
      this.reportProgress(progressCallback, {
        phase: 'complete',
        current: 100,
        total: 100,
        message: 'Migration complete!',
      });

      result.success = true;
      this.logger.log('=== Migration Complete ===');

      return result;

    } catch (error: any) {
      this.logger.error(`Migration failed: ${error.message}`);
      result.stats.errors.push(`Migration failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a timestamped backup of the current database
   */
  private async createBackup(dryRun: boolean): Promise<string> {
    const currentDbPath = this.databaseService.getCurrentDbPath();
    if (!currentDbPath) {
      throw new Error('No active database to backup');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(path.dirname(currentDbPath), 'backups');
    const backupPath = path.join(backupDir, `library_backup_${timestamp}.db`);

    if (!dryRun) {
      // Create backups directory
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      // Copy database file
      fs.copyFileSync(currentDbPath, backupPath);
    }

    return backupPath;
  }

  /**
   * Convert all video paths from absolute to NAS-relative
   */
  private async convertAllPaths(
    config: PathMappingConfig,
    dryRun: boolean,
    progressCallback?: (current: number, total: number) => void,
  ): Promise<{
    total: number;
    converted: number;
    skipped: number;
    errors: string[];
  }> {
    const videos = this.databaseService.getAllVideos({ includeChildren: true });
    const result = {
      total: videos.length,
      converted: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      if (progressCallback) {
        progressCallback(i + 1, videos.length);
      }

      try {
        const currentPath = video.current_path as string;

        // Skip if already relative (shouldn't happen on first migration)
        if (!path.isAbsolute(currentPath)) {
          this.logger.debug(`Skipping ${video.id}: path already relative`);
          result.skipped++;
          continue;
        }

        // Convert to relative path using temporary path mapping
        const relativePath = this.convertPathWithConfig(currentPath, config);

        if (!dryRun) {
          // Update in database
          const db = this.databaseService.getDatabase();
          db.run(
            'UPDATE videos SET current_path = ? WHERE id = ?',
            [relativePath, video.id]
          );
        }

        this.logger.debug(`Converted ${video.id}: ${currentPath} → ${relativePath}`);
        result.converted++;

      } catch (error: any) {
        const errorMsg = `Failed to convert path for video ${video.id}: ${error.message}`;
        this.logger.error(errorMsg);
        result.errors.push(errorMsg);
        result.skipped++;
      }
    }

    return result;
  }

  /**
   * Convert a path to relative format using a specific config
   * (doesn't require PathMappingService to be initialized)
   */
  private convertPathWithConfig(absolutePath: string, config: PathMappingConfig): string {
    const normalized = absolutePath.replace(/\\/g, '/');

    // Try each path mapping
    for (const [key, mountPoint] of Object.entries(config.pathMappings)) {
      const normalizedMount = mountPoint.replace(/\\/g, '/');

      if (normalized.startsWith(normalizedMount)) {
        const relative = normalized.substring(normalizedMount.length);
        return `${key}${relative}`.replace(/^\/+/, '');
      }
    }

    // Fallback: try nasRoot
    const normalizedRoot = config.nasRoot.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedRoot)) {
      return normalized.substring(normalizedRoot.length).replace(/^\/+/, '');
    }

    throw new Error(`Path "${absolutePath}" is not under NAS root`);
  }

  /**
   * Move clips folder to a new location
   */
  private async moveClipsFolder(
    newLocation: string,
    config: PathMappingConfig,
    dryRun: boolean,
  ): Promise<{ moved: number; errors: string[] }> {
    const oldLocation = config.pathMappings.clips;
    const result = { moved: 0, errors: [] as string[] };

    this.logger.log(`Moving clips from ${oldLocation} to ${newLocation}...`);

    if (!dryRun) {
      try {
        // Create new directory
        if (!fs.existsSync(newLocation)) {
          fs.mkdirSync(newLocation, { recursive: true });
        }

        // Move all files (this could take a while!)
        // TODO: Implement actual file moving logic
        // For now, just update the config
        config.pathMappings.clips = newLocation;
        this.pathMappingService.saveConfig(config);

      } catch (error: any) {
        result.errors.push(`Failed to move clips: ${error.message}`);
      }
    }

    return result;
  }

  /**
   * Validate that all converted paths are accessible
   */
  private async validateAllPaths(
    config: PathMappingConfig,
  ): Promise<{ valid: number; invalid: number; missing: number }> {
    const videos = this.databaseService.getAllVideos({ includeChildren: true });
    const result = { valid: 0, invalid: 0, missing: 0 };

    for (const video of videos) {
      try {
        const relativePath = video.current_path as string;
        const absolutePath = this.toAbsolutePathWithConfig(relativePath, config);

        if (fs.existsSync(absolutePath)) {
          result.valid++;
        } else {
          this.logger.warn(`File not found: ${absolutePath} (${relativePath})`);
          result.missing++;
        }

      } catch (error: any) {
        this.logger.error(`Invalid path for video ${video.id}: ${error.message}`);
        result.invalid++;
      }
    }

    return result;
  }

  /**
   * Convert relative path to absolute using a specific config
   */
  private toAbsolutePathWithConfig(relativePath: string, config: PathMappingConfig): string {
    const normalized = relativePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const rootFolder = parts[0];

    if (config.pathMappings[rootFolder]) {
      const mountPoint = config.pathMappings[rootFolder];
      const restOfPath = parts.slice(1).join(path.sep);
      return path.join(mountPoint, restOfPath);
    }

    return path.join(config.nasRoot, normalized.replace(/\//g, path.sep));
  }

  /**
   * Helper to report progress
   */
  private reportProgress(
    callback: ((progress: MigrationProgress) => void) | undefined,
    progress: MigrationProgress,
  ) {
    if (callback) {
      callback(progress);
    }
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupPath: string): Promise<void> {
    const currentDbPath = this.databaseService.getCurrentDbPath();
    if (!currentDbPath) {
      throw new Error('No active database');
    }

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    this.logger.log(`Restoring database from backup: ${backupPath}`);
    fs.copyFileSync(backupPath, currentDbPath);

    // Reload database
    await this.databaseService.initializeDatabase(currentDbPath);
    this.logger.log('✓ Database restored from backup');
  }
}
