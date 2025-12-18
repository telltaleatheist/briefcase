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
import { AnalysisService, AnalysisRequest } from './analysis.service';
import { OllamaService } from './ollama.service';
import { SharedConfigService } from '../config/shared-config.service';
import { DatabaseService } from '../database/database.service';
import { DEFAULT_CATEGORIES } from './prompts/analysis-prompts';
import * as path from 'path';
import * as os from 'os';

@Controller('analysis')
export class AnalysisController {
  constructor(
    private analysisService: AnalysisService,
    private ollamaService: OllamaService,
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
    return path.join(os.homedir(), 'Downloads', 'ClipChimp');
  }

  /**
   * Start a new analysis job
   */
  @Post('start')
  async startAnalysis(@Body() request: AnalysisRequest) {
    try {
      // Validate request
      if (!request.input || !request.inputType) {
        throw new HttpException(
          'Missing required fields: input, inputType',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!request.aiModel) {
        throw new HttpException(
          'Missing required field: aiModel',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Start analysis immediately - model availability will be checked during analysis
      const jobId = await this.analysisService.startAnalysis(request);

      return {
        success: true,
        jobId,
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
   * Get job status
   */
  @Get('job/:jobId')
  async getJob(@Param('jobId') jobId: string) {
    const job = this.analysisService.getJob(jobId);

    if (!job) {
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      job,
    };
  }

  /**
   * Get all jobs
   */
  @Get('jobs')
  async getAllJobs() {
    const jobs = this.analysisService.getAllJobs();

    return {
      success: true,
      jobs,
    };
  }

  /**
   * Delete a job
   */
  @Delete('job/:jobId')
  async deleteJob(@Param('jobId') jobId: string) {
    const deleted = await this.analysisService.deleteJob(jobId);

    if (!deleted) {
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      message: 'Job deleted',
    };
  }

  /**
   * Check Ollama connection and list available models
   */
  @Get('models')
  async getModels() {
    try {
      const connected = await this.ollamaService.checkConnection();

      if (!connected) {
        return {
          success: false,
          connected: false,
          message: 'Cannot connect to Ollama',
          recommended: this.ollamaService.getRecommendedModels(),
        };
      }

      const models = await this.ollamaService.listModels();

      return {
        success: true,
        connected: true,
        models,
        recommended: this.ollamaService.getRecommendedModels(),
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to get models: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Pull/download an Ollama model
   * This is a long-running operation - the frontend should show a spinner
   */
  @Post('pull-model')
  async pullModel(@Body() body: { modelName: string; endpoint?: string }) {
    try {
      const { modelName, endpoint } = body;

      if (!modelName) {
        throw new HttpException('modelName is required', HttpStatus.BAD_REQUEST);
      }

      // Check if Ollama is connected first
      const connected = await this.ollamaService.checkConnection(endpoint);
      if (!connected) {
        throw new HttpException(
          'Ollama is not running. Please start Ollama first.',
          HttpStatus.SERVICE_UNAVAILABLE
        );
      }

      // Start the pull (this will log progress to backend logs)
      await this.ollamaService.pullModel(modelName, endpoint);

      return {
        success: true,
        message: `Successfully downloaded ${modelName}`,
        modelName
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to download model: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Check if a specific model is available
   */
  @Post('check-model')
  async checkModel(@Body() body: { model: string; endpoint?: string }) {
    try {
      const available = await this.ollamaService.isModelAvailable(
        body.model,
        body.endpoint,
      );

      return {
        success: true,
        available,
        model: body.model,
        instructions: available
          ? null
          : this.ollamaService.getInstallInstructions(body.model),
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to check model: ${(error as Error).message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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

      const sanitizedTitle = videoTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
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
  async transcribeVideo(@Body() body: { videoId: string; whisperModel?: string }) {
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

      // Get config defaults
      const config = await this.configService.getConfig();
      const whisperModel = body.whisperModel || 'base';

      // Start batch analysis with transcribe-only mode for this single video
      const result = await this.analysisService.startBatchAnalysis({
        videoIds: [body.videoId],
        transcribeOnly: true,
        whisperModel,
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
    aiProvider?: 'ollama' | 'claude' | 'openai';
    whisperModel?: string;
    forceReanalyze?: boolean;
    forceRetranscribe?: boolean;
    claudeApiKey?: string;
    openaiApiKey?: string;
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

      // Get config defaults - NO HARDCODED FALLBACK for AI model
      const config = await this.configService.getConfig();
      const aiModel = body.aiModel || config.aiModel;
      const aiProvider = body.aiProvider;
      const whisperModel = body.whisperModel || 'base';
      const forceReanalyze = body.forceReanalyze || false;
      const forceRetranscribe = body.forceRetranscribe || false;

      // Validate AI model is configured
      if (!aiModel) {
        throw new HttpException(
          'AI analysis requires an AI model to be configured. Please select a model in settings.',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!aiProvider) {
        throw new HttpException(
          'AI analysis requires an AI provider to be configured. Please select a provider in settings.',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Start batch analysis for this single video
      const result = await this.analysisService.startBatchAnalysis({
        videoIds: [body.videoId],
        aiModel,
        aiProvider,
        whisperModel,
        forceReanalyze,
        forceRetranscribe,
        claudeApiKey: body.claudeApiKey,
        openaiApiKey: body.openaiApiKey,
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
      fs.writeFileSync(categoriesPath, JSON.stringify(DEFAULT_CATEGORIES, null, 2), 'utf-8');
      return DEFAULT_CATEGORIES;
    }

    // Read from file
    const data = fs.readFileSync(categoriesPath, 'utf-8');
    const categories = JSON.parse(data);

    return categories;
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

      // Write to file
      fs.writeFileSync(categoriesPath, JSON.stringify(body.categories, null, 2), 'utf-8');

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

      // Write defaults to file
      fs.writeFileSync(categoriesPath, JSON.stringify(DEFAULT_CATEGORIES, null, 2), 'utf-8');

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
