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
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { OnEvent } from '@nestjs/event-emitter';
import { AnalysisService, AnalysisRequest } from './analysis.service';
import { OllamaService } from './ollama.service';
import { SharedConfigService } from '../config/shared-config.service';
import { DatabaseService } from '../database/database.service';
import * as path from 'path';
import * as os from 'os';

@Controller('analysis')
@WebSocketGateway({ cors: true })
export class AnalysisController implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private analysisService: AnalysisService,
    private ollamaService: OllamaService,
    private configService: SharedConfigService,
    private databaseService: DatabaseService,
  ) {}

  afterInit(server: Server) {
    console.log('Analysis WebSocket Gateway initialized');
  }

  /**
   * Get the base output directory from config or default
   */
  private getBaseOutputDir(): string {
    const configOutputDir = this.configService.getOutputDir();
    if (configOutputDir) {
      return configOutputDir;
    }
    // Fallback to default
    return path.join(os.homedir(), 'Downloads', 'clippy');
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
    claudeApiKey?: string;
    openaiApiKey?: string;
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

      // Get config defaults
      const config = await this.configService.getConfig();
      const aiModel = body.aiModel || config.aiModel || 'qwen2.5:7b';
      const aiProvider = body.aiProvider || 'ollama';
      const whisperModel = body.whisperModel || 'base';
      const forceReanalyze = body.forceReanalyze || false;

      // Start batch analysis for this single video
      const result = await this.analysisService.startBatchAnalysis({
        videoIds: [body.videoId],
        aiModel,
        aiProvider,
        whisperModel,
        forceReanalyze,
        claudeApiKey: body.claudeApiKey,
        openaiApiKey: body.openaiApiKey,
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
   */
  @Get('categories')
  async getCategories() {
    try {
      const fs = require('fs');
      const categoriesPath = this.getCategoriesFilePath();

      // If file doesn't exist, return defaults
      if (!fs.existsSync(categoriesPath)) {
        return this.getDefaultCategories();
      }

      // Read from file
      const data = fs.readFileSync(categoriesPath, 'utf-8');
      const categories = JSON.parse(data);

      return categories;
    } catch (error: any) {
      console.error('Error reading categories:', error);
      // Return defaults on error
      return this.getDefaultCategories();
    }
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

      // Also update the Python prompts file
      await this.updatePythonPrompts(body.categories);

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

      const defaults = this.getDefaultCategories();

      // Ensure directory exists
      const dir = path.dirname(categoriesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write defaults to file
      fs.writeFileSync(categoriesPath, JSON.stringify(defaults, null, 2), 'utf-8');

      // Also update the Python prompts file
      await this.updatePythonPrompts(defaults);

      return defaults;
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

  /**
   * Get default categories
   */
  private getDefaultCategories() {
    return [
      {
        name: 'hate',
        description: 'Discrimination, dehumanization, or calls for harm against ANY minority group (LGBTQ+, racial minorities, religious minorities, ethnic groups, immigrants, etc.), including "biblical" justifications for hatred'
      },
      {
        name: 'conspiracy',
        description: 'Political conspiracy theories (election fraud, deep state, QAnon, globalists, voter fraud, "stolen election", New World Order, Illuminati, Freemasons, Soros conspiracies, etc.)'
      },
      {
        name: 'false-prophecy',
        description: 'ANY claims of divine communication or prophecy (God speaking to them, prophetic declarations, divine revelations, "God told me", supernatural knowledge claims, prophecies about political/world events)'
      },
      {
        name: 'misinformation',
        description: 'Factually incorrect or misleading claims about science, medicine, history, or current events (vaccine conspiracies, COVID denialism, alternative medicine fraud, historical revisionism, climate denial, etc.)'
      },
      {
        name: 'violence',
        description: 'Explicit or implicit calls for violence, revolutionary rhetoric, threats, Second Amendment intimidation, civil war talk, bloodshed predictions, "rise up" rhetoric, militia organizing'
      },
      {
        name: 'christian-nationalism',
        description: 'Claims that church/Christianity should control government, theocracy advocacy, anti-separation of church/state, demanding "biblical law", opposition to secular governance'
      },
      {
        name: 'prosperity-gospel',
        description: 'Religious leaders demanding money from followers, "seed faith" offerings, wealth justifications, private jets/luxury defense, "sow to receive" theology'
      },
      {
        name: 'extremism',
        description: 'Defense of oppression/genocide/slavery, white supremacy/nationalism, ethnic cleansing justifications, authoritarian/fascist advocacy, calls for execution/persecution of groups'
      },
      {
        name: 'political-violence',
        description: 'References to political violence events (Capitol riot, insurrections, political attacks), defending/downplaying political violence, false flag claims about violence'
      },
      {
        name: 'routine',
        description: 'Normal content that doesn\'t match other categories - use for general analysis of what\'s being said (religious teaching, political commentary, testimonies, announcements, music, etc.)'
      }
    ];
  }

  /**
   * Update Python prompts file with new categories
   */
  private async updatePythonPrompts(categories: Array<{ name: string; description: string }>) {
    const fs = require('fs').promises;

    // Find the Python prompts file
    // It should be in backend/python/analysis_prompts.py
    const promptsPath = path.join(process.cwd(), 'python', 'analysis_prompts.py');

    try {
      // Read the current file
      const content = await fs.readFile(promptsPath, 'utf-8');

      // Build category list text
      const categoryListText = categories
        .filter(c => c.name !== 'routine')
        .map((c, i) => `${i + 1}. **${c.name}** - ${c.description}`)
        .join('\n\n');

      // Build category names for JSON format (pipe-separated)
      const categoryNames = categories.map(c => c.name).join('|');

      // Build category names list for IMPORTANT RULES
      const categoryNamesList = categories.map(c => c.name).join(', ');

      // Replace the FLAGGING CRITERIA section
      const newContent = content.replace(
        /FLAGGING CRITERIA:[\s\S]*?MANDATORY JSON OUTPUT FORMAT:/,
        `FLAGGING CRITERIA:\n\n**INTERESTING CATEGORIES** (Flag anything matching these broad topics):\n\n${categoryListText}\n\n**BORING (Flag as "routine"):**\n- Normal religious teaching without extremism or hate\n- Standard sermon content (prayer, worship, biblical teaching without conspiracy/politics)\n- General political commentary that doesn't involve conspiracies/violence/hate\n- Personal testimonies and stories without extreme content\n- Church announcements and logistics\n- Music, hymns, worship segments\n- Context-setting or introductions\n\nCRITICAL: Even if content uses religious language or biblical references, flag it in the appropriate category above if it matches the topics (conspiracies, prophecies, hate, misinformation, etc.)\n\nMANDATORY JSON OUTPUT FORMAT:`
      );

      // Replace the category list in JSON format
      const finalContent = newContent.replace(
        /"category": "[^"]+"/g,
        `"category": "${categoryNames}"`
      ).replace(
        /Categories: [^\n]+/,
        `Categories: ${categoryNamesList}`
      );

      // Write back to file
      await fs.writeFile(promptsPath, finalContent, 'utf-8');

      console.log('Python prompts file updated with new categories');
    } catch (error) {
      console.error('Failed to update Python prompts file:', error);
      // Don't throw - this is not critical, categories are still saved
    }
  }

  /**
   * Listen for analysis progress events and broadcast via WebSocket
   */
  @OnEvent('analysis.progress')
  handleAnalysisProgress(payload: any) {
    // Only log and broadcast if WebSocket server is ready
    if (this.server) {
      this.server.emit('analysisProgress', payload);
    }
    // Silently skip if WebSocket not yet initialized (happens during early startup)
  }
}
