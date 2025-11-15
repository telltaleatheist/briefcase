import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from './database.service';

/**
 * Library configuration stored in settings
 */
export interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

interface LibraryManagerConfig {
  activeLibraryId: string | null;
  libraries: ClipLibrary[];
}

/**
 * LibraryManagerService - Manages multiple clip libraries
 *
 * Each library has:
 * - Unique ID
 * - Name (user-friendly)
 * - SQLite database file
 * - Clips folder (where imported videos are copied)
 *
 * Libraries are stored in: ~/Library/Application Support/clippy/libraries/
 * Configuration stored in: ~/Library/Application Support/clippy/libraries-config.json
 */
@Injectable()
export class LibraryManagerService implements OnModuleInit {
  private readonly logger = new Logger(LibraryManagerService.name);
  private readonly appDataPath: string;
  private readonly librariesBasePath: string;
  private readonly configFilePath: string;
  private config: LibraryManagerConfig;

  constructor(private readonly databaseService: DatabaseService) {
    // Base directory: ~/Library/Application Support/clippy
    this.appDataPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'clippy',
    );

    // Libraries directory: ~/Library/Application Support/clippy/libraries
    this.librariesBasePath = path.join(this.appDataPath, 'libraries');

    // Config file
    this.configFilePath = path.join(this.appDataPath, 'libraries-config.json');

    // Ensure directories exist
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }
    if (!fs.existsSync(this.librariesBasePath)) {
      fs.mkdirSync(this.librariesBasePath, { recursive: true });
    }

    // Load or initialize config
    this.config = this.loadConfig();
    this.logger.log(`Loaded library configuration: ${this.config.libraries.length} libraries`);
  }

  /**
   * Lifecycle hook - called after module initialization
   * Automatically loads the active library database on startup
   */
  async onModuleInit() {
    const startTime = Date.now();
    this.logger.log('[onModuleInit] Starting library manager initialization...');

    const activeLibrary = this.getActiveLibrary();
    if (activeLibrary) {
      this.logger.log(`[onModuleInit] Auto-loading active library: ${activeLibrary.name} (${activeLibrary.id})`);
      const initStart = Date.now();
      await this.initializeActiveLibrary();
      this.logger.log(`[onModuleInit] ✓ Library initialized in ${Date.now() - initStart}ms`);
    } else {
      this.logger.log('[onModuleInit] No active library to load on startup');
    }

    this.logger.log(`[onModuleInit] Total initialization took ${Date.now() - startTime}ms`);
  }

  /**
   * Load library configuration from disk
   */
  private loadConfig(): LibraryManagerConfig {
    if (fs.existsSync(this.configFilePath)) {
      try {
        const data = fs.readFileSync(this.configFilePath, 'utf8');
        return JSON.parse(data);
      } catch (error: any) {
        this.logger.error(`Error loading library config: ${error?.message || 'Unknown error'}`);
      }
    }

    // Default: empty configuration
    return {
      activeLibraryId: null,
      libraries: [],
    };
  }

  /**
   * Save library configuration to disk
   */
  private saveConfig() {
    try {
      fs.writeFileSync(
        this.configFilePath,
        JSON.stringify(this.config, null, 2),
        'utf8',
      );
    } catch (error: any) {
      this.logger.error(`Error saving library config: ${error?.message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Get all libraries
   */
  getAllLibraries(): ClipLibrary[] {
    return this.config.libraries;
  }

  /**
   * Get active library
   */
  getActiveLibrary(): ClipLibrary | null {
    if (!this.config.activeLibraryId) {
      return null;
    }
    return this.config.libraries.find(
      (lib) => lib.id === this.config.activeLibraryId,
    ) || null;
  }

  /**
   * Create a new clip library
   * @param name - Library name
   * @param clipsFolderPath - User-selected path where videos will be stored
   */
  async createLibrary(name: string, clipsFolderPath: string): Promise<ClipLibrary> {
    const id = `lib_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const libraryPath = path.join(this.librariesBasePath, id);

    // Create library directory for database
    fs.mkdirSync(libraryPath, { recursive: true });

    // Ensure clips folder exists (user-provided path)
    if (!fs.existsSync(clipsFolderPath)) {
      fs.mkdirSync(clipsFolderPath, { recursive: true });
    }

    // Database path (stored in system location)
    const databasePath = path.join(libraryPath, 'library.db');

    const library: ClipLibrary = {
      id,
      name,
      databasePath,
      clipsFolderPath, // Use user-provided path
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };

    // Add to config
    this.config.libraries.push(library);

    // Set as active if it's the first library
    if (this.config.libraries.length === 1) {
      this.config.activeLibraryId = id;
    }

    this.saveConfig();

    this.logger.log(`Created new library: ${name} (${id}) with clips folder: ${clipsFolderPath}`);

    // Initialize database for this library if it's now active
    if (this.config.activeLibraryId === id) {
      await this.databaseService.initializeDatabase(databasePath);
    }

    return library;
  }

  /**
   * Switch to a different library
   */
  async switchLibrary(libraryId: string): Promise<boolean> {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    // Update active library
    this.config.activeLibraryId = libraryId;
    library.lastAccessedAt = new Date().toISOString();
    this.saveConfig();

    // Initialize database for this library
    await this.databaseService.initializeDatabase(library.databasePath);

    this.logger.log(`Switched to library: ${library.name} (${libraryId})`);
    return true;
  }

  /**
   * Delete a library (removes from config and optionally deletes files)
   */
  async deleteLibrary(libraryId: string, deleteFiles = false): Promise<boolean> {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    // If deleting the active library, switch to another one first
    if (this.config.activeLibraryId === libraryId) {
      const otherLibraries = this.config.libraries.filter((lib) => lib.id !== libraryId);
      if (otherLibraries.length > 0) {
        // Switch to the first available library
        this.config.activeLibraryId = otherLibraries[0].id;
        this.logger.log(`Switched to library: ${otherLibraries[0].name} (${otherLibraries[0].id})`);
      } else {
        // No other libraries, set to null
        this.config.activeLibraryId = null;
        this.logger.log('No libraries remaining, setting activeLibraryId to null');
      }
    }

    // Remove from config
    this.config.libraries = this.config.libraries.filter(
      (lib) => lib.id !== libraryId,
    );
    this.saveConfig();

    // Optionally delete files
    if (deleteFiles) {
      const libraryPath = path.dirname(library.databasePath);
      try {
        fs.rmSync(libraryPath, { recursive: true, force: true });
        this.logger.log(`Deleted library files: ${libraryPath}`);
      } catch (error: any) {
        this.logger.error(`Error deleting library files: ${error?.message || 'Unknown error'}`);
      }
    }

    this.logger.log(`Deleted library: ${library.name} (${libraryId})`);
    return true;
  }

  /**
   * Rename a library
   */
  renameLibrary(libraryId: string, newName: string): boolean {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    library.name = newName;
    this.saveConfig();

    this.logger.log(`Renamed library ${libraryId} to: ${newName}`);
    return true;
  }

  /**
   * Update library's clips folder path
   */
  updateLibraryClipsFolder(libraryId: string, newPath: string): boolean {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    library.clipsFolderPath = newPath;
    this.saveConfig();

    this.logger.log(`Updated clips folder for library ${libraryId} to: ${newPath}`);
    return true;
  }

  /**
   * Check if database is initialized and ready
   */
  isDatabaseReady(): boolean {
    return this.databaseService.isInitialized();
  }

  /**
   * Initialize the active library's database (for app startup)
   */
  async initializeActiveLibrary(): Promise<boolean> {
    const activeLibrary = this.getActiveLibrary();

    if (!activeLibrary) {
      this.logger.warn('No active library found');
      return false;
    }

    await this.databaseService.initializeDatabase(activeLibrary.databasePath);
    activeLibrary.lastAccessedAt = new Date().toISOString();
    this.saveConfig();

    return true;
  }

  /**
   * Transfer videos between libraries (move or copy)
   */
  async transferVideos(
    videoIds: string[],
    targetLibraryId: string,
    action: 'move' | 'copy',
    replaceExisting: boolean,
  ): Promise<{
    transferred: number;
    skipped: number;
    replaced: number;
    errors: string[];
  }> {
    const result = {
      transferred: 0,
      skipped: 0,
      replaced: 0,
      errors: [] as string[],
    };

    // Get source (active) library
    const sourceLibrary = this.getActiveLibrary();
    if (!sourceLibrary) {
      throw new Error('No active source library');
    }

    // Get target library
    const targetLibrary = this.config.libraries.find(
      (lib) => lib.id === targetLibraryId,
    );
    if (!targetLibrary) {
      throw new Error('Target library not found');
    }

    this.logger.log(
      `Transferring ${videoIds.length} videos from ${sourceLibrary.name} to ${targetLibrary.name} (${action})`,
    );

    // Store current database path to restore later
    const currentDbPath = this.databaseService['dbPath'];

    try {
      // Process each video
      for (const videoId of videoIds) {
        try {
          // Ensure source database is active
          await this.databaseService.initializeDatabase(
            sourceLibrary.databasePath,
          );

          // Get video data from source
          const video = this.databaseService.findVideoById(videoId);
          if (!video) {
            result.errors.push(`Video ${videoId} not found in source library`);
            continue;
          }

          // Get associated data
          const transcript = this.databaseService.getTranscript(videoId);
          const analysis = this.databaseService.getAnalysis(videoId);
          const analysisSections =
            this.databaseService.getAnalysisSections(videoId);
          const tags = this.databaseService.getTags(videoId);

          // Switch to target database
          await this.databaseService.initializeDatabase(
            targetLibrary.databasePath,
          );

          // Check if video already exists in target
          const existingVideo = this.databaseService.findVideoByFilename(
            video.filename as string,
          );

          if (existingVideo && !replaceExisting) {
            result.skipped++;
            this.logger.log(
              `Skipping ${video.filename} - already exists in target`,
            );
            continue;
          }

          // Determine if we're replacing
          const isReplacing = !!existingVideo;
          const targetVideoId = existingVideo ? (existingVideo.id as string) : videoId;

          if (isReplacing) {
            result.replaced++;
            this.logger.log(`Replacing existing video: ${video.filename}`);
          }

          // Copy video file to target library's clips folder
          const sourceVideoPath = video.current_path as string;
          const targetVideoPath = path.join(
            targetLibrary.clipsFolderPath,
            (video.date_folder as string) || '',
            video.filename as string,
          );

          // Ensure target directory exists
          const targetDir = path.dirname(targetVideoPath);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          // Copy the video file (only if not already there)
          if (!fs.existsSync(targetVideoPath) || isReplacing) {
            fs.copyFileSync(sourceVideoPath, targetVideoPath);
          }

          // Insert or update video in target database
          if (isReplacing) {
            // Update existing video record
            this.databaseService.updateVideoPath(
              targetVideoId,
              targetVideoPath,
              video.date_folder as string | undefined,
            );
          } else {
            // Insert new video record
            this.databaseService.insertVideo({
              id: targetVideoId,
              filename: video.filename as string,
              fileHash: video.file_hash as string,
              currentPath: targetVideoPath,
              uploadDate: video.upload_date as string | undefined,
              downloadDate: video.download_date as string | undefined,
              durationSeconds: video.duration_seconds as number | undefined,
              fileSizeBytes: video.file_size_bytes as number | undefined,
              sourceUrl: video.source_url as string | undefined,
            });
          }

          // Copy transcript if exists
          if (transcript) {
            this.databaseService.insertTranscript({
              videoId: targetVideoId,
              plainText: transcript.plain_text as string,
              srtFormat: transcript.srt_format as string,
              whisperModel: transcript.whisper_model as string | undefined,
              language: transcript.language as string | undefined,
            });
          }

          // Copy analysis if exists
          if (analysis) {
            this.databaseService.insertAnalysis({
              videoId: targetVideoId,
              aiAnalysis: analysis.ai_analysis as string,
              summary: analysis.summary as string | undefined,
              sectionsCount: analysis.sections_count as number | undefined,
              aiModel: analysis.ai_model as string,
              aiProvider: analysis.ai_provider as string | undefined,
            });
          }

          // Copy analysis sections if exist
          if (analysisSections && analysisSections.length > 0) {
            for (const section of analysisSections) {
              this.databaseService.insertAnalysisSection({
                id: section.id as string,
                videoId: targetVideoId,
                startSeconds: section.start_seconds as number,
                endSeconds: section.end_seconds as number,
                timestampText: section.timestamp_text as string | undefined,
                title: section.title as string | undefined,
                description: section.description as string | undefined,
                category: section.category as string | undefined,
                source: (section.source as string) || 'ai',
              });
            }
          }

          // Copy tags if exist
          if (tags && tags.length > 0) {
            for (const tag of tags) {
              this.databaseService.insertTag({
                id: tag.id as string,
                videoId: targetVideoId,
                tagName: tag.tag_name as string,
                tagType: tag.tag_type as string | undefined,
                confidence: tag.confidence as number | undefined,
                source: tag.source as string | undefined,
              });
            }
          }

          result.transferred++;
          this.logger.log(
            `Successfully transferred ${video.filename} to ${targetLibrary.name}`,
          );

          // If moving (not copying), delete from source
          if (action === 'move') {
            // Switch back to source database
            await this.databaseService.initializeDatabase(
              sourceLibrary.databasePath,
            );

            // Delete the video and associated data
            this.databaseService.deleteVideo(videoId);

            // Delete the video file from source
            if (fs.existsSync(sourceVideoPath)) {
              fs.unlinkSync(sourceVideoPath);
            }

            this.logger.log(
              `Deleted ${video.filename} from source library`,
            );
          }
        } catch (error: any) {
          this.logger.error(`Failed to transfer video ${videoId}:`, error);
          result.errors.push(
            `Failed to transfer video ${videoId}: ${error.message}`,
          );
        }
      }

      // Restore original database
      if (currentDbPath) {
        await this.databaseService.initializeDatabase(currentDbPath);
      }

      this.logger.log(
        `Transfer complete: ${result.transferred} transferred, ${result.skipped} skipped, ${result.replaced} replaced, ${result.errors.length} errors`,
      );

      return result;
    } catch (error) {
      // Restore original database on error
      if (currentDbPath) {
        await this.databaseService.initializeDatabase(currentDbPath);
      }
      throw error;
    }
  }
}
