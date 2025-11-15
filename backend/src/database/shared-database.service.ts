import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { PathMappingService } from './path-mapping.service';
import { DatabaseConflictService } from './database-conflict.service';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

/**
 * SharedDatabaseService
 *
 * Extends DatabaseService with multi-computer support:
 * - Pull-before-push: Always reload latest changes before saving
 * - Path translation: Converts between NAS-relative and absolute paths
 * - Conflict detection: Handles delete vs update scenarios
 * - File locking: Prevents simultaneous writes from multiple computers
 *
 * Usage pattern:
 *   await sharedDb.withLock(async () => {
 *     // Your database operations here
 *     db.insertTag(...);
 *     db.updateVideo(...);
 *   });
 */
@Injectable()
export class SharedDatabaseService extends DatabaseService {
  protected readonly sharedLogger = new Logger(SharedDatabaseService.name);
  private masterDbPath: string;
  private isSharedMode: boolean = false;

  constructor(
    private pathMapper: PathMappingService,
    private conflictService: DatabaseConflictService,
  ) {
    super();
  }

  /**
   * Initialize in shared mode (database on NAS)
   */
  async initializeShared(): Promise<void> {
    if (!this.pathMapper.isConfigured()) {
      throw new Error(
        'Path mapping not configured. Please run setup wizard or migration first.'
      );
    }

    // Get master database path from path mapping
    this.masterDbPath = this.pathMapper.toAbsolutePath('libraries/master.db');
    this.isSharedMode = true;

    this.sharedLogger.log(`Initializing shared database at: ${this.masterDbPath}`);

    // Initialize database (will load from NAS if exists)
    await this.initializeDatabase(this.masterDbPath);

    this.sharedLogger.log('✓ Shared database initialized');
  }

  /**
   * Check if running in shared mode
   */
  isShared(): boolean {
    return this.isSharedMode;
  }

  /**
   * Execute database operations with pull-before-push pattern
   *
   * Pattern:
   * 1. LOCK - Acquire exclusive lock
   * 2. PULL - Reload latest changes from NAS
   * 3. EXECUTE - Run your database operations
   * 4. PUSH - Save changes back to NAS
   * 5. UNLOCK - Release lock
   *
   * Example:
   *   await sharedDb.withLock(async (db) => {
   *     db.insertTag({ videoId: 'abc', tagName: 'cooking' });
   *   });
   */
  async withLock<T>(
    operation: (db: DatabaseService) => Promise<T> | T,
    operationName: string = 'database_operation'
  ): Promise<T> {
    if (!this.isSharedMode) {
      // Not in shared mode, just execute directly
      return await Promise.resolve(operation(this));
    }

    let release: (() => Promise<void>) | null = null;
    const startTime = Date.now();

    try {
      // === STEP 1: LOCK ===
      this.sharedLogger.log(`[${operationName}] 🔒 Acquiring lock...`);

      release = await lockfile.lock(this.masterDbPath, {
        retries: {
          retries: 10,
          minTimeout: 100,
          maxTimeout: 2000,
          factor: 2,
        },
        stale: 30000, // 30 seconds
        realpath: false,
        fs: {
          ...fs,
        } as any,
      });

      const lockTime = Date.now() - startTime;
      this.sharedLogger.log(`[${operationName}] ✓ Lock acquired (${lockTime}ms)`);

      // === STEP 2: PULL ===
      this.sharedLogger.log(`[${operationName}] 📥 Pulling latest changes from NAS...`);
      await this.pullFromNAS();

      const pullTime = Date.now() - startTime - lockTime;
      this.sharedLogger.log(`[${operationName}] ✓ Pulled (${pullTime}ms)`);

      // === STEP 3: EXECUTE ===
      this.sharedLogger.log(`[${operationName}] ⚙️  Executing operation...`);
      const result = await Promise.resolve(operation(this));

      const executeTime = Date.now() - startTime - lockTime - pullTime;
      this.sharedLogger.log(`[${operationName}] ✓ Executed (${executeTime}ms)`);

      // === STEP 4: PUSH ===
      this.sharedLogger.log(`[${operationName}] 📤 Pushing changes to NAS...`);
      await this.pushToNAS();

      const pushTime = Date.now() - startTime - lockTime - pullTime - executeTime;
      this.sharedLogger.log(`[${operationName}] ✓ Pushed (${pushTime}ms)`);

      // === SUCCESS ===
      const totalTime = Date.now() - startTime;
      this.sharedLogger.log(
        `[${operationName}] ✅ Complete (${totalTime}ms total: ` +
        `lock=${lockTime}ms, pull=${pullTime}ms, execute=${executeTime}ms, push=${pushTime}ms)`
      );

      return result;

    } catch (error: any) {
      this.sharedLogger.error(`[${operationName}] ❌ Failed: ${error.message}`);
      throw error;

    } finally {
      // === STEP 5: UNLOCK ===
      if (release) {
        await release();
        this.sharedLogger.log(`[${operationName}] 🔓 Lock released`);
      }
    }
  }

  /**
   * Pull latest changes from NAS (reload database)
   */
  private async pullFromNAS(): Promise<void> {
    if (!fs.existsSync(this.masterDbPath)) {
      this.sharedLogger.warn('Master database does not exist on NAS yet');
      return;
    }

    const buffer = fs.readFileSync(this.masterDbPath);
    const SQL = await import('sql.js');
    const sqlJs = await SQL.default();

    // Access protected database property
    const db = new sqlJs.Database(buffer);
    this.setDatabase(db);
  }

  /**
   * Push changes to NAS (save database atomically)
   */
  private async pushToNAS(): Promise<void> {
    const db = this.getDatabase();
    if (!db) {
      throw new Error('Database not initialized');
    }

    // Export database to buffer
    const data = db.export();
    const buffer = Buffer.from(data);

    // Write to temp file first (atomic write)
    const tempPath = `${this.masterDbPath}.tmp`;
    fs.writeFileSync(tempPath, buffer);

    // Atomic rename (this is instant and crash-safe)
    fs.renameSync(tempPath, this.masterDbPath);
  }

  /**
   * Helper to set database (internal use)
   */
  private setDatabase(db: any): void {
    // @ts-ignore - Access private property
    this.db = db;
  }

  /**
   * Override insertVideo to use path translation
   */
  insertVideo(video: {
    id: string;
    filename: string;
    currentPath: string; // Absolute path
    fileHash: string;
    uploadDate?: string;
    durationSeconds?: number;
    fileSizeBytes?: number;
    sourceUrl?: string;
    mediaType?: string;
    fileExtension?: string;
    downloadDate?: string;
  }): void {
    // Convert absolute path to NAS-relative if in shared mode
    const pathToStore = this.isSharedMode
      ? this.pathMapper.toRelativePath(video.currentPath)
      : video.currentPath;

    super.insertVideo({
      ...video,
      currentPath: pathToStore,
    });
  }

  /**
   * Override getVideoById to use path translation
   */
  getVideoById(id: string): any {
    const video = super.getVideoById(id);

    if (video && this.isSharedMode) {
      // Convert NAS-relative path to absolute path
      video.current_path = this.pathMapper.toAbsolutePath(video.current_path as string);

      // Check if file actually exists on this computer
      video.is_linked = this.pathMapper.exists(video.current_path) ? 1 : 0;
    }

    return video;
  }

  /**
   * Override getAllVideos to use path translation
   */
  getAllVideos(options?: any): any[] {
    const videos = super.getAllVideos(options);

    if (this.isSharedMode) {
      for (const video of videos) {
        // Convert NAS-relative path to absolute path
        video.current_path = this.pathMapper.toAbsolutePath(video.current_path as string);

        // Check if file actually exists on this computer
        video.is_linked = this.pathMapper.exists(video.current_path) ? 1 : 0;
      }
    }

    return videos;
  }

  /**
   * Override updateVideoPath to use path translation
   */
  updateVideoPath(id: string, newPath: string, uploadDate?: string): void {
    // Convert absolute path to NAS-relative if in shared mode
    const pathToStore = this.isSharedMode
      ? this.pathMapper.toRelativePath(newPath)
      : newPath;

    super.updateVideoPath(id, pathToStore, uploadDate);
  }

  /**
   * Safe update that checks for conflicts
   */
  async safeUpdateVideo(
    videoId: string,
    updateFn: () => void,
    operationName: string = 'update_video'
  ): Promise<void> {
    await this.withLock(async () => {
      // Check if video still exists (conflict detection)
      this.conflictService.ensureVideoExists(videoId);

      // Perform update
      updateFn();
    }, operationName);
  }

  /**
   * Safe delete that is idempotent
   */
  async safeDeleteVideo(
    videoId: string,
    operationName: string = 'delete_video'
  ): Promise<{ deleted: boolean; alreadyDeleted: boolean }> {
    return await this.withLock(async () => {
      return this.conflictService.safeDeleteVideo(videoId);
    }, operationName);
  }

  /**
   * Batch operation with conflict detection
   */
  async safeBatchUpdate(
    videoIds: string[],
    updateFn: (validIds: string[]) => void,
    operationName: string = 'batch_update'
  ): Promise<{ successful: string[]; conflicts: any[] }> {
    return await this.withLock(async () => {
      // Validate all video IDs first
      const validation = this.conflictService.validateBatchOperation(videoIds);

      if (validation.valid.length > 0) {
        // Update only valid videos
        updateFn(validation.valid);
      }

      return {
        successful: validation.valid,
        conflicts: validation.conflicts,
      };
    }, operationName);
  }
}
