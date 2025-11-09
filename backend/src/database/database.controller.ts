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
   * POST /api/database/analysis-sections
   * Add a custom marker to a video
   */
  @Post('analysis-sections')
  async addAnalysisSection(
    @Body() body: {
      videoId: string;
      startSeconds: number;
      endSeconds: number;
      title?: string;
      description?: string;
      category?: string;
      source?: string;
    }
  ) {
    try {
      // Verify video exists
      const video = this.databaseService.getVideoById(body.videoId);
      if (!video) {
        return {
          success: false,
          error: 'Video not found'
        };
      }

      // Generate unique ID for the marker
      const { v4: uuidv4 } = require('uuid');
      const markerId = uuidv4();

      // Format timestamp text
      const formatTimestamp = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
      };

      const timestampText = `${formatTimestamp(body.startSeconds)} - ${formatTimestamp(body.endSeconds)}`;

      // Insert the custom marker into the custom_markers table
      this.databaseService.insertCustomMarker({
        id: markerId,
        videoId: body.videoId,
        startSeconds: body.startSeconds,
        endSeconds: body.endSeconds,
        timestampText,
        title: body.title || undefined,
        description: body.description || undefined,
        category: body.category || 'custom'
      });

      this.logger.log(`Added custom marker to video ${body.videoId}: ${timestampText}`);

      return {
        success: true,
        sectionId: markerId
      };
    } catch (error: any) {
      this.logger.error(`Error adding custom marker: ${error?.message || 'Unknown error'}`);
      return {
        success: false,
        error: error?.message || 'Failed to add custom marker'
      };
    }
  }

  /**
   * DELETE /api/database/videos/:videoId/sections/:sectionId
   * Delete a specific section (AI section or custom marker)
   */
  @Delete('videos/:videoId/sections/:sectionId')
  async deleteAnalysisSection(
    @Param('videoId') videoId: string,
    @Param('sectionId') sectionId: string
  ) {
    try {
      // Try to delete from analysis_sections first
      this.databaseService.deleteAnalysisSection(sectionId);

      // Also try to delete from custom_markers (one of them will succeed)
      try {
        this.databaseService.deleteCustomMarker(sectionId);
      } catch (e) {
        // Ignore if it doesn't exist in custom_markers
      }

      this.logger.log(`Deleted section ${sectionId} from video ${videoId}`);

      return {
        success: true,
        message: 'Section deleted successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to delete section ${sectionId}:`, error);
      return {
        success: false,
        error: error.message || 'Failed to delete section'
      };
    }
  }

  /**
   * GET /api/database/videos/:id/tags
   * Get all tags for a video
   */
  @Get('videos/:id/tags')
  getVideoTags(@Param('id') videoId: string) {
    const tags = this.databaseService.getTags(videoId);
    return {
      tags,
      count: tags.length
    };
  }

  /**
   * POST /api/database/videos/:id/tags
   * Add a tag to a video
   */
  @Post('videos/:id/tags')
  async addVideoTag(
    @Param('id') videoId: string,
    @Body() body: {
      tagName: string;
      tagType?: string;
      confidence?: number;
      source?: string
    }
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

      // Validate tag name
      if (!body.tagName || typeof body.tagName !== 'string' || body.tagName.trim() === '') {
        return {
          success: false,
          error: 'Valid tag name is required'
        };
      }

      // Insert tag
      const tagId = this.databaseService.insertTag(
        videoId,
        body.tagName.trim(),
        body.tagType || 'manual',
        body.confidence,
        body.source || 'user'
      );

      this.logger.log(`Added tag "${body.tagName}" to video ${videoId}`);

      return {
        success: true,
        tagId,
        message: 'Tag added successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to add tag to video ${videoId}:`, error);
      return {
        success: false,
        error: error.message || 'Failed to add tag'
      };
    }
  }

  /**
   * DELETE /api/database/videos/:id/tags/:tagId
   * Delete a specific tag from a video
   */
  @Delete('videos/:id/tags/:tagId')
  async deleteVideoTag(
    @Param('id') videoId: string,
    @Param('tagId') tagId: string
  ) {
    try {
      // Delete the tag
      this.databaseService.deleteTag(tagId);

      this.logger.log(`Deleted tag ${tagId} from video ${videoId}`);

      return {
        success: true,
        message: 'Tag deleted successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to delete tag ${tagId}:`, error);
      return {
        success: false,
        error: error.message || 'Failed to delete tag'
      };
    }
  }

  /**
   * DELETE /api/database/videos/:id/transcript
   * Delete transcript for a video
   */
  @Delete('videos/:id/transcript')
  deleteTranscript(@Param('id') videoId: string) {
    try {
      this.databaseService.deleteTranscript(videoId);
      return {
        success: true,
        message: 'Transcript deleted successfully'
      };
    } catch (error) {
      this.logger.error(`Failed to delete transcript for video ${videoId}:`, error);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * DELETE /api/database/videos/:id/analysis
   * Delete analysis for a video (including sections)
   */
  @Delete('videos/:id/analysis')
  deleteAnalysis(@Param('id') videoId: string) {
    try {
      this.databaseService.deleteAnalysis(videoId);
      return {
        success: true,
        message: 'Analysis deleted successfully'
      };
    } catch (error) {
      this.logger.error(`Failed to delete analysis for video ${videoId}:`, error);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * POST /api/database/videos/lookup-by-file
   * Lookup a video in the database by computing its hash
   * Returns video data with analysis and transcript if they exist
   */
  @Post('videos/lookup-by-file')
  async lookupVideoByFile(@Body() body: { filePath: string }) {
    try {
      if (!body.filePath) {
        return {
          success: false,
          error: 'File path is required'
        };
      }

      this.logger.log(`Looking up video by file: ${body.filePath}`);

      // Compute hash of the file
      const hash = await this.databaseService.hashFile(body.filePath);
      this.logger.log(`Computed hash: ${hash}`);

      // Look up video by hash
      const video = this.databaseService.findVideoByHash(hash);

      if (!video) {
        this.logger.log('No matching video found in database');
        return {
          success: true,
          found: false,
          hash
        };
      }

      const videoId = String(video.id);
      this.logger.log(`Found video in database: ${videoId}`);

      // Get analysis and transcript if they exist
      const analysis = this.databaseService.getAnalysis(videoId);
      const transcript = this.databaseService.getTranscript(videoId);
      const sections = this.databaseService.getAnalysisSections(videoId);

      return {
        success: true,
        found: true,
        hash,
        video,
        analysis: analysis || null,
        transcript: transcript || null,
        sections: sections || []
      };
    } catch (error: any) {
      this.logger.error(`Failed to lookup video by file: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to lookup video'
      };
    }
  }

  /**
   * PATCH /api/database/videos/:id/source-url
   * Update video source URL
   */
  @Patch('videos/:id/source-url')
  async updateVideoSourceUrl(
    @Param('id') videoId: string,
    @Body() body: { sourceUrl: string | null }
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

      this.databaseService.updateVideoSourceUrl(videoId, body.sourceUrl);

      return {
        success: true,
        message: 'Source URL updated successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to update source URL for video ${videoId}:`, error);
      return {
        success: false,
        error: error.message || 'Failed to update source URL'
      };
    }
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
   * PATCH /api/database/videos/:id/filename
   * Update video filename/title (renames both database record AND physical file)
   */
  @Patch('videos/:id/filename')
  async updateVideoFilename(
    @Param('id') videoId: string,
    @Body() body: { filename: string }
  ) {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      // Verify video exists
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        return {
          success: false,
          error: 'Video not found'
        };
      }

      // Validate filename
      if (!body.filename || typeof body.filename !== 'string' || body.filename.trim() === '') {
        return {
          success: false,
          error: 'Valid filename is required'
        };
      }

      const newFilename = body.filename.trim();
      const oldPath = video.current_path as string;

      // Skip if filename hasn't changed
      if (video.filename === newFilename) {
        return {
          success: true,
          message: 'Filename unchanged'
        };
      }

      // Get the directory path and construct new path
      const directory = path.dirname(oldPath);
      const newPath = path.join(directory, newFilename);

      // Check if new path already exists
      try {
        await fs.access(newPath);
        return {
          success: false,
          error: 'A file with this name already exists in the library'
        };
      } catch {
        // File doesn't exist, which is what we want
      }

      // Rename the physical file
      try {
        await fs.rename(oldPath, newPath);
        this.logger.log(`Renamed physical file: ${oldPath} -> ${newPath}`);
      } catch (error: any) {
        this.logger.error(`Failed to rename physical file: ${error.message}`);
        return {
          success: false,
          error: `Failed to rename file: ${error.message}`
        };
      }

      // Update database with new filename and path
      this.databaseService.updateVideoFilename(videoId, newFilename);
      this.databaseService.updateVideoPath(videoId, newPath);

      this.logger.log(`Updated filename for video ${videoId}: ${newFilename}`);

      return {
        success: true,
        message: 'Video filename updated successfully',
        newPath: newPath
      };
    } catch (error: any) {
      this.logger.error(`Failed to update video filename: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to update video filename'
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
   * POST /api/database/prune
   * Prune orphaned videos from the database
   * Deletes all videos marked as unlinked (is_linked = 0)
   */
  @Post('prune')
  pruneOrphanedVideos() {
    this.logger.log('Pruning orphaned videos from database');
    const result = this.databaseService.pruneOrphanedVideos();
    return {
      success: true,
      deletedCount: result.deletedCount,
      deletedVideos: result.deletedVideos,
      message: result.deletedCount > 0
        ? `Pruned ${result.deletedCount} orphaned video${result.deletedCount > 1 ? 's' : ''} from database`
        : 'No orphaned videos to prune'
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

  /**
   * POST /api/database/transfer-videos
   * Transfer (move or copy) videos from current library to another library
   */
  @Post('transfer-videos')
  async transferVideos(@Body() body: {
    videoIds: string[];
    targetLibraryId: string;
    action: 'move' | 'copy';
    replaceExisting: boolean;
  }) {
    try {
      this.logger.log(
        `Transferring ${body.videoIds?.length || 0} videos to library ${body.targetLibraryId} (${body.action})`,
      );

      if (!body.videoIds || !Array.isArray(body.videoIds) || body.videoIds.length === 0) {
        return {
          success: false,
          error: 'videoIds array is required',
        };
      }

      if (!body.targetLibraryId) {
        return {
          success: false,
          error: 'targetLibraryId is required',
        };
      }

      if (!body.action || !['move', 'copy'].includes(body.action)) {
        return {
          success: false,
          error: 'action must be "move" or "copy"',
        };
      }

      const result = await this.libraryManagerService.transferVideos(
        body.videoIds,
        body.targetLibraryId,
        body.action,
        body.replaceExisting ?? false,
      );

      return {
        success: true,
        transferred: result.transferred,
        skipped: result.skipped,
        replaced: result.replaced,
        errors: result.errors,
        message: `${body.action === 'move' ? 'Moved' : 'Copied'} ${result.transferred} video${result.transferred !== 1 ? 's' : ''}`,
      };
    } catch (error: any) {
      this.logger.error('Transfer failed:', error);
      return {
        success: false,
        error: error.message || 'Failed to transfer videos',
      };
    }
  }
}
