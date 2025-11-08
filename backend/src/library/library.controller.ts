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
import { createReadStream, statSync } from 'fs';
import * as fs from 'fs';
import { LibraryService } from './library.service';
import { Logger } from '@nestjs/common';
import { RelinkService } from './relink.service';
import { ClipExtractorService } from './clip-extractor.service';
import { SharedConfigService } from '../config/shared-config.service';
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
    private configService: SharedConfigService
  ) {}

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

      // Check if file exists
      try {
        const stat = statSync(videoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Determine content type from file extension
        const ext = path.extname(videoPath).toLowerCase();
        const contentTypeMap: Record<string, string> = {
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.ogg': 'video/ogg',
          '.mov': 'video/quicktime', // Use proper QuickTime MIME type
          '.avi': 'video/x-msvideo',
          '.mkv': 'video/x-matroska',
        };
        const contentType = contentTypeMap[ext] || 'video/mp4';

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

      // Generate clip filename
      const originalFilename = path.basename(body.videoPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category
      );

      // Determine output path
      let outputDir: string;

      if (body.customDirectory) {
        // If custom directory is provided, use it directly without adding /clips subfolder
        outputDir = body.customDirectory.replace(/[\\/]+$/, ''); // Remove trailing slashes
      } else {
        // Otherwise use configured directory or default Downloads with clippy/clips structure
        const baseDir = this.configService.getOutputDir() || path.join(os.homedir(), 'Downloads');
        const normalizedBaseDir = baseDir.replace(/[\\/]+$/, ''); // Remove trailing slashes
        const endsWithClippy = path.basename(normalizedBaseDir).toLowerCase() === 'clippy';

        // If baseDir already ends with 'clippy', use it directly. Otherwise add 'clippy' folder
        const clippyDir = endsWithClippy ? normalizedBaseDir : path.join(normalizedBaseDir, 'clippy');
        outputDir = path.join(clippyDir, 'clips');
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

      return {
        success: true,
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
    }
  ) {
    try {
      const analysis = await this.libraryService.getAnalysis(id);

      if (!analysis) {
        throw new HttpException('Analysis not found', HttpStatus.NOT_FOUND);
      }

      // Generate clip filename
      const originalFilename = path.basename(analysis.video.currentPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category
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
        // Otherwise use configured directory or default Downloads with clippy/clips structure
        baseDir = this.configService.getOutputDir() || path.join(os.homedir(), 'Downloads');
        const normalizedBaseDir = baseDir.replace(/[\\/]+$/, ''); // Remove trailing slashes
        const endsWithClippy = path.basename(normalizedBaseDir).toLowerCase() === 'clippy';

        // If baseDir already ends with 'clippy', use it directly. Otherwise add 'clippy' folder
        clippyDir = endsWithClippy ? normalizedBaseDir : path.join(normalizedBaseDir, 'clippy');
        outputDir = path.join(clippyDir, 'clips');
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

      // Generate clip filename
      const originalFilename = path.basename(body.videoPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category
      );

      // Determine output path
      let outputDir: string;

      if (body.customDirectory) {
        outputDir = body.customDirectory.replace(/[\\/]+$/, '');
      } else {
        // Use default [library folder]/clips
        const baseDir = this.configService.getOutputDir() || path.join(os.homedir(), 'Downloads');
        const normalizedBaseDir = baseDir.replace(/[\\/]+$/, '');
        const endsWithClippy = path.basename(normalizedBaseDir).toLowerCase() === 'clippy';
        const clippyDir = endsWithClippy ? normalizedBaseDir : path.join(normalizedBaseDir, 'clippy');
        outputDir = path.join(clippyDir, 'clips');
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

      // Generate clip filename
      const originalFilename = path.basename(analysis.video.currentPath);
      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        body.startTime,
        body.endTime,
        body.category
      );

      // Determine output path
      let outputDir: string;

      if (body.customDirectory) {
        // If custom directory is provided, use it directly without adding /clips subfolder
        outputDir = body.customDirectory.replace(/[\\/]+$/, ''); // Remove trailing slashes
      } else {
        // Otherwise use configured directory or default Downloads with clippy/clips structure
        const baseDir = this.configService.getOutputDir() || path.join(os.homedir(), 'Downloads');
        const normalizedBaseDir = baseDir.replace(/[\\/]+$/, ''); // Remove trailing slashes
        const endsWithClippy = path.basename(normalizedBaseDir).toLowerCase() === 'clippy';

        // If baseDir already ends with 'clippy', use it directly. Otherwise add 'clippy' folder
        const clippyDir = endsWithClippy ? normalizedBaseDir : path.join(normalizedBaseDir, 'clippy');
        outputDir = path.join(clippyDir, 'clips');
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

      return {
        success: true,
        clip,
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
}
