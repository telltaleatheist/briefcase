// backend/src/media/whisper.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import * as path from 'path';
import * as fs from 'fs';
import { WhisperManager } from './whisper-manager';
import {
  FfmpegBridge,
  getRuntimePaths,
  verifyBinary,
} from '../bridges';

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private ffmpeg: FfmpegBridge;

  constructor(
    private readonly eventService: MediaEventService,
  ) {
    // ALWAYS use bundled binaries from getRuntimePaths() - NEVER use system binaries
    const paths = getRuntimePaths();
    const ffmpegPath = paths.ffmpeg;

    verifyBinary(ffmpegPath, 'FFmpeg');
    this.ffmpeg = new FfmpegBridge(ffmpegPath);
    this.logger.log(`WhisperService initialized with FFmpeg: ${ffmpegPath}`);
  }

  async transcribeVideo(videoFile: string, jobId?: string, model?: string): Promise<string | null> {
    console.log(`[WHISPER SERVICE] Transcription started`);
    console.log(`[WHISPER SERVICE] Video file: ${videoFile}`);
    console.log(`[WHISPER SERVICE] Job ID: ${jobId}`);
    console.log(`[WHISPER SERVICE] Model: ${model || 'default'}`);

    let outputDir: string | undefined;
    let audioFile: string | undefined;

    try {
      if (!fs.existsSync(videoFile)) {
        throw new Error(`Video file not found: ${videoFile}`);
      }

      // Create a dedicated temp directory for this transcription job
      const os = require('os');
      const crypto = require('crypto');
      const jobHash = crypto.randomBytes(8).toString('hex');
      outputDir = path.join(os.tmpdir(), `whisper-${jobHash}`);

      // Ensure the output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      this.logger.log(`Created dedicated output directory: ${outputDir}`);

      // Extract audio from video first (much more reliable for whisper)
      this.logger.log(`Extracting audio from video...`);
      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 5, 'Extracting audio...');
      audioFile = await this.extractAudio(videoFile, outputDir, jobId || 'standalone');
      this.logger.log(`Audio extracted to: ${audioFile}`);
      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 15, 'Starting transcription...');

      const whisperManager = new WhisperManager();

      // Set up progress tracking
      whisperManager.on('progress', (progress) => {
        this.logger.log(`Transcription progress: ${progress.percent}% - ${progress.task}`);
        // Emit old event for backward compatibility
        this.eventService.emitTranscriptionProgress(
          progress.percent,
          progress.task,
          jobId
        );
        // Emit new task-progress event for queue system
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'transcribe', progress.percent, progress.task);
        }

        console.log(`Progress event: ${JSON.stringify(progress)}`);
      });

      this.logger.log(`Starting transcription for ${audioFile}`);
      this.eventService.emitTranscriptionStarted(videoFile, jobId);

      // Start transcription on the extracted audio file
      const srtFile = await whisperManager.transcribe(audioFile, outputDir, model);

      if (srtFile && fs.existsSync(srtFile)) {
        this.logger.log(`Transcription completed: ${srtFile}`);
        this.eventService.emitTranscriptionCompleted(srtFile, jobId);

        // Clean up the temporary directory (including extracted audio)
        try {
          // Delete the extracted audio file
          if (audioFile && fs.existsSync(audioFile)) {
            fs.unlinkSync(audioFile);
            this.logger.log(`Cleaned up audio file: ${audioFile}`);
          }

          // Delete any other temp files except the SRT
          const files = fs.readdirSync(outputDir);
          for (const file of files) {
            if (file !== path.basename(srtFile)) {
              fs.unlinkSync(path.join(outputDir, file));
            }
          }
        } catch (cleanupError) {
          this.logger.warn(`Failed to clean up temp directory: ${cleanupError}`);
        }

        return srtFile;
      } else {
        throw new Error('Transcription failed - no SRT file generated');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? (error as Error).message : String(error);
      this.logger.error(`Transcription failed: ${errorMessage}`);
      this.eventService.emitTranscriptionFailed(videoFile, errorMessage, jobId);

      // Clean up the temporary directory on error
      try {
        // Delete the extracted audio file
        if (audioFile && fs.existsSync(audioFile)) {
          fs.unlinkSync(audioFile);
          this.logger.log(`Cleaned up audio file: ${audioFile}`);
        }

        // Delete the temp directory and all contents
        if (outputDir && fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          for (const file of files) {
            fs.unlinkSync(path.join(outputDir, file));
          }
          fs.rmdirSync(outputDir);
        }
      } catch (cleanupError) {
        this.logger.warn(`Failed to clean up temp directory: ${cleanupError}`);
      }

      return null;
    }
  }

  /**
   * Extract audio from video using FFmpeg bridge
   * Optimized for whisper: 16kHz, mono, WAV format
   */
  private async extractAudio(videoPath: string, outputDir: string, jobId: string): Promise<string> {
    const audioFilename = `${jobId}_audio.wav`;
    const audioPath = path.join(outputDir, audioFilename);

    this.logger.log(`Extracting audio from: ${videoPath}`);
    this.logger.log(`Audio output: ${audioPath}`);

    const result = await this.ffmpeg.extractAudio(videoPath, audioPath, {
      sampleRate: 16000,
      channels: 1,
      format: 'wav',
      processId: `audio-extract-${jobId}`,
    });

    if (!result.success) {
      throw new Error(`Failed to extract audio: ${result.error}`);
    }

    this.logger.log(`Audio extraction complete: ${audioPath}`);
    return audioPath;
  }
}
