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
import { LibraryService } from './library.service';
import { RelinkService } from './relink.service';
import { ClipExtractorService } from './clip-extractor.service';
import {
  CreateLibraryAnalysisRequest,
  UpdateLibraryAnalysisRequest,
  CreateClipRequest,
} from './interfaces/library.interface';
import { parseAnalysisReport, extractCategories, saveAnalysisMetadata } from './parsers/analysis-parser';
import * as path from 'path';

@Controller('library')
export class LibraryController {
  constructor(
    private libraryService: LibraryService,
    private relinkService: RelinkService,
    private clipExtractor: ClipExtractorService
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
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = end - start + 1;

          const stream = createReadStream(videoPath, { start, end });

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
          });

          stream.pipe(res);
        } else {
          // No range request, stream entire file
          const stream = createReadStream(videoPath);

          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
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

      // Calculate week folder (Sunday-based)
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0 = Sunday
      const daysToSubtract = dayOfWeek; // Days since last Sunday
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - daysToSubtract);
      weekStart.setHours(0, 0, 0, 0);
      const weekFolder = weekStart.toISOString().split('T')[0]; // YYYY-MM-DD

      // Determine output path
      const clipsBasePath = '/Volumes/Callisto/clips';
      const outputDir = path.join(clipsBasePath, weekFolder);
      const outputPath = path.join(outputDir, clipFilename);

      // Extract the clip
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
