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

@Controller('api/analysis')
@WebSocketGateway({ cors: true })
export class AnalysisController implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private analysisService: AnalysisService,
    private ollamaService: OllamaService,
  ) {}

  afterInit(server: Server) {
    console.log('Analysis WebSocket Gateway initialized');
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

      // Check if AI model is available
      const modelAvailable = await this.ollamaService.isModelAvailable(
        request.aiModel,
        request.ollamaEndpoint,
      );

      if (!modelAvailable) {
        throw new HttpException(
          {
            message: `AI model '${request.aiModel}' is not available`,
            instructions: this.ollamaService.getInstallInstructions(
              request.aiModel,
            ),
          },
          HttpStatus.PRECONDITION_FAILED,
        );
      }

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
        `Failed to start analysis: ${error.message || 'Unknown error'}`,
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
  async getModels(@Body() body?: { endpoint?: string }) {
    try {
      const endpoint = body?.endpoint;
      const connected = await this.ollamaService.checkConnection(endpoint);

      if (!connected) {
        return {
          success: false,
          connected: false,
          message: 'Cannot connect to Ollama',
          recommended: this.ollamaService.getRecommendedModels(),
        };
      }

      const models = await this.ollamaService.listModels(endpoint);

      return {
        success: true,
        connected: true,
        models,
        recommended: this.ollamaService.getRecommendedModels(),
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to get models: ${error.message || 'Unknown error'}`,
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
        `Failed to check model: ${error.message || 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
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
