import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MediaEventService } from '../media/media-event.service';
import { WhisperService } from '../media/whisper.service';
import * as fs from 'fs/promises';

interface TranscribeRequest {
  videoId: string;
  whisperModel?: string;
  jobId?: string;
}

/**
 * Simple transcription controller - handles ONLY transcription
 * No analysis, no complex job management, just transcribe and emit events
 */
@Controller('transcribe')
export class SimpleTranscribeController {
  private readonly logger = new Logger(SimpleTranscribeController.name);
  private activeTranscriptions = new Map<string, AbortController>();

  constructor(
    private databaseService: DatabaseService,
    private mediaEventService: MediaEventService,
    private whisperService: WhisperService,
  ) {}

  /**
   * Transcribe a video by ID
   */
  @Post()
  async transcribe(@Body() body: TranscribeRequest) {
    try {
      const { videoId, whisperModel = 'base', jobId } = body;
      const finalJobId = jobId || `transcribe-${videoId}`;

      if (!videoId) {
        throw new HttpException('Missing videoId', HttpStatus.BAD_REQUEST);
      }

      // Get video from database
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      if (!video.current_path) {
        throw new HttpException('Video has no file path', HttpStatus.BAD_REQUEST);
      }

      this.logger.log(`Starting transcription for video ${videoId}: ${video.filename}`);

      // Delete existing transcript if it exists (user explicitly requested transcription)
      const existingTranscript = this.databaseService.getTranscript(videoId);
      if (existingTranscript) {
        this.logger.log(`Video ${videoId} already has transcript, deleting and re-transcribing`);
        this.databaseService.deleteTranscript(videoId);
      }

      // Run transcription asynchronously
      this.runTranscription(videoId, video.current_path, whisperModel, finalJobId);

      return {
        success: true,
        videoId,
        message: 'Transcription started',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to start transcription: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Run transcription in background
   */
  private async runTranscription(
    videoId: string,
    videoPath: string,
    whisperModel: string,
    jobId: string,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeTranscriptions.set(videoId, abortController);

    try {
      // Emit start event
      this.mediaEventService.emitTranscriptionProgress(0, 'Starting transcription...', jobId);

      // Use WhisperService which handles everything
      const srtPath = await this.whisperService.transcribeVideo(videoPath, jobId);

      if (!srtPath) {
        throw new Error('Transcription failed - no SRT file generated');
      }

      // Read the SRT file content
      const srtContent = await fs.readFile(srtPath, 'utf-8');

      // Normalize line endings: convert \r\n (Windows) to \n (Unix)
      const normalizedSrt = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      // Convert SRT to plain text (remove timestamps)
      const plainText = normalizedSrt
        .split('\n\n')
        .map(block => {
          const lines = block.split('\n');
          return lines.slice(2).join(' '); // Skip index and timestamp lines
        })
        .filter(text => text.trim())
        .join(' ');

      // Save to database
      this.mediaEventService.emitTranscriptionProgress(95, 'Saving transcript...', jobId);

      this.databaseService.insertTranscript({
        videoId: videoId,
        plainText: plainText,
        srtFormat: normalizedSrt,
        whisperModel: whisperModel,
        language: 'en',
      });

      // Emit 100% progress for completion
      this.mediaEventService.emitTranscriptionProgress(100, 'Transcription completed', jobId);

      // Emit completion event
      this.mediaEventService.emitTranscriptionCompleted(srtPath, jobId);

      this.logger.log(`Transcription completed for video ${videoId}`);
    } catch (error: any) {
      this.logger.error(`Transcription failed for video ${videoId}:`, error);
      this.mediaEventService.emitTranscriptionFailed(videoId, error.message, jobId);
    } finally {
      this.activeTranscriptions.delete(videoId);
    }
  }
}
