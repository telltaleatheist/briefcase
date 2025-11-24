import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as Database from 'better-sqlite3';

/**
 * LibraryMigrationService - Handles migration of libraries from old structure to new
 *
 * Migrates:
 * 1. Database location: from ~/Library/Application Support/clipchimp/libraries/lib_[id]/library.db
 *    to [clipsFolderPath]/.library.db
 * 2. Video paths: from absolute paths to relative paths
 */
@Injectable()
export class LibraryMigrationService {
  private readonly logger = new Logger(LibraryMigrationService.name);

  /**
   * Migrate a single library from old structure to new
   * @param libraryId - ID of the library to migrate
   * @param oldDatabasePath - Current database path (in app data)
   * @param clipsFolderPath - Clips folder path where database should be moved
   * @returns New database path
   */
  async migrateLibrary(
    libraryId: string,
    oldDatabasePath: string,
    clipsFolderPath: string,
  ): Promise<string> {
    this.logger.log(`Starting migration for library ${libraryId}`);
    this.logger.log(`  Old DB: ${oldDatabasePath}`);
    this.logger.log(`  Clips folder: ${clipsFolderPath}`);

    // Check if old database exists
    if (!fs.existsSync(oldDatabasePath)) {
      throw new Error(`Old database not found: ${oldDatabasePath}`);
    }

    // Ensure clips folder exists
    if (!fs.existsSync(clipsFolderPath)) {
      fs.mkdirSync(clipsFolderPath, { recursive: true });
    }

    const newDatabasePath = path.join(clipsFolderPath, '.library.db');

    // Check if new database already exists
    if (fs.existsSync(newDatabasePath)) {
      this.logger.warn(`Database already exists at new location: ${newDatabasePath}`);
      this.logger.warn(`Skipping migration for library ${libraryId}`);
      return newDatabasePath;
    }

    // Create backup of old database
    const backupPath = `${oldDatabasePath}.backup-${Date.now()}`;
    this.logger.log(`Creating backup: ${backupPath}`);
    fs.copyFileSync(oldDatabasePath, backupPath);

    // Copy database to new location
    this.logger.log(`Copying database to: ${newDatabasePath}`);
    fs.copyFileSync(oldDatabasePath, newDatabasePath);

    // Convert paths from absolute to relative
    this.logger.log(`Converting paths to relative...`);
    await this.convertPathsToRelative(newDatabasePath, clipsFolderPath);

    this.logger.log(`Migration complete for library ${libraryId}`);
    this.logger.log(`  New DB: ${newDatabasePath}`);
    this.logger.log(`  Backup: ${backupPath}`);

    return newDatabasePath;
  }

  /**
   * Convert all absolute paths in the database to relative paths
   * @param databasePath - Path to the database file
   * @param clipsFolderPath - Clips folder path (base path for relative paths)
   */
  private async convertPathsToRelative(
    databasePath: string,
    clipsFolderPath: string,
  ): Promise<void> {
    const db = new Database(databasePath);

    try {
      // Get all videos with their current paths
      const videos = db.prepare('SELECT id, current_path FROM videos').all() as Array<{
        id: string;
        current_path: string;
      }>;

      this.logger.log(`Found ${videos.length} videos to process`);

      let convertedCount = 0;
      let alreadyRelativeCount = 0;
      let outsideClipsFolderCount = 0;

      const updateStmt = db.prepare('UPDATE videos SET current_path = ? WHERE id = ?');

      // Process each video
      for (const video of videos) {
        const currentPath = video.current_path;

        // Skip if already relative
        if (!path.isAbsolute(currentPath)) {
          alreadyRelativeCount++;
          continue;
        }

        // Convert to relative path
        const normalizedAbsolute = path.normalize(currentPath);
        const normalizedClipsFolder = path.normalize(clipsFolderPath);

        // Check if path is inside clips folder
        if (normalizedAbsolute.startsWith(normalizedClipsFolder)) {
          const relativePath = path.relative(normalizedClipsFolder, normalizedAbsolute);
          updateStmt.run(relativePath, video.id);
          convertedCount++;

          if (convertedCount <= 5) {
            this.logger.log(`  Converted: ${currentPath} -> ${relativePath}`);
          }
        } else {
          // Path is outside clips folder - keep as absolute (shouldn't happen normally)
          this.logger.warn(`  Path outside clips folder (keeping absolute): ${currentPath}`);
          outsideClipsFolderCount++;
        }
      }

      // Also convert paths in saved_links table if it exists
      try {
        const savedLinks = db.prepare('SELECT id, download_path, thumbnail_path FROM saved_links').all() as Array<{
          id: string;
          download_path: string | null;
          thumbnail_path: string | null;
        }>;

        const updateLinkStmt = db.prepare(
          'UPDATE saved_links SET download_path = ?, thumbnail_path = ? WHERE id = ?'
        );

        for (const link of savedLinks) {
          let downloadPath = link.download_path;
          let thumbnailPath = link.thumbnail_path;

          // Convert download_path if absolute
          if (downloadPath && path.isAbsolute(downloadPath)) {
            const normalizedAbsolute = path.normalize(downloadPath);
            const normalizedClipsFolder = path.normalize(clipsFolderPath);
            if (normalizedAbsolute.startsWith(normalizedClipsFolder)) {
              downloadPath = path.relative(normalizedClipsFolder, normalizedAbsolute);
            }
          }

          // Convert thumbnail_path if absolute
          if (thumbnailPath && path.isAbsolute(thumbnailPath)) {
            const normalizedAbsolute = path.normalize(thumbnailPath);
            const normalizedClipsFolder = path.normalize(clipsFolderPath);
            if (normalizedAbsolute.startsWith(normalizedClipsFolder)) {
              thumbnailPath = path.relative(normalizedClipsFolder, normalizedAbsolute);
            }
          }

          updateLinkStmt.run(downloadPath, thumbnailPath, link.id);
        }

        this.logger.log(`Converted paths in ${savedLinks.length} saved links`);
      } catch (error) {
        // saved_links table might not exist in older databases
        this.logger.log('No saved_links table found (this is OK for older databases)');
      }

      this.logger.log(`Path conversion complete:`);
      this.logger.log(`  - Converted: ${convertedCount}`);
      this.logger.log(`  - Already relative: ${alreadyRelativeCount}`);
      this.logger.log(`  - Outside clips folder: ${outsideClipsFolderCount}`);
    } finally {
      db.close();
    }
  }

  /**
   * Check if a library needs migration
   * @param databasePath - Current database path
   * @param clipsFolderPath - Clips folder path
   * @returns True if migration is needed
   */
  needsMigration(databasePath: string, clipsFolderPath: string): boolean {
    // If database is not in clips folder, it needs migration
    const expectedPath = path.join(clipsFolderPath, '.library.db');
    return databasePath !== expectedPath;
  }
}
