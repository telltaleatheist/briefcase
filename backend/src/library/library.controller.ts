// clippy/backend/src/library/library.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Res,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { createReadStream, statSync, existsSync } from 'fs';
import * as fs from 'fs';
import { LibraryService } from './library.service';
import { Logger } from '@nestjs/common';
import { RelinkService } from './relink.service';
import { ClipExtractorService } from './clip-extractor.service';
import { SharedConfigService } from '../config/shared-config.service';
import { FileScannerService } from '../database/file-scanner.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { DatabaseService } from '../database/database.service';
import { AIProviderService } from '../analysis/ai-provider.service';
import { buildAnalyticsInsightsPrompt } from './prompts/analytics-insights.prompt';
import {
  CreateLibraryAnalysisRequest,
  UpdateLibraryAnalysisRequest,
  CreateClipRequest,
} from './interfaces/library.interface';
import { parseAnalysisReport, extractCategories, saveAnalysisMetadata } from './parsers/analysis-parser';
import * as path from 'path';
import * as os from 'os';

@Controller('library')
export class LibraryController {
  private readonly logger = new Logger(LibraryController.name);

  constructor(
    private libraryService: LibraryService,
    private relinkService: RelinkService,
    private clipExtractor: ClipExtractorService,
    private configService: SharedConfigService,
    private fileScannerService: FileScannerService,
    private libraryManagerService: LibraryManagerService,
    private databaseService: DatabaseService,
    private aiProviderService: AIProviderService
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
   * Get all analyses (optionally filtered by archived status)
   */
  @Get('analyses')
  async getAnalyses(@Query('archived') archived?: string) {
    try {
      const archivedBool = archived === 'true' ? true : archived === 'false' ? false : undefined;
      return await this.libraryService.getAnalyses(archivedBool);
    } catch (error) {
      throw new HttpException(
        `Failed to get analyses: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get a single analysis by ID
   */
  @Get('analyses/:id')
  async getAnalysis(@Param('id') id: string) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      return analysis;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get analysis: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get parsed metadata for an analysis
   */
  @Get('analyses/:id/metadata')
  async getAnalysisMetadata(@Param('id') id: string) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      // Read the parsed metadata JSON file
      const fs = require('fs/promises');
      const content = await fs.readFile(analysis.files.analysisMetadata, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get analysis metadata: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get transcript text for an analysis
   */
  @Get('analyses/:id/transcript')
  async getAnalysisTranscript(@Param('id') id: string) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      // Check if transcript exists - prefer SRT for timestamps, fallback to TXT
      const transcriptPath = analysis.files.transcriptSrt || analysis.files.transcriptTxt;

      if (!transcriptPath) {
        return {
          exists: false,
          text: null
        };
      }

      try {
        // Read the transcript file (SRT format preferred for timestamps)
        const fs = require('fs/promises');
        const text = await fs.readFile(transcriptPath, 'utf-8');
        return {
          exists: true,
          text
        };
      } catch (error) {
        // File doesn't exist or can't be read
        return {
          exists: false,
          text: null
        };
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get transcript: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Create a new analysis
   */
  @Post('analyses')
  async createAnalysis(@Body() request: CreateLibraryAnalysisRequest) {
    try {
      // Validate required fields
      if (!request.title || !request.videoPath || !request.transcriptSrtPath ||
          !request.transcriptTxtPath || !request.analysisReportPath) {
        throw new HttpException(
          'Missing required fields',
          HttpStatus.BAD_REQUEST
        );
      }

      // Create analysis in library
      const analysis = await this.libraryService.createAnalysis(request);

      // Parse analysis report to generate metadata JSON
      const parsedMetadata = await parseAnalysisReport(
        analysis.files.analysis,
        analysis.id,
        analysis.title,
        analysis.createdAt
      );

      // Extract categories
      const categories = extractCategories(parsedMetadata);

      // Save parsed metadata to JSON file
      await saveAnalysisMetadata(analysis.files.analysisMetadata, parsedMetadata);

      // Update analysis with extracted categories
      await this.libraryService.updateAnalysis(analysis.id, {});

      // Update categories in library
      const updatedAnalysis = await this.libraryService.getAnalysis(analysis.id);
      if (updatedAnalysis) {
        updatedAnalysis.metadata.categories = categories;
        // Force a save by doing a dummy update
        await this.libraryService.updateAnalysis(analysis.id, {});
      }

      return {
        success: true,
        analysis,
        metadata: parsedMetadata,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to create analysis: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Update an analysis (archive, relink, etc.)
   */
  @Patch('analyses/:id')
  async updateAnalysis(
    @Param('id') id: string,
    @Body() update: UpdateLibraryAnalysisRequest
  ) {
    try {
      const analysis = await this.libraryService.updateAnalysis(id, update);
      return {
        success: true,
        analysis,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to update analysis: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Delete an analysis
   */
  @Delete('analyses/:id')
  async deleteAnalysis(@Param('id') id: string) {
    try {
      await this.libraryService.deleteAnalysis(id);
      return {
        success: true,
        message: 'Analysis deleted',
      };
    } catch (error) {
      throw new HttpException(
        `Failed to delete analysis: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get all clips for an analysis
   */
  @Get('analyses/:id/clips')
  async getClipsForAnalysis(@Param('id') id: string) {
    try {
      return await this.libraryService.getClipsForAnalysis(id);
    } catch (error) {
      throw new HttpException(
        `Failed to get clips: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get a single clip
   */
  @Get('clips/:id')
  async getClip(@Param('id') id: string) {
    try {
      const clip = await this.libraryService.getClip(id);

      if (!clip) {
        throw new HttpException('Clip not found', HttpStatus.NOT_FOUND);
      }

      return clip;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get clip: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Create a new clip
   */
  @Post('clips')
  async createClip(@Body() request: CreateClipRequest) {
    try {
      const clip = await this.libraryService.createClip(request);
      return {
        success: true,
        clip,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to create clip: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Delete a clip
   */
  @Delete('clips/:id')
  async deleteClip(@Param('id') id: string) {
    try {
      await this.libraryService.deleteClip(id);
      return {
        success: true,
        message: 'Clip deleted',
      };
    } catch (error) {
      throw new HttpException(
        `Failed to delete clip: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get library statistics
   */
  @Get('stats')
  async getStats() {
    try {
      return await this.libraryService.getStats();
    } catch (error) {
      throw new HttpException(
        `Failed to get stats: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get library paths (for debugging/admin)
   */
  @Get('paths')
  getPaths() {
    return this.libraryService.getLibraryPaths();
  }

  /**
   * Auto-relink video by searching clips collection
   */
  @Post('analyses/:id/auto-relink')
  async autoRelink(@Param('id') id: string) {
    try {
      const result = await this.relinkService.autoRelinkVideo(id);
      return result;
    } catch (error) {
      throw new HttpException(
        `Failed to auto-relink: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Manual relink video
   */
  @Post('analyses/:id/manual-relink')
  async manualRelink(
    @Param('id') id: string,
    @Body() body: { videoPath: string }
  ) {
    try {
      const result = await this.relinkService.manualRelink(id, body.videoPath);
      return result;
    } catch (error) {
      throw new HttpException(
        `Failed to manual relink: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Verify all videos and mark broken links
   */
  @Post('verify-all')
  async verifyAll() {
    try {
      const result = await this.relinkService.verifyAllVideos();
      return result;
    } catch (error) {
      throw new HttpException(
        `Failed to verify videos: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Search clips collection for a video
   */
  @Get('search-clips')
  async searchClips(@Query('filename') filename: string) {
    try {
      if (!filename) {
        throw new HttpException('Filename required', HttpStatus.BAD_REQUEST);
      }
      const results = await this.relinkService.searchClipsCollection(filename);
      return { results };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to search clips: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Serve image file by direct file path (encoded in query param)
   * Uses sendFile for simple, direct image serving
   * NOTE: This must be defined BEFORE videos/custom to handle images separately
   */
  @Get('images/custom')
  async serveCustomImage(
    @Query('path') encodedPath: string,
    @Res() res: Response
  ) {
    try {
      if (!encodedPath) {
        throw new HttpException('path parameter is required', HttpStatus.BAD_REQUEST);
      }

      // Decode the base64-encoded path
      const imagePath = Buffer.from(encodedPath, 'base64').toString('utf-8');
      this.logger.log(`[Image] Decoded path: ${imagePath}`);

      // Check if file exists
      if (!existsSync(imagePath)) {
        throw new HttpException('Image file not found', HttpStatus.NOT_FOUND);
      }

      // Determine content type from file extension
      const ext = path.extname(imagePath).toLowerCase();
      const contentTypeMap: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const contentType = contentTypeMap[ext] || 'application/octet-stream';

      // Set headers and send file
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.sendFile(imagePath);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to serve image: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to serve image: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Stream video file by direct file path (encoded in query param)
   * Supports range requests for seeking
   * Allows loading videos without requiring AI analysis
   * NOTE: This must be defined BEFORE videos/:id to avoid route conflicts
   */
  @Get('videos/custom')
  async streamCustomVideo(
    @Query('path') encodedPath: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      if (!encodedPath) {
        throw new HttpException('path parameter is required', HttpStatus.BAD_REQUEST);
      }

      // Decode the base64-encoded path
      const videoPath = Buffer.from(encodedPath, 'base64').toString('utf-8');
      this.logger.log(`[Stream] Decoded path: ${videoPath}`);

      // Check if file exists
      try {
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
          '.bmp': 'image/bmp',
          // Document formats
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.md': 'text/markdown',
          // Web formats
          '.html': 'text/html',
          '.htm': 'text/html',
          '.mhtml': 'message/rfc822',
        };
        const contentType = contentTypeMap[ext] || 'application/octet-stream';

        if (range) {
          // Handle range request for seeking
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          // Honor the browser's requested end byte, or provide 10MB chunks for smooth playback
          const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 10 * 1024 * 1024, fileSize - 1);
          const chunkSize = end - start + 1;

          const stream = createReadStream(videoPath, { start, end, highWaterMark: 256 * 1024 }); // 256KB buffer for faster streaming

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
          });

          stream.pipe(res);
        } else {
          // No range request, stream entire file with optimized buffer
          const stream = createReadStream(videoPath, { highWaterMark: 256 * 1024 }); // 256KB buffer

          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
          });

          stream.pipe(res);
        }
      } catch (fileError) {
        throw new HttpException(
          'Video file not found on disk',
          HttpStatus.NOT_FOUND
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to stream video: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get video metadata by ID
   * Returns the video database record with all flags and metadata
   */
  @Get('videos/:id/metadata')
  async getVideoMetadata(@Param('id') id: string) {
    try {
      const video = this.databaseService.getVideoById(id);

      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      return video;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to get video metadata',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Stream video file for an analysis
   * Supports range requests for seeking
   */
  @Get('videos/:id')
  async streamVideo(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      if (!analysis.video.isLinked) {
        throw new HttpException('Video file is not linked', HttpStatus.NOT_FOUND);
      }

      const videoPath = analysis.video.currentPath;

      // Check if file exists
      try {
        const stat = statSync(videoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
          // Handle range request for seeking
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          // Honor the browser's requested end byte, or provide 10MB chunks for smooth playback
          const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 10 * 1024 * 1024, fileSize - 1);
          const chunkSize = end - start + 1;

          const stream = createReadStream(videoPath, { start, end, highWaterMark: 256 * 1024 }); // 256KB buffer for faster streaming

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
            'Cache-Control': 'public, max-age=3600',
          });

          stream.pipe(res);
        } else {
          // No range request, stream entire file with optimized buffer
          const stream = createReadStream(videoPath, { highWaterMark: 256 * 1024 }); // 256KB buffer

          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
          });

          stream.pipe(res);
        }
      } catch (fileError) {
        throw new HttpException(
          'Video file not found on disk',
          HttpStatus.NOT_FOUND
        );
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to stream video: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Extract a clip from a custom video (not in library)
   */
  @Post('videos/custom/extract-clip')
  async extractClipFromCustomVideo(
    @Body() body: {
      videoPath: string;
      startTime: number;
      endTime: number;
      title?: string;
      description?: string;
      category?: string;
      customDirectory?: string;
      progressId?: string;
      reEncode?: boolean;
    }
  ) {
    try {
      if (!body.videoPath) {
        throw new HttpException('videoPath is required', HttpStatus.BAD_REQUEST);
      }

      // Validate time range
      if (body.startTime < 0 || body.endTime <= body.startTime) {
        throw new HttpException(
          'Invalid time range',
          HttpStatus.BAD_REQUEST
        );
      }

      // Check if file exists
      const fsSync = require('fs');
      if (!fsSync.existsSync(body.videoPath)) {
        throw new HttpException('Video file not found', HttpStatus.NOT_FOUND);
      }

      // Find the source video and determine the correct parent for the clip
      // If source video is a child, use its parent; otherwise use source video as parent
      let parentVideo: any = null;
      let parentVideoId: string | undefined;
      try {
        const allVideos = this.databaseService.getAllVideos({ includeChildren: true });
        parentVideo = allVideos.find((v: any) => v.current_path === body.videoPath);

        if (parentVideo && parentVideo.id) {
          // If source video has a parent, make the clip a co-child (sibling)
          // Otherwise, make the source video the parent
          if (parentVideo.parent_id) {
            parentVideoId = String(parentVideo.parent_id);
            this.logger.log(`Source video is a child - linking clip as co-child to parent: ${parentVideoId}`);
          } else {
            parentVideoId = String(parentVideo.id);
            this.logger.log(`Source video is a parent - linking clip as child: ${parentVideoId}`);
          }
        }
      } catch (error) {
        this.logger.warn(`Could not find source video for linking: ${(error as Error).message}`);
      }

      // Generate clip filename
      const originalFilename = path.basename(body.videoPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category,
        body.title,
        parentVideo?.upload_date
      );

      // Determine output path
      let outputDir: string;

      if (body.customDirectory) {
        // If custom directory is provided, use it directly without adding /clips subfolder
        outputDir = body.customDirectory.replace(/[\\/]+$/, ''); // Remove trailing slashes
      } else {
        // Use library clips directory
        outputDir = this.libraryService.getLibraryPaths().clipsDir;
      }

      const outputPath = path.join(outputDir, clipFilename);

      // Progress tracking map (stored in memory)
      const progressMap = new Map<string, number>();
      const progressId = body.progressId || 'default';

      // Extract the clip with progress callback
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: body.videoPath,
        startTime: body.startTime,
        endTime: body.endTime,
        outputPath,
        reEncode: body.reEncode || false,
        metadata: {
          title: body.title,
          description: body.description,
          category: body.category,
        },
        onProgress: (progress: number) => {
          progressMap.set(progressId, progress);
        },
      });

      if (!extractionResult.success) {
        throw new HttpException(
          extractionResult.error || 'Failed to extract clip',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Import the created clip to the library
      let videoId: string | undefined;
      if (extractionResult.outputPath) {
        try {
          this.logger.log(`Importing clip to library: ${extractionResult.outputPath}`);

          // Find the source video and determine the correct parent for the clip
          // If source video is a child, use its parent; otherwise use source video as parent
          let parentVideoId: string | undefined;
          try {
            const allVideos = this.databaseService.getAllVideos({ includeChildren: true });
            const sourceVideo = allVideos.find((v: any) => v.current_path === body.videoPath);

            if (sourceVideo && sourceVideo.id) {
              // If source video has a parent, make the clip a co-child (sibling)
              // Otherwise, make the source video the parent
              if (sourceVideo.parent_id) {
                parentVideoId = String(sourceVideo.parent_id);
                this.logger.log(`Source video is a child - linking clip as co-child to parent: ${parentVideoId}`);
              } else {
                parentVideoId = String(sourceVideo.id);
                this.logger.log(`Source video is a parent - linking clip as child: ${parentVideoId}`);
              }
            }
          } catch (error) {
            this.logger.warn(`Could not find parent video for linking: ${(error as Error).message}`);
            // Continue without parent linking
          }

          const importResult = await this.fileScannerService.importVideos(
            [extractionResult.outputPath],
            undefined,
            parentVideoId
          );
          if (importResult.imported.length > 0) {
            videoId = importResult.imported[0];
            this.logger.log(`Clip imported to library with ID: ${videoId}${parentVideoId ? ` (linked to parent ${parentVideoId})` : ''}`);
          } else {
            this.logger.warn(`Failed to import clip to library: ${extractionResult.outputPath}`);
          }
        } catch (importError) {
          this.logger.error(`Error importing clip to library: ${(importError as Error).message}`);
          // Don't fail the entire request if import fails
        }
      }

      return {
        success: true,
        videoId,
        extraction: {
          duration: extractionResult.duration,
          fileSize: extractionResult.fileSize,
          outputPath: extractionResult.outputPath,
        },
      };

    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to create clip: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get the default save path for a clip
   */
  @Post('analyses/:id/clip-save-path')
  async getClipSavePath(
    @Param('id') id: string,
    @Body() body: {
      startTime: number;
      endTime: number;
      category?: string;
      customDirectory?: string;
      title?: string;
    }
  ) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      // Try to get the parent video from database to retrieve upload_date
      let uploadDate: string | undefined;
      try {
        const parentVideos = this.databaseService.getAllVideos({ includeChildren: true });
        const parentVideo = parentVideos.find((v: any) => v.current_path === analysis.video.currentPath);
        if (parentVideo && parentVideo.upload_date) {
          uploadDate = parentVideo.upload_date;
        }
      } catch (error) {
        this.logger.warn(`Could not find parent video upload_date: ${(error as Error).message}`);
      }

      // Generate clip filename
      const originalFilename = path.basename(analysis.video.currentPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category,
        body.title,
        uploadDate
      );

      // Determine output path
      let outputDir: string;
      let baseDir: string;
      let clippyDir: string;

      if (body.customDirectory) {
        // If custom directory is provided, use it directly without adding /clips subfolder
        baseDir = body.customDirectory.replace(/[\\/]+$/, ''); // Remove trailing slashes
        clippyDir = baseDir;
        outputDir = baseDir;
      } else {
        // Use library clips directory
        const libraryPaths = this.libraryService.getLibraryPaths();
        outputDir = libraryPaths.clipsDir;
        baseDir = libraryPaths.libraryDir;
        clippyDir = libraryPaths.libraryDir;
      }

      const outputPath = path.join(outputDir, clipFilename);

      return {
        success: true,
        outputPath,
        outputDir,
        filename: clipFilename,
        baseDir,
        clippyDir,
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get clip save path: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Extract a clip from any video by path
   */
  @Post('extract-clip')
  async extractClipFromPath(
    @Body() body: {
      videoPath: string;
      startTime: number;
      endTime: number;
      title?: string;
      description?: string;
      category?: string;
      customDirectory?: string;
    }
  ) {
    try {
      // Validate time range
      if (body.startTime < 0 || body.endTime <= body.startTime) {
        throw new HttpException(
          'Invalid time range',
          HttpStatus.BAD_REQUEST
        );
      }

      // Check if video file exists
      if (!fs.existsSync(body.videoPath)) {
        throw new HttpException('Video file not found', HttpStatus.NOT_FOUND);
      }

      // Find the source video and determine the correct parent for the clip
      // If source video is a child, use its parent; otherwise use source video as parent
      let parentVideo: any = null;
      let parentVideoId: string | undefined;
      try {
        const allVideos = this.databaseService.getAllVideos({ includeChildren: true });
        parentVideo = allVideos.find((v: any) => v.current_path === body.videoPath);

        if (parentVideo && parentVideo.id) {
          // If source video has a parent, make the clip a co-child (sibling)
          // Otherwise, make the source video the parent
          if (parentVideo.parent_id) {
            parentVideoId = String(parentVideo.parent_id);
            this.logger.log(`Source video is a child - linking clip as co-child to parent: ${parentVideoId}`);
          } else {
            parentVideoId = String(parentVideo.id);
            this.logger.log(`Source video is a parent - linking clip as child: ${parentVideoId}`);
          }
        }
      } catch (error) {
        this.logger.warn(`Could not find source video for linking: ${(error as Error).message}`);
      }

      // Generate clip filename
      const originalFilename = path.basename(body.videoPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category,
        body.title,
        parentVideo?.upload_date
      );

      // Determine output path
      let outputDir: string;
      let weekFolder: string | null = null;

      if (body.customDirectory) {
        outputDir = body.customDirectory.replace(/[\\/]+$/, '');
      } else {
        // Use active library's clips folder with weekly organization
        const activeLibrary = this.libraryManagerService.getActiveLibrary();
        if (!activeLibrary) {
          throw new HttpException(
            'No active library. Please create or select a library first.',
            HttpStatus.BAD_REQUEST
          );
        }

        // Create weekly folder based on current date
        weekFolder = this.getWeekStartDate(new Date());
        const weekFolderPath = path.join(activeLibrary.clipsFolderPath, weekFolder);

        // Ensure weekly folder exists
        if (!fs.existsSync(weekFolderPath)) {
          fs.mkdirSync(weekFolderPath, { recursive: true });
          this.logger.log(`Created weekly folder: ${weekFolderPath}`);
        }

        outputDir = weekFolderPath;
      }

      const outputPath = path.join(outputDir, clipFilename);

      // Extract the clip
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: body.videoPath,
        startTime: body.startTime,
        endTime: body.endTime,
        outputPath,
        metadata: {
          title: body.title,
          description: body.description,
          category: body.category,
        },
      });

      if (!extractionResult.success) {
        throw new HttpException(
          extractionResult.error || 'Failed to extract clip',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Automatically import the clip to the library with parent linking
      try {
        const importResult = await this.fileScannerService.importVideos(
          [outputPath],
          undefined,
          parentVideoId
        );
        this.logger.log(`Imported clip to library: ${importResult.imported.length > 0 ? 'success' : 'failed'}${parentVideoId ? ` (linked to parent ${parentVideoId})` : ''}`);
        if (importResult.errors.length > 0) {
          this.logger.warn(`Import warnings: ${importResult.errors.join(', ')}`);
        }
      } catch (importError) {
        this.logger.error(`Failed to import clip to library: ${(importError as Error).message}`);
        // Don't fail the whole request if import fails
      }

      return {
        success: true,
        extraction: extractionResult,
        message: 'Clip extracted successfully',
      };
    } catch (error: any) {
      this.logger.error(`Failed to extract clip: ${error?.message}`);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        error?.message || 'Failed to extract clip',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Overwrite a video file with a clip from itself
   * This will replace the original video file and clear all metadata
   */
  @Post('overwrite-with-clip')
  async overwriteVideoWithClip(
    @Body() body: {
      videoId: string;
      videoPath: string;
      startTime: number;
      endTime: number;
      reEncode?: boolean;
    }
  ) {
    try {
      // Validate time range
      if (body.startTime < 0 || body.endTime <= body.startTime) {
        throw new HttpException(
          'Invalid time range',
          HttpStatus.BAD_REQUEST
        );
      }

      // Check if video file exists
      if (!fs.existsSync(body.videoPath)) {
        throw new HttpException('Video file not found', HttpStatus.NOT_FOUND);
      }

      // Get video record from database to preserve metadata
      const video = this.databaseService.getVideoById(body.videoId);
      if (!video) {
        throw new HttpException('Video not found in database', HttpStatus.NOT_FOUND);
      }

      // Store original metadata to preserve after overwrite
      const originalMetadata = {
        uploadDate: video.upload_date,
        downloadDate: video.download_date,
        addedAt: video.added_at,
        sourceUrl: video.source_url,
        aiDescription: video.ai_description,
        suggestedTitle: video.suggested_title,
      };

      this.logger.log(`Overwriting video ${body.videoId} with clip from ${body.startTime} to ${body.endTime}`);

      // Create a temporary file for the clip
      const tempDir = os.tmpdir();
      const originalExt = path.extname(body.videoPath);
      const tempFilename = `clippy_temp_${Date.now()}${originalExt}`;
      const tempPath = path.join(tempDir, tempFilename);

      // Extract the clip to temp file
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: body.videoPath,
        startTime: body.startTime,
        endTime: body.endTime,
        outputPath: tempPath,
        reEncode: body.reEncode || false,
      });

      if (!extractionResult.success) {
        throw new HttpException(
          extractionResult.error || 'Failed to extract clip',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Delete the original file
      try {
        fs.unlinkSync(body.videoPath);
        this.logger.log(`Deleted original file: ${body.videoPath}`);
      } catch (error) {
        // Clean up temp file
        try {
          fs.unlinkSync(tempPath);
        } catch (cleanupError) {
          this.logger.error(`Failed to clean up temp file: ${(cleanupError as Error).message}`);
        }
        throw new HttpException(
          `Failed to delete original file: ${(error as Error).message}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Copy temp file to replace original (can't use rename across different devices)
      try {
        fs.copyFileSync(tempPath, body.videoPath);
        this.logger.log(`Copied temp file to original location: ${body.videoPath}`);

        // Delete temp file after successful copy
        try {
          fs.unlinkSync(tempPath);
          this.logger.log(`Deleted temp file: ${tempPath}`);
        } catch (cleanupError) {
          this.logger.warn(`Failed to delete temp file: ${(cleanupError as Error).message}`);
          // Don't fail the request if temp cleanup fails
        }
      } catch (error) {
        throw new HttpException(
          `Failed to copy temp file to original location: ${(error as Error).message}`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Clear all metadata for this video
      try {
        // Delete transcript
        this.databaseService.deleteTranscript(body.videoId);
        this.logger.log(`Deleted transcript for video ${body.videoId}`);

        // Delete analysis sections
        this.databaseService.deleteAnalysisSections(body.videoId);
        this.logger.log(`Deleted analysis sections for video ${body.videoId}`);

        // Delete custom markers
        this.databaseService.deleteCustomMarkers(body.videoId);
        this.logger.log(`Deleted custom markers for video ${body.videoId}`);

        // Delete analysis record
        this.databaseService.deleteAnalysis(body.videoId);
        this.logger.log(`Deleted analysis for video ${body.videoId}`);

        // Update video record with new duration and file size, but preserve dates and other metadata
        const newDuration = extractionResult.duration || (body.endTime - body.startTime);
        const db = this.databaseService['db'];
        if (db) {
          db.prepare(`
            UPDATE videos
            SET duration = ?,
                file_size = ?,
                has_transcript = 0,
                has_analysis = 0,
                transcript_status = NULL,
                analysis_status = NULL,
                upload_date = ?,
                download_date = ?,
                added_at = ?,
                source_url = ?,
                ai_description = ?,
                suggested_title = ?
            WHERE id = ?
          `).run(
            newDuration,
            extractionResult.fileSize,
            originalMetadata.uploadDate,
            originalMetadata.downloadDate,
            originalMetadata.addedAt,
            originalMetadata.sourceUrl,
            originalMetadata.aiDescription,
            originalMetadata.suggestedTitle,
            body.videoId
          );
          this.databaseService['saveDatabase']();
          this.logger.log(`Updated video ${body.videoId} with new duration: ${newDuration}, preserved original metadata`);
        }
      } catch (error) {
        this.logger.error(`Failed to clear metadata: ${(error as Error).message}`);
        // Don't fail the whole request if metadata clearing fails
        // The file has already been overwritten successfully
      }

      return {
        success: true,
        message: 'Video file overwritten successfully',
        newDuration: extractionResult.duration || (body.endTime - body.startTime),
        fileSize: extractionResult.fileSize,
      };
    } catch (error: any) {
      this.logger.error(`Failed to overwrite video: ${error?.message}`);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        error?.message || 'Failed to overwrite video',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Extract a clip from an analysis video
   */
  @Post('analyses/:id/extract-clip')
  async extractClipFromAnalysis(
    @Param('id') id: string,
    @Body() body: {
      startTime: number;
      endTime: number;
      title?: string;
      description?: string;
      category?: string;
      customDirectory?: string;
      progressId?: string;
      reEncode?: boolean;
    }
  ) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      if (!analysis.video.isLinked) {
        throw new HttpException('Video file is not linked', HttpStatus.NOT_FOUND);
      }

      // Validate time range
      if (body.startTime < 0 || body.endTime <= body.startTime) {
        throw new HttpException(
          'Invalid time range',
          HttpStatus.BAD_REQUEST
        );
      }

      // Try to get the parent video from database to retrieve upload_date
      let uploadDate: string | undefined;
      try {
        const parentVideos = this.databaseService.getAllVideos({ includeChildren: true });
        const parentVideo = parentVideos.find((v: any) => v.current_path === analysis.video.currentPath);
        if (parentVideo && parentVideo.upload_date) {
          uploadDate = parentVideo.upload_date;
        }
      } catch (error) {
        this.logger.warn(`Could not find parent video upload_date: ${(error as Error).message}`);
      }

      // Generate clip filename
      const originalFilename = path.basename(analysis.video.currentPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category,
        body.title,
        uploadDate
      );

      // Determine output path
      let outputDir: string;

      if (body.customDirectory) {
        // If custom directory is provided, use it directly without adding /clips subfolder
        outputDir = body.customDirectory.replace(/[\\/]+$/, ''); // Remove trailing slashes
      } else {
        // Use library clips directory
        outputDir = this.libraryService.getLibraryPaths().clipsDir;
      }

      const outputPath = path.join(outputDir, clipFilename);

      // Progress tracking map (stored in memory)
      const progressMap = new Map<string, number>();
      const progressId = body.progressId || 'default';

      // Extract the clip with progress callback
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: analysis.video.currentPath,
        startTime: body.startTime,
        endTime: body.endTime,
        outputPath,
        reEncode: body.reEncode || false,
        metadata: {
          title: body.title,
          description: body.description,
          category: body.category,
        },
        onProgress: (progress: number) => {
          progressMap.set(progressId, progress);
        },
      });

      if (!extractionResult.success) {
        throw new HttpException(
          extractionResult.error || 'Failed to extract clip',
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }

      // Create clip record in library
      const clip = await this.libraryService.createClip({
        analysisId: id,
        name: body.title || `Clip from ${analysis.title}`,
        startSeconds: body.startTime,
        endSeconds: body.endTime,
        outputPath: extractionResult.outputPath!,
        notes: body.description || undefined,
      });

      // Import the created clip to the library as a video
      let videoId: string | undefined;
      if (extractionResult.outputPath) {
        try {
          this.logger.log(`Importing clip to library: ${extractionResult.outputPath}`);

          // Find the source video and determine the correct parent for the clip
          // If source video is a child, use its parent; otherwise use source video as parent
          let parentVideoId: string | undefined;
          try {
            const allVideos = this.databaseService.getAllVideos({ includeChildren: true });
            const sourceVideo = allVideos.find((v: any) => v.current_path === analysis.video.currentPath);

            if (sourceVideo && sourceVideo.id) {
              // If source video has a parent, make the clip a co-child (sibling)
              // Otherwise, make the source video the parent
              if (sourceVideo.parent_id) {
                parentVideoId = String(sourceVideo.parent_id);
                this.logger.log(`Source video is a child - linking clip as co-child to parent: ${parentVideoId}`);
              } else {
                parentVideoId = String(sourceVideo.id);
                this.logger.log(`Source video is a parent - linking clip as child: ${parentVideoId}`);
              }
            }
          } catch (error) {
            this.logger.warn(`Could not find source video for linking: ${(error as Error).message}`);
            // Continue without parent linking
          }

          const importResult = await this.fileScannerService.importVideos(
            [extractionResult.outputPath],
            undefined,
            parentVideoId
          );
          if (importResult.imported.length > 0) {
            videoId = importResult.imported[0];
            this.logger.log(`Clip imported to library with ID: ${videoId}${parentVideoId ? ` (linked to parent ${parentVideoId})` : ''}`);
          } else {
            this.logger.warn(`Failed to import clip to library: ${extractionResult.outputPath}`);
          }
        } catch (importError) {
          this.logger.error(`Error importing clip to library: ${(importError as Error).message}`);
          // Don't fail the entire request if import fails
        }
      }

      return {
        success: true,
        clip,
        videoId,
        extraction: {
          duration: extractionResult.duration,
          fileSize: extractionResult.fileSize,
          outputPath: extractionResult.outputPath,
        },
      };

    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to create clip: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * ==================================================================
   * ANALYTICS ENDPOINTS
   * ==================================================================
   */

  /**
   * Get library health metrics (completion stats)
   */
  @Get('analytics/health')
  async getLibraryHealth() {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      // Get stats directly from database
      const videos = this.databaseService.getAllVideos({ includeChildren: false });
      const totalVideos = videos.length;

      // Count videos with transcripts and analyses
      let videosWithTranscripts = 0;
      let videosWithAnalyses = 0;
      let totalDurationSeconds = 0;
      let totalFileSizeBytes = 0;

      for (const video of videos) {
        if (video.duration_seconds) {
          totalDurationSeconds += parseFloat(String(video.duration_seconds));
        }
        if (video.file_size_bytes) {
          totalFileSizeBytes += parseInt(String(video.file_size_bytes), 10);
        }

        // Check if video has transcript
        const transcript = this.databaseService.getTranscript(video.id);
        if (transcript) {
          videosWithTranscripts++;
        }

        // Check if video has analysis
        const analysis = this.databaseService.getAnalysis(video.id);
        if (analysis) {
          videosWithAnalyses++;
        }
      }

      return {
        success: true,
        health: {
          totalVideos,
          videosWithTranscripts,
          videosWithAnalyses,
          videosNeedingTranscripts: totalVideos - videosWithTranscripts,
          videosNeedingAnalysis: totalVideos - videosWithAnalyses,
          completionRate: totalVideos > 0 ? Math.round((videosWithAnalyses / totalVideos) * 100) : 0,
          totalDurationSeconds,
          totalFileSizeBytes,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get library health: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get topic analytics (tag frequency, distributions)
   */
  @Get('analytics/topics')
  async getTopicAnalytics(@Query('limit') limit?: string) {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      const maxResults = limit ? parseInt(limit, 10) : 50;

      // Get all tags grouped by name and type
      const allTags = this.databaseService.getAllTags();

      // Group by tag_name and tag_type
      const tagCounts = new Map<string, { count: number; type: string; videoIds: Set<string> }>();

      for (const tag of allTags) {
        const key = `${tag.tag_name}|${tag.tag_type || 'other'}`;
        if (!tagCounts.has(key)) {
          tagCounts.set(key, {
            count: 0,
            type: tag.tag_type || 'other',
            videoIds: new Set(),
          });
        }
        const entry = tagCounts.get(key)!;
        entry.count++;
        entry.videoIds.add(tag.video_id);
      }

      // Convert to array and sort by count
      const topicList = Array.from(tagCounts.entries())
        .map(([key, data]) => {
          const [name, type] = key.split('|');
          return {
            name,
            type,
            count: data.count,
            videoCount: data.videoIds.size,
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, maxResults);

      // Group by type for statistics
      const byType = {
        topic: topicList.filter(t => t.type === 'topic'),
        person: topicList.filter(t => t.type === 'person'),
        other: topicList.filter(t => t.type !== 'topic' && t.type !== 'person'),
      };

      return {
        success: true,
        topics: topicList,
        byType,
        totalUniqueTags: tagCounts.size,
        totalTagInstances: allTags.length,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get topic analytics: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get trend analytics (topics over time)
   */
  @Get('analytics/trends')
  async getTrendAnalytics(@Query('groupBy') groupBy?: string) {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      const grouping = groupBy || 'month'; // month, week, quarter, year

      // Get all videos with tags
      const videos = this.databaseService.getAllVideos({ includeChildren: false });
      const allTags = this.databaseService.getAllTags();

      // Create tag lookup
      const tagsByVideo = new Map<string, any[]>();
      for (const tag of allTags) {
        if (!tagsByVideo.has(tag.video_id)) {
          tagsByVideo.set(tag.video_id, []);
        }
        tagsByVideo.get(tag.video_id)!.push(tag);
      }

      // Group videos by time period
      const timeGroups = new Map<string, { videos: any[]; tagCounts: Map<string, number> }>();

      for (const video of videos) {
        const date = video.download_date || video.upload_date;
        if (!date) continue;

        const period = this.getTimePeriod(new Date(date), grouping);
        if (!timeGroups.has(period)) {
          timeGroups.set(period, { videos: [], tagCounts: new Map() });
        }

        const group = timeGroups.get(period)!;
        group.videos.push(video);

        // Count tags in this period
        const videoTags = tagsByVideo.get(video.id) || [];
        for (const tag of videoTags) {
          const tagKey = `${tag.tag_name}|${tag.tag_type || 'other'}`;
          group.tagCounts.set(tagKey, (group.tagCounts.get(tagKey) || 0) + 1);
        }
      }

      // Convert to timeline format
      const timeline = Array.from(timeGroups.entries())
        .map(([period, data]) => ({
          period,
          videoCount: data.videos.length,
          topTags: Array.from(data.tagCounts.entries())
            .map(([tagKey, count]) => {
              const [name, type] = tagKey.split('|');
              return { name, type, count };
            })
            .sort((a, b) => b.count - a.count)
            .slice(0, 10), // Top 10 tags for this period
        }))
        .sort((a, b) => a.period.localeCompare(b.period));

      return {
        success: true,
        timeline,
        grouping,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get trend analytics: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get co-occurrence network data (which tags appear together)
   */
  @Get('analytics/network')
  async getNetworkAnalytics(@Query('minConnections') minConnections?: string) {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      const minConn = minConnections ? parseInt(minConnections, 10) : 2;

      // Get all tags
      const allTags = this.databaseService.getAllTags();

      // Group tags by video
      const tagsByVideo = new Map<string, any[]>();
      for (const tag of allTags) {
        if (!tagsByVideo.has(tag.video_id)) {
          tagsByVideo.set(tag.video_id, []);
        }
        tagsByVideo.get(tag.video_id)!.push(tag);
      }

      // Build co-occurrence matrix
      const coOccurrence = new Map<string, Map<string, number>>();

      for (const [videoId, videoTags] of tagsByVideo.entries()) {
        // For each pair of tags in the same video
        for (let i = 0; i < videoTags.length; i++) {
          for (let j = i + 1; j < videoTags.length; j++) {
            const tag1Key = `${videoTags[i].tag_name}|${videoTags[i].tag_type || 'other'}`;
            const tag2Key = `${videoTags[j].tag_name}|${videoTags[j].tag_type || 'other'}`;

            // Add bidirectional connection
            if (!coOccurrence.has(tag1Key)) {
              coOccurrence.set(tag1Key, new Map());
            }
            if (!coOccurrence.has(tag2Key)) {
              coOccurrence.set(tag2Key, new Map());
            }

            const tag1Connections = coOccurrence.get(tag1Key)!;
            const tag2Connections = coOccurrence.get(tag2Key)!;

            tag1Connections.set(tag2Key, (tag1Connections.get(tag2Key) || 0) + 1);
            tag2Connections.set(tag1Key, (tag2Connections.get(tag1Key) || 0) + 1);
          }
        }
      }

      // Build nodes and edges for network graph
      const nodes = Array.from(coOccurrence.keys()).map(tagKey => {
        const [name, type] = tagKey.split('|');
        const connections = coOccurrence.get(tagKey)!;
        const totalConnections = Array.from(connections.values()).reduce((sum, count) => sum + count, 0);

        return {
          id: tagKey,
          name,
          type,
          connectionCount: totalConnections,
        };
      });

      const edges: any[] = [];
      const processedPairs = new Set<string>();

      for (const [tag1Key, connections] of coOccurrence.entries()) {
        for (const [tag2Key, count] of connections.entries()) {
          if (count < minConn) continue;

          const pairKey = [tag1Key, tag2Key].sort().join('---');
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);

          edges.push({
            source: tag1Key,
            target: tag2Key,
            weight: count,
          });
        }
      }

      return {
        success: true,
        network: {
          nodes,
          edges,
        },
        stats: {
          totalNodes: nodes.length,
          totalEdges: edges.length,
          minConnections: minConn,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get network analytics: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Generate AI insights about the library
   */
  @Post('analytics/generate-insights')
  async generateAIInsights(@Body() body: { aiProvider?: string; aiModel?: string }) {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      const startTime = Date.now();

      // Gather all analytics data
      const videos = this.databaseService.getAllVideos({ includeChildren: false });
      const allTags = this.databaseService.getAllTags();
      const totalVideos = videos.length;

      // Count analyzed videos
      let analyzedCount = 0;
      for (const video of videos) {
        const analysis = this.databaseService.getAnalysis(video.id);
        if (analysis) analyzedCount++;
      }

      // Get top topics
      const tagCounts = new Map<string, { count: number; type: string }>();
      for (const tag of allTags) {
        const key = `${tag.tag_name}|${tag.tag_type || 'other'}`;
        if (!tagCounts.has(key)) {
          tagCounts.set(key, { count: 0, type: tag.tag_type || 'other' });
        }
        tagCounts.get(key)!.count++;
      }

      const topTopics = Array.from(tagCounts.entries())
        .map(([key, data]) => {
          const [name, type] = key.split('|');
          return { name, type, count: data.count };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);

      // Build prompt using prompt builder
      const prompt = buildAnalyticsInsightsPrompt({
        totalVideos,
        analyzedCount,
        tagCount: tagCounts.size,
        topTopics,
      });

      this.logger.log('[AI Insights] Sending prompt to AI...');

      // Call AI service
      const aiProvider = (body.aiProvider || 'ollama') as 'ollama' | 'claude' | 'openai';
      const aiModel = body.aiModel || 'qwen2.5:7b';
      const aiResponse = await this.aiProviderService.generateText(
        prompt,
        {
          provider: aiProvider,
          model: aiModel,
        }
      );

      const aiResponseText = aiResponse.text;
      this.logger.log('[AI Insights] Received AI response');

      // Try to parse JSON from the response
      let insights: any;
      try {
        // Try direct parse
        insights = JSON.parse(aiResponseText);
      } catch (e) {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = aiResponseText.match(/```json\s*([\s\S]*?)\s*```/) ||
                          aiResponseText.match(/```\s*([\s\S]*?)\s*```/) ||
                          aiResponseText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          insights = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        } else {
          // Fallback: use raw text
          insights = {
            overview: aiResponseText.substring(0, 500),
            keyFindings: ['Unable to parse structured insights'],
            recommendations: [],
            contentGaps: [],
          };
        }
      }

      const generationTimeSeconds = (Date.now() - startTime) / 1000;

      // Save to database
      const analyticsId = this.databaseService.saveLibraryAnalytics({
        libraryId: activeLibrary.id,
        videosAnalyzedCount: analyzedCount,
        aiInsights: JSON.stringify(insights),
        aiModel,
        generationTimeSeconds,
      });

      // Cleanup old analytics (keep last 5)
      this.databaseService.cleanupOldAnalytics(activeLibrary.id, 5);

      return {
        success: true,
        insights,
        metadata: {
          generatedAt: new Date().toISOString(),
          videosAnalyzed: analyzedCount,
          totalVideos,
          aiModel,
          generationTimeSeconds,
          analyticsId,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Failed to generate AI insights: ${(error as Error).message}`);
      throw new HttpException(
        `Failed to generate AI insights: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get cached AI insights
   */
  @Get('analytics/insights')
  async getCachedInsights() {
    try {
      const activeLibrary = this.libraryManagerService.getActiveLibrary();
      if (!activeLibrary) {
        throw new HttpException('No active library', HttpStatus.BAD_REQUEST);
      }

      const cached = this.databaseService.getLatestLibraryAnalytics(activeLibrary.id);

      if (!cached) {
        return {
          success: true,
          hasInsights: false,
          insights: null,
        };
      }

      // Parse insights JSON
      let insights: any;
      try {
        insights = JSON.parse(cached.ai_insights as string);
      } catch (e) {
        insights = { overview: cached.ai_insights };
      }

      return {
        success: true,
        hasInsights: true,
        insights,
        metadata: {
          generatedAt: cached.generated_at,
          videosAnalyzed: cached.videos_analyzed_count,
          aiModel: cached.ai_model,
          generationTimeSeconds: cached.generation_time_seconds,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get cached insights: ${(error as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Helper: Get time period string for grouping
   */
  private getTimePeriod(date: Date, groupBy: string): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    switch (groupBy) {
      case 'year':
        return `${year}`;
      case 'quarter':
        const quarter = Math.floor(date.getMonth() / 3) + 1;
        return `${year}-Q${quarter}`;
      case 'month':
        return `${year}-${month}`;
      case 'week':
        // Get ISO week number
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        return `${year}-W${String(Math.ceil(weekStart.getDate() / 7)).padStart(2, '0')}`;
      default:
        return `${year}-${month}`;
    }
  }
}
