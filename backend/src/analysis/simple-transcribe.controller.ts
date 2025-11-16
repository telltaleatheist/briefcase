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
import { spawn } from 'child_process';
import * as path from 'path';
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

      // Convert SRT to plain text (remove timestamps)
      const plainText = srtContent
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
        srtFormat: srtContent,
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

  /**
   * Check if video has an audio stream
   */
  private async hasAudioStream(videoPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ]);

      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        // If ffprobe found an audio stream, output will contain 'audio'
        resolve(output.trim() === 'audio');
      });

      ffprobe.on('error', () => {
        // If ffprobe fails, assume no audio
        resolve(false);
      });
    });
  }

  /**
   * Extract audio from video
   */
  private async extractAudio(videoPath: string, videoId: string): Promise<string> {
    // Check if video file exists
    this.logger.log(`Checking if video file exists: ${videoPath}`);
    const exists = await fs.access(videoPath).then(() => true).catch(() => false);
    if (!exists) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    // Check if video has audio stream
    const hasAudio = await this.hasAudioStream(videoPath);
    if (!hasAudio) {
      throw new Error('Video file does not contain an audio stream. Cannot transcribe video-only files.');
    }

    const outputPath = path.join(
      path.dirname(videoPath),
      `.temp_audio_${videoId}.wav`,
    );

    this.logger.log(`Extracting audio from ${videoPath} to ${outputPath}`);

    return new Promise((resolve, reject) => {
      let stderrOutput = '';
      let stdoutOutput = '';

      const ffmpeg = spawn('ffmpeg', [
        '-i', videoPath,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-y',
        outputPath,
      ]);

      ffmpeg.stdout.on('data', (data) => {
        stdoutOutput += data.toString();
      });

      ffmpeg.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderrOutput += chunk;
        // FFmpeg outputs progress to stderr, log it
        this.logger.debug(`FFmpeg: ${chunk.trim()}`);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          this.logger.log(`Audio extraction successful: ${outputPath}`);
          resolve(outputPath);
        } else {
          this.logger.error(`FFmpeg failed with code ${code}`);
          this.logger.error(`FFmpeg stderr: ${stderrOutput}`);
          this.logger.error(`FFmpeg stdout: ${stdoutOutput}`);
          reject(new Error(`FFmpeg exited with code ${code}. Stderr: ${stderrOutput.slice(-500)}`));
        }
      });

      ffmpeg.on('error', (error) => {
        this.logger.error(`FFmpeg spawn error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Run Whisper transcription
   */
  private async runWhisper(
    audioPath: string,
    model: string,
    onProgress: (progress: number) => void,
    signal: AbortSignal,
  ): Promise<{ text: string; srt: string }> {
    return new Promise((resolve, reject) => {
      const pythonScript = path.join(process.cwd(), 'python', 'transcribe.py');

      const python = spawn('python3', [
        pythonScript,
        audioPath,
        model,
      ]);

      if (signal.aborted) {
        python.kill();
        reject(new Error('Transcription aborted'));
        return;
      }

      signal.addEventListener('abort', () => {
        python.kill();
        reject(new Error('Transcription aborted'));
      });

      let text = '';
      let srt = '';
      let currentSection: 'text' | 'srt' | null = null;

      python.stdout.on('data', (data) => {
        const output = data.toString();

        // Parse progress
        const progressMatch = output.match(/PROGRESS: (\d+)/);
        if (progressMatch) {
          onProgress(parseInt(progressMatch[1]));
        }

        // Parse output sections
        if (output.includes('=== TEXT ===')) {
          currentSection = 'text';
        } else if (output.includes('=== SRT ===')) {
          currentSection = 'srt';
        } else if (currentSection === 'text') {
          text += output;
        } else if (currentSection === 'srt') {
          srt += output;
        }
      });

      python.stderr.on('data', (data) => {
        this.logger.warn(`Whisper stderr: ${data.toString()}`);
      });

      python.on('close', (code) => {
        if (code === 0) {
          resolve({ text: text.trim(), srt: srt.trim() });
        } else {
          reject(new Error(`Whisper exited with code ${code}`));
        }
      });

      python.on('error', reject);
    });
  }
}
