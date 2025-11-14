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

/**
 * Optimized file import with streaming, batching, and memory management
 */
@Injectable()
export class FileImportOptimizer {
  private readonly logger = new Logger(FileImportOptimizer.name);

  // Configuration for memory-efficient import
  private readonly BATCH_SIZE = 5; // Process 5 files at a time
  private readonly HASH_SAMPLE_SIZE = 1024 * 1024; // 1MB sample for quick hash
  private readonly STREAM_CHUNK_SIZE = 64 * 1024; // 64KB chunks for streaming

  constructor(
    private readonly databaseService: DatabaseService,
    @Inject(forwardRef(() => LibraryManagerService))
    private readonly libraryManagerService: LibraryManagerService,
    private readonly ffmpegService: FfmpegService,
    private readonly mediaEventService: MediaEventService,
  ) {}

  /**
   * Import videos with proper batching and memory management
   */
  async importVideosOptimized(
    videoPaths: string[],
    duplicateHandling?: Map<string, 'skip' | 'replace' | 'keep-both'>,
    parentVideoId?: string
  ): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
    // Filter out ._ files
    const filteredPaths = videoPaths.filter(filePath => {
      const filename = path.basename(filePath);
      return !filename.startsWith('._');
    });

    if (filteredPaths.length < videoPaths.length) {
      this.logger.log(`Filtered out ${videoPaths.length - filteredPaths.length} ._ files`);
    }

    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // Get active library
    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      errors.push('No active library found');
      return { imported, skipped, errors };
    }

    const clipsRoot = activeLibrary.clipsFolderPath;

    // Process in batches to limit memory usage
    for (let i = 0; i < filteredPaths.length; i += this.BATCH_SIZE) {
      const batch = filteredPaths.slice(i, i + this.BATCH_SIZE);
      this.logger.log(`Processing batch ${Math.floor(i / this.BATCH_SIZE) + 1}/${Math.ceil(filteredPaths.length / this.BATCH_SIZE)}`);

      // Process batch with concurrency limit
      const batchResults = await Promise.allSettled(
        batch.map(filePath => this.importSingleVideoOptimized(
          filePath,
          clipsRoot,
          duplicateHandling,
          parentVideoId
        ))
      );

      // Collect results
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const filePath = batch[j];

        if (result.status === 'fulfilled') {
          const { imported: imp, skipped: skip, error } = result.value;
          if (imp) imported.push(imp);
          if (skip) skipped.push(filePath);
          if (error) errors.push(`${path.basename(filePath)}: ${error}`);
        } else {
          errors.push(`${path.basename(filePath)}: ${result.reason?.message || 'Unknown error'}`);
        }
      }

      // Force garbage collection hint between batches
      if (global.gc) {
        global.gc();
      }

      // Emit progress update
      this.mediaEventService.emitEvent('import-progress', {
        current: Math.min(i + this.BATCH_SIZE, filteredPaths.length),
        total: filteredPaths.length,
        imported: imported.length,
        skipped: skipped.length,
        errors: errors.length
      });
    }

    this.logger.log(`Import complete: ${imported.length} imported, ${skipped.length} skipped, ${errors.length} errors`);
    this.mediaEventService.emitImportComplete(imported.length, skipped.length, errors.length);

    return { imported, skipped, errors };
  }

  /**
   * Import a single video with streaming and efficient resource usage
   */
  private async importSingleVideoOptimized(
    fullPath: string,
    clipsRoot: string,
    duplicateHandling?: Map<string, 'skip' | 'replace' | 'keep-both'>,
    parentVideoId?: string
  ): Promise<{ imported?: string; skipped?: boolean; error?: string }> {
    try {
      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        return { error: 'File not found' };
      }

      const filename = path.basename(fullPath);
      const stats = fs.statSync(fullPath);

      // Use fast hash (file size + first/last bytes) instead of full file hash
      const quickHash = await this.quickHashFile(fullPath, stats.size);

      // Check for duplicates
      const existing = this.databaseService.findVideoByHash(quickHash);
      if (existing && existing.id) {
        const videoId = String(existing.id);
        const action = duplicateHandling?.get(fullPath) || 'skip';

        if (action === 'skip') {
          return { skipped: true };
        } else if (action === 'replace') {
          this.databaseService.deleteVideo(videoId);
        } else if (action === 'keep-both') {
          return { imported: videoId };
        }
      }

      // Determine destination and upload date
      let destinationPath: string;
      let uploadDate: string | null = null;

      const filenameDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\s/);
      if (filenameDateMatch) {
        uploadDate = filenameDateMatch[1];
      }

      const fileCreationDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;
      const downloadDate = fileCreationDate.toISOString();

      if (fullPath.startsWith(clipsRoot)) {
        // Already in clips folder
        destinationPath = fullPath;

        if (!uploadDate) {
          const relativePath = path.relative(clipsRoot, fullPath);
          const pathParts = relativePath.split(path.sep);
          if (pathParts.length > 1) {
            uploadDate = pathParts[0];
          }
        }
      } else {
        // Copy to clips folder using streaming
        const weekFolder = this.getWeekStartDate(fileCreationDate);
        const weekFolderPath = path.join(clipsRoot, weekFolder);

        if (!fs.existsSync(weekFolderPath)) {
          fs.mkdirSync(weekFolderPath, { recursive: true });
        }

        destinationPath = path.join(weekFolderPath, filename);

        // Stream copy instead of loading entire file into memory
        await this.streamCopyFile(fullPath, destinationPath);

        // Preserve timestamps
        fs.utimesSync(destinationPath, stats.atime, stats.mtime);
      }

      // Create video entry
      const videoId = uuidv4();

      // Extract duration only for video/audio (skip for large files to save time)
      let durationSeconds: number | undefined = undefined;
      const fileExt = path.extname(filename).toLowerCase();
      const isVideoOrAudio = ['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.mp3', '.m4a', '.aac'].includes(fileExt);

      if (isVideoOrAudio && stats.size < 500 * 1024 * 1024) { // Only get duration for files < 500MB
        try {
          const metadata = await this.ffmpegService.getVideoMetadata(destinationPath);
          durationSeconds = metadata.duration;
        } catch (error: any) {
          // Not critical, continue without duration
          this.logger.warn(`Could not extract duration for ${filename}: ${error.message}`);
        }
      }

      // Insert into database
      this.databaseService.insertVideo({
        id: videoId,
        filename,
        fileHash: quickHash,
        currentPath: destinationPath,
        uploadDate: uploadDate || undefined,
        downloadDate,
        durationSeconds,
        fileSizeBytes: stats.size,
      });

      // Link to parent if specified
      if (parentVideoId) {
        try {
          this.databaseService.setVideoParent(videoId, parentVideoId);
        } catch (error: any) {
          this.logger.error(`Failed to link video to parent: ${error.message}`);
        }
      }

      // Emit event
      this.mediaEventService.emitVideoImported(videoId, filename, destinationPath);

      return { imported: videoId };
    } catch (error: any) {
      this.logger.error(`Failed to import ${fullPath}: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Quick hash using file size + samples from beginning/middle/end
   * Much faster and memory-efficient than hashing entire file
   */
  private async quickHashFile(filePath: string, fileSize: number): Promise<string> {
    const crypto = require('crypto');
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

  /**
   * Calculate Sunday of the current week
   */
  private getWeekStartDate(date: Date = new Date()): string {
    const dayOfWeek = date.getDay();
    const sundayDate = new Date(date);
    sundayDate.setDate(date.getDate() - dayOfWeek);

    const year = sundayDate.getFullYear();
    const month = String(sundayDate.getMonth() + 1).padStart(2, '0');
    const day = String(sundayDate.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }
}
