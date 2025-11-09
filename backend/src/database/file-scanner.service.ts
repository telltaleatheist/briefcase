import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { LibraryManagerService } from './library-manager.service';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * FileScannerService - Scans clips folder and maintains video catalog in database
 *
 * Responsibilities:
 * - Recursively scan /Volumes/Callisto/clips/ for video files
 * - Hash video files for identification
 * - Match videos to existing database entries (by filename or hash)
 * - Detect moved/renamed videos and update paths
 * - Identify new videos that need analysis
 * - Mark missing videos as unlinked
 */
@Injectable()
export class FileScannerService {
  private readonly logger = new Logger(FileScannerService.name);
  // NO hardcoded paths - clips folder must come from active library
  private readonly VIDEO_EXTENSIONS = ['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'];

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(forwardRef(() => LibraryManagerService))
    private readonly libraryManagerService: LibraryManagerService,
  ) {}

  /**
   * Calculate the Sunday of the current week for a given date
   * Format: YYYY-MM-DD (e.g., "2025-09-02")
   */
  private getWeekStartDate(date: Date = new Date()): string {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const sundayDate = new Date(date);
    sundayDate.setDate(date.getDate() - dayOfWeek); // Subtract days to get to Sunday

    const year = sundayDate.getFullYear();
    const month = String(sundayDate.getMonth() + 1).padStart(2, '0');
    const day = String(sundayDate.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  /**
   * Scan entire clips folder and synchronize with database
   * Returns statistics about the scan
   * @param clipsFolder - Optional clips folder path (if not provided, uses active library's clips folder)
   */
  async scanClipsFolder(clipsFolder?: string): Promise<ScanResult> {
    // Get clips folder from parameter or active library
    let clipsRoot = clipsFolder;

    if (!clipsRoot) {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new Error('No active library found. Cannot scan without a clips folder path.');
      }
      clipsRoot = activeLibrary.clipsFolderPath;
    }

    this.logger.log(`Starting full clips folder scan: ${clipsRoot}`);
    const startTime = Date.now();

    const result: ScanResult = {
      totalFiles: 0,
      newVideos: 0,
      updatedPaths: 0,
      markedMissing: 0,
      errorCount: 0,
      duration: 0,
      newVideoIds: [],
      errors: [],
    };

    try {
      // Step 1: Scan filesystem and collect all video files
      const videoFiles = await this.findAllVideoFiles(clipsRoot);
      result.totalFiles = videoFiles.length;
      this.logger.log(`Found ${videoFiles.length} video files in clips folder`);

      // Step 2: Build a set of found file paths for quick lookup
      const foundPaths = new Set(videoFiles.map((f) => f.fullPath));
      const foundHashes = new Map<string, VideoFileInfo>(); // hash -> file info

      // Step 3: Hash all found files (this will take time)
      this.logger.log('Computing file hashes...');
      for (const file of videoFiles) {
        try {
          const hash = await this.databaseService.hashFile(file.fullPath);
          file.hash = hash;
          foundHashes.set(hash, file);
        } catch (error) {
          const err = error as Error;
          this.logger.error(`Failed to hash ${file.fullPath}: ${err.message}`);
          result.errors.push(`Hash failed: ${file.filename} - ${err.message}`);
          result.errorCount++;
        }
      }

      // Step 4: Check all videos in database and verify they still exist
      const dbVideos = this.databaseService.getAllVideos() as Array<{
        id: string;
        filename: string;
        file_hash: string;
        current_path: string;
        date_folder: string | null;
      }>;
      this.logger.log(`Checking ${dbVideos.length} database entries...`);

      for (const dbVideo of dbVideos) {
        const dbPath = dbVideo.current_path;
        const dbHash = dbVideo.file_hash;

        // Case 1: Video still exists at same path
        if (foundPaths.has(dbPath)) {
          // Update last_verified timestamp
          this.databaseService.updateVideoPath(dbVideo.id, dbPath, dbVideo.date_folder || undefined);
          continue;
        }

        // Case 2: Video not at expected path - try to find by hash
        if (dbHash && foundHashes.has(dbHash)) {
          const newLocation = foundHashes.get(dbHash)!;
          this.logger.log(
            `Video moved: "${dbVideo.filename}" from ${dbVideo.date_folder || 'unknown'} to ${newLocation.dateFolder}`,
          );

          this.databaseService.updateVideoPath(
            dbVideo.id,
            newLocation.fullPath,
            newLocation.dateFolder,
          );
          result.updatedPaths++;

          // Remove from found hashes so we don't process it again as "new"
          foundHashes.delete(dbHash);
          continue;
        }

        // Case 3: Video not found anywhere - mark as missing
        this.logger.warn(`Video not found: ${dbVideo.filename} (was at ${dbPath})`);
        this.databaseService.markVideoUnlinked(dbVideo.id);
        result.markedMissing++;
      }

      // Step 5: Add new videos that aren't in database yet
      const dbHashes = new Set(dbVideos.map((v) => v.file_hash).filter(Boolean));

      for (const file of videoFiles) {
        if (!file.hash) continue; // Skip files we couldn't hash

        // If this hash isn't in database, it's a new video
        if (!dbHashes.has(file.hash)) {
          const videoId = uuidv4();

          try {
            const stats = fs.statSync(file.fullPath);

            this.databaseService.insertVideo({
              id: videoId,
              filename: file.filename,
              fileHash: file.hash,
              currentPath: file.fullPath,
              dateFolder: file.dateFolder,
              fileSizeBytes: stats.size,
              // Duration will be populated later when analyzing
            });

            result.newVideos++;
            result.newVideoIds.push(videoId);
            this.logger.log(`New video added: ${file.filename}`);
          } catch (error) {
            const err = error as Error;
            this.logger.error(`Failed to add video ${file.filename}: ${err.message}`);
            result.errors.push(`Insert failed: ${file.filename} - ${err.message}`);
            result.errorCount++;
          }
        }
      }

      result.duration = Date.now() - startTime;
      this.logger.log(
        `Scan complete in ${(result.duration / 1000).toFixed(1)}s: ` +
          `${result.totalFiles} files, ${result.newVideos} new, ` +
          `${result.updatedPaths} moved, ${result.markedMissing} missing`,
      );

      return result;
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Scan failed: ${err.message}`, err.stack);
      throw error;
    }
  }

  /**
   * Get list of videos in clips folder that are not yet in database
   * @param clipsFolder - Optional clips folder path (if not provided, uses active library's clips folder)
   */
  async getUnimportedVideos(clipsFolder?: string): Promise<VideoFileInfo[]> {
    // Get clips folder from parameter or active library
    let clipsRoot = clipsFolder;

    if (!clipsRoot) {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new Error('No active library found. Cannot check for unimported videos without a clips folder path.');
      }
      clipsRoot = activeLibrary.clipsFolderPath;
    }

    this.logger.log(`Checking for unimported videos in: ${clipsRoot}`);

    // Get all video files from filesystem
    const allFiles = await this.findAllVideoFiles(clipsRoot);

    // Get all videos already in database
    const dbVideos = this.databaseService.getAllVideos() as Array<{
      current_path: string;
      file_hash: string;
    }>;

    // Create sets for fast lookup
    const dbPaths = new Set(dbVideos.map(v => v.current_path));
    const dbHashes = new Set(dbVideos.map(v => v.file_hash).filter(Boolean));

    // Filter to only unimported videos
    const unimported: VideoFileInfo[] = [];

    for (const file of allFiles) {
      // Check if path already in database
      if (dbPaths.has(file.fullPath)) {
        continue;
      }

      // Hash the file to check if it's in DB under different path
      try {
        const hash = await this.databaseService.hashFile(file.fullPath);
        if (!dbHashes.has(hash)) {
          // Not in database at all - this is a new video
          file.hash = hash;
          unimported.push(file);
        }
      } catch (error) {
        this.logger.error(`Failed to hash ${file.fullPath}: ${error}`);
      }
    }

    this.logger.log(`Found ${unimported.length} unimported videos`);
    return unimported;
  }

  /**
   * Recursively find all video files in clips folder
   * @param clipsRoot - Root directory to scan
   */
  private async findAllVideoFiles(clipsRoot: string): Promise<VideoFileInfo[]> {
    const results: VideoFileInfo[] = [];

    const scanDirectory = async (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Recursively scan subdirectories
            await scanDirectory(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();

            if (this.VIDEO_EXTENSIONS.includes(ext)) {
              // First, try to extract date from filename (format: YYYY-MM-DD Title.ext)
              const filenameDateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})\s/);
              let dateFolder: string | undefined;

              if (filenameDateMatch) {
                dateFolder = filenameDateMatch[1];
              } else {
                // Fallback: Extract date folder from path
                // e.g., /Volumes/Callisto/clips/2021-08-08/video.mov -> "2021-08-08"
                const relativePath = fullPath.replace(clipsRoot, '');
                const pathParts = relativePath.split(path.sep).filter(Boolean);
                dateFolder = pathParts.length > 1 ? pathParts[0] : undefined;
              }

              results.push({
                filename: entry.name,
                fullPath,
                dateFolder,
              });
            }
          }
        }
      } catch (error) {
        const err = error as Error;
        this.logger.error(`Error scanning directory ${dir}: ${err.message}`);
      }
    };

    await scanDirectory(clipsRoot);
    return results;
  }

  /**
   * Get videos that need analysis (have no transcript or analysis)
   */
  getNeedsAnalysis(): NeedsAnalysisVideo[] {
    const db = this.databaseService.getDatabase();

    const stmt = db.prepare(`
      SELECT
        v.id,
        v.filename,
        v.current_path,
        v.date_folder,
        v.duration_seconds,
        CASE WHEN t.video_id IS NULL THEN 1 ELSE 0 END as needs_transcript,
        CASE WHEN a.video_id IS NULL THEN 1 ELSE 0 END as needs_analysis
      FROM videos v
      LEFT JOIN transcripts t ON v.id = t.video_id
      LEFT JOIN analyses a ON v.id = a.video_id
      WHERE v.is_linked = 1
        AND (t.video_id IS NULL OR a.video_id IS NULL)
      ORDER BY v.created_at DESC
    `);

    const results: NeedsAnalysisVideo[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as NeedsAnalysisVideo);
    }
    stmt.free();

    return results;
  }

  /**
   * Get count of videos needing analysis
   */
  getNeedsAnalysisCount(): number {
    const db = this.databaseService.getDatabase();

    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM videos v
      LEFT JOIN transcripts t ON v.id = t.video_id
      LEFT JOIN analyses a ON v.id = a.video_id
      WHERE v.is_linked = 1
        AND (t.video_id IS NULL OR a.video_id IS NULL)
    `);

    stmt.step();
    const result = stmt.getAsObject() as any;
    stmt.free();

    return result.count;
  }

  /**
   * Import selected videos into the database
   * @param videoPaths - Array of full file paths to import
   * @returns Array of imported video IDs
   */
  async importVideos(videoPaths: string[]): Promise<{ imported: string[]; errors: string[] }> {
    this.logger.log(`Importing ${videoPaths.length} videos...`);
    this.logger.log(`Received paths:`, videoPaths);
    const imported: string[] = [];
    const errors: string[] = [];

    // Get active library's clips folder
    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      errors.push('No active library found');
      return { imported, errors };
    }

    const clipsRoot = activeLibrary.clipsFolderPath;

    for (const fullPath of videoPaths) {
      try {
        // Check if file exists
        if (!fs.existsSync(fullPath)) {
          errors.push(`File not found: ${fullPath}`);
          continue;
        }

        // Get file info
        const filename = path.basename(fullPath);
        const stats = fs.statSync(fullPath);

        // Hash the file
        const fileHash = await this.databaseService.hashFile(fullPath);

        // Check if file is already in the clips folder structure
        let destinationPath: string;
        let dateFolder: string | null = null;

        // First, try to extract date from filename (format: YYYY-MM-DD Title.ext)
        const filenameDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\s/);
        if (filenameDateMatch) {
          dateFolder = filenameDateMatch[1];
          this.logger.log(`Extracted date from filename: ${dateFolder}`);
        }

        if (fullPath.startsWith(clipsRoot)) {
          // File is already in the clips folder - don't copy, just use it
          destinationPath = fullPath;
          this.logger.log(`Video already in clips folder: ${fullPath}`);

          // If we didn't get date from filename, try to extract from path
          if (!dateFolder) {
            const relativePath = path.relative(clipsRoot, fullPath);
            const pathParts = relativePath.split(path.sep);
            if (pathParts.length > 1) {
              // File is in a subfolder - use that as the date folder
              dateFolder = pathParts[0];
              this.logger.log(`Extracted date folder from path: ${dateFolder}`);
            }
          }
        } else {
          // File is outside clips folder - copy to weekly folder
          // Use date from filename if available, otherwise use file creation date
          let weekFolder: string;
          if (dateFolder) {
            // Use the date from filename to calculate week folder
            const filenameDate = new Date(dateFolder);
            weekFolder = this.getWeekStartDate(filenameDate);
            this.logger.log(`Using week folder based on filename date: ${weekFolder}`);
          } else {
            // Fallback to file creation date
            const fileDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;
            weekFolder = this.getWeekStartDate(fileDate);
            dateFolder = weekFolder;
            this.logger.log(`Using week folder based on file date: ${weekFolder}`);
          }

          const weekFolderPath = path.join(clipsRoot, weekFolder);

          // Create week folder if it doesn't exist
          if (!fs.existsSync(weekFolderPath)) {
            fs.mkdirSync(weekFolderPath, { recursive: true });
            this.logger.log(`Created weekly folder: ${weekFolderPath}`);
          }

          destinationPath = path.join(weekFolderPath, filename);
          fs.copyFileSync(fullPath, destinationPath);
          this.logger.log(`Copied ${filename} to ${weekFolder}/`);
        }

        // Check if video already exists in database (by hash)
        const existing = this.databaseService.findVideoByHash(fileHash);
        if (existing && existing.id) {
          // Re-link the existing video instead of creating a new entry
          const videoId = String(existing.id);
          this.logger.log(`Video already in database, re-linking: ${filename} (${videoId})`);
          this.databaseService.updateVideoPath(videoId, destinationPath, dateFolder || undefined);
          imported.push(videoId);
          continue;
        }

        // Create new video entry
        const videoId = uuidv4();

        // Insert into database
        this.databaseService.insertVideo({
          id: videoId,
          filename,
          fileHash,
          currentPath: destinationPath,
          dateFolder: dateFolder || undefined,
          durationSeconds: undefined, // Will be populated later
          fileSizeBytes: stats.size,
        });

        imported.push(videoId);
        this.logger.log(`Imported: ${filename} (${videoId})${dateFolder ? ` into ${dateFolder}` : ''}`);
      } catch (error: any) {
        this.logger.error(`Failed to import ${fullPath}: ${error.message}`);
        errors.push(`${path.basename(fullPath)}: ${error.message}`);
      }
    }

    this.logger.log(`Import complete: ${imported.length} imported, ${errors.length} errors`);
    return { imported, errors };
  }
}

// Types

export interface VideoFileInfo {
  filename: string;
  fullPath: string;
  dateFolder?: string;
  hash?: string;
}

export interface ScanResult {
  totalFiles: number;
  newVideos: number;
  updatedPaths: number;
  markedMissing: number;
  errorCount: number;
  duration: number;
  newVideoIds: string[];
  errors: string[];
}

export interface NeedsAnalysisVideo {
  id: string;
  filename: string;
  current_path: string;
  date_folder: string | null;
  duration_seconds: number | null;
  needs_transcript: number; // 0 or 1
  needs_analysis: number; // 0 or 1
}
