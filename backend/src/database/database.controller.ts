import { Controller, Get, Post, Delete, Patch, Logger, Body, Query, Param } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { MigrationService } from './migration.service';
import { BatchAnalysisService } from './batch-analysis.service';
import { LibraryManagerService } from './library-manager.service';

/**
 * DatabaseController - REST API endpoints for database operations
 *
 * Provides:
 * - Database statistics
 * - Trigger library scans
 * - Get videos needing analysis
 * - Batch analysis operations
 * - Migration from legacy library.json (optional)
 */
@Controller('database')
export class DatabaseController {
  private readonly logger = new Logger(DatabaseController.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly fileScannerService: FileScannerService,
    private readonly migrationService: MigrationService,
    private readonly batchAnalysisService: BatchAnalysisService,
    private readonly libraryManagerService: LibraryManagerService,
  ) {}

  /**
   * GET /api/database/stats
   * Get database statistics (video counts, etc.)
   */
  @Get('stats')
  getStats() {
    return this.databaseService.getStats();
  }

  /**
   * POST /api/database/scan
   * Trigger a full library scan
   */
  @Post('scan')
  async scanLibrary(@Body() body?: { clipsFolder?: string }) {
    this.logger.log('Manual library scan triggered');
    const clipsFolder = body?.clipsFolder || undefined;
    const result = await this.fileScannerService.scanClipsFolder(clipsFolder);
    return {
      success: true,
      ...result,
    };
  }

  /**
   * GET /api/database/unimported
   * Get list of videos in active library's clips folder that aren't in database yet
   */
  @Get('unimported')
  async getUnimportedVideos() {
    this.logger.log('Checking for unimported videos in active library');

    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      return {
        success: false,
        error: 'No active library',
        count: 0,
        videos: [],
      };
    }

    const videos = await this.fileScannerService.getUnimportedVideos(
      activeLibrary.clipsFolderPath,
    );
    return {
      success: true,
      count: videos.length,
      videos,
    };
  }

  /**
   * POST /api/database/import
   * Import selected videos into the database
   */
  @Post('import')
  async importVideos(@Body() body: { videoPaths: string[] }) {
    this.logger.log(`Importing ${body.videoPaths?.length || 0} videos`);

    if (!body.videoPaths || !Array.isArray(body.videoPaths)) {
      return {
        success: false,
        error: 'videoPaths array is required',
      };
    }

    const result = await this.fileScannerService.importVideos(body.videoPaths);
    return {
      success: true,
      imported: result.imported,
      importedCount: result.imported.length,
      errors: result.errors,
      errorCount: result.errors.length,
    };
  }

  /**
   * GET /api/database/needs-analysis
   * Get list of videos that need transcription or analysis
   */
  @Get('needs-analysis')
  async getNeedsAnalysis() {
    const videos = await this.fileScannerService.getNeedsAnalysis();
    const count = this.fileScannerService.getNeedsAnalysisCount();

    return {
      count,
      videos,
    };
  }

  /**
   * GET /api/database/videos
   * Get all videos with optional filters
   */
  @Get('videos')
  getVideos(@Query('tags') tags?: string) {
    let videos = this.databaseService.getAllVideos({
      linkedOnly: true,
    });

    // Filter by tags if specified
    if (tags) {
      const tagNames = tags.split(',').filter(Boolean);
      if (tagNames.length > 0) {
        // Get video IDs that have these tags
        const videoIds = this.databaseService.getVideoIdsByTags(tagNames);
        videos = videos.filter((v: any) => videoIds.includes(v.id));
      }
    }

    return {
      videos,
      count: videos.length,
    };
  }

  /**
   * GET /api/database/tags
   * Get all tags with counts (grouped by type)
   */
  @Get('tags')
  getTags() {
    return this.databaseService.getAllTagsWithCounts();
  }

  /**
   * GET /api/database/videos/:id/has-analysis
   * Check if a video has an analysis
   */
  @Get('videos/:id/has-analysis')
  hasAnalysis(@Param('id') videoId: string) {
    const analysis = this.databaseService.getAnalysis(videoId);
    return {
      exists: !!analysis
    };
  }

  /**
   * GET /api/database/videos/:id/has-transcript
   * Check if a video has a transcript
   */
  @Get('videos/:id/has-transcript')
  hasTranscript(@Param('id') videoId: string) {
    const transcript = this.databaseService.getTranscript(videoId);
    return {
      exists: !!transcript
    };
  }

  /**
   * GET /api/database/videos/:id/analysis
   * Get analysis for a video
   */
  @Get('videos/:id/analysis')
  getAnalysis(@Param('id') videoId: string) {
    const analysis = this.databaseService.getAnalysis(videoId);
    if (!analysis) {
      return {
        success: false,
        error: 'Analysis not found'
      };
    }
    return analysis;
  }

  /**
   * GET /api/database/videos/:id/transcript
   * Get transcript for a video
   */
  @Get('videos/:id/transcript')
  getTranscript(@Param('id') videoId: string) {
    const transcript = this.databaseService.getTranscript(videoId);
    if (!transcript) {
      return {
        success: false,
        error: 'Transcript not found'
      };
    }
    return transcript;
  }

  /**
   * GET /api/database/videos/:id/sections
   * Get analysis sections for a video
   */
  @Get('videos/:id/sections')
  getAnalysisSections(@Param('id') videoId: string) {
    const sections = this.databaseService.getAnalysisSections(videoId);
    return {
      sections,
      count: sections.length
    };
  }

  /**
   * PATCH /api/database/videos/:id/metadata
   * Update video metadata (date_folder and added_at)
   */
  @Patch('videos/:id/metadata')
  async updateVideoMetadata(
    @Param('id') videoId: string,
    @Body() body: { dateFolder: string | null; addedAt: string }
  ) {
    try {
      // Verify video exists
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        return {
          success: false,
          error: 'Video not found'
        };
      }

      // Update metadata
      this.databaseService.updateVideoMetadata(videoId, body.dateFolder, body.addedAt);

      this.logger.log(`Updated metadata for video ${videoId}: dateFolder=${body.dateFolder}, addedAt=${body.addedAt}`);

      return {
        success: true,
        message: 'Video metadata updated successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to update video metadata: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to update video metadata'
      };
    }
  }

  /**
   * DELETE /api/database/videos/:id
   * Delete a video from the library (both database record AND physical file)
   */
  @Delete('videos/:id')
  async deleteVideo(@Param('id') videoId: string) {
    try {
      // Delete from database and get video info (includes file path)
      const video = this.databaseService.deleteVideo(videoId);

      // Delete physical file from library folder
      const fs = require('fs').promises;
      const videoPath = video.current_path;

      if (videoPath) {
        try {
          await fs.unlink(videoPath);
          this.logger.log(`Deleted physical file: ${videoPath}`);
        } catch (fileError: any) {
          // File might already be deleted or not exist - log but don't fail
          this.logger.warn(`Could not delete physical file ${videoPath}: ${fileError.message}`);
        }
      }

      this.logger.log(`Deleted video ${videoId} from library (database and file)`);

      return {
        success: true,
        message: 'Video deleted successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to delete video: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to delete video'
      };
    }
  }

  /**
   * GET /api/database/migration/check
   * Check if migration from library.json is needed/possible
   */
  @Get('migration/check')
  async checkMigration() {
    const shouldMigrate = await this.migrationService.shouldMigrate();
    return {
      shouldMigrate,
      message: shouldMigrate
        ? 'Migration available: library.json found and database is empty'
        : 'Migration not needed or already completed',
    };
  }

  /**
   * POST /api/database/migration/run
   * Run migration from library.json to database (optional, for future use)
   */
  @Post('migration/run')
  async runMigration() {
    this.logger.log('Migration triggered by user');

    const shouldMigrate = await this.migrationService.shouldMigrate();
    if (!shouldMigrate) {
      return {
        success: false,
        message: 'Migration not needed or already completed',
      };
    }

    // Create backup first
    const backupPath = await this.migrationService.backupLibrary();

    // Run migration
    const result = await this.migrationService.migrate();

    return {
      success: true,
      backupPath,
      ...result,
    };
  }

  /**
   * POST /api/database/batch/start
   * Start batch analysis of all videos
   */
  @Post('batch/start')
  async startBatchAnalysis(
    @Body() options?: {
      aiModel?: string;
      aiProvider?: 'ollama' | 'claude' | 'openai';
      whisperModel?: string;
      ollamaEndpoint?: string;
      limit?: number;
      videoIds?: string[];
      transcribeOnly?: boolean;
      forceReanalyze?: boolean;
      claudeApiKey?: string;
      openaiApiKey?: string;
    },
  ) {
    this.logger.log(`Starting batch ${options?.transcribeOnly ? 'transcription' : 'analysis'}`);
    const jobId = await this.batchAnalysisService.startBatchAnalysis(options);
    return {
      success: true,
      jobId,
      message: options?.transcribeOnly ? 'Batch transcription started' : 'Batch analysis started',
    };
  }

  /**
   * GET /api/database/batch/progress
   * Get current batch analysis progress
   */
  @Get('batch/progress')
  getBatchProgress() {
    const progress = this.batchAnalysisService.getBatchProgress();
    if (!progress) {
      return {
        running: false,
        message: 'No batch job currently running',
      };
    }
    return {
      running: true,
      ...progress,
    };
  }

  /**
   * POST /api/database/batch/pause
   * Pause the current batch analysis
   */
  @Post('batch/pause')
  pauseBatch() {
    const success = this.batchAnalysisService.pauseBatch();
    return {
      success,
      message: success ? 'Batch paused' : 'No running batch to pause',
    };
  }

  /**
   * POST /api/database/batch/resume
   * Resume a paused batch analysis
   */
  @Post('batch/resume')
  async resumeBatch() {
    const success = await this.batchAnalysisService.resumeBatch();
    return {
      success,
      message: success ? 'Batch resumed' : 'No paused batch to resume',
    };
  }

  /**
   * POST /api/database/batch/stop
   * Stop the current batch analysis
   */
  @Post('batch/stop')
  stopBatch() {
    const success = this.batchAnalysisService.stopBatch();
    return {
      success,
      message: success ? 'Batch stopped' : 'No running batch to stop',
    };
  }

  /**
   * GET /api/database/libraries
   * Get all clip libraries
   */
  @Get('libraries')
  getAllLibraries() {
    const startTime = Date.now();
    this.logger.log('[getAllLibraries] Request received');

    const t1 = Date.now();
    const libraries = this.libraryManagerService.getAllLibraries();
    this.logger.log(`[getAllLibraries] getAllLibraries() took ${Date.now() - t1}ms, found ${libraries.length} libraries`);

    const t2 = Date.now();
    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    this.logger.log(`[getAllLibraries] getActiveLibrary() took ${Date.now() - t2}ms, active: ${activeLibrary?.name || 'none'}`);

    const response = {
      libraries,
      activeLibrary,
    };

    this.logger.log(`[getAllLibraries] Total request took ${Date.now() - startTime}ms`);
    return response;
  }

  /**
   * GET /api/database/libraries/active
   * Get the active library
   */
  @Get('libraries/active')
  getActiveLibrary() {
    const library = this.libraryManagerService.getActiveLibrary();
    return {
      library,
      isDatabaseReady: this.libraryManagerService.isDatabaseReady(),
    };
  }

  /**
   * POST /api/database/libraries
   * Create a new clip library
   */
  @Post('libraries')
  async createLibrary(@Body() body: { name: string; clipsFolderPath: string }) {
    if (!body.name || typeof body.name !== 'string') {
      return {
        success: false,
        error: 'Library name is required',
      };
    }

    if (!body.clipsFolderPath || typeof body.clipsFolderPath !== 'string') {
      return {
        success: false,
        error: 'Clips folder path is required',
      };
    }

    const library = await this.libraryManagerService.createLibrary(
      body.name,
      body.clipsFolderPath,
    );
    return {
      success: true,
      library,
    };
  }

  /**
   * POST /api/database/libraries/:id/switch
   * Switch to a different library
   */
  @Post('libraries/:id/switch')
  async switchLibrary(@Param('id') id: string) {
    const success = await this.libraryManagerService.switchLibrary(id);
    return {
      success,
      message: success ? 'Library switched' : 'Library not found',
    };
  }

  /**
   * PATCH /api/database/libraries/:id
   * Rename a library
   */
  @Patch('libraries/:id')
  renameLibrary(@Param('id') id: string, @Body() body: { name: string }) {
    if (!body.name || typeof body.name !== 'string') {
      return {
        success: false,
        error: 'Library name is required',
      };
    }

    const success = this.libraryManagerService.renameLibrary(id, body.name);
    return {
      success,
      message: success ? 'Library renamed' : 'Library not found',
    };
  }

  /**
   * DELETE /api/database/libraries/:id
   * Delete a library
   */
  @Delete('libraries/:id')
  async deleteLibrary(
    @Param('id') id: string,
    @Query('deleteFiles') deleteFiles?: string,
  ) {
    try {
      const shouldDeleteFiles = deleteFiles === 'true';
      const success = await this.libraryManagerService.deleteLibrary(
        id,
        shouldDeleteFiles,
      );
      return {
        success,
        message: success ? 'Library deleted' : 'Library not found',
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
