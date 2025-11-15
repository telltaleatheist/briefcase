import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { DatabaseService } from './database.service';

export interface ConflictError {
  type: 'DELETED' | 'MODIFIED' | 'NOT_FOUND';
  videoId: string;
  message: string;
  lastModifiedBy?: string;
  lastModifiedAt?: string;
}

/**
 * DatabaseConflictService
 *
 * Handles conflict detection for shared database scenarios:
 * - Video deleted on Computer A, then updated on Computer B
 * - Video updated on Computer A, then deleted on Computer B
 * - Video updated on both computers simultaneously
 */
@Injectable()
export class DatabaseConflictService {
  private readonly logger = new Logger(DatabaseConflictService.name);

  constructor(private databaseService: DatabaseService) {}

  /**
   * Check if a video exists before performing an update
   * Throws ConflictException if video was deleted by another computer
   */
  ensureVideoExists(videoId: string): void {
    const video = this.databaseService.getVideoById(videoId);

    if (!video) {
      const error: ConflictError = {
        type: 'DELETED',
        videoId,
        message: `Video ${videoId} was deleted by another computer`,
      };

      this.logger.warn(`Conflict detected: ${error.message}`);
      throw new ConflictException(error);
    }
  }

  /**
   * Check if a video exists and is not deleted
   * Returns null if deleted, throws NotFoundException if never existed
   */
  getVideoOrThrowIfDeleted(videoId: string): any {
    const video = this.databaseService.getVideoById(videoId);

    if (!video) {
      const error: ConflictError = {
        type: 'NOT_FOUND',
        videoId,
        message: `Video ${videoId} does not exist (may have been deleted)`,
      };

      this.logger.warn(`Video not found: ${error.message}`);
      throw new NotFoundException(error);
    }

    return video;
  }

  /**
   * Safely update a video (checks if it still exists first)
   */
  safeUpdateVideo(videoId: string, updateFn: () => void): void {
    // Check if video exists
    this.ensureVideoExists(videoId);

    // Perform update
    updateFn();

    this.logger.log(`✓ Video ${videoId} updated successfully`);
  }

  /**
   * Safely delete a video (idempotent - won't fail if already deleted)
   */
  safeDeleteVideo(videoId: string): { deleted: boolean; alreadyDeleted: boolean } {
    const video = this.databaseService.getVideoById(videoId);

    if (!video) {
      this.logger.log(`Video ${videoId} already deleted (no-op)`);
      return { deleted: false, alreadyDeleted: true };
    }

    this.databaseService.deleteVideo(videoId);
    this.logger.log(`✓ Video ${videoId} deleted successfully`);

    return { deleted: true, alreadyDeleted: false };
  }

  /**
   * Check for conflicts before performing a batch operation
   */
  validateBatchOperation(videoIds: string[]): {
    valid: string[];
    conflicts: ConflictError[];
  } {
    const valid: string[] = [];
    const conflicts: ConflictError[] = [];

    for (const videoId of videoIds) {
      try {
        this.ensureVideoExists(videoId);
        valid.push(videoId);
      } catch (error: any) {
        if (error instanceof ConflictException) {
          conflicts.push(error.getResponse() as ConflictError);
        }
      }
    }

    return { valid, conflicts };
  }

  /**
   * Get conflict summary for UI display
   */
  getConflictSummary(conflicts: ConflictError[]): string {
    const deleted = conflicts.filter(c => c.type === 'DELETED').length;
    const notFound = conflicts.filter(c => c.type === 'NOT_FOUND').length;

    const parts: string[] = [];
    if (deleted > 0) {
      parts.push(`${deleted} video(s) were deleted by another computer`);
    }
    if (notFound > 0) {
      parts.push(`${notFound} video(s) not found`);
    }

    return parts.join(', ');
  }
}
