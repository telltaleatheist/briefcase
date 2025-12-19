// Media Controller - Atomic operations for media processing

import { Controller, Post, Get, Body, Query, HttpException, HttpStatus } from '@nestjs/common';
import { MediaOperationsService } from './media-operations.service';
import { WhisperManager } from './whisper-manager';

@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaOps: MediaOperationsService,
    private readonly whisperManager: WhisperManager,
  ) {}

  /**
   * Get video metadata without downloading
   * GET /media/info?url=https://...
   */
  @Get('info')
  async getInfo(@Query('url') url: string) {
    if (!url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.mediaOps.getVideoInfo(url);

    if (!result.success) {
      throw new HttpException(
        result.error || 'Failed to get video info',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Download video only (no processing)
   * POST /media/download
   * Body: { url, quality?, displayName?, outputDir? }
   */
  @Post('download')
  async download(
    @Body()
    body: {
      url: string;
      quality?: string;
      convertToMp4?: boolean;
      useCookies?: boolean;
      browser?: string;
      displayName?: string;
      outputDir?: string;
    },
  ) {
    if (!body.url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.mediaOps.downloadVideo(body.url, body);

    if (!result.success) {
      throw new HttpException(
        result.error || 'Download failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Import video to library
   * POST /media/import
   * Body: { videoPath, duplicateHandling? }
   */
  @Post('import')
  async import(
    @Body()
    body: {
      videoPath: string;
      duplicateHandling?: 'skip' | 'replace' | 'keep-both';
    },
  ) {
    if (!body.videoPath) {
      throw new HttpException('Video path is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.mediaOps.importToLibrary(body.videoPath, {
      duplicateHandling: body.duplicateHandling,
    });

    if (!result.success) {
      throw new HttpException(
        result.error || 'Import failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Fix aspect ratio for vertical videos
   * POST /media/fix-aspect-ratio
   * Body: { videoId } or { videoPath }
   */
  @Post('fix-aspect-ratio')
  async fixAspectRatio(
    @Body()
    body: {
      videoId?: string;
      videoPath?: string;
    },
  ) {
    if (!body.videoId && !body.videoPath) {
      throw new HttpException(
        'Either videoId or videoPath is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.mediaOps.fixAspectRatio(
      body.videoId || body.videoPath!,
    );

    if (!result.success) {
      throw new HttpException(
        result.error || 'Fix aspect ratio failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Normalize audio levels
   * POST /media/normalize-audio
   * Body: { videoId } or { videoPath }, level?, method?
   */
  @Post('normalize-audio')
  async normalizeAudio(
    @Body()
    body: {
      videoId?: string;
      videoPath?: string;
      level?: number;
      method?: 'rms' | 'ebu-r128';
    },
  ) {
    if (!body.videoId && !body.videoPath) {
      throw new HttpException(
        'Either videoId or videoPath is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.mediaOps.normalizeAudio(
      body.videoId || body.videoPath!,
      {
        level: body.level,
        method: body.method,
      },
    );

    if (!result.success) {
      throw new HttpException(
        result.error || 'Normalize audio failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * Get available whisper models (dynamically discovered from disk)
   * GET /media/whisper-models
   */
  @Get('whisper-models')
  getWhisperModels() {
    const models = this.whisperManager.getAvailableModelsWithInfo();
    return {
      success: true,
      models,
      default: models.length > 0 ? (models.find(m => m.id === 'base')?.id || models[0].id) : null,
    };
  }

  /**
   * Get Whisper GPU mode and status
   * GET /media/whisper-gpu
   */
  @Get('whisper-gpu')
  getWhisperGpuMode() {
    return {
      success: true,
      mode: this.whisperManager.getGpuMode(),
      gpuFailed: this.whisperManager.hasGpuFailed(),
    };
  }

  /**
   * Set Whisper GPU mode
   * POST /media/whisper-gpu
   * Body: { mode: 'auto' | 'gpu' | 'cpu' }
   */
  @Post('whisper-gpu')
  setWhisperGpuMode(@Body() body: { mode: 'auto' | 'gpu' | 'cpu' }) {
    if (!body.mode || !['auto', 'gpu', 'cpu'].includes(body.mode)) {
      throw new HttpException(
        'Invalid mode. Must be "auto", "gpu", or "cpu"',
        HttpStatus.BAD_REQUEST,
      );
    }

    this.whisperManager.setGpuMode(body.mode);

    return {
      success: true,
      mode: this.whisperManager.getGpuMode(),
    };
  }

  /**
   * Transcribe video
   * POST /media/transcribe
   * Body: { videoId } or { videoPath }, model?, language?
   */
  @Post('transcribe')
  async transcribe(
    @Body()
    body: {
      videoId?: string;
      videoPath?: string;
      model?: string;
      language?: string;
    },
  ) {
    if (!body.videoId && !body.videoPath) {
      throw new HttpException(
        'Either videoId or videoPath is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const result = await this.mediaOps.transcribeVideo(
      body.videoId || body.videoPath!,
      {
        model: body.model,
        language: body.language,
      },
    );

    if (!result.success) {
      throw new HttpException(
        result.error || 'Transcription failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }

  /**
   * AI analysis of video
   * POST /media/analyze
   * Body: { videoId, aiModel, aiProvider?, apiKey?, ollamaEndpoint?, customInstructions? }
   */
  @Post('analyze')
  async analyze(
    @Body()
    body: {
      videoId: string;
      aiModel: string;
      aiProvider?: 'ollama' | 'claude' | 'openai';
      apiKey?: string;
      ollamaEndpoint?: string;
      customInstructions?: string;
    },
  ) {
    if (!body.videoId) {
      throw new HttpException('Video ID is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.aiModel) {
      throw new HttpException('AI model is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.mediaOps.analyzeVideo(body.videoId, {
      aiModel: body.aiModel,
      aiProvider: body.aiProvider,
      apiKey: body.apiKey,
      ollamaEndpoint: body.ollamaEndpoint,
      customInstructions: body.customInstructions,
    });

    if (!result.success) {
      throw new HttpException(
        result.error || 'Analysis failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      data: result.data,
    };
  }
}
