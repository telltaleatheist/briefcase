import { Controller, Get, Post, Delete, Patch, Logger, Body, Query, Param, Res, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { MigrationService } from './migration.service';
import { AnalysisService } from '../analysis/analysis.service';
import { LibraryManagerService } from './library-manager.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { MediaEventService } from '../media/media-event.service';

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
    private readonly analysisService: AnalysisService,
    private readonly libraryManagerService: LibraryManagerService,
    private readonly ffmpegService: FfmpegService,
    private readonly mediaEventService: MediaEventService,
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
  /**
   * POST /api/database/check-duplicates
   * Check for duplicate videos before importing
   */
  @Post('check-duplicates')
  async checkDuplicates(@Body() body: { videoPaths: string[] }) {
    this.logger.log(`Checking ${body.videoPaths?.length || 0} videos for duplicates`);

    if (!body.videoPaths || !Array.isArray(body.videoPaths)) {
      return {
        success: false,
        error: 'videoPaths array is required',
      };
    }

    const result = await this.fileScannerService.checkDuplicates(body.videoPaths);
    return {
      success: true,
      duplicates: result.duplicates,
      unique: result.unique,
      duplicateCount: result.duplicates.length,
      uniqueCount: result.unique.length,
    };
  }

  @Post('import')
  async importVideos(@Body() body: {
    videoPaths: string[];
    duplicateHandling?: { [key: string]: 'skip' | 'replace' | 'keep-both' };
  }) {
    this.logger.log(`Importing ${body.videoPaths?.length || 0} videos`);

    if (!body.videoPaths || !Array.isArray(body.videoPaths)) {
      return {
        success: false,
        error: 'videoPaths array is required',
      };
    }

    // Convert duplicateHandling object to Map
    let handlingMap: Map<string, 'skip' | 'replace' | 'keep-both'> | undefined;
    if (body.duplicateHandling) {
      handlingMap = new Map(Object.entries(body.duplicateHandling));
    }

    const result = await this.fileScannerService.importVideos(body.videoPaths, handlingMap);
    return {
      success: true,
      imported: result.imported,
      importedCount: result.imported.length,
      skipped: result.skipped,
      skippedCount: result.skipped.length,
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
  getVideos(
    @Query('tags') tags?: string,
    @Query('linkedOnly') linkedOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('hierarchical') hierarchical?: string
  ) {
    // Default to linked only unless explicitly set to false
    const shouldFilterLinked = linkedOnly === 'false' ? false : true;

    // If hierarchical mode is requested, use getAllVideosHierarchical
    let videos: any[];
    if (hierarchical === 'true') {
      videos = this.databaseService.getAllVideosHierarchical({
        linkedOnly: shouldFilterLinked,
      });
    } else {
      videos = this.databaseService.getAllVideos({
        linkedOnly: shouldFilterLinked,
      });
    }

    // Filter by tags if specified
    if (tags) {
      const tagNames = tags.split(',').filter(Boolean);
      if (tagNames.length > 0) {
        // Get video IDs that have these tags
        const videoIds = this.databaseService.getVideoIdsByTags(tagNames);
        videos = videos.filter((v: any) => videoIds.includes(v.id));
      }
    }

    const totalCount = videos.length;

    // Apply pagination if limit/offset provided
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const offsetNum = offset ? parseInt(offset, 10) : 0;

    if (limitNum !== undefined && limitNum > 0) {
      videos = videos.slice(offsetNum, offsetNum + limitNum);
    }

    return {
      videos,
      count: totalCount, // Return total count, not paginated count
    };
  }

  /**
   * GET /api/database/search
   * Search videos across filename, AI description, transcripts, analyses, and tags
   */
  @Get('search')
  searchVideos(
    @Query('q') query: string,
    @Query('limit') limit?: string,
    @Query('filename') searchFilename?: string,
    @Query('aiDescription') searchAiDescription?: string,
    @Query('transcript') searchTranscript?: string,
    @Query('analysis') searchAnalysis?: string,
    @Query('tags') searchTags?: string,
  ) {
    if (!query || query.trim() === '') {
      return {
        results: [],
        count: 0,
        query: query || '',
      };
    }

    const limitNum = limit ? parseInt(limit, 10) : 1000;

    // Parse filter flags (default to true if not specified)
    const filters = {
      filename: searchFilename !== 'false',
      aiDescription: searchAiDescription !== 'false',
      transcript: searchTranscript !== 'false',
      analysis: searchAnalysis !== 'false',
      tags: searchTags !== 'false',
    };

    const searchResults = this.databaseService.searchVideos(query, limitNum, filters);

    // Get full video details for each result
    const videos = searchResults.map(result => {
      const video = this.databaseService.getVideoById(result.id);
      if (!video) {
        return null;
      }
      return {
        ...video,
        searchScore: result.score,
        matchType: result.matchType,
      };
    }).filter((v): v is NonNullable<typeof v> => v !== null); // Filter out any null results

    return {
      results: videos,
      count: videos.length,
      query,
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
   * GET /api/database/videos/:id
   * Get a single video by ID
   */
  @Get('videos/:id')
  getVideoById(@Param('id') videoId: string) {
    const video = this.databaseService.getVideoById(videoId);
    if (!video) {
      throw new NotFoundException(`Video not found: ${videoId}`);
    }
    return video;
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
   * Update video metadata (upload_date and added_at)
   */
  @Patch('videos/:id/metadata')
  async updateVideoMetadata(
    @Param('id') videoId: string,
    @Body() body: { uploadDate: string | null; addedAt: string }
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
      this.databaseService.updateVideoMetadata(videoId, body.uploadDate, body.addedAt);

      this.logger.log(`Updated metadata for video ${videoId}: uploadDate=${body.uploadDate}, addedAt=${body.addedAt}`);

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

      // Emit WebSocket event to notify frontend of the rename
      this.mediaEventService.emitVideoRenamed(
        videoId,
        video.filename as string,
        newFilename,
        newPath
      );

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
   * POST /api/database/videos/:id/accept-suggested-title
   * Accept the AI-suggested title and rename the file
   */
  @Post('videos/:id/accept-suggested-title')
  async acceptSuggestedTitle(
    @Param('id') videoId: string
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

      // Check if video has a suggested title
      if (!video.suggested_title) {
        return {
          success: false,
          error: 'No suggested title available for this video'
        };
      }

      // Format the new filename: YYYY-MM-DD [suggested-title].ext
      const uploadDate = video.upload_date || '';
      const extension = video.file_extension || '.mp4';
      const suggestedTitle = String(video.suggested_title || '').trim();

      let newFilename: string;
      if (uploadDate) {
        newFilename = `${uploadDate} ${suggestedTitle}${extension}`;
      } else {
        newFilename = `${suggestedTitle}${extension}`;
      }

      const oldPath = video.current_path as string;
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
        this.logger.log(`Renamed physical file (suggested title): ${oldPath} -> ${newPath}`);
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

      // Clear the suggested_title since it's been accepted
      this.databaseService.updateVideoSuggestedTitle(videoId, null);

      this.logger.log(`Accepted suggested title for video ${videoId}: ${newFilename}`);

      // Emit WebSocket event to notify frontend of the rename
      this.mediaEventService.emitVideoRenamed(
        videoId,
        video.filename as string,
        newFilename,
        newPath
      );

      return {
        success: true,
        message: 'Video renamed successfully with suggested title',
        newPath: newPath,
        newFilename: newFilename
      };
    } catch (error: any) {
      this.logger.error(`Failed to accept suggested title: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to accept suggested title'
      };
    }
  }

  /**
   * DELETE /api/database/videos/:id
   * Delete a video from the library (both database record AND physical file)
   */
  @Delete('videos/:id')
  async deleteVideo(
    @Param('id') videoId: string,
    @Query('deleteFiles') deleteFiles?: string
  ) {
    try {
      // Delete from database and get video info (includes file path)
      const video = this.databaseService.deleteVideo(videoId);

      // Only delete physical file if deleteFiles parameter is 'true'
      const shouldDeleteFiles = deleteFiles === 'true';

      if (shouldDeleteFiles) {
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
      } else {
        this.logger.log(`Removed video ${videoId} from library (database only, file kept)`);
      }

      return {
        success: true,
        message: shouldDeleteFiles ? 'Video deleted successfully' : 'Video removed from library'
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
   * POST /api/database/videos/delete-batch
   * Delete multiple videos from the library in a batch operation
   */
  @Post('videos/delete-batch')
  async deleteVideoBatch(
    @Body() body: { videoIds: string[]; deleteFiles?: boolean }
  ) {
    try {
      if (!body.videoIds || !Array.isArray(body.videoIds) || body.videoIds.length === 0) {
        return {
          success: false,
          error: 'videoIds array is required',
          successCount: 0,
          errorCount: 0,
        };
      }

      const deleteFiles = body.deleteFiles === true;
      let successCount = 0;
      let errorCount = 0;
      const errors: Array<{ videoId: string; error: string }> = [];

      // Process deletions
      for (const videoId of body.videoIds) {
        try {
          // Delete from database
          const video = this.databaseService.deleteVideo(videoId);

          // Delete physical file if requested
          if (deleteFiles && video.current_path) {
            const fs = require('fs').promises;
            try {
              await fs.unlink(video.current_path);
              this.logger.log(`Deleted physical file: ${video.current_path}`);
            } catch (fileError: any) {
              // File might already be deleted - log but don't fail
              this.logger.warn(`Could not delete physical file ${video.current_path}: ${fileError.message}`);
            }
          }

          successCount++;
        } catch (error: any) {
          this.logger.error(`Failed to delete video ${videoId}: ${error.message}`);
          errorCount++;
          errors.push({
            videoId,
            error: error.message || 'Unknown error'
          });
        }
      }

      this.logger.log(
        `Batch delete complete: ${successCount} succeeded, ${errorCount} failed (deleteFiles: ${deleteFiles})`
      );

      return {
        success: successCount > 0,
        successCount,
        errorCount,
        errors: errors.length > 0 ? errors : undefined,
        message: successCount > 0
          ? `${deleteFiles ? 'Deleted' : 'Removed'} ${successCount} video${successCount > 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} failed` : ''}`
          : `Failed to delete any videos (${errorCount} errors)`
      };
    } catch (error: any) {
      this.logger.error(`Batch delete operation failed: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Batch delete operation failed',
        successCount: 0,
        errorCount: body.videoIds?.length || 0,
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
    const result = await this.analysisService.startBatchAnalysis(options || {});
    return {
      success: true,
      batchId: result.batchId,
      jobIds: result.jobIds,
      totalJobs: result.jobIds.length,
      message: options?.transcribeOnly ? 'Batch transcription started' : 'Batch analysis started',
    };
  }

  /**
   * POST /api/database/batch/queue
   * Queue videos for analysis without starting processing
   * Note: This currently just starts the batch immediately like /batch/start
   * TODO: Implement true queueing without auto-start if needed
   */
  @Post('batch/queue')
  async queueVideosForAnalysis(
    @Body() options: {
      videoIds: string[];
      transcribeOnly?: boolean;
      forceReanalyze?: boolean;
    },
  ) {
    this.logger.log(`Queueing ${options.videoIds.length} videos for ${options?.transcribeOnly ? 'transcription' : 'analysis'}`);

    // For now, use the analysis service's batch start
    // This adds jobs to the queue system
    const result = await this.analysisService.startBatchAnalysis({
      videoIds: options.videoIds,
      transcribeOnly: options.transcribeOnly,
      forceReanalyze: options.forceReanalyze,
    });

    return {
      success: true,
      jobId: result.batchId,
      message: `${options.videoIds.length} video(s) queued for ${options?.transcribeOnly ? 'transcription' : 'analysis'}`,
    };
  }

  /**
   * GET /api/database/batch/progress
   * Get batch analysis progress for specific job IDs
   */
  @Get('batch/progress')
  getBatchProgress(@Query('jobIds') jobIds?: string) {
    if (!jobIds) {
      return {
        running: false,
        message: 'No batch job IDs provided',
      };
    }

    const jobIdArray = jobIds.split(',');
    const progress = this.analysisService.getBatchProgress(jobIdArray);

    return {
      running: progress.processing > 0 || progress.pending > 0,
      ...progress,
    };
  }

  /**
   * POST /api/database/batch/pause
   * Pause the current batch analysis (deprecated - kept for compatibility)
   */
  @Post('batch/pause')
  pauseBatch() {
    // This functionality is deprecated with the new queue system
    // Jobs are automatically managed by the queue
    return {
      success: false,
      message: 'Batch pause/resume is no longer supported with the new queue system',
    };
  }

  /**
   * POST /api/database/batch/resume
   * Resume a paused batch analysis (deprecated - kept for compatibility)
   */
  @Post('batch/resume')
  async resumeBatch() {
    return {
      success: false,
      message: 'Batch pause/resume is no longer supported with the new queue system',
    };
  }

  /**
   * POST /api/database/batch/stop
   * Stop the current batch analysis (deprecated - kept for compatibility)
   */
  @Post('batch/stop')
  stopBatch() {
    return {
      success: false,
      message: 'Batch stop is no longer supported with the new queue system',
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
   * POST /api/database/populate-durations
   * Populate missing video durations for existing videos
   * Useful for migrating videos that were imported before duration extraction was implemented
   */
  @Post('populate-durations')
  async populateMissingDurations() {
    this.logger.log('Populating missing video durations');
    const result = await this.fileScannerService.populateMissingDurations();
    return {
      success: true,
      total: result.total,
      updated: result.updated,
      failed: result.failed,
      errors: result.errors,
      message: result.total === 0
        ? 'All videos already have duration information'
        : `Populated duration for ${result.updated} of ${result.total} videos${result.failed > 0 ? ` (${result.failed} failed)` : ''}`
    };
  }

  /**
   * POST /api/database/prune-selected
   * Delete selected orphaned videos from the database
   */
  @Post('prune-selected')
  pruneSelectedVideos(@Body() body: { videoIds: string[] }) {
    this.logger.log(`Pruning ${body.videoIds?.length || 0} selected orphaned videos`);

    if (!body.videoIds || !Array.isArray(body.videoIds) || body.videoIds.length === 0) {
      return {
        success: false,
        error: 'videoIds array is required',
        deletedCount: 0,
      };
    }

    let deletedCount = 0;
    for (const videoId of body.videoIds) {
      try {
        this.databaseService.deleteVideo(videoId);
        deletedCount++;
      } catch (error: any) {
        this.logger.warn(`Failed to delete video ${videoId}: ${error.message}`);
      }
    }

    return {
      success: true,
      deletedCount,
      message: deletedCount > 0
        ? `Deleted ${deletedCount} orphaned video${deletedCount > 1 ? 's' : ''} from database`
        : 'No videos were deleted'
    };
  }

  /**
   * POST /api/database/relink
   * Attempt to relink orphaned videos by searching for them recursively
   * - autoScan: true -> search in existing library directories
   * - searchFolder: provided -> search in specified folder recursively
   */
  @Post('relink')
  async relinkOrphanedVideos(@Body() body: {
    videoIds: string[];
    searchFolder?: string;
    newFolder?: string; // Keep for backwards compatibility
    autoScan?: boolean;
    recursive?: boolean; // Ignored, always recursive
  }) {
    const folder = body.searchFolder || body.newFolder;
    this.logger.log(`Attempting to relink ${body.videoIds?.length || 0} orphaned videos (autoScan: ${body.autoScan}, folder: ${folder})`);

    if (!body.videoIds || !Array.isArray(body.videoIds) || body.videoIds.length === 0) {
      return {
        success: false,
        error: 'videoIds array is required',
        relinkedCount: 0,
        failedCount: 0,
      };
    }

    // If not auto-scanning, folder is required
    if (!body.autoScan && !folder) {
      return {
        success: false,
        error: 'searchFolder path is required',
        relinkedCount: 0,
        failedCount: 0,
      };
    }

    // Check if the folder exists (if provided)
    if (folder && !fs.existsSync(folder)) {
      return {
        success: false,
        error: 'The specified folder does not exist',
        relinkedCount: 0,
        failedCount: 0,
      };
    }

    // Helper: Recursively search for video files in a folder
    const findVideosRecursively = (dir: string, fileMap: Map<string, string>) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Recursively search subdirectories
            findVideosRecursively(fullPath, fileMap);
          } else if (entry.isFile()) {
            // Add file to map with filename as key
            fileMap.set(entry.name, fullPath);
          }
        }
      } catch (error: any) {
        this.logger.warn(`Could not read directory ${dir}: ${error.message}`);
      }
    };

    // Build a map of all video files in the directory tree
    const videoFileMap = new Map<string, string>();

    if (body.autoScan) {
      // Auto-scan: search in existing library directories
      const allVideos = this.databaseService.getAllVideos();
      const libraryDirs = new Set<string>();

      // Get all unique directories from existing videos
      for (const video of allVideos) {
        if (video.file_path) {
          const dir = path.dirname(video.file_path);
          libraryDirs.add(dir);
        }
      }

      this.logger.log(`Auto-scanning ${libraryDirs.size} library directories`);

      // Scan each library directory
      for (const dir of libraryDirs) {
        if (fs.existsSync(dir)) {
          findVideosRecursively(dir, videoFileMap);
        }
      }

      this.logger.log(`Found ${videoFileMap.size} files in library directories`);
    } else if (folder) {
      // Manual folder search
      findVideosRecursively(folder, videoFileMap);
      this.logger.log(`Found ${videoFileMap.size} files in ${folder} (recursive)`);
    }

    let relinkedCount = 0;
    let failedCount = 0;
    const notFoundIds: string[] = [];

    // Create case-insensitive lookup map
    const caseInsensitiveMap = new Map<string, string>();
    for (const [filename, fullPath] of videoFileMap.entries()) {
      caseInsensitiveMap.set(filename.toLowerCase(), fullPath);
    }

    for (const videoId of body.videoIds) {
      try {
        const video = this.databaseService.getVideoById(videoId);
        if (!video) {
          failedCount++;
          notFoundIds.push(videoId);
          continue;
        }

        const filename = video.filename as string;
        this.logger.log(`Searching for: "${filename}"`);

        let foundPath: string | undefined;

        // Try 1: Exact match
        if (videoFileMap.has(filename)) {
          foundPath = videoFileMap.get(filename)!;
          this.logger.log(`Found via exact match`);
        }

        // Try 2: Case-insensitive match
        if (!foundPath && caseInsensitiveMap.has(filename.toLowerCase())) {
          foundPath = caseInsensitiveMap.get(filename.toLowerCase())!;
          this.logger.log(`Found via case-insensitive match`);
        }

        // Try 3: Match on basename without extension
        if (!foundPath) {
          const baseWithoutExt = path.basename(filename, path.extname(filename));
          for (const [mapFilename, mapPath] of videoFileMap.entries()) {
            const mapBaseWithoutExt = path.basename(mapFilename, path.extname(mapFilename));
            if (baseWithoutExt.toLowerCase() === mapBaseWithoutExt.toLowerCase()) {
              foundPath = mapPath;
              this.logger.log(`Found via basename match: "${mapFilename}"`);
              break;
            }
          }
        }

        if (foundPath) {
          // Update the video path (this also marks it as linked)
          this.databaseService.updateVideoPath(videoId, foundPath);
          relinkedCount++;
          this.logger.log(`Relinked video ${videoId}: ${foundPath}`);
        } else {
          failedCount++;
          notFoundIds.push(videoId);
          this.logger.warn(`Could not find video "${filename}" in ${videoFileMap.size} scanned files`);
        }
      } catch (error: any) {
        this.logger.error(`Failed to relink video ${videoId}: ${error.message}`);
        failedCount++;
        notFoundIds.push(videoId);
      }
    }

    return {
      success: relinkedCount > 0 || failedCount === 0,
      relinkedCount,
      failedCount,
      notFoundIds,
      message: relinkedCount > 0
        ? `Relinked ${relinkedCount} video${relinkedCount > 1 ? 's' : ''}${failedCount > 0 ? `, ${failedCount} failed` : ''}`
        : `Could not find videos in ${body.autoScan ? 'library' : 'selected folder'}`
    };
  }

  /**
   * POST /api/database/scan-directory
   * Scan a directory for videos that haven't been imported yet
   */
  @Post('scan-directory')
  async scanDirectoryForUnimportedVideos(@Body() body: { directoryPath: string }) {
    this.logger.log(`Scanning directory for unimported videos: ${body.directoryPath}`);

    if (!body.directoryPath || typeof body.directoryPath !== 'string') {
      return {
        success: false,
        error: 'directoryPath is required',
        videos: [],
        total: 0,
        alreadyImported: 0
      };
    }

    // Check if directory exists
    if (!fs.existsSync(body.directoryPath)) {
      return {
        success: false,
        error: 'Directory does not exist',
        videos: [],
        total: 0,
        alreadyImported: 0
      };
    }

    try {
      // Video extensions to search for
      const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv'];

      // Recursively find all video files in the directory
      const findVideosRecursively = (dir: string, files: Array<{ filename: string; fullPath: string }> = []) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
              // Recursively search subdirectories
              findVideosRecursively(fullPath, files);
            } else if (entry.isFile()) {
              // Check if it's a video file
              const ext = path.extname(entry.name).toLowerCase();
              if (videoExtensions.includes(ext)) {
                files.push({
                  filename: entry.name,
                  fullPath: fullPath
                });
              }
            }
          }
        } catch (error: any) {
          this.logger.warn(`Could not read directory ${dir}: ${error.message}`);
        }

        return files;
      };

      // Find all video files
      const allVideos = findVideosRecursively(body.directoryPath);
      this.logger.log(`Found ${allVideos.length} video files in ${body.directoryPath}`);

      // Get all videos from database to check which are already imported
      const allDbVideos = this.databaseService.getAllVideos();
      const importedPaths = new Set(allDbVideos.map(v => v.current_path));

      // Filter out videos that are already imported
      const unimportedVideos = allVideos.filter(video => !importedPaths.has(video.fullPath));

      this.logger.log(`${unimportedVideos.length} videos are not yet imported`);

      return {
        success: true,
        videos: unimportedVideos,
        total: allVideos.length,
        alreadyImported: allVideos.length - unimportedVideos.length
      };
    } catch (error: any) {
      this.logger.error(`Failed to scan directory: ${error.message}`);
      return {
        success: false,
        error: error.message,
        videos: [],
        total: 0,
        alreadyImported: 0
      };
    }
  }

  /**
   * POST /api/database/delete-unimported-files
   * Delete unimported video files from disk
   */
  @Post('delete-unimported-files')
  async deleteUnimportedFiles(@Body() body: { filePaths: string[] }) {
    this.logger.log(`Deleting ${body.filePaths?.length || 0} unimported video files`);

    if (!body.filePaths || !Array.isArray(body.filePaths) || body.filePaths.length === 0) {
      return {
        success: false,
        error: 'filePaths array is required',
        deletedCount: 0,
        failedCount: 0
      };
    }

    let deletedCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    for (const filePath of body.filePaths) {
      try {
        // Validate that the file exists
        if (!fs.existsSync(filePath)) {
          this.logger.warn(`File does not exist: ${filePath}`);
          failedCount++;
          errors.push(`File not found: ${path.basename(filePath)}`);
          continue;
        }

        // Safety check: ensure it's a file, not a directory
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          this.logger.warn(`Path is not a file: ${filePath}`);
          failedCount++;
          errors.push(`Not a file: ${path.basename(filePath)}`);
          continue;
        }

        // Delete the file
        fs.unlinkSync(filePath);
        deletedCount++;
        this.logger.log(`Deleted file: ${filePath}`);
      } catch (error: any) {
        this.logger.error(`Failed to delete file ${filePath}: ${error.message}`);
        failedCount++;
        errors.push(`${path.basename(filePath)}: ${error.message}`);
      }
    }

    return {
      success: deletedCount > 0,
      deletedCount,
      failedCount,
      errors: errors.length > 0 ? errors : undefined,
      message: deletedCount > 0
        ? `Deleted ${deletedCount} file${deletedCount > 1 ? 's' : ''}${failedCount > 0 ? `, ${failedCount} failed` : ''}`
        : `Could not delete any files (${failedCount} failed)`
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

  /**
   * GET /api/database/videos/:id/thumbnail
   * Get or generate thumbnail for a library video
   */
  @Get('videos/:id/thumbnail')
  async getVideoThumbnail(
    @Param('id') id: string,
    @Res() res: Response
  ) {
    try {
      const video = this.databaseService.getVideoById(id);

      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      if (!video.current_path || typeof video.current_path !== 'string') {
        throw new HttpException('Video path not available', HttpStatus.NOT_FOUND);
      }

      const videoPath = video.current_path as string;

      if (!fs.existsSync(videoPath)) {
        throw new HttpException('Video file not found', HttpStatus.NOT_FOUND);
      }

      // Check if thumbnail already exists
      const videoDir = path.dirname(videoPath);
      const videoBase = path.parse(videoPath).name;
      const thumbnailPath = path.join(videoDir, `${videoBase}_thumbnail.jpg`);

      // If thumbnail doesn't exist, generate it
      if (!fs.existsSync(thumbnailPath)) {
        this.logger.log(`Generating thumbnail for video ${id}: ${video.filename}`);
        const generatedPath = await this.ffmpegService.createThumbnail(videoPath);

        if (!generatedPath || !fs.existsSync(generatedPath)) {
          throw new HttpException(
            'Failed to generate thumbnail',
            HttpStatus.INTERNAL_SERVER_ERROR
          );
        }
      }

      // Send the thumbnail file
      res.sendFile(thumbnailPath);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error getting thumbnail: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to get thumbnail: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/database/videos/:id/related
   * Get all media items related to a video
   */
  @Get('videos/:id/related')
  getRelatedMedia(@Param('id') videoId: string) {
    try {
      const relatedMedia = this.databaseService.getRelatedMedia(videoId);
      return {
        success: true,
        relatedMedia
      };
    } catch (error) {
      this.logger.error(`Error getting related media: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
        relatedMedia: []
      };
    }
  }

  /**
   * POST /api/database/videos/:id/link
   * Link two media items together
   */
  @Post('videos/:id/link')
  linkMedia(
    @Param('id') primaryMediaId: string,
    @Body() body: { relatedMediaId: string; relationshipType?: string }
  ) {
    try {
      if (!body.relatedMediaId) {
        return {
          success: false,
          error: 'Related media ID is required'
        };
      }

      this.databaseService.insertMediaRelationship({
        id: require('uuid').v4(),
        primaryMediaId: primaryMediaId,
        relatedMediaId: body.relatedMediaId,
        relationshipType: body.relationshipType || 'related'
      });

      return {
        success: true,
        message: 'Media files linked successfully'
      };
    } catch (error) {
      this.logger.error(`Error linking media: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * DELETE /api/database/relationships/:relationshipId
   * Unlink two media items
   */
  @Delete('relationships/:relationshipId')
  unlinkMedia(@Param('relationshipId') relationshipId: string) {
    try {
      this.databaseService.deleteMediaRelationship(relationshipId);
      return {
        success: true,
        message: 'Media files unlinked successfully'
      };
    } catch (error) {
      this.logger.error(`Error unlinking media: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * POST /api/database/videos/:childId/set-parent
   * Set a parent for a video (create parent-child relationship)
   */
  @Post('videos/:childId/set-parent')
  setVideoParent(
    @Param('childId') childId: string,
    @Body() body: { parentId: string | null }
  ) {
    try {
      this.databaseService.setVideoParent(childId, body.parentId);
      return {
        success: true,
        message: body.parentId
          ? 'Parent set successfully'
          : 'Parent removed successfully'
      };
    } catch (error) {
      this.logger.error(`Error setting parent: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * GET /api/database/videos/:parentId/children
   * Get all children of a parent video
   */
  @Get('videos/:parentId/children')
  getChildVideos(@Param('parentId') parentId: string) {
    try {
      const children = this.databaseService.getChildVideos(parentId);
      return {
        success: true,
        children
      };
    } catch (error) {
      this.logger.error(`Error getting children: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * POST /api/database/videos/:childId/remove-parent
   * Remove parent from a video (make it a root video)
   */
  @Post('videos/:childId/remove-parent')
  removeVideoParent(@Param('childId') childId: string) {
    try {
      this.databaseService.setVideoParent(childId, null);
      return {
        success: true,
        message: 'Video is now a root-level item'
      };
    } catch (error) {
      this.logger.error(`Error removing parent: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * POST /api/database/videos/link-files
   * Link multiple files to a parent (add them as children)
   * If files don't exist in library, import them first
   */
  @Post('videos/link-files')
  async linkFilesToParent(
    @Body() body: {
      parentId: string;
      filePaths: string[];
    }
  ) {
    try {
      const { parentId, filePaths } = body;

      if (!parentId || !filePaths || filePaths.length === 0) {
        return {
          success: false,
          error: 'Parent ID and file paths are required'
        };
      }

      // Verify parent exists
      const parent = this.databaseService.getVideoById(parentId);
      if (!parent) {
        return {
          success: false,
          error: 'Parent video not found'
        };
      }

      // Check if parent is already a child (children can't be parents)
      if (parent.parent_id) {
        return {
          success: false,
          error: 'Cannot link files to a child video. Only root-level videos can be parents.'
        };
      }

      const results = [];
      const errors = [];

      for (const filePath of filePaths) {
        try {
          this.logger.log(`Processing file: ${filePath}`);

          // Check if file exists
          if (!fs.existsSync(filePath)) {
            this.logger.error(`File not found: ${filePath}`);
            errors.push({ filePath, error: 'File not found' });
            continue;
          }

          // Calculate file hash
          this.logger.log(`Calculating hash for: ${filePath}`);
          const fileHash = await this.databaseService.hashFile(filePath);
          this.logger.log(`File hash: ${fileHash}`);

          // Check if file is already in library
          let video = this.databaseService.findVideoByHash(fileHash);

          if (!video) {
            // Import the file to the library
            const filename = path.basename(filePath);
            const stats = fs.statSync(filePath);
            const fileExtension = path.extname(filename).toLowerCase();

            // Determine media type
            const mediaType = this.getMediaTypeFromExtension(fileExtension);

            // Get duration for media files
            let duration = null;
            if (mediaType === 'video' || mediaType === 'audio') {
              try {
                const metadata = await this.ffmpegService.getVideoMetadata(filePath);
                duration = metadata.duration;
              } catch (e) {
                this.logger.warn(`Could not get duration for ${filename}`);
              }
            }

            // Create video ID
            const { v4: uuidv4 } = require('uuid');
            const videoId = uuidv4();

            // Insert into database
            this.databaseService.insertVideo({
              id: videoId,
              filename,
              fileHash,
              currentPath: filePath,
              durationSeconds: duration || undefined,
              fileSizeBytes: stats.size,
              mediaType,
              fileExtension,
              downloadDate: stats.birthtime.toISOString()
            });

            video = this.databaseService.getVideoById(videoId);
          }

          // Verify video was created/found
          if (!video) {
            errors.push({
              filePath,
              error: 'Failed to create or find video in database'
            });
            continue;
          }

          // Set the parent
          this.databaseService.setVideoParent(video.id as string, parentId);

          results.push({
            filename: video.filename as string,
            videoId: video.id as string,
            status: 'linked'
          });

        } catch (error) {
          this.logger.error(`Error processing file ${filePath}:`, error);
          errors.push({
            filePath,
            error: (error as Error).message || 'Unknown error'
          });
        }
      }

      this.logger.log(`Link files complete. Success: ${results.length}, Errors: ${errors.length}`);

      return {
        success: errors.length === 0,
        message: `Linked ${results.length} file(s) to parent`,
        results,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      this.logger.error(`Error linking files: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * Helper to determine media type from file extension
   */
  private getMediaTypeFromExtension(extension: string): string {
    const ext = extension.toLowerCase();

    if (['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'].includes(ext)) {
      return 'video';
    }

    if (['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg'].includes(ext)) {
      return 'audio';
    }

    if (['.pdf', '.epub', '.mobi', '.txt', '.md'].includes(ext)) {
      return 'document';
    }

    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      return 'image';
    }

    if (['.html', '.htm', '.mhtml'].includes(ext)) {
      return 'webpage';
    }

    return 'video'; // default
  }
}
