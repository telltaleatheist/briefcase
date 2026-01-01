// backend/src/media/whisper.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import * as path from 'path';
import * as fs from 'fs';
import { WhisperManager } from './whisper-manager';
import {
  FfmpegBridge,
  FfprobeBridge,
  getRuntimePaths,
  verifyBinary,
} from '../bridges';

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;

  constructor(
    private readonly eventService: MediaEventService,
  ) {
    // ALWAYS use bundled binaries from getRuntimePaths() - NEVER use system binaries
    const paths = getRuntimePaths();
    const ffmpegPath = paths.ffmpeg;
    const ffprobePath = paths.ffprobe;

    verifyBinary(ffmpegPath, 'FFmpeg');
    verifyBinary(ffprobePath, 'FFprobe');
    this.ffmpeg = new FfmpegBridge(ffmpegPath);
    this.ffprobe = new FfprobeBridge(ffprobePath);
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

      // Quick check: is the first 10 seconds quiet?
      // If very quiet, run silence detection to skip leading silence
      let silenceOffset = 0;

      try {
        this.eventService.emitTaskProgress(jobId || '', 'transcribe', 2, 'Checking audio levels...');
        const startVolume = await this.ffmpeg.getVolumeLevel(videoFile, 0, 10);
        this.logger.log(`First 10s volume: mean=${startVolume.mean.toFixed(1)}dB, max=${startVolume.max.toFixed(1)}dB`);

        // If very quiet (< -40dB), run silence detection to skip leading silence
        if (startVolume.mean < -40) {
          this.eventService.emitTaskProgress(jobId || '', 'transcribe', 3, 'Quiet start detected, scanning for audio...');
          silenceOffset = await this.ffmpeg.detectAudioStart(videoFile, {
            silenceThreshold: -45,
            minSilenceDuration: 2,
            maxSearchDuration: 300, // Only search first 5 minutes (faster)
          });
          if (silenceOffset > 5) {
            this.logger.log(`Detected ${silenceOffset.toFixed(1)}s of silence at start, will skip`);
            const skipMinutes = Math.floor(silenceOffset / 60);
            const skipSeconds = Math.floor(silenceOffset % 60);
            this.eventService.emitTaskProgress(jobId || '', 'transcribe', 4, `Skipping ${skipMinutes}m ${skipSeconds}s of silence...`);
          } else {
            silenceOffset = 0;
          }
        }
      } catch (err) {
        this.logger.warn(`Volume/silence detection failed, processing from start: ${err}`);
      }

      // Get video duration for progress tracking during extraction
      let videoDurationSeconds: number | undefined;
      try {
        videoDurationSeconds = await this.ffprobe.getDuration(videoFile);
        this.logger.log(`Video duration: ${videoDurationSeconds} seconds`);
      } catch (err) {
        this.logger.warn(`Could not determine video duration: ${err}`);
      }

      // Extract audio from video first (much more reliable for whisper)
      this.logger.log(`Extracting audio from video...`);
      const extractMessage = 'Extracting audio...';
      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 5, extractMessage);

      // Set up progress tracking for extraction (5% to 12% range)
      let lastExtractProgress = 5;
      const extractProgressHandler = (progress: { percent: number }) => {
        // Map FFmpeg progress (0-100) to our range (5-12)
        const mappedProgress = 5 + Math.round((progress.percent / 100) * 7);
        // Only emit if progress increased (prevent bouncing)
        if (mappedProgress > lastExtractProgress) {
          lastExtractProgress = mappedProgress;
          this.eventService.emitTaskProgress(jobId || '', 'transcribe', mappedProgress, extractMessage);
        }
      };
      this.ffmpeg.on('progress', extractProgressHandler);

      audioFile = await this.extractAudio(videoFile, outputDir, jobId || 'standalone', silenceOffset, videoDurationSeconds);

      // Remove the progress handler after extraction
      this.ffmpeg.off('progress', extractProgressHandler);

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 12, 'Audio extracted, starting transcription...');
      this.logger.log(`Audio extracted to: ${audioFile}`);

      // Use video duration (adjusted for offset) as audio duration estimate
      const audioDurationSeconds = videoDurationSeconds ? videoDurationSeconds - silenceOffset : undefined;
      if (audioDurationSeconds) {
        this.logger.log(`Audio duration: ${audioDurationSeconds} seconds`);
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 15, 'Starting transcription...');

      const whisperManager = new WhisperManager();

      // Track start time for ETA calculation
      const transcriptionStartTime = Date.now();
      let lastWhisperProgress = 15;

      // Set up progress tracking
      whisperManager.on('progress', (progress) => {
        // Only emit if progress increased (prevent bouncing)
        if (progress.percent <= lastWhisperProgress) {
          return;
        }
        lastWhisperProgress = progress.percent;

        this.logger.log(`Transcription progress: ${progress.percent}% - ${progress.task}`);

        // Calculate ETA based on elapsed time and progress
        const elapsedMs = Date.now() - transcriptionStartTime;
        let eta: number | undefined;
        if (progress.percent > 0 && progress.percent < 100) {
          // ETA = elapsed * ((100 - progress) / progress)
          eta = Math.round((elapsedMs * ((100 - progress.percent) / progress.percent)) / 1000);
        }

        // Emit old event for backward compatibility
        this.eventService.emitTranscriptionProgress(
          progress.percent,
          progress.task,
          jobId
        );
        // Emit new task-progress event for queue system with ETA
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'transcribe', progress.percent, progress.task, {
            eta,
            elapsedMs,
          });
        }

        console.log(`Progress event: ${JSON.stringify(progress)}, ETA: ${eta}s`);
      });

      this.logger.log(`Starting transcription for ${audioFile}`);
      this.eventService.emitTranscriptionStarted(videoFile, jobId);

      // Start transcription on the extracted audio file
      // Pass audio duration for time-based progress estimation
      const srtFile = await whisperManager.transcribe(audioFile, outputDir, model, audioDurationSeconds);

      if (srtFile && fs.existsSync(srtFile)) {
        // If we skipped silence at the start, offset all timestamps to match original video
        if (silenceOffset > 0) {
          this.logger.log(`Adjusting timestamps by ${silenceOffset.toFixed(1)}s to match original video`);
          this.offsetSrtTimestamps(srtFile, silenceOffset);
        }

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
  private async extractAudio(videoPath: string, outputDir: string, jobId: string, startOffset: number = 0, duration?: number): Promise<string> {
    const audioFilename = `${jobId}_audio.wav`;
    const audioPath = path.join(outputDir, audioFilename);

    this.logger.log(`Extracting audio from: ${videoPath}`);
    this.logger.log(`Audio output: ${audioPath}`);
    if (startOffset > 0) {
      this.logger.log(`Skipping first ${startOffset.toFixed(1)} seconds of silence`);
    }

    const result = await this.ffmpeg.extractAudio(videoPath, audioPath, {
      sampleRate: 16000,
      channels: 1,
      format: 'wav',
      processId: `audio-extract-${jobId}`,
      startOffset: startOffset > 0 ? startOffset : undefined,
      duration: duration,
    });

    if (!result.success) {
      throw new Error(`Failed to extract audio: ${result.error}`);
    }

    this.logger.log(`Audio extraction complete: ${audioPath}`);
    return audioPath;
  }

  /**
   * Offset all timestamps in an SRT file by a given number of seconds
   * This is used when we skip silence at the start of the video
   */
  private offsetSrtTimestamps(srtPath: string, offsetSeconds: number): void {
    if (offsetSeconds <= 0) return;

    const content = fs.readFileSync(srtPath, 'utf-8');
    const lines = content.split('\n');
    const newLines: string[] = [];

    // SRT timestamp format: 00:01:23,456 --> 00:01:25,789
    const timestampRegex = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/;

    for (const line of lines) {
      const match = line.match(timestampRegex);
      if (match) {
        // Parse start time
        const startH = parseInt(match[1]);
        const startM = parseInt(match[2]);
        const startS = parseInt(match[3]);
        const startMs = parseInt(match[4]);
        const startTotal = startH * 3600 + startM * 60 + startS + startMs / 1000 + offsetSeconds;

        // Parse end time
        const endH = parseInt(match[5]);
        const endM = parseInt(match[6]);
        const endS = parseInt(match[7]);
        const endMs = parseInt(match[8]);
        const endTotal = endH * 3600 + endM * 60 + endS + endMs / 1000 + offsetSeconds;

        // Format new timestamps
        const formatTime = (seconds: number): string => {
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = Math.floor(seconds % 60);
          const ms = Math.round((seconds % 1) * 1000);
          return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
        };

        newLines.push(`${formatTime(startTotal)} --> ${formatTime(endTotal)}`);
      } else {
        newLines.push(line);
      }
    }

    fs.writeFileSync(srtPath, newLines.join('\n'));
    this.logger.log(`Offset SRT timestamps by ${offsetSeconds.toFixed(1)} seconds`);
  }
}
