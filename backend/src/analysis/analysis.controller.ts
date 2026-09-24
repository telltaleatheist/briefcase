import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { SharedConfigService } from '../config/shared-config.service';
import { DatabaseService } from '../database/database.service';
import { DEFAULT_CATEGORIES } from './prompts/analysis-prompts';
import * as path from 'path';
import * as os from 'os';

@Controller('analysis')
export class AnalysisController {
  constructor(
    private analysisService: AnalysisService,
    private configService: SharedConfigService,
    private databaseService: DatabaseService,
  ) {}

  /**
   * Get the base output directory from config or default
   */
  private getBaseOutputDir(): string {
    const configOutputDir = this.configService.getOutputDir();
    if (configOutputDir) {
      return configOutputDir;
    }
    // Fallback to default
    return path.join(os.homedir(), 'Downloads', 'Briefcase');
  }

  /**
   * Check if a report already exists for a given input
   */
  @Post('check-existing-report')
  async checkExistingReport(@Body() body: { input: string; inputType: string; outputPath?: string }) {
    try {
      const fs = require('fs');

      // Determine the output directory
      const baseOutputPath = body.outputPath || this.getBaseOutputDir();
      const reportsPath = path.join(baseOutputPath, 'analysis', 'reports');

      // Generate the sanitized title (same logic as in analysis.service.ts)
      let videoTitle: string;

      if (body.inputType === 'url') {
        // For URLs, extract title from URL
        const urlParts = body.input.split('/');
        videoTitle = urlParts[urlParts.length - 1] || 'video';
      } else {
        // For local files, use the filename
        videoTitle = path.basename(body.input, path.extname(body.input));
      }

      const sanitizedTitle = videoTitle.replace(/[^a-zA-Z0-9\s\-_()]/g, '').trim();
      const expectedReportPath = path.join(reportsPath, `${sanitizedTitle}.txt`);

      // Check if file exists
      const exists = fs.existsSync(expectedReportPath);

      if (exists) {
        const stats = fs.statSync(expectedReportPath);
        return {
          success: true,
          exists: true,
          reportPath: expectedReportPath,
          reportName: `${sanitizedTitle}.txt`,
          stats: {
            mtime: stats.mtime,
            size: stats.size
          }
        };
      }

      return {
        success: true,
        exists: false,
        expectedPath: expectedReportPath,
        expectedName: `${sanitizedTitle}.txt`
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to check existing report: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get list of analysis reports
   */
  @Get('reports')
  async getReports() {
    try {
      const fs = require('fs');

      const baseOutputDir = this.getBaseOutputDir();
      const reportsDir = path.join(baseOutputDir, 'analysis', 'reports');

      // Check if directory exists
      if (!fs.existsSync(reportsDir)) {
        return {
          success: true,
          reports: []
        };
      }

      // Read directory
      const files = fs.readdirSync(reportsDir);

      // Get file stats
      const reports = files
        .filter((file: string) => file.endsWith('.txt'))
        .map((file: string) => {
          const filePath = path.join(reportsDir, file);
          const stats = fs.statSync(filePath);
          return {
            name: file,
            path: filePath,
            stats: {
              mtime: stats.mtime,
              size: stats.size
            }
          };
        });

      return {
        success: true,
        reports
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to get reports: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Read a specific report file
   */
  @Get('report/:filePath')
  async getReport(@Param('filePath') filePath: string) {
    try {
      const fs = require('fs');
      const decodedPath = decodeURIComponent(filePath);

      // Security: ensure path is within reports directory
      const baseOutputDir = this.getBaseOutputDir();
      const reportsDir = path.join(baseOutputDir, 'analysis', 'reports');

      if (!decodedPath.startsWith(reportsDir)) {
        throw new HttpException('Invalid file path', HttpStatus.FORBIDDEN);
      }

      // Read file
      const content = fs.readFileSync(decodedPath, 'utf-8');

      return {
        success: true,
        content
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to read report: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Delete a specific report file
   */
  @Delete('report/:filePath')
  async deleteReport(@Param('filePath') filePath: string) {
    try {
      const fs = require('fs');
      const decodedPath = decodeURIComponent(filePath);

      // Security: ensure path is within reports directory
      const baseOutputDir = this.getBaseOutputDir();
      const reportsDir = path.join(baseOutputDir, 'analysis', 'reports');

      if (!decodedPath.startsWith(reportsDir)) {
        throw new HttpException('Invalid file path', HttpStatus.FORBIDDEN);
      }

      // Check if file exists
      if (!fs.existsSync(decodedPath)) {
        throw new HttpException('Report file not found', HttpStatus.NOT_FOUND);
      }

      // Delete the file
      fs.unlinkSync(decodedPath);

      return {
        success: true,
        message: 'Report deleted successfully'
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to delete report: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Transcribe a single video by ID
   */
  @Post('transcribe')
  async transcribeVideo(@Body() body: { videoId: string }) {
    try {
      if (!body.videoId) {
        throw new HttpException(
          'Missing required field: videoId',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Get video from database
      const video = this.databaseService.getVideoById(body.videoId);
      if (!video) {
        throw new HttpException(
          'Video not found',
          HttpStatus.NOT_FOUND,
        );
      }

      // Start batch analysis with transcribe-only mode for this single video
      const result = await this.analysisService.startBatchAnalysis({
        videoIds: [body.videoId],
        transcribeOnly: true,
      });

      return {
        success: true,
        batchId: result.batchId,
        jobIds: result.jobIds,
        message: 'Transcription started',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to start transcription: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Analyze a single video by ID (runs AI analysis, transcribes if needed)
   */
  @Post('analyze')
  async analyzeVideo(@Body() body: {
    videoId: string;
    videoTitle?: string;
    aiModel?: string;
    aiProvider?: 'local' | 'ollama' | 'claude' | 'openai';
    forceReanalyze?: boolean;
    forceRetranscribe?: boolean;
    jobId?: string;  // Custom job ID from frontend (for tracking in processing queue)
  }) {
    try {
      if (!body.videoId) {
        throw new HttpException(
          'Missing required field: videoId',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Get video from database
      const video = this.databaseService.getVideoById(body.videoId);
      if (!video) {
        throw new HttpException(
          'Video not found',
          HttpStatus.NOT_FOUND,
        );
      }

      // Get config defaults - NO HARDCODED FALLBACKS
      const config = await this.configService.getConfig();
      let aiModel = body.aiModel || config.aiModel;
      let aiProvider = body.aiProvider; // No fallback - must be explicitly provided
      const forceReanalyze = body.forceReanalyze || false;
      const forceRetranscribe = body.forceRetranscribe || false;

      // Validate AI model is configured
      if (!aiModel) {
        throw new HttpException(
          'AI analysis requires an AI model to be configured. Please select a model in settings.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Validate AI provider is configured - no fallbacks
      if (!aiProvider) {
        throw new HttpException(
          'AI analysis requires an AI provider to be specified.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Extract provider from model name if present (e.g., "ollama:cogito:14b" -> provider="ollama", model="cogito:14b")
      const knownProviders = ['ollama', 'openai', 'claude', 'local'] as const;
      const colonIndex = aiModel.indexOf(':');
      if (colonIndex > 0) {
        const possibleProvider = aiModel.substring(0, colonIndex);
        if (knownProviders.includes(possibleProvider as typeof knownProviders[number])) {
          aiProvider = possibleProvider as 'local' | 'ollama' | 'openai' | 'claude';
          aiModel = aiModel.substring(colonIndex + 1);
        }
      }

      // Start batch analysis for this single video
      const result = await this.analysisService.startBatchAnalysis({
        videoIds: [body.videoId],
        aiModel,
        aiProvider,
        forceReanalyze,
        forceRetranscribe,
        customJobId: body.jobId,  // Pass the custom job ID from frontend
      });

      return {
        success: true,
        batchId: result.batchId,
        jobIds: result.jobIds,
        message: 'Analysis started',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to start analysis: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get analysis categories configuration
   * Initializes with defaults if file doesn't exist
   */
  @Get('categories')
  async getCategories() {
    const fs = require('fs');
    const categoriesPath = this.getCategoriesFilePath();

    // If file doesn't exist, initialize it with defaults
    if (!fs.existsSync(categoriesPath)) {
      console.log('Categories file not found, initializing with defaults');
      const dir = path.dirname(categoriesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Persist the { categories: [...] } shape that loadCategories() reads.
      fs.writeFileSync(categoriesPath, JSON.stringify({ categories: DEFAULT_CATEGORIES }, null, 2), 'utf-8');
      return DEFAULT_CATEGORIES;
    }

    // Read from file — tolerate both the object shape and a legacy bare array.
    const data = fs.readFileSync(categoriesPath, 'utf-8');
    const parsed = JSON.parse(data);

    return Array.isArray(parsed) ? parsed : (parsed.categories || []);
  }

  /**
   * Save analysis categories configuration
   */
  @Post('categories')
  async saveCategories(@Body() body: { categories: Array<{ name: string; description: string }> }) {
    try {
      const fs = require('fs');
      const categoriesPath = this.getCategoriesFilePath();

      // Ensure directory exists
      const dir = path.dirname(categoriesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to file in the { categories: [...] } shape that loadCategories() reads.
      fs.writeFileSync(categoriesPath, JSON.stringify({ categories: body.categories }, null, 2), 'utf-8');

      return {
        success: true,
        message: 'Categories saved successfully'
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to save categories: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Reset categories to defaults
   */
  @Post('categories/reset')
  async resetCategories() {
    try {
      const fs = require('fs');
      const categoriesPath = this.getCategoriesFilePath();

      // Ensure directory exists
      const dir = path.dirname(categoriesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write defaults in the { categories: [...] } shape that loadCategories() reads.
      fs.writeFileSync(categoriesPath, JSON.stringify({ categories: DEFAULT_CATEGORIES }, null, 2), 'utf-8');

      return DEFAULT_CATEGORIES;
    } catch (error: any) {
      throw new HttpException(
        `Failed to reset categories: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get path to categories configuration file
   */
  private getCategoriesFilePath(): string {
    const configDir = this.configService.getConfigDir();
    return path.join(configDir, 'analysis-categories.json');
  }
}
