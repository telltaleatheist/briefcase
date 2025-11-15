import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface RelinkOptions {
  targetPath: string; // e.g., "/Volumes/Callisto/clips"
  dryRun?: boolean;
  copyMissingFiles?: boolean; // Copy missing files to target before relinking
}

export interface RelinkProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export interface RelinkResult {
  success: boolean;
  stats: {
    totalFiles: number;
    filesScanned: number;
    matched: number;
    updated: number;
    notFound: number;
    copied: number;
    errors: string[];
  };
  backupPath?: string;
}

interface FileHashMap {
  [hash: string]: {
    relativePath: string; // e.g., "2025-11-02/video.mp4"
    fullPath: string;
    size: number;
    filename: string;
  };
}

interface FileNameMap {
  [filename: string]: {
    relativePath: string;
    fullPath: string;
    size: number;
    hash: string;
    filename: string;
  };
}

@Injectable()
export class RelinkingService {
  private readonly logger = new Logger(RelinkingService.name);
  private readonly HASH_SAMPLE_SIZE = 1024 * 1024; // 1MB sample for quick hash

  constructor(private databaseService: DatabaseService) {}

  /**
   * Relink videos by scanning target folder and matching by hash
   */
  async relinkByHash(
    options: RelinkOptions,
    progressCallback?: (progress: RelinkProgress) => void
  ): Promise<RelinkResult> {
    const result: RelinkResult = {
      success: false,
      stats: {
        totalFiles: 0,
        filesScanned: 0,
        matched: 0,
        updated: 0,
        notFound: 0,
        copied: 0,
        errors: [],
      },
    };

    try {
      this.logger.log('=== Starting Relinking Process ===');
      this.logger.log(`Target Path: ${options.targetPath}`);
      this.logger.log(`Dry Run: ${options.dryRun || false}`);
      this.logger.log(`Copy Missing Files: ${options.copyMissingFiles || false}`);

      // Phase 1: Create backup
      if (!options.dryRun) {
        this.emitProgress(progressCallback, {
          phase: 'backup',
          current: 0,
          total: 1,
          message: 'Creating database backup...',
        });

        result.backupPath = await this.createBackup();
        this.logger.log(`Backup created at: ${result.backupPath}`);
      }

      // Phase 2: Scan target folder and build hash map
      this.emitProgress(progressCallback, {
        phase: 'scanning',
        current: 0,
        total: 100,
        message: 'Scanning target folder...',
      });

      const { hashMap, filenameMap } = await this.scanAndHashFolder(options.targetPath, progressCallback);
      result.stats.totalFiles = Object.keys(hashMap).length;
      this.logger.log(`Found ${result.stats.totalFiles} files in target folder`);

      // Phase 3: Get all videos from database
      this.emitProgress(progressCallback, {
        phase: 'matching',
        current: 0,
        total: 100,
        message: 'Loading database entries...',
      });

      const videos = this.databaseService.getAllVideos({
        linkedOnly: false,
        includeChildren: true  // Include child/derived videos too!
      });
      this.logger.log(`Found ${videos.length} videos in database (including children)`);

      // Phase 4: Match videos by hash and update paths
      this.emitProgress(progressCallback, {
        phase: 'relinking',
        current: 0,
        total: videos.length,
        message: 'Matching and relinking videos...',
      });

      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        const videoHash = video.file_hash;

        if (!videoHash) {
          this.logger.warn(`Video ${video.id} has no hash, skipping`);
          result.stats.errors.push(`${video.filename}: No hash in database`);
          continue;
        }

        // Try to find matching file by hash first
        let matchedFile = hashMap[videoHash];
        let matchMethod = 'hash';

        // If no hash match, try filename fallback
        if (!matchedFile && filenameMap[video.filename]) {
          matchedFile = filenameMap[video.filename];
          matchMethod = 'filename';
          this.logger.warn(`No hash match for ${video.filename}, using filename fallback`);
        }

        if (matchedFile) {
          result.stats.matched++;

          const relativePath = matchedFile.relativePath;
          this.logger.log(`Match found (${matchMethod}): ${video.filename} -> ${relativePath}`);

          if (!options.dryRun) {
            try {
              this.databaseService.updateVideoPath(video.id, matchedFile.fullPath);
              result.stats.updated++;
            } catch (err: any) {
              this.logger.error(`Failed to update video ${video.id}: ${err.message}`);
              result.stats.errors.push(`${video.filename}: Update failed - ${err.message}`);
            }
          } else {
            result.stats.updated++;
          }
        } else {
          // File not found in target - try to copy if enabled
          if (options.copyMissingFiles && video.current_path) {
            try {
              const sourceFile = video.current_path;

              // Check if source file exists
              if (fs.existsSync(sourceFile)) {
                // Extract date folder from source path or use current date
                const sourcePath = path.dirname(sourceFile);
                const dateFolder = path.basename(sourcePath);

                // Create target path maintaining folder structure
                const targetFolder = path.join(options.targetPath, dateFolder);
                const targetFile = path.join(targetFolder, video.filename);

                this.logger.log(`Copying missing file: ${video.filename} -> ${targetFile}`);

                if (!options.dryRun) {
                  // Create target folder if it doesn't exist
                  if (!fs.existsSync(targetFolder)) {
                    fs.mkdirSync(targetFolder, { recursive: true });
                  }

                  // Copy file
                  fs.copyFileSync(sourceFile, targetFile);

                  // Update database path
                  this.databaseService.updateVideoPath(video.id, targetFile);
                  result.stats.copied++;
                  result.stats.updated++;
                } else {
                  result.stats.copied++;
                  result.stats.updated++;
                }
              } else {
                result.stats.notFound++;
                this.logger.warn(`Source file not found: ${sourceFile}`);
                result.stats.errors.push(`${video.filename}: Source file not found for copying`);
              }
            } catch (err: any) {
              result.stats.notFound++;
              this.logger.error(`Failed to copy ${video.filename}: ${err.message}`);
              result.stats.errors.push(`${video.filename}: Copy failed - ${err.message}`);
            }
          } else {
            result.stats.notFound++;
            this.logger.warn(`No match found for: ${video.filename} (hash: ${videoHash})`);
            result.stats.errors.push(`${video.filename}: File not found in target folder`);
          }
        }

        // Emit progress
        if (i % 10 === 0 || i === videos.length - 1) {
          this.emitProgress(progressCallback, {
            phase: 'relinking',
            current: i + 1,
            total: videos.length,
            message: `Relinked ${result.stats.updated} / ${videos.length} videos`,
          });
        }
      }

      // Phase 5: Complete
      result.success = true;
      this.logger.log('=== Relinking Complete ===');
      this.logger.log(`Matched: ${result.stats.matched}`);
      this.logger.log(`Updated: ${result.stats.updated}`);
      this.logger.log(`Copied: ${result.stats.copied}`);
      this.logger.log(`Not Found: ${result.stats.notFound}`);
      this.logger.log(`Errors: ${result.stats.errors.length}`);

      return result;
    } catch (error: any) {
      this.logger.error(`Relinking failed: ${error.message}`, error.stack);
      result.success = false;
      result.stats.errors.push(`Fatal error: ${error.message}`);
      return result;
    }
  }

  /**
   * Scan folder recursively and build hash and filename maps
   */
  private async scanAndHashFolder(
    folderPath: string,
    progressCallback?: (progress: RelinkProgress) => void
  ): Promise<{ hashMap: FileHashMap; filenameMap: FileNameMap }> {
    const hashMap: FileHashMap = {};
    const filenameMap: FileNameMap = {};
    const files: string[] = [];

    // Recursively find all video files
    const findFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          findFiles(fullPath);
        } else if (this.isArchivableFile(entry.name)) {
          files.push(fullPath);
        }
      }
    };

    this.logger.log(`Scanning folder: ${folderPath}`);
    findFiles(folderPath);
    this.logger.log(`Found ${files.length} archivable files (videos, images, documents, audio)`);

    // Hash each file
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];

      try {
        const stats = fs.statSync(filePath);
        const hash = await this.quickHashFile(filePath, stats.size);

        // Calculate relative path from base folder
        // Example: "/Volumes/Callisto/clips/2025-11-02/video.mp4" -> "2025-11-02/video.mp4"
        const relativePath = path.relative(folderPath, filePath);
        const filename = path.basename(filePath);

        // Build hash map
        hashMap[hash] = {
          relativePath,
          fullPath: filePath,
          size: stats.size,
          filename,
        };

        // Build filename map
        filenameMap[filename] = {
          relativePath,
          fullPath: filePath,
          size: stats.size,
          hash,
          filename,
        };

        // Emit progress every 10 files
        if (i % 10 === 0 || i === files.length - 1) {
          this.emitProgress(progressCallback, {
            phase: 'scanning',
            current: i + 1,
            total: files.length,
            message: `Hashing files: ${i + 1} / ${files.length}`,
          });
        }
      } catch (err: any) {
        this.logger.error(`Failed to hash ${filePath}: ${err.message}`);
      }
    }

    return { hashMap, filenameMap };
  }

  /**
   * Quick hash using file size + samples from beginning/middle/end
   * MUST match FileScannerService.quickHashFile() algorithm exactly
   * This is critical for matching existing database entries created during import
   */
  private async quickHashFile(filePath: string, fileSize: number): Promise<string> {
    const hash = crypto.createHash('sha256');

    // Add file size to hash (CRITICAL - matches import algorithm)
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
        fs.readSync(fd, buffer, 0, sampleSize, Math.floor(fileSize / 2) - Math.floor(sampleSize / 2));
        hash.update(buffer);

        // End
        fs.readSync(fd, buffer, 0, sampleSize, fileSize - sampleSize);
        hash.update(buffer);
      } finally {
        fs.closeSync(fd);
      }
    }

    return hash.digest('hex');
  }

  /**
   * Check if file should be archived/relinked
   * Includes videos, images, documents, and audio files
   */
  private isArchivableFile(filename: string): boolean {
    // Skip macOS system files
    if (filename === '.DS_Store' || filename.startsWith('._')) {
      return false;
    }

    const archivableExtensions = [
      // Videos
      '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v',
      // Images
      '.jpg', '.jpeg', '.png', '.gif', '.webp',
      // Documents
      '.pdf', '.txt', '.md', '.mhtml', '.html', '.htm', '.epub',
      // Audio
      '.mp3', '.wav', '.m4a', '.aac', '.flac',
      // Data
      '.json', '.xml',
    ];
    const ext = path.extname(filename).toLowerCase();
    return archivableExtensions.includes(ext);
  }

  /**
   * Create backup of database
   */
  private async createBackup(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const dbPath = this.databaseService.getCurrentDbPath();

    if (!dbPath) {
      throw new Error('Database not initialized');
    }

    const dbDir = path.dirname(dbPath);
    const backupFilename = `library_backup_${timestamp}.db`;
    const backupPath = path.join(dbDir, backupFilename);

    // Copy database file
    fs.copyFileSync(dbPath, backupPath);

    this.logger.log(`Database backed up to: ${backupPath}`);
    return backupPath;
  }

  /**
   * Emit progress update
   */
  private emitProgress(
    callback: ((progress: RelinkProgress) => void) | undefined,
    progress: RelinkProgress
  ): void {
    if (callback) {
      callback(progress);
    }
  }
}
