// backend/src/media/whisper.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import * as path from 'path';
import * as fs from 'fs';
import { WhisperManager } from './whisper-manager';
import { SharedConfigService } from '../config/shared-config.service';

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);

  constructor(
    private readonly eventService: MediaEventService,
    private readonly sharedConfigService: SharedConfigService
  ) {}

  async transcribeVideo(videoFile: string, jobId?: string): Promise<string | null> {
    console.log(`[WHISPER SERVICE] Transcription started`);
    console.log(`[WHISPER SERVICE] Video file: ${videoFile}`);
    console.log(`[WHISPER SERVICE] Job ID: ${jobId}`);
  
    try {
      if (!fs.existsSync(videoFile)) {
        throw new Error(`Video file not found: ${videoFile}`);
      }
  
      const outputDir = path.dirname(videoFile);
      const whisperManager = new WhisperManager(this.sharedConfigService);
  
      // Set up progress tracking
      whisperManager.on('progress', (progress) => {
        this.logger.log(`Transcription progress: ${progress.percent}% - ${progress.task}`);
        this.eventService.emitTranscriptionProgress(
          progress.percent,
          progress.task,
          jobId
        );

        console.log(`Progress event: ${JSON.stringify(progress)}`);
      });
    
      this.logger.log(`Starting transcription for ${videoFile}`);
      this.eventService.emitTranscriptionStarted(videoFile, jobId);
  
      // Start transcription
      const srtFile = await whisperManager.transcribe(videoFile, outputDir);
  
      if (srtFile && fs.existsSync(srtFile)) {
        this.logger.log(`Transcription completed: ${srtFile}`);
        this.eventService.emitTranscriptionCompleted(srtFile, jobId);
        return srtFile;
      } else {
        throw new Error('Transcription failed - no SRT file generated');
      }
  
    } catch (error) {
      const errorMessage = error instanceof Error ? (error as Error).message : String(error);
      this.logger.error(`Transcription failed: ${errorMessage}`);
      this.eventService.emitTranscriptionFailed(videoFile, errorMessage, jobId);
      return null;
    }
  }
}