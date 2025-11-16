import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { LibraryManagerService } from './library-manager.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { MediaEventService } from '../media/media-event.service';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import * as crypto from 'crypto';

/**
 * FileScannerService - Scans clips folder and maintains media catalog in database
 *
 * Responsibilities:
 * - Recursively scan clips folder for all supported media files
 * - Hash media files for identification
 * - Match media to existing database entries (by filename or hash)
 * - Detect moved/renamed media and update paths
 * - Identify new media that need analysis
 * - Mark missing media as unlinked
 *
 * Supported media types:
 * - Videos: .mov, .mp4, .avi, .mkv, .webm, .m4v, .flv
 * - Audio: .mp3, .m4a, .m4b, .aac, .flac, .wav, .ogg
 * - Documents: .pdf, .epub, .mobi, .txt, .md
 * - Images: .jpg, .jpeg, .png, .gif, .webp, .bmp
 * - Web archives: .html, .htm, .mhtml
 */
@Injectable()
export class FileScannerService {
  private readonly logger = new Logger(FileScannerService.name);
  // NO hardcoded paths - clips folder must come from active library

  // All supported file extensions
  private readonly VIDEO_EXTENSIONS = ['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
  private readonly AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg'];
  private readonly DOCUMENT_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.txt', '.md'];
  private readonly IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  private readonly WEBPAGE_EXTENSIONS = ['.html', '.htm', '.mhtml'];

  private readonly ALL_MEDIA_EXTENSIONS = [
    ...this.VIDEO_EXTENSIONS,
    ...this.AUDIO_EXTENSIONS,
    ...this.DOCUMENT_EXTENSIONS,
    ...this.IMAGE_EXTENSIONS,
    ...this.WEBPAGE_EXTENSIONS,
  ];

  // Memory optimization constants
  private readonly IMPORT_BATCH_SIZE = 5; // Process 5 files at a time
  private readonly HASH_SAMPLE_SIZE = 1024 * 1024; // 1MB sample for quick hash
  private readonly STREAM_CHUNK_SIZE = 64 * 1024; // 64KB chunks for streaming
  private readonly MAX_DURATION_EXTRACT_SIZE = 500 * 1024 * 1024; // Only extract duration for files < 500MB

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(forwardRef(() => LibraryManagerService))
    private readonly libraryManagerService: LibraryManagerService,
    private readonly ffmpegService: FfmpegService,
    private readonly mediaEventService: MediaEventService,
  ) {}

  /**
   * Calculate the Sunday of the current week for a given date
   * Format: YYYY-MM-DD (e.g., "2025-09-02")
   */
  private getWeekStartDate(date: Date = new Date()): string {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const sundayDate = new Date(date);

    // Find closest Sunday:
    // - If Sunday-Wednesday (0-3): use current/previous Sunday
    // - If Thursday-Saturday (4-6): use next Sunday
    if (dayOfWeek === 0) {
      // Already Sunday, use current day
      // No adjustment needed
    } else if (dayOfWeek <= 3) {
      // Monday-Wednesday: go back to previous Sunday
      sundayDate.setDate(date.getDate() - dayOfWeek);
    } else {
      // Thursday-Saturday: go forward to next Sunday
      sundayDate.setDate(date.getDate() + (7 - dayOfWeek));
    }

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
      // Step 1: Scan filesystem and collect all media files
      const videoFiles = await this.findAllVideoFiles(clipsRoot);
      result.totalFiles = videoFiles.length;
      this.logger.log(`Found ${videoFiles.length} media files in clips folder`);

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
        upload_date: string | null;
      }>;
      this.logger.log(`Checking ${dbVideos.length} database entries...`);

      for (const dbVideo of dbVideos) {
        const dbPath = dbVideo.current_path;
        const dbHash = dbVideo.file_hash;

        // Case 1: Video still exists at same path
        if (foundPaths.has(dbPath)) {
          // Update last_verified timestamp
          this.databaseService.updateVideoPath(dbVideo.id, dbPath, dbVideo.upload_date || undefined);
          continue;
        }

        // Case 2: Video not at expected path - try to find by hash
        if (dbHash && foundHashes.has(dbHash)) {
          const newLocation = foundHashes.get(dbHash)!;
          this.logger.log(
            `Video moved: "${dbVideo.filename}" from ${dbVideo.upload_date || 'unknown'} to ${newLocation.uploadDate}`,
          );

          this.databaseService.updateVideoPath(
            dbVideo.id,
            newLocation.fullPath,
            newLocation.uploadDate,
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
            const fileCreationDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;

            this.databaseService.insertVideo({
              id: videoId,
              filename: file.filename,
              fileHash: file.hash,
              currentPath: file.fullPath,
              uploadDate: file.uploadDate,
              downloadDate: fileCreationDate.toISOString(),
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
   * Recursively find all media files in clips folder
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

            if (this.ALL_MEDIA_EXTENSIONS.includes(ext)) {
              // First, try to extract upload date from filename (format: YYYY-MM-DD Title.ext)
              const filenameDateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})\s/);
              let uploadDate: string | undefined;

              if (filenameDateMatch) {
                uploadDate = filenameDateMatch[1];
              } else {
                // Fallback: Extract date folder from path
                // e.g., /Volumes/Callisto/clips/2021-08-08/video.mov -> "2021-08-08"
                const relativePath = fullPath.replace(clipsRoot, '');
                const pathParts = relativePath.split(path.sep).filter(Boolean);
                uploadDate = pathParts.length > 1 ? pathParts[0] : undefined;
              }

              results.push({
                filename: entry.name,
                fullPath,
                uploadDate,
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
   * Only returns video files (not audio, documents, images, or webpages)
   */
  getNeedsAnalysis(): NeedsAnalysisVideo[] {
    const db = this.databaseService.getDatabase();

    const stmt = db.prepare(`
      SELECT
        v.id,
        v.filename,
        v.current_path,
        v.upload_date,
        v.download_date,
        v.duration_seconds,
        v.media_type,
        CASE WHEN t.video_id IS NULL THEN 1 ELSE 0 END as needs_transcript,
        CASE WHEN a.video_id IS NULL THEN 1 ELSE 0 END as needs_analysis
      FROM videos v
      LEFT JOIN transcripts t ON v.id = t.video_id
      LEFT JOIN analyses a ON v.id = a.video_id
      WHERE v.is_linked = 1
        AND v.media_type = 'video'
        AND (t.video_id IS NULL OR a.video_id IS NULL)
      ORDER BY v.download_date DESC
    `);

    const results = stmt.all() as NeedsAnalysisVideo[];
    return results;
  }

  /**
   * Get count of videos needing analysis
   * Only counts video files (not audio, documents, images, or webpages)
   */
  getNeedsAnalysisCount(): number {
    const db = this.databaseService.getDatabase();

    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM videos v
      LEFT JOIN transcripts t ON v.id = t.video_id
      LEFT JOIN analyses a ON v.id = a.video_id
      WHERE v.is_linked = 1
        AND v.media_type = 'video'
        AND (t.video_id IS NULL OR a.video_id IS NULL)
    `);

    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Populate duration for videos that don't have it set
   * This is useful for migrating existing videos
   */
  async populateMissingDurations(): Promise<{
    total: number;
    updated: number;
    failed: number;
    errors: string[];
  }> {
    this.logger.log('Starting to populate missing video durations...');
    const db = this.databaseService.getDatabase();

    // Find all video/audio files that don't have duration set
    const stmt = db.prepare(`
      SELECT id, filename, current_path, media_type
      FROM videos
      WHERE duration_seconds IS NULL
        AND media_type IN ('video', 'audio')
        AND is_linked = 1
    `);

    const videosToUpdate = stmt.all() as Array<{ id: string; filename: string; current_path: string; media_type: string }>;

    const result = {
      total: videosToUpdate.length,
      updated: 0,
      failed: 0,
      errors: [] as string[]
    };

    this.logger.log(`Found ${result.total} videos/audio files without duration`);

    for (const video of videosToUpdate) {
      try {
        // Check if file exists
        if (!fs.existsSync(video.current_path)) {
          this.logger.warn(`File not found: ${video.current_path}`);
          result.failed++;
          result.errors.push(`${video.filename}: File not found`);
          continue;
        }

        // Extract duration using ffprobe
        const metadata = await this.ffmpegService.getVideoMetadata(video.current_path);

        if (metadata.duration) {
          // Update database
          db.prepare('UPDATE videos SET duration_seconds = ? WHERE id = ?')
            .run(metadata.duration, video.id);

          result.updated++;
          this.logger.log(`Updated duration for ${video.filename}: ${metadata.duration}s`);
        } else {
          result.failed++;
          result.errors.push(`${video.filename}: No duration in metadata`);
        }
      } catch (error: any) {
        this.logger.error(`Failed to extract duration for ${video.filename}: ${error.message}`);
        result.failed++;
        result.errors.push(`${video.filename}: ${error.message}`);
      }
    }

    this.databaseService.saveDatabaseToDisk();

    this.logger.log(`Duration population complete: ${result.updated} updated, ${result.failed} failed`);
    return result;
  }

  /**
   * Check for duplicate videos before importing
   * @param videoPaths - Array of full file paths to check
   * @returns Information about duplicates found
   */
  async checkDuplicates(videoPaths: string[]): Promise<{
    duplicates: Array<{ path: string; filename: string; existingVideo: any }>;
    unique: string[];
  }> {
    const duplicates: Array<{ path: string; filename: string; existingVideo: any }> = [];
    const unique: string[] = [];

    for (const fullPath of videoPaths) {
      try {
        if (!fs.existsSync(fullPath)) {
          continue;
        }

        const stats = fs.statSync(fullPath);
        const fileHash = await this.quickHashFile(fullPath, stats.size);
        const existing = this.databaseService.findVideoByHash(fileHash);

        if (existing && existing.id) {
          duplicates.push({
            path: fullPath,
            filename: path.basename(fullPath),
            existingVideo: {
              id: existing.id,
              filename: existing.filename,
              current_path: existing.current_path,
              added_at: existing.added_at
            }
          });
        } else {
          unique.push(fullPath);
        }
      } catch (error: any) {
        this.logger.error(`Failed to check ${fullPath}: ${error.message}`);
        unique.push(fullPath); // Treat errors as unique to allow import attempt
      }
    }

    return { duplicates, unique };
  }

  /**
   * Import selected videos into the database
   * @param videoPaths - Array of full file paths to import
   * @param duplicateHandling - Optional map of filepath -> action ('skip', 'replace', 'keep-both')
   * @param parentVideoId - Optional parent video ID to link imported videos as children
   * @returns Array of imported video IDs
   */
  async importVideos(
    videoPaths: string[],
    duplicateHandling?: Map<string, 'skip' | 'replace' | 'keep-both'>,
    parentVideoId?: string
  ): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
    // Filter out macOS resource fork files (._*)
    const filteredPaths = videoPaths.filter(filePath => {
      const filename = path.basename(filePath);
      return !filename.startsWith('._');
    });

    if (filteredPaths.length < videoPaths.length) {
      this.logger.log(`Filtered out ${videoPaths.length - filteredPaths.length} ._ files`);
    }

    this.logger.log(`Importing ${filteredPaths.length} videos...`);
    this.logger.log(`Received paths:`, filteredPaths);
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Get active library's clips folder
    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      errors.push('No active library found');
      return { imported, skipped, errors };
    }

    const clipsRoot = activeLibrary.clipsFolderPath;

    for (const fullPath of filteredPaths) {
      try {
        // Check if file exists
        if (!fs.existsSync(fullPath)) {
          errors.push(`File not found: ${fullPath}`);
          continue;
        }

        // Get file info
        const filename = path.basename(fullPath);
        const stats = fs.statSync(fullPath);

        // Use quick hash instead of full file hash for better performance
        const fileHash = await this.quickHashFile(fullPath, stats.size);

        // Check if video already exists in database (by hash) BEFORE copying
        const existing = this.databaseService.findVideoByHash(fileHash);
        if (existing && existing.id) {
          const videoId = String(existing.id);
          const action = duplicateHandling?.get(fullPath) || 'skip';

          if (action === 'skip') {
            this.logger.log(`Skipping duplicate: ${filename} (existing ID: ${videoId})`);
            skipped.push(fullPath);
            continue;
          } else if (action === 'replace') {
            // Delete the existing entry completely and continue to import as new below
            this.logger.log(`Replacing existing entry for: ${filename} (${videoId})`);
            this.databaseService.deleteVideo(videoId);
            // Fall through to import as new
          } else if (action === 'keep-both') {
            // Just keep the existing entry, don't copy or import again
            this.logger.log(`Keeping existing entry: ${filename} (${videoId})`);
            imported.push(videoId);
            continue;
          }
        }

        // Determine destination path and upload date (content creation date)
        let destinationPath: string;
        let uploadDate: string | null = null;

        // First, try to extract upload date from filename (format: YYYY-MM-DD Title.ext)
        // This is the date the content was created/filmed by the person
        const filenameDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\s/);
        if (filenameDateMatch) {
          uploadDate = filenameDateMatch[1];
          this.logger.log(`Extracted upload date from filename: ${uploadDate}`);
        }

        // Get file creation date (download date - when you downloaded/created the file)
        const fileCreationDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;
        const downloadDate = fileCreationDate.toISOString();

        if (fullPath.startsWith(clipsRoot)) {
          // File is already in the clips folder - don't copy, just use it
          destinationPath = fullPath;
          this.logger.log(`Video already in clips folder: ${fullPath}`);

          // If we didn't get upload date from filename, try to extract from path
          if (!uploadDate) {
            const relativePath = path.relative(clipsRoot, fullPath);
            const pathParts = relativePath.split(path.sep);
            if (pathParts.length > 1) {
              // File is in a subfolder - use that as the upload date
              uploadDate = pathParts[0];
              this.logger.log(`Extracted upload date from path: ${uploadDate}`);
            }
          }
        } else {
          // File is outside clips folder - copy to weekly folder based on download date
          // Use nearest Sunday to download date for folder organization
          const weekFolder = this.getWeekStartDate(fileCreationDate);

          this.logger.log(`Using week folder based on download date: ${weekFolder}${uploadDate ? ` (upload date: ${uploadDate})` : ''}`);

          const weekFolderPath = path.join(clipsRoot, weekFolder);

          // Create week folder if it doesn't exist
          if (!fs.existsSync(weekFolderPath)) {
            fs.mkdirSync(weekFolderPath, { recursive: true });
            this.logger.log(`Created weekly folder: ${weekFolderPath}`);
          }

          destinationPath = path.join(weekFolderPath, filename);

          // Use streaming copy to avoid loading entire file into memory
          await this.streamCopyFile(fullPath, destinationPath);

          // Preserve original file timestamps (atime and mtime)
          // This ensures the file retains its original creation/modification dates
          fs.utimesSync(destinationPath, stats.atime, stats.mtime);

          this.logger.log(`Copied ${filename} to ${weekFolder}/ (preserved timestamps)`);
        }

        // Create new video entry
        const videoId = uuidv4();

        // Extract duration for video/audio files (skip for very large files to save memory)
        let durationSeconds: number | undefined = undefined;
        const fileExt = path.extname(filename).toLowerCase();
        const isVideoOrAudio = [...this.VIDEO_EXTENSIONS, ...this.AUDIO_EXTENSIONS].includes(fileExt);

        if (isVideoOrAudio && stats.size < this.MAX_DURATION_EXTRACT_SIZE) {
          try {
            const metadata = await this.ffmpegService.getVideoMetadata(destinationPath);
            durationSeconds = metadata.duration;
            this.logger.log(`Extracted duration: ${durationSeconds}s for ${filename}`);
          } catch (error: any) {
            this.logger.warn(`Could not extract duration for ${filename}: ${error.message}`);
            // Continue with undefined duration - not critical for import
          }
        } else if (isVideoOrAudio && stats.size >= this.MAX_DURATION_EXTRACT_SIZE) {
          this.logger.log(`Skipping duration extraction for large file (${(stats.size / 1024 / 1024).toFixed(1)}MB): ${filename}`);
        }

        // Insert into database
        this.databaseService.insertVideo({
          id: videoId,
          filename,
          fileHash,
          currentPath: destinationPath,
          uploadDate: uploadDate || undefined, // Content creation date from filename
          downloadDate, // File creation timestamp (when you downloaded it)
          durationSeconds,
          fileSizeBytes: stats.size,
        });

        // Link to parent video if specified
        if (parentVideoId) {
          try {
            this.databaseService.setVideoParent(videoId, parentVideoId);
            this.logger.log(`Linked ${videoId} as child of ${parentVideoId}`);
          } catch (error: any) {
            this.logger.error(`Failed to link video to parent: ${error.message}`);
            // Don't fail the import, just log the error
          }
        }

        // Emit WebSocket event so frontend refreshes immediately
        this.mediaEventService.emitVideoImported(videoId, filename, destinationPath);

        imported.push(videoId);
        this.logger.log(`Imported: ${filename} (${videoId})${uploadDate ? ` with upload date ${uploadDate}` : ''}`);
      } catch (error: any) {
        this.logger.error(`Failed to import ${fullPath}: ${error.message}`);
        errors.push(`${path.basename(fullPath)}: ${error.message}`);
      }
    }

    this.logger.log(`Import complete: ${imported.length} imported, ${skipped.length} skipped, ${errors.length} errors`);

    // Emit WebSocket event so frontend knows import is complete
    this.mediaEventService.emitImportComplete(imported.length, skipped.length, errors.length);

    return { imported, skipped, errors };
  }

  /**
   * Import videos with progress updates (for large batches)
   * Uses batching and memory optimization
   */
  async importVideosWithProgress(
    videoPaths: string[],
    duplicateHandling?: Map<string, 'skip' | 'replace' | 'keep-both'>
  ): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Filter out macOS resource fork files (._*)
    const filteredPaths = videoPaths.filter(filePath => {
      const filename = path.basename(filePath);
      return !filename.startsWith('._');
    });

    const total = filteredPaths.length;
    this.logger.log(`Starting batched import of ${total} videos (filtered ${videoPaths.length - total} ._ files)`);

    // Emit start event
    this.mediaEventService.emitEvent('import-progress', {
      current: 0,
      total: total,
      imported: 0,
      skipped: 0,
      errors: 0
    });

    // Process in batches to limit memory usage
    for (let i = 0; i < filteredPaths.length; i += this.IMPORT_BATCH_SIZE) {
      const batch = filteredPaths.slice(i, i + this.IMPORT_BATCH_SIZE);
      this.logger.log(`Processing batch ${Math.floor(i / this.IMPORT_BATCH_SIZE) + 1}/${Math.ceil(filteredPaths.length / this.IMPORT_BATCH_SIZE)}`);

      // Import batch sequentially to maintain control over memory
      for (const fullPath of batch) {
        try {
          const result = await this.importVideos([fullPath], duplicateHandling);

          if (result.imported.length > 0) {
            imported.push(...result.imported);
          } else if (result.skipped.length > 0) {
            skipped.push(fullPath);
          }
          if (result.errors.length > 0) {
            errors.push(...result.errors);
          }
        } catch (error: any) {
          this.logger.error(`Failed to import ${fullPath}: ${error.message}`);
          errors.push(`${path.basename(fullPath)}: ${error.message}`);
        }
      }

      // Force garbage collection between batches if available
      if (global.gc) {
        global.gc();
      }

      // Emit progress after each batch
      this.mediaEventService.emitEvent('import-progress', {
        current: Math.min(i + this.IMPORT_BATCH_SIZE, filteredPaths.length),
        total: total,
        imported: imported.length,
        skipped: skipped.length,
        errors: errors.length
      });
    }

    this.logger.log(`Import complete: ${imported.length} imported, ${skipped.length} skipped, ${errors.length} errors`);

    // Emit final complete event
    this.mediaEventService.emitImportComplete(imported.length, skipped.length, errors.length);

    return { imported, skipped, errors };
  }

  /**
   * Quick hash using file size + samples from beginning/middle/end
   * Much faster and memory-efficient than hashing entire file
   */
  public async quickHashFile(filePath: string, fileSize: number): Promise<string> {
    const hash = crypto.createHash('sha256');

    // Add file size to hash
    hash.update(fileSize.toString());

    // Sample from beginning, middle, and end of file
    const sampleSize = Math.min(this.HASH_SAMPLE_SIZE, Math.floor(fileSize / 3));

    if (fileSize <= this.HASH_SAMPLE_SIZE * 3) {
      // Small file - just hash the whole thing
      const buffer = fs.readFileSync(filePath);
      hash.update(buffer);
    } else {
      // Large file - sample three sections
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(sampleSize);

        // Beginning
        fs.readSync(fd, buffer, 0, sampleSize, 0);
        hash.update(buffer);

        // Middle
        const middlePos = Math.floor(fileSize / 2) - Math.floor(sampleSize / 2);
        fs.readSync(fd, buffer, 0, sampleSize, middlePos);
        hash.update(buffer);

        // End
        const endPos = fileSize - sampleSize;
        fs.readSync(fd, buffer, 0, sampleSize, endPos);
        hash.update(buffer);
      } finally {
        fs.closeSync(fd);
      }
    }

    return hash.digest('hex');
  }

  /**
   * Stream copy file instead of loading entire file into memory
   */
  private async streamCopyFile(source: string, destination: string): Promise<void> {
    const readStream = createReadStream(source, { highWaterMark: this.STREAM_CHUNK_SIZE });
    const writeStream = createWriteStream(destination, { highWaterMark: this.STREAM_CHUNK_SIZE });

    await pipeline(readStream, writeStream);
  }
}

// Types

export interface VideoFileInfo {
  filename: string;
  fullPath: string;
  uploadDate?: string;
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
  upload_date: string | null;
  download_date: string | null;
  duration_seconds: number | null;
  media_type: string; // 'video', 'audio', 'document', 'image', 'webpage'
  needs_transcript: number; // 0 or 1
  needs_analysis: number; // 0 or 1
}
