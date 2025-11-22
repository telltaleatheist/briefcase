import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Service for managing video thumbnails
 * Handles thumbnail storage, retrieval, and cleanup
 *
 * Thumbnails are stored in a .thumbnails folder within each library directory.
 * This allows for per-library thumbnail management and organization.
 */
@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);
  private currentLibraryPath: string | null = null;

  constructor() {
    this.logger.log('ThumbnailService created');
  }

  /**
   * Set the current library path
   * @param dbPath - Path to the database file
   */
  setLibraryPath(dbPath: string): void {
    this.currentLibraryPath = path.dirname(dbPath);
    this.ensureThumbnailsDirectory();
  }

  /**
   * Get the thumbnails directory for the current library
   * @returns Path to .thumbnails folder in the current library
   */
  private getThumbnailsDirectory(): string {
    if (!this.currentLibraryPath) {
      throw new Error('Library path not set. Call setLibraryPath() first.');
    }
    return path.join(this.currentLibraryPath, '.thumbnails');
  }

  /**
   * Ensure the thumbnails directory exists for the current library
   */
  private ensureThumbnailsDirectory(): void {
    if (!this.currentLibraryPath) {
      return;
    }

    const thumbnailsDir = this.getThumbnailsDirectory();
    if (!fs.existsSync(thumbnailsDir)) {
      fs.mkdirSync(thumbnailsDir, { recursive: true });
      this.logger.log(`Created thumbnails directory: ${thumbnailsDir}`);
    }
  }

  /**
   * Get the path where a thumbnail should be stored for a given video ID
   * @param videoId - The video database ID
   * @returns Full path to the thumbnail file
   */
  getThumbnailPath(videoId: string): string {
    const thumbnailsDir = this.getThumbnailsDirectory();
    return path.join(thumbnailsDir, `${videoId}.jpg`);
  }

  /**
   * Check if a thumbnail exists for a video
   * @param videoId - The video database ID
   * @returns true if thumbnail exists
   */
  thumbnailExists(videoId: string): boolean {
    const thumbnailPath = this.getThumbnailPath(videoId);
    return fs.existsSync(thumbnailPath);
  }

  /**
   * Delete a thumbnail file
   * @param videoId - The video database ID
   * @returns true if deleted, false if didn't exist
   */
  deleteThumbnail(videoId: string): boolean {
    const thumbnailPath = this.getThumbnailPath(videoId);

    if (fs.existsSync(thumbnailPath)) {
      try {
        fs.unlinkSync(thumbnailPath);
        this.logger.log(`Deleted thumbnail for video ${videoId}`);
        return true;
      } catch (error) {
        this.logger.error(`Failed to delete thumbnail for video ${videoId}: ${error}`);
        return false;
      }
    }

    return false;
  }

  /**
   * Delete multiple thumbnails
   * @param videoIds - Array of video database IDs
   * @returns Count of deleted thumbnails
   */
  deleteThumbnails(videoIds: string[]): number {
    let deletedCount = 0;

    for (const videoId of videoIds) {
      if (this.deleteThumbnail(videoId)) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  /**
   * Find orphaned thumbnails (thumbnails without corresponding database records)
   * @param validVideoIds - Set of valid video IDs from database
   * @returns Array of orphaned thumbnail file paths
   */
  findOrphanedThumbnails(validVideoIds: Set<string>): string[] {
    const orphaned: string[] = [];

    try {
      const thumbnailsDir = this.getThumbnailsDirectory();
      if (!fs.existsSync(thumbnailsDir)) {
        return orphaned;
      }

      const files = fs.readdirSync(thumbnailsDir);

      for (const file of files) {
        // Only check .jpg files
        if (!file.endsWith('.jpg')) {
          continue;
        }

        // Extract video ID from filename (remove .jpg extension)
        const videoId = file.replace('.jpg', '');

        // If video ID is not in the valid set, it's orphaned
        if (!validVideoIds.has(videoId)) {
          orphaned.push(path.join(thumbnailsDir, file));
        }
      }

      this.logger.log(`Found ${orphaned.length} orphaned thumbnails`);
    } catch (error) {
      this.logger.error(`Error finding orphaned thumbnails: ${error}`);
    }

    return orphaned;
  }

  /**
   * Clean up orphaned thumbnails
   * @param validVideoIds - Set of valid video IDs from database
   * @returns Count of deleted orphaned thumbnails
   */
  cleanupOrphanedThumbnails(validVideoIds: Set<string>): number {
    const orphaned = this.findOrphanedThumbnails(validVideoIds);
    let deletedCount = 0;

    for (const thumbnailPath of orphaned) {
      try {
        fs.unlinkSync(thumbnailPath);
        deletedCount++;
        this.logger.log(`Deleted orphaned thumbnail: ${thumbnailPath}`);
      } catch (error) {
        this.logger.error(`Failed to delete orphaned thumbnail ${thumbnailPath}: ${error}`);
      }
    }

    this.logger.log(`Cleaned up ${deletedCount} orphaned thumbnails`);
    return deletedCount;
  }

  /**
   * Get statistics about thumbnails
   */
  getStats(): { totalThumbnails: number; totalSizeBytes: number; directory: string } {
    let totalThumbnails = 0;
    let totalSizeBytes = 0;

    try {
      const thumbnailsDir = this.getThumbnailsDirectory();
      if (!fs.existsSync(thumbnailsDir)) {
        return {
          totalThumbnails: 0,
          totalSizeBytes: 0,
          directory: thumbnailsDir
        };
      }

      const files = fs.readdirSync(thumbnailsDir);

      for (const file of files) {
        if (file.endsWith('.jpg')) {
          totalThumbnails++;
          const filePath = path.join(thumbnailsDir, file);
          const stats = fs.statSync(filePath);
          totalSizeBytes += stats.size;
        }
      }
    } catch (error) {
      this.logger.error(`Error getting thumbnail stats: ${error}`);
    }

    return {
      totalThumbnails,
      totalSizeBytes,
      directory: this.getThumbnailsDirectory()
    };
  }
}
