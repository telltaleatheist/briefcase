import { Controller, Get, Post, Put, Delete, Patch, Logger, Body, Query, Param, Res, Req, HttpException, HttpStatus, NotFoundException, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { Response, Request } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import * as path from 'path';
import * as fs from 'fs';
import { createReadStream, statSync } from 'fs';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { MigrationService } from './migration.service';
import { AnalysisService } from '../analysis/analysis.service';
import { LibraryManagerService } from './library-manager.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { MediaEventService } from '../media/media-event.service';
import { IgnoreService } from './ignore.service';
import { ThumbnailService } from './thumbnail.service';
import { WaveformService } from './waveform.service';
import { FilenameDateUtil } from '../common/utils/filename-date.util';

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
    private readonly ignoreService: IgnoreService,
    private readonly thumbnailService: ThumbnailService,
    private readonly waveformService: WaveformService,
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
    this.logger.log('Checking for unimported videos and searching for potential database matches');

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

    // Filter out ignored files
    const filteredVideos = videos.filter(video => !this.ignoreService.shouldIgnore(video.fullPath));
    this.logger.log(`Filtered ${videos.length - filteredVideos.length} ignored files`);

    // Check if any unimported files match existing database entries
    this.logger.log('Checking for existing database entries by filename and hash');
    const allDbVideos = this.databaseService.getAllVideos({ linkedOnly: false, includeChildren: true });
    const filenameMap = new Map<string, any[]>();
    const hashMap = new Map<string, any[]>();

    // Build maps of database videos by filename and hash
    for (const dbVideo of allDbVideos) {
      // Filename map
      if (!filenameMap.has(dbVideo.filename)) {
        filenameMap.set(dbVideo.filename, []);
      }
      filenameMap.get(dbVideo.filename)!.push({
        id: dbVideo.id,
        filename: dbVideo.filename,
        current_path: dbVideo.current_path,
        file_exists: dbVideo.current_path ? fs.existsSync(dbVideo.current_path) : false,
      });

      // Hash map (for duplicate content detection)
      if (dbVideo.file_hash) {
        if (!hashMap.has(dbVideo.file_hash)) {
          hashMap.set(dbVideo.file_hash, []);
        }
        hashMap.get(dbVideo.file_hash)!.push({
          id: dbVideo.id,
          filename: dbVideo.filename,
          current_path: dbVideo.current_path,
          file_exists: dbVideo.current_path ? fs.existsSync(dbVideo.current_path) : false,
        });
      }
    }

    // Check for content duplicates by computing hashes
    const videosWithMatches = await Promise.all(filteredVideos.map(async (video) => {
      const filenameMatches = filenameMap.get(video.filename) || [];
      let isDuplicateContent = false;
      let duplicateOf = null;

      try {
        // Compute hash for this unimported file
        const stats = fs.statSync(video.fullPath);
        const fileHash = await this.fileScannerService.quickHashFile(video.fullPath, stats.size);

        // Check if this hash exists in database
        const hashMatches = hashMap.get(fileHash) || [];
        if (hashMatches.length > 0) {
          isDuplicateContent = true;
          duplicateOf = hashMatches[0]; // First match
          this.logger.debug(`Found duplicate content: ${video.filename} matches ${duplicateOf.filename}`);
        }
      } catch (error: any) {
        this.logger.warn(`Could not compute hash for ${video.filename}: ${error.message}`);
      }

      return {
        ...video,
        potential_db_matches: filenameMatches,
        has_db_match: filenameMatches.length > 0,
        isDuplicateContent,
        duplicateOf,
      };
    }));

    const withMatches = videosWithMatches.filter(v => v.has_db_match).length;
    const duplicateCount = videosWithMatches.filter(v => v.isDuplicateContent).length;
    this.logger.log(`Found ${filteredVideos.length} unimported videos (${withMatches} filename matches, ${duplicateCount} content duplicates)`);

    return {
      success: true,
      count: filteredVideos.length,
      videos: videosWithMatches,
      matchesFound: withMatches,
      duplicatesFound: duplicateCount,
    };
  }

  /**
   * GET /api/database/duplicate-entries
   * Find duplicate database entries (multiple entries with same file hash)
   */
  @Get('duplicate-entries')
  findDuplicateEntries() {
    this.logger.log('Scanning for duplicate database entries by file path');

    const allVideos = this.databaseService.getAllVideos({ linkedOnly: false, includeChildren: true });
    const pathMap = new Map<string, any[]>();

    // Group videos by current_path
    for (const video of allVideos) {
      if (video.current_path) {
        if (!pathMap.has(video.current_path)) {
          pathMap.set(video.current_path, []);
        }
        pathMap.get(video.current_path)!.push({
          id: video.id,
          filename: video.filename,
          current_path: video.current_path,
          file_exists: video.current_path ? fs.existsSync(video.current_path) : false,
          file_size_bytes: video.file_size_bytes,
          duration_seconds: video.duration_seconds,
          media_type: video.media_type,
          download_date: video.download_date,
          upload_date: video.upload_date,
        });
      }
    }

    // Find duplicate entries (all entries except the first one for each path)
    const duplicateEntries: any[] = [];
    const pathsWithDuplicates: string[] = [];

    for (const [path, entries] of pathMap.entries()) {
      if (entries.length > 1) {
        pathsWithDuplicates.push(path);
        // Keep the first entry, mark the rest as duplicates
        for (let i = 1; i < entries.length; i++) {
          duplicateEntries.push({
            ...entries[i],
            duplicate_count: entries.length,
            is_duplicate_of: path,
          });
        }
      }
    }

    this.logger.log(`Found ${pathsWithDuplicates.length} paths with duplicates (${duplicateEntries.length} duplicate entries total)`);

    return {
      success: true,
      duplicateEntries,
      pathsWithDuplicates: pathsWithDuplicates.length,
      totalDuplicates: duplicateEntries.length,
    };
  }

  /**
   * POST /api/database/scan-ignored
   * Scan database for entries that match ignore patterns and remove them
   */
  @Post('scan-ignored')
  async scanAndRemoveIgnored() {
    this.logger.log('Scanning database for entries matching ignore patterns');

    const allVideos = this.databaseService.getAllVideos({ linkedOnly: false, includeChildren: true });
    const toRemove: string[] = [];

    for (const video of allVideos) {
      if (video.current_path && this.ignoreService.shouldIgnore(video.current_path)) {
        toRemove.push(video.id);
        this.logger.log(`Found ignored entry: ${video.filename} (${video.id})`);
      }
    }

    this.logger.log(`Found ${toRemove.length} database entries matching ignore patterns`);

    // Delete the entries
    const deleted = [];
    for (const videoId of toRemove) {
      try {
        this.databaseService.deleteVideo(videoId);
        deleted.push(videoId);
      } catch (error: any) {
        this.logger.error(`Failed to delete video ${videoId}: ${error.message}`);
      }
    }

    this.logger.log(`Deleted ${deleted.length} ignored entries from database`);

    return {
      success: true,
      found: toRemove.length,
      deleted: deleted.length,
      message: `Found ${toRemove.length} ignored entries, deleted ${deleted.length}`,
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

  @Post('import-batch')
  async importVideos(@Body() body: {
    videoPaths: string[];
    duplicateHandling?: { [key: string]: 'skip' | 'replace' | 'keep-both' };
  }) {
    this.logger.log(`Importing ${body.videoPaths?.length || 0} videos (batch mode)`);

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

    // Always use standard import (batching is handled by frontend queue now)
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
    @Query('hierarchical') hierarchical?: string,
    @Query('includeRelationships') includeRelationships?: string
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

    // Enrich with parent/child relationship data if requested
    if (includeRelationships === 'true') {
      videos = videos.map(video => {
        const children = this.databaseService.getChildVideos(video.id as string);
        const parents = this.databaseService.getParentVideos(video.id as string);

        return {
          ...video,
          child_ids: children.map(c => c.id),
          parent_ids: parents.map(p => p.id),
          children: children,
          parents: parents
        };
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
  ) {
    if (!query || query.trim() === '') {
      return {
        results: [],
        count: 0,
        query: query || '',
      };
    }

    const limitNum = limit ? parseInt(limit, 10) : 1000;

    // Use FTS5 search for efficient full-text searching
    const searchResults = this.databaseService.searchFTS(query, limitNum);

    // Get full video details for each result
    const videos = searchResults.map(result => {
      const video = this.databaseService.getVideoById(result.videoId);
      if (!video) {
        return null;
      }
      return {
        ...video,
        searchScore: result.score,
        matchTypes: result.matches, // Array of match sources (filename, transcript, etc.)
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
   * PUT /api/database/markers/:markerId
   * Update a custom marker
   */
  @Put('markers/:markerId')
  async updateMarker(
    @Param('markerId') markerId: string,
    @Body() body: {
      startSeconds?: number;
      endSeconds?: number;
      title?: string;
      description?: string;
      category?: string;
    }
  ) {
    try {
      // Format timestamp text if times changed
      let timestampText: string | undefined;
      if (body.startSeconds !== undefined || body.endSeconds !== undefined) {
        const formatTimestamp = (seconds: number): string => {
          const mins = Math.floor(seconds / 60);
          const secs = Math.floor(seconds % 60);
          return `${mins}:${secs.toString().padStart(2, '0')}`;
        };

        if (body.startSeconds !== undefined && body.endSeconds !== undefined) {
          timestampText = `${formatTimestamp(body.startSeconds)} - ${formatTimestamp(body.endSeconds)}`;
        }
      }

      this.databaseService.updateCustomMarker({
        id: markerId,
        startSeconds: body.startSeconds,
        endSeconds: body.endSeconds,
        timestampText,
        title: body.title,
        description: body.description,
        category: body.category
      });

      this.logger.log(`Updated marker ${markerId}`);

      return {
        success: true,
        message: 'Marker updated successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to update marker ${markerId}:`, error);
      return {
        success: false,
        error: error.message || 'Failed to update marker'
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
   * GET /api/database/videos/:id/stream
   * Stream video file by video ID
   * Supports range requests for seeking
   */
  @Get('videos/:id/stream')
  async streamVideoById(
    @Param('id') videoId: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      const video = this.databaseService.getVideoById(videoId);

      if (!video) {
        this.logger.warn(`Video not found in database: ${videoId}`);
        throw new HttpException(`Video not found in database: ${videoId}`, HttpStatus.NOT_FOUND);
      }

      // Normalize path: replace backslashes with forward slashes for cross-platform compatibility
      let videoPath = video.current_path;
      if (videoPath) {
        videoPath = videoPath.replace(/\\/g, '/');
      }

      if (!videoPath || !fs.existsSync(videoPath)) {
        this.logger.warn(`Video file not found on disk for video ${videoId}: ${videoPath || 'no path'} (original: ${video.current_path})`);
        throw new HttpException(
          `Video file not found on disk: ${videoPath || 'no path'}`,
          HttpStatus.NOT_FOUND
        );
      }

      const stat = statSync(videoPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      // Determine content type from file extension
      const ext = path.extname(videoPath).toLowerCase();
      const contentTypeMap: Record<string, string> = {
        // Video formats
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.m4v': 'video/x-m4v',
        '.flv': 'video/x-flv',
        // Audio formats
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.m4b': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.oga': 'audio/ogg',
        // Image formats
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      const contentType = contentTypeMap[ext] || 'application/octet-stream';

      if (range) {
        // Handle range request for seeking
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 10 * 1024 * 1024, fileSize - 1);
        const chunkSize = end - start + 1;

        const stream = createReadStream(videoPath, { start, end, highWaterMark: 256 * 1024 });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        });

        stream.pipe(res);
      } else {
        // No range request, stream entire file
        const stream = createReadStream(videoPath, { highWaterMark: 256 * 1024 });

        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
        });

        stream.pipe(res);
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to stream video: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to stream video: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/database/videos/:id/waveform
   * Generate and return waveform data for a video using server-side processing
   * This is much more efficient than loading the entire video in the browser
   *
   * Query params:
   * - samples: number of samples to generate (default 1000)
   * - progressive: if true, uses progressive generation with updates every few seconds
   */
  @Get('videos/:id/waveform')
  async getVideoWaveform(
    @Param('id') videoId: string,
    @Query('samples') samples?: string,
    @Query('progressive') progressive?: string
  ) {
    try {
      const video = this.databaseService.getVideoById(videoId);

      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      const videoPath = video.current_path;

      if (!videoPath || !fs.existsSync(videoPath)) {
        throw new HttpException('Video file not found on disk', HttpStatus.NOT_FOUND);
      }

      const samplesCount = samples ? parseInt(samples, 10) : 1000;
      const useProgressive = progressive === 'true';

      this.logger.log(`Generating waveform for video ${videoId}: ${video.filename} with ${samplesCount} samples (progressive: ${useProgressive})`);

      // Use the new WaveformService for efficient server-side generation with caching
      const waveformData = await this.waveformService.generateWaveform(
        videoPath,
        videoId,
        { samples: samplesCount, useCache: true, progressive: useProgressive }
      );

      this.logger.log(`Waveform generated successfully: ${waveformData.samples.length} samples, duration: ${waveformData.duration}s`);

      return {
        success: true,
        data: waveformData
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to generate waveform: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to generate waveform: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * GET /api/database/videos/:id/waveform/progress
   * Get the current progress of waveform generation
   */
  @Get('videos/:id/waveform/progress')
  async getWaveformProgress(@Param('id') videoId: string) {
    const progress = this.waveformService.getProgress(videoId);

    if (!progress) {
      return {
        success: false,
        message: 'No waveform generation in progress'
      };
    }

    return {
      success: true,
      data: progress
    };
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
   * Update video metadata (upload_date, download_date, added_at, ai_description)
   * If upload_date changes, also updates the filename to include/update the date prefix
   */
  @Patch('videos/:id/metadata')
  async updateVideoMetadata(
    @Param('id') videoId: string,
    @Body() body: {
      uploadDate?: string | null;
      downloadDate?: string;
      addedAt?: string;
      aiDescription?: string | null;
    }
  ) {
    const fs = require('fs').promises;
    const path = require('path');

    this.logger.log(`updateVideoMetadata called for ${videoId}:`, JSON.stringify(body));

    try {
      // Verify video exists
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        this.logger.error(`Video not found: ${videoId}`);
        return {
          success: false,
          error: 'Video not found'
        };
      }

      this.logger.log(`Current video: ${video.filename}, upload_date: ${video.upload_date}`);

      // If upload date is being set/changed, update the filename
      if (body.uploadDate !== undefined) {
        const oldFilename = video.filename as string;
        const oldPath = video.current_path as string;

        // Get new filename with updated date prefix
        const newFilename = body.uploadDate
          ? FilenameDateUtil.ensureDatePrefix(oldFilename, body.uploadDate)
          : oldFilename; // Keep filename as-is if clearing date

        // Rename physical file if filename changed
        if (newFilename !== oldFilename) {
          const directory = path.dirname(oldPath);
          const newPath = path.join(directory, newFilename);

          // Check if new path already exists (but exclude the current file)
          // On case-insensitive filesystems, oldPath and newPath might point to the same file
          const isSameFile = oldPath.toLowerCase() === newPath.toLowerCase();

          if (!isSameFile) {
            try {
              await fs.access(newPath);
              return {
                success: false,
                error: 'A file with this name already exists'
              };
            } catch {
              // File doesn't exist, which is what we want
            }
          }

          // Rename the physical file
          try {
            await fs.rename(oldPath, newPath);
            this.logger.log(`Renamed file for upload date change: ${oldPath} -> ${newPath}`);

            // Update database with new filename and path
            this.databaseService.updateVideoFilename(videoId, newFilename);
            this.databaseService.updateVideoPath(videoId, newPath);

            // Emit WebSocket event
            this.mediaEventService.emitVideoRenamed(videoId, oldFilename, newFilename, newPath);
          } catch (error: any) {
            this.logger.error(`Failed to rename file: ${error.message}`);
            return {
              success: false,
              error: `Failed to rename file: ${error.message}`
            };
          }
        }
      }

      // Update metadata in database
      this.databaseService.updateVideoMetadata(
        videoId,
        body.uploadDate,
        body.downloadDate,
        body.addedAt,
        body.aiDescription
      );

      this.logger.log(`Updated metadata for video ${videoId}`);

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

      const oldPath = video.current_path as string;
      const oldFilename = video.filename as string;

      // FILENAME IS SOURCE OF TRUTH for rename operations
      // When renaming, ONLY use dates that are explicitly in the filename
      // DO NOT pull upload_date from database during rename (it may be incorrect/stale)
      // The database will be UPDATED after rename based on the final filename
      const oldDateInfo = FilenameDateUtil.extractDateInfo(oldFilename);

      // Check if user provided a date in their new input
      const newTitleInfo = FilenameDateUtil.extractDateInfo(body.filename.trim());
      if (newTitleInfo.hasDate) {
        this.logger.log(`User provided date in new filename: "${newTitleInfo.date}"`);
      }

      this.logger.log(`updateVideoFilename: oldFilename="${oldFilename}", requested="${body.filename.trim()}"`);

      // Create new filename:
      // - If user provides date in new title → use it
      // - If old filename has date → preserve it (unless user provides new date)
      // - If neither has date → no date in new filename
      // DO NOT add date from database during rename
      const newFilename = FilenameDateUtil.updateTitle(oldFilename, body.filename.trim(), undefined);

      this.logger.log(`updateVideoFilename: computed newFilename="${newFilename}"`);

      // Extract the final date from the new filename to update the database
      const finalDateInfo = FilenameDateUtil.extractDateInfo(newFilename);
      const finalUploadDate = finalDateInfo.hasDate
        ? FilenameDateUtil.toISODate(finalDateInfo.date)
        : null;

      // Check if database needs to be corrected to match filename
      if (finalUploadDate && video.upload_date !== finalUploadDate) {
        this.logger.log(`Correcting database upload_date: "${video.upload_date}" -> "${finalUploadDate}" (filename is source of truth)`);
      }

      this.logger.log(`updateVideoFilename: finalUploadDate="${finalUploadDate}"`);

      // Skip if filename hasn't changed
      if (video.filename === newFilename) {
        this.logger.log(`updateVideoFilename: Filenames are identical, skipping rename`);
        return {
          success: true,
          message: 'Filename unchanged'
        };
      }

      // Check if another video in the database already has this filename
      const existingVideo = this.databaseService.findVideoByFilename(newFilename);
      if (existingVideo && existingVideo.id !== videoId) {
        this.logger.warn(`updateVideoFilename: Found existing video with filename "${newFilename}": ${existingVideo.id}`);
        return {
          success: false,
          error: 'A file with this name already exists in the library'
        };
      }

      // Get the directory path and construct new path
      const directory = path.dirname(oldPath);
      const newPath = path.join(directory, newFilename);

      // Check if new path already exists (but exclude the current file)
      // On case-insensitive filesystems, oldPath and newPath might point to the same file
      const isSameFile = oldPath.toLowerCase() === newPath.toLowerCase();

      if (!isSameFile) {
        try {
          await fs.access(newPath);
          return {
            success: false,
            error: 'A file with this name already exists in the library'
          };
        } catch {
          // File doesn't exist, which is what we want
        }
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

      // Update database with new filename, path, and upload date
      this.databaseService.updateVideoFilename(videoId, newFilename);
      this.databaseService.updateVideoPath(videoId, newPath);
      this.databaseService.updateVideoUploadDate(videoId, finalUploadDate);

      // Clear AI suggested title since user manually renamed the file
      this.databaseService.updateVideoSuggestedTitle(videoId, null);

      this.logger.log(`Updated filename for video ${videoId}: ${newFilename}, upload_date: ${finalUploadDate}, cleared AI suggestion`);

      // Emit WebSocket event to notify frontend of the rename (including upload date)
      this.mediaEventService.emitVideoRenamed(
        videoId,
        video.filename as string,
        newFilename,
        newPath,
        finalUploadDate
      );

      return {
        success: true,
        message: 'Video filename updated successfully',
        newFilename: newFilename,
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
   * PATCH /api/database/videos/:id/suggested-title
   * Update video suggested title (without renaming file)
   */
  @Patch('videos/:id/suggested-title')
  async updateVideoSuggestedTitle(
    @Param('id') videoId: string,
    @Body() body: { suggestedTitle: string }
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

      // Validate suggested title
      if (!body.suggestedTitle || typeof body.suggestedTitle !== 'string') {
        return {
          success: false,
          error: 'Valid suggested title is required'
        };
      }

      // Update suggested title
      this.databaseService.updateVideoSuggestedTitle(videoId, body.suggestedTitle.trim());

      this.logger.log(`Updated suggested title for video ${videoId}: ${body.suggestedTitle}`);

      return {
        success: true,
        message: 'Suggested title updated successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to update suggested title: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to update suggested title'
      };
    }
  }

  /**
   * POST /api/database/videos/:id/accept-suggested-title
   * Accept the AI-suggested title and rename the file
   */
  @Post('videos/:id/accept-suggested-title')
  async acceptSuggestedTitle(
    @Param('id') videoId: string,
    @Body() body?: { customFilename?: string }
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

      const oldFilename = video.filename as string;

      // FILENAME IS SOURCE OF TRUTH for rename operations
      // When accepting AI suggestions, ONLY use dates that are explicitly in the filename
      // DO NOT pull upload_date from database during rename (it may be incorrect/stale)
      // The database will be UPDATED after rename based on the final filename
      const oldDateInfo = FilenameDateUtil.extractDateInfo(oldFilename);

      // Use custom filename if provided, otherwise format from suggested title
      let newFilename: string;
      if (body?.customFilename) {
        // Check if user provided a date in their custom filename
        const newTitleInfo = FilenameDateUtil.extractDateInfo(body.customFilename);
        if (newTitleInfo.hasDate) {
          this.logger.log(`User provided date in AI suggestion: "${newTitleInfo.date}"`);
        }

        // Process custom filename:
        // - If user provides date in new title → use it
        // - If old filename has date → preserve it (unless user provides new date)
        // - If neither has date → no date in new filename
        // DO NOT add date from database during rename
        this.logger.log(`Processing custom filename: ${body.customFilename}`);
        newFilename = FilenameDateUtil.updateTitle(oldFilename, body.customFilename, undefined);
        this.logger.log(`Processed to: ${newFilename}`);
      } else {
        // Format the new filename from suggested title (no date added from database)
        const suggestedTitle = String(video.suggested_title || '').trim();
        newFilename = FilenameDateUtil.updateTitle(oldFilename, suggestedTitle, undefined);
      }

      // Extract the final date from the new filename to update the database
      const finalDateInfo = FilenameDateUtil.extractDateInfo(newFilename);
      const finalUploadDate = finalDateInfo.hasDate
        ? FilenameDateUtil.toISODate(finalDateInfo.date)
        : null;

      // Check if database needs to be corrected to match filename
      if (finalUploadDate && video.upload_date !== finalUploadDate) {
        this.logger.log(`Correcting database upload_date: "${video.upload_date}" -> "${finalUploadDate}" (filename is source of truth)`);
      }

      this.logger.log(`acceptSuggestedTitle: oldFilename="${oldFilename}", newFilename="${newFilename}", finalUploadDate="${finalUploadDate}"`);

      const oldPath = video.current_path as string;
      const directory = path.dirname(oldPath);
      const newPath = path.join(directory, newFilename);

      // Check if new path already exists (but exclude the current file)
      // On case-insensitive filesystems, oldPath and newPath might point to the same file
      const isSameFile = oldPath.toLowerCase() === newPath.toLowerCase();

      if (!isSameFile) {
        try {
          await fs.access(newPath);
          return {
            success: false,
            error: 'A file with this name already exists in the library'
          };
        } catch {
          // File doesn't exist, which is what we want
        }
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

      // Update database with new filename, path, and upload date
      this.databaseService.updateVideoFilename(videoId, newFilename);
      this.databaseService.updateVideoPath(videoId, newPath);
      this.databaseService.updateVideoUploadDate(videoId, finalUploadDate);

      // Clear the suggested_title since it's been accepted
      this.databaseService.updateVideoSuggestedTitle(videoId, null);

      this.logger.log(`Accepted suggested title for video ${videoId}: ${newFilename}, upload_date: ${finalUploadDate}`);

      // Emit WebSocket events to notify frontend (including upload date)
      this.mediaEventService.emitVideoRenamed(
        videoId,
        video.filename as string,
        newFilename,
        newPath,
        finalUploadDate
      );

      // Emit suggestion-specific event for reactive UI updates (including upload date)
      this.mediaEventService.emitSuggestionAccepted(
        videoId,
        video.filename as string,
        newFilename,
        finalUploadDate
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
   * POST /api/database/videos/:id/reject-suggested-title
   * Reject the AI-suggested title (clear it from the database)
   */
  @Post('videos/:id/reject-suggested-title')
  async rejectSuggestedTitle(
    @Param('id') videoId: string
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

      // Check if video has a suggested title
      if (!video.suggested_title) {
        return {
          success: false,
          error: 'No suggested title to reject'
        };
      }

      // Clear the suggested_title from the database
      this.databaseService.updateVideoSuggestedTitle(videoId, null);

      this.logger.log(`Rejected suggested title for video ${videoId}`);

      // Emit WebSocket event to notify frontend of the rejection
      this.mediaEventService.emitSuggestionRejected(videoId);

      return {
        success: true,
        message: 'Suggested title rejected successfully'
      };
    } catch (error: any) {
      this.logger.error(`Failed to reject suggested title: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Failed to reject suggested title'
      };
    }
  }

  /**
   * DELETE /api/database/videos/:id
   * Delete a video from the library
   * @param mode - 'database-only' (keep file), 'file-only' (keep db), 'everything' (delete both)
   */
  @Delete('videos/:id')
  async deleteVideo(
    @Param('id') videoId: string,
    @Query('deleteFiles') deleteFiles?: string,
    @Body() body?: { mode?: 'database-only' | 'file-only' | 'everything' }
  ) {
    try {
      const fs = require('fs').promises;

      // Determine mode from body or legacy query param
      let mode = body?.mode || 'everything';
      if (!body?.mode && deleteFiles === 'true') {
        mode = 'everything';
      } else if (!body?.mode && deleteFiles === 'false') {
        mode = 'database-only';
      }

      // Get video info first for file path
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        return {
          success: false,
          error: 'Video not found'
        };
      }

      const videoPath = video.current_path;

      // Handle each mode
      switch (mode) {
        case 'database-only':
          // Delete from database only, keep file
          this.databaseService.deleteVideo(videoId);
          this.logger.log(`Removed video ${videoId} from library (database only, file kept)`);
          return {
            success: true,
            message: 'Video removed from library (file kept on disk)'
          };

        case 'file-only':
          // Delete file only, keep database entry
          if (videoPath) {
            try {
              await fs.unlink(videoPath);
              this.logger.log(`Deleted physical file: ${videoPath}`);
            } catch (fileError: any) {
              this.logger.warn(`Could not delete physical file ${videoPath}: ${fileError.message}`);
            }
          }
          this.logger.log(`Deleted file for video ${videoId} (database entry kept)`);
          return {
            success: true,
            message: 'File deleted (database entry kept)'
          };

        case 'everything':
        default:
          // Delete both database and file
          this.databaseService.deleteVideo(videoId);
          if (videoPath) {
            try {
              await fs.unlink(videoPath);
              this.logger.log(`Deleted physical file: ${videoPath}`);
            } catch (fileError: any) {
              this.logger.warn(`Could not delete physical file ${videoPath}: ${fileError.message}`);
            }
          }
          this.logger.log(`Deleted video ${videoId} from library (database and file)`);
          return {
            success: true,
            message: 'Video deleted successfully'
          };
      }
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
   * POST /api/database/cleanup-thumbnails
   * Clean up orphaned thumbnails (thumbnails without corresponding videos)
   */
  @Post('cleanup-thumbnails')
  cleanupOrphanedThumbnails() {
    this.logger.log('Cleaning up orphaned thumbnails');
    const result = this.databaseService.cleanupOrphanedThumbnails();
    return {
      success: true,
      deletedCount: result.deletedCount,
      orphanedThumbnails: result.orphanedThumbnails,
      message: result.deletedCount > 0
        ? `Cleaned up ${result.deletedCount} orphaned thumbnail${result.deletedCount > 1 ? 's' : ''}`
        : 'No orphaned thumbnails found'
    };
  }

  /**
   * GET /api/database/missing-files
   * Find database entries where the file doesn't exist on disk
   * Actually checks file existence, not just is_linked flag
   */
  @Get('missing-files')
  findMissingFiles() {
    this.logger.log('Scanning for missing files and searching for potential matches');
    const allVideos = this.databaseService.getAllVideos({ linkedOnly: false, includeChildren: true });
    const missingVideos = [];

    // Get active library's clips folder
    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      this.logger.error('No active library found');
      return {
        success: false,
        error: 'No active library',
        count: 0,
        videos: [],
      };
    }

    const clipsFolder = activeLibrary.clipsFolderPath;
    this.logger.log(`Searching for matches in library folder: ${clipsFolder}`);

    // Build a map of all files in the library folder (filename -> full path)
    const fileMap = new Map<string, string[]>();
    const scanDirectory = (dir: string) => {
      try {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDirectory(fullPath);
          } else if (entry.isFile()) {
            const filename = entry.name;
            if (!fileMap.has(filename)) {
              fileMap.set(filename, []);
            }
            fileMap.get(filename)!.push(fullPath);
          }
        }
      } catch (error: any) {
        this.logger.warn(`Could not read directory ${dir}: ${error.message}`);
      }
    };

    scanDirectory(clipsFolder);
    this.logger.log(`Built file map with ${fileMap.size} unique filenames`);

    // Find missing files and search for potential matches
    for (const video of allVideos) {
      if (video.current_path && !fs.existsSync(video.current_path)) {
        const potentialMatches = fileMap.get(video.filename) || [];

        missingVideos.push({
          id: video.id,
          filename: video.filename,
          current_path: video.current_path,
          duration_seconds: video.duration_seconds,
          media_type: video.media_type,
          file_size_bytes: video.file_size_bytes,
          download_date: video.download_date,
          potential_matches: potentialMatches, // Add potential matches
          has_match: potentialMatches.length > 0,
        });
      }
    }

    const withMatches = missingVideos.filter(v => v.has_match).length;
    this.logger.log(`Found ${missingVideos.length} missing files (${withMatches} have potential matches)`);

    return {
      success: true,
      count: missingVideos.length,
      videos: missingVideos,
      matchesFound: withMatches,
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
      const clipsFolder = this.databaseService.getClipsFolderPath();

      // Get all unique directories from existing videos
      for (const video of allVideos) {
        if (video.current_path) {
          // Convert relative paths to absolute using clips folder
          let absolutePath = String(video.current_path);
          if (clipsFolder && !path.isAbsolute(absolutePath)) {
            absolutePath = path.join(clipsFolder, absolutePath);
          }

          const dir = path.dirname(absolutePath);
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
          const oldPath = video.current_path ? String(video.current_path) : undefined;

          // Update the video path (this also marks it as linked)
          this.databaseService.updateVideoPath(videoId, foundPath);
          relinkedCount++;
          this.logger.log(`Relinked video ${videoId}: ${foundPath}`);

          // Emit WebSocket event to notify frontend of the relink
          this.mediaEventService.emitVideoPathUpdated(videoId, foundPath, oldPath);
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
   * POST /api/database/libraries/open
   * Open an existing library from a folder (looks for .library.db)
   */
  @Post('libraries/open')
  async openExistingLibrary(@Body() body: { clipsFolderPath: string; name?: string }) {
    if (!body.clipsFolderPath || typeof body.clipsFolderPath !== 'string') {
      return {
        success: false,
        error: 'Clips folder path is required',
      };
    }

    try {
      const library = await this.libraryManagerService.openExistingLibrary(
        body.clipsFolderPath,
        body.name,
      );
      return {
        success: true,
        library,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to open library',
      };
    }
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
   * Update a library (name and/or clipsFolderPath)
   */
  @Patch('libraries/:id')
  updateLibrary(@Param('id') id: string, @Body() body: { name?: string; clipsFolderPath?: string }) {
    if (!body.name && !body.clipsFolderPath) {
      return {
        success: false,
        error: 'At least one of name or clipsFolderPath is required',
      };
    }

    let success = true;
    const updates: string[] = [];

    // Update name if provided
    if (body.name && typeof body.name === 'string') {
      success = this.libraryManagerService.renameLibrary(id, body.name) && success;
      if (success) updates.push('name');
    }

    // Update clipsFolderPath if provided
    if (body.clipsFolderPath && typeof body.clipsFolderPath === 'string') {
      success = this.libraryManagerService.updateLibraryClipsFolder(id, body.clipsFolderPath) && success;
      if (success) updates.push('clipsFolderPath');
    }

    // Return the updated library
    const library = this.libraryManagerService.getAllLibraries().find((lib) => lib.id === id);

    return {
      success,
      message: success ? `Library updated (${updates.join(', ')})` : 'Library not found',
      library,
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
   * GET /api/database/libraries/:id/default-ai-model
   * Get default AI model for a library (or active library if no ID provided)
   */
  @Get('libraries/default-ai-model')
  getLibraryDefaultAiModel(@Query('libraryId') libraryId?: string) {
    const aiModel = this.libraryManagerService.getDefaultAiModel(libraryId);
    return {
      success: true,
      aiModel,
    };
  }

  /**
   * POST /api/database/libraries/:id/default-ai-model
   * Set default AI model for a library (or active library if no ID provided)
   */
  @Post('libraries/default-ai-model')
  setLibraryDefaultAiModel(@Body() body: { aiModel: string; libraryId?: string }) {
    if (!body.aiModel || typeof body.aiModel !== 'string') {
      return {
        success: false,
        error: 'AI model is required',
      };
    }

    const success = this.libraryManagerService.setDefaultAiModel(
      body.aiModel,
      body.libraryId,
    );
    return {
      success,
      message: success ? 'Default AI model saved' : 'Library not found',
    };
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
   * Thumbnails are stored in centralized .thumbnails directory
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

      // Get thumbnail path from ThumbnailService
      const thumbnailPath = this.thumbnailService.getThumbnailPath(id);

      // If thumbnail doesn't exist, generate it
      if (!this.thumbnailService.thumbnailExists(id)) {
        this.logger.log(`Generating thumbnail for video ${id}: ${video.filename}`);
        const generatedPath = await this.ffmpegService.createThumbnail(videoPath, undefined, id);

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

      // Note: Children CAN now be parents (many-to-many relationships)

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
   * POST /api/database/videos/:parentId/remove-all-children
   * Remove all children from a parent video
   */
  @Post('videos/:parentId/remove-all-children')
  removeAllChildren(@Param('parentId') parentId: string) {
    try {
      this.databaseService.removeAllChildren(parentId);
      return {
        success: true,
        message: 'All children removed from parent'
      };
    } catch (error) {
      this.logger.error(`Error removing all children: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * POST /api/database/videos/:parentId/remove-child/:childId
   * Remove a specific child from a parent
   */
  @Post('videos/:parentId/remove-child/:childId')
  removeChild(
    @Param('parentId') parentId: string,
    @Param('childId') childId: string
  ) {
    try {
      this.databaseService.removeParentChildRelationship(parentId, childId);
      return {
        success: true,
        message: 'Child removed from parent'
      };
    } catch (error) {
      this.logger.error(`Error removing child: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * GET /api/database/videos/:videoId/parents
   * Get all parents of a video
   */
  @Get('videos/:videoId/parents')
  getParentVideos(@Param('videoId') videoId: string) {
    try {
      const parents = this.databaseService.getParentVideos(videoId);
      return {
        success: true,
        parents
      };
    } catch (error) {
      this.logger.error(`Error getting parents: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message
      };
    }
  }

  /**
   * POST /api/database/videos/:parentId/add-children
   * Add multiple existing videos as children of a parent
   */
  @Post('videos/:parentId/add-children')
  addChildren(
    @Param('parentId') parentId: string,
    @Body() body: { childIds: string[] }
  ) {
    try {
      const { childIds } = body;

      if (!childIds || childIds.length === 0) {
        return {
          success: false,
          error: 'Child IDs are required'
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

      const results = [];
      const errors = [];

      for (const childId of childIds) {
        try {
          this.databaseService.setVideoParent(childId, parentId);
          results.push({ childId, status: 'linked' });
        } catch (error) {
          errors.push({
            childId,
            error: (error as Error).message
          });
        }
      }

      return {
        success: errors.length === 0,
        message: `Linked ${results.length} video(s) as children`,
        results,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      this.logger.error(`Error adding children: ${(error as Error).message}`);
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

  /**
   * GET /api/database/ignore
   * Get the .clipchimpignore file content
   */
  @Get('ignore')
  getIgnoreFile() {
    const content = this.ignoreService.getIgnoreFileContent();
    const filePath = this.ignoreService.getIgnoreFilePathString();

    if (content === null) {
      return {
        success: false,
        error: 'Could not read ignore file',
      };
    }

    return {
      success: true,
      content,
      filePath,
      patterns: this.ignoreService.getIgnorePatterns(),
    };
  }

  /**
   * POST /api/database/ignore
   * Update the .clipchimpignore file content
   */
  @Post('ignore')
  updateIgnoreFile(@Body() body: { content: string }) {
    if (!body.content || typeof body.content !== 'string') {
      return {
        success: false,
        error: 'Content is required',
      };
    }

    const success = this.ignoreService.updateIgnoreFileContent(body.content);

    return {
      success,
      message: success ? 'Ignore file updated successfully' : 'Failed to update ignore file',
    };
  }

  /**
   * POST /api/database/ignore/add
   * Add a pattern to the .clipchimpignore file
   */
  @Post('ignore/add')
  addIgnorePattern(@Body() body: { pattern: string }) {
    if (!body.pattern || typeof body.pattern !== 'string') {
      return {
        success: false,
        error: 'Pattern is required',
      };
    }

    const success = this.ignoreService.addIgnorePattern(body.pattern);

    return {
      success,
      message: success ? 'Pattern added to ignore file' : 'Failed to add pattern',
    };
  }

  /**
   * POST /api/database/rebuild-search-index
   * Rebuild FTS5 full-text search indexes from existing data
   */
  @Post('rebuild-search-index')
  rebuildSearchIndex() {
    this.logger.log('Rebuilding FTS5 search indexes');
    try {
      this.databaseService.rebuildFTS5Indexes();
      return {
        success: true,
        message: 'FTS5 search indexes rebuilt successfully',
      };
    } catch (error: any) {
      this.logger.error('Failed to rebuild FTS5 search indexes:', error);
      return {
        success: false,
        error: error?.message || 'Unknown error',
      };
    }
  }

  /**
   * POST /api/database/import
   * Import media files to the library by file path
   * If files are already in clips folder, just scan them
   * If files are elsewhere, copy them to clips folder then scan
   */
  @Post('import')
  async importFiles(@Body() body: { filePaths: string[] }) {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      if (!body.filePaths || body.filePaths.length === 0) {
        throw new HttpException('No file paths provided', HttpStatus.BAD_REQUEST);
      }

      this.logger.log(`Importing ${body.filePaths.length} file(s) to library: ${activeLibrary.name}`);

      const clipsFolder = activeLibrary.clipsFolderPath;
      if (!fs.existsSync(clipsFolder)) {
        fs.mkdirSync(clipsFolder, { recursive: true });
      }

      const results: any[] = [];
      const filesToScan = new Set<string>();

      for (const filePath of body.filePaths) {
        try {
          if (!fs.existsSync(filePath)) {
            results.push({
              success: false,
              filePath,
              error: 'File not found'
            });
            continue;
          }

          const filename = path.basename(filePath);

          // Normalize paths for comparison
          const normalizedFilePath = path.resolve(filePath);
          const normalizedClipsFolder = path.resolve(clipsFolder);
          const normalizedFileDir = path.dirname(normalizedFilePath);

          // Check if file is already in clips folder
          const isInClipsFolder = normalizedFileDir === normalizedClipsFolder;

          let finalFilename = filename;

          if (!isInClipsFolder) {
            // Calculate week folder based on file creation date
            const stats = fs.statSync(filePath);
            const fileCreationDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;

            // Calculate Sunday of the current week for the file's creation date
            const dayOfWeek = fileCreationDate.getDay();
            const sundayDate = new Date(fileCreationDate);

            if (dayOfWeek === 0) {
              // Already Sunday
            } else if (dayOfWeek <= 3) {
              // Monday-Wednesday: go back to previous Sunday
              sundayDate.setDate(fileCreationDate.getDate() - dayOfWeek);
            } else {
              // Thursday-Saturday: go forward to next Sunday
              sundayDate.setDate(fileCreationDate.getDate() + (7 - dayOfWeek));
            }

            const year = sundayDate.getFullYear();
            const month = String(sundayDate.getMonth() + 1).padStart(2, '0');
            const day = String(sundayDate.getDate()).padStart(2, '0');
            const weekFolder = `${year}-${month}-${day}`;

            // Create week folder if it doesn't exist
            const weekFolderPath = path.join(clipsFolder, weekFolder);
            if (!fs.existsSync(weekFolderPath)) {
              fs.mkdirSync(weekFolderPath, { recursive: true });
              this.logger.log(`Created week folder: ${weekFolderPath}`);
            }

            // Copy file to week folder
            this.logger.log(`Copying ${filename} to week folder ${weekFolder} (from ${filePath})`);

            // Generate unique filename if needed
            let uniqueFilename = filename;
            let counter = 1;
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);

            while (fs.existsSync(path.join(weekFolderPath, uniqueFilename))) {
              uniqueFilename = `${base}_${counter}${ext}`;
              counter++;
            }

            finalFilename = path.join(weekFolder, uniqueFilename);  // Include week folder in path
            const finalTargetPath = path.join(weekFolderPath, uniqueFilename);
            fs.copyFileSync(filePath, finalTargetPath);

            // Preserve original file timestamps
            fs.utimesSync(finalTargetPath, stats.atime, stats.mtime);

            this.logger.log(`Copied to: ${finalTargetPath}`);
            filesToScan.add(finalFilename);  // Use relative path with week folder
          } else {
            this.logger.log(`File already in clips folder: ${filename}`);
            filesToScan.add(filename);
          }

          results.push({
            success: true,
            filePath,
            filename: finalFilename,
            pendingScan: true
          });
        } catch (error: any) {
          this.logger.error(`Failed to import file ${filePath}:`, error);
          results.push({
            success: false,
            filePath,
            error: error.message
          });
        }
      }

      // Import specific files directly without scanning entire folder
      this.logger.log(`Importing ${filesToScan.size} specific file(s)...`);

      for (const result of results) {
        if (!result.success || !result.pendingScan) continue;

        try {
          const filePath = path.join(clipsFolder, result.filename);

          // Check if already in database by filename
          const existingByFilename = this.databaseService.getAllVideos({ linkedOnly: false })
            .find((v: any) => v.filename === result.filename);

          if (existingByFilename) {
            // File exists in database - update its path and mark as linked
            this.logger.log(`File "${result.filename}" already in database as ${existingByFilename.id} - relinking`);
            this.databaseService.updateVideoPath(existingByFilename.id, filePath);
            result.videoId = existingByFilename.id;
            result.wasRelinked = true;
            delete result.pendingScan;
            continue;
          }

          // Compute hash for the specific file
          const stats = fs.statSync(filePath);
          const fileHash = await this.databaseService.hashFile(filePath);

          // Check if this hash already exists in database
          const existingByHash = this.databaseService.getAllVideos({ linkedOnly: false })
            .find((v: any) => v.file_hash === fileHash);

          if (existingByHash) {
            // Same content exists - update path and mark as linked
            this.logger.log(`File "${result.filename}" matches existing video ${existingByHash.id} by hash - relinking`);
            this.databaseService.updateVideoPath(existingByHash.id, filePath);
            result.videoId = existingByHash.id;
            result.wasRelinked = true;
            delete result.pendingScan;
            continue;
          }

          // New file - add to database
          const videoId = require('uuid').v4();
          const fileCreationDate = stats.birthtime < stats.mtime ? stats.birthtime : stats.mtime;

          // Extract upload date from filename or parent folder
          let uploadDate: string | undefined;
          const dateInfo = FilenameDateUtil.extractDateInfo(result.filename);
          if (dateInfo.hasDate) {
            uploadDate = FilenameDateUtil.toISODate(dateInfo.date) || undefined;
          }
          // NOTE: We do NOT use the folder date as upload_date fallback.
          // The folder date represents when the file was downloaded/organized (closest Sunday),
          // NOT when the content was originally uploaded to the internet.
          // If filename has no date, uploadDate should remain undefined.

          this.databaseService.insertVideo({
            id: videoId,
            filename: result.filename,
            fileHash: fileHash,
            currentPath: result.filename, // Store as relative path
            uploadDate: uploadDate,
            downloadDate: fileCreationDate.toISOString(),
            fileSizeBytes: stats.size,
          });

          this.logger.log(`Added new video: ${result.filename} (${videoId})`);
          result.videoId = videoId;
          result.wasRelinked = false;
          delete result.pendingScan;

        } catch (error: any) {
          this.logger.error(`Failed to import ${result.filename}:`, error);
          result.success = false;
          result.error = error.message;
          delete result.pendingScan;
        }
      }

      const successCount = results.filter(r => r.success).length;

      return {
        success: successCount > 0,
        message: `Successfully imported ${successCount} of ${body.filePaths.length} file(s)`,
        results
      };
    } catch (error: any) {
      this.logger.error('Import failed:', error);
      throw new HttpException(
        error.message || 'Failed to import files',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * POST /api/database/upload
   * Upload media files to the library
   * Accepts multiple files and saves them to the active library's clips folder
   */
  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', 20))
  async uploadFiles(@UploadedFiles() files: Express.Multer.File[]) {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      if (!files || files.length === 0) {
        throw new HttpException('No files uploaded', HttpStatus.BAD_REQUEST);
      }

      this.logger.log(`Uploading ${files.length} file(s) to library: ${activeLibrary.name}`);

      // Ensure clips folder exists
      const clipsFolder = activeLibrary.clipsFolderPath;
      if (!fs.existsSync(clipsFolder)) {
        fs.mkdirSync(clipsFolder, { recursive: true });
      }

      const results = [];

      for (const file of files) {
        try {
          // Validate file type
          const allowedMimeTypes = [
            'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
            'video/x-msvideo', 'video/x-matroska', 'audio/mpeg',
            'audio/mp4', 'audio/wav', 'audio/webm', 'audio/ogg'
          ];

          const isValidType = allowedMimeTypes.includes(file.mimetype) ||
            file.mimetype.startsWith('video/') ||
            file.mimetype.startsWith('audio/');

          if (!isValidType) {
            results.push({
              success: false,
              filename: file.originalname,
              error: `Invalid file type: ${file.mimetype}`
            });
            continue;
          }

          // Generate unique filename
          let filename = file.originalname;
          let counter = 1;
          const ext = path.extname(filename);
          const base = path.basename(filename, ext);

          while (fs.existsSync(path.join(clipsFolder, filename))) {
            filename = `${base}_${counter}${ext}`;
            counter++;
          }

          // Move file from temp location to clips folder
          const targetPath = path.join(clipsFolder, filename);
          fs.renameSync(file.path, targetPath);

          this.logger.log(`Saved file to: ${targetPath}`);

          // Scan and import the file into the database
          await this.fileScannerService.scanClipsFolder(clipsFolder);

          // Find the newly added video in the database
          const allVideos = this.databaseService.getAllVideos({ linkedOnly: true });
          const newVideo = allVideos.find(v => v.filename === filename);

          if (newVideo) {
            results.push({
              success: true,
              filename: filename,
              videoId: newVideo.id,
              path: targetPath,
              size: file.size
            });
          } else {
            results.push({
              success: false,
              filename: filename,
              error: 'File uploaded but not found in database after scan'
            });
          }
        } catch (error: any) {
          this.logger.error(`Failed to process uploaded file ${file.originalname}:`, error);
          results.push({
            success: false,
            filename: file.originalname,
            error: error.message
          });
        }
      }

      const successCount = results.filter(r => r.success).length;

      return {
        success: successCount > 0,
        message: `Successfully uploaded ${successCount} of ${files.length} file(s)`,
        results
      };
    } catch (error: any) {
      this.logger.error('Upload failed:', error);
      throw new HttpException(
        error.message || 'Failed to upload files',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
