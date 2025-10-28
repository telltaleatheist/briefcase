import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PythonBridgeService } from './python-bridge.service';
import { OllamaService } from './ollama.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { DownloaderService } from '../downloader/downloader.service';
import { PathService } from '../path/path.service';
import { v4 as uuidv4 } from 'uuid';

export interface AnalysisJob {
  id: string;
  status: 'pending' | 'downloading' | 'extracting' | 'transcribing' | 'analyzing' | 'completed' | 'failed';
  progress: number;
  currentPhase: string;
  error?: string;
  videoPath?: string;
  audioPath?: string;
  transcriptPath?: string;
  analysisPath?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface AnalysisRequest {
  input: string; // URL or file path
  inputType: 'url' | 'file';
  aiModel: string;
  ollamaEndpoint: string;
  whisperModel?: string;
  language?: string;
  outputPath?: string;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private jobs = new Map<string, AnalysisJob>();

  constructor(
    private pythonBridge: PythonBridgeService,
    private ollama: OllamaService,
    private ffmpeg: FfmpegService,
    private downloader: DownloaderService,
    private pathService: PathService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Start a new analysis job
   */
  async startAnalysis(request: AnalysisRequest): Promise<string> {
    const jobId = uuidv4();

    const job: AnalysisJob = {
      id: jobId,
      status: 'pending',
      progress: 0,
      currentPhase: 'Initializing...',
      createdAt: new Date(),
    };

    this.jobs.set(jobId, job);

    // Start processing asynchronously
    this.processAnalysis(jobId, request).catch((error) => {
      this.logger.error(`Analysis job ${jobId} failed: ${error.message}`);
      this.updateJob(jobId, {
        status: 'failed',
        error: error.message,
      });
    });

    return jobId;
  }

  /**
   * Get job status
   */
  getJob(jobId: string): AnalysisJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): AnalysisJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Delete a job
   */
  async deleteJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Clean up temporary files
    try {
      if (job.audioPath) await fs.unlink(job.audioPath).catch(() => {});
    } catch (error: any) {
      this.logger.warn(`Error cleaning up job ${jobId}: ${error.message || 'Unknown error'}`);
    }

    this.jobs.delete(jobId);
    return true;
  }

  /**
   * Main processing pipeline
   */
  private async processAnalysis(
    jobId: string,
    request: AnalysisRequest,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    try {
      // Determine output paths
      const baseOutputPath = request.outputPath || this.getDefaultOutputPath();
      const videosPath = path.join(baseOutputPath, 'videos');
      const analysisPath = path.join(baseOutputPath, 'analysis');
      const transcriptsPath = path.join(analysisPath, 'transcripts');
      const reportsPath = path.join(analysisPath, 'reports');

      // Create directories
      await fs.mkdir(videosPath, { recursive: true });
      await fs.mkdir(transcriptsPath, { recursive: true });
      await fs.mkdir(reportsPath, { recursive: true });

      let videoPath: string;
      let videoTitle: string;

      // Phase 1: Download or prepare video (0-20%)
      if (request.inputType === 'url') {
        this.updateJob(jobId, {
          status: 'downloading',
          progress: 5,
          currentPhase: 'Downloading video (fast mode)...',
        });

        const downloadResult = await this.downloadVideo(
          request.input,
          videosPath,
          jobId,
        );
        videoPath = downloadResult.path;
        videoTitle = downloadResult.title;

        this.updateJob(jobId, {
          progress: 20,
          videoPath,
        });
      } else {
        // Local file
        videoPath = request.input;
        videoTitle = path.basename(videoPath, path.extname(videoPath));

        this.updateJob(jobId, {
          status: 'extracting',
          progress: 5,
          currentPhase: 'Preparing local video...',
          videoPath,
        });

        await new Promise((resolve) => setTimeout(resolve, 500)); // Brief delay for UI
        this.updateJob(jobId, { progress: 20 });
      }

      // Phase 2: Extract audio (20-30%)
      this.updateJob(jobId, {
        status: 'extracting',
        progress: 20,
        currentPhase: 'Extracting audio...',
      });

      const audioPath = await this.extractAudio(videoPath, jobId);

      this.updateJob(jobId, {
        progress: 30,
        audioPath,
      });

      // Phase 3: Transcribe (30-60%)
      this.updateJob(jobId, {
        status: 'transcribing',
        progress: 30,
        currentPhase: 'Transcribing audio (this may take a few minutes)...',
      });

      const transcriptResult = await this.pythonBridge.transcribe(
        audioPath,
        request.whisperModel || 'base',
        request.language || 'en',
        (progress) => {
          this.updateJob(jobId, {
            progress: progress.progress,
            currentPhase: progress.message,
          });
        },
      );

      // Save transcript files
      const sanitizedTitle = this.sanitizeFilename(videoTitle);
      const transcriptPath = path.join(
        transcriptsPath,
        `${sanitizedTitle}.srt`,
      );
      const txtTranscriptPath = path.join(
        transcriptsPath,
        `${sanitizedTitle}.txt`,
      );

      await fs.writeFile(transcriptPath, transcriptResult.srt, 'utf-8');
      await fs.writeFile(txtTranscriptPath, transcriptResult.text, 'utf-8');

      this.updateJob(jobId, {
        progress: 60,
        transcriptPath,
      });

      // Phase 4: AI Analysis (60-95%)
      this.updateJob(jobId, {
        status: 'analyzing',
        progress: 60,
        currentPhase: `Analyzing with ${request.aiModel}...`,
      });

      const analysisOutputPath = path.join(
        reportsPath,
        `${sanitizedTitle}.txt`,
      );

      const analysisResult = await this.pythonBridge.analyze(
        request.ollamaEndpoint,
        request.aiModel,
        transcriptResult.text,
        transcriptResult.segments,
        analysisOutputPath,
        (progress) => {
          this.updateJob(jobId, {
            progress: progress.progress,
            currentPhase: progress.message,
          });
        },
      );

      this.updateJob(jobId, {
        progress: 95,
        analysisPath: analysisOutputPath,
      });

      // Phase 5: Finalize (95-100%)
      this.updateJob(jobId, {
        progress: 98,
        currentPhase: 'Finalizing analysis...',
      });

      // Clean up temporary audio file
      await fs.unlink(audioPath).catch(() => {});

      // Complete
      this.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        currentPhase: `Analysis complete! Found ${analysisResult.sections_count} interesting sections.`,
        completedAt: new Date(),
      });

      this.logger.log(`Analysis job ${jobId} completed successfully`);
    } catch (error: any) {
      this.logger.error(`Analysis job ${jobId} failed: ${error.message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Download video using existing downloader service
   */
  private async downloadVideo(
    url: string,
    outputDir: string,
    jobId: string,
  ): Promise<{ path: string; title: string }> {
    // Use fast download settings - lowest quality for speed
    const result = await this.downloader.downloadVideo({
      url,
      quality: '360',
      convertToMp4: false, // Skip conversion for speed
      fixAspectRatio: false, // Skip processing for speed
      useCookies: false,
      browser: 'auto',
      outputDir,
    });

    // Handle the DownloadResult return type
    if (!result.success || !result.outputFile) {
      throw new Error(result.error || 'Download failed');
    }

    const outputPath = result.outputFile;
    const title = path.basename(outputPath, path.extname(outputPath));

    return { path: outputPath, title };
  }

  /**
   * Extract audio from video using FFmpeg
   */
  private async extractAudio(videoPath: string, jobId: string): Promise<string> {
    const audioPath = videoPath.replace(
      path.extname(videoPath),
      '_audio.wav',
    );

    // Use FFmpeg to extract audio
    return new Promise((resolve, reject) => {
      const ffmpeg = require('fluent-ffmpeg');

      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .format('wav')
        .on('end', () => resolve(audioPath))
        .on('error', (err: Error) => reject(err))
        .save(audioPath);
    });
  }

  /**
   * Get default output path
   */
  private getDefaultOutputPath(): string {
    const homeDir = require('os').homedir();
    return path.join(homeDir, 'Downloads', 'clippy');
  }

  /**
   * Sanitize filename for safe file system usage
   * Preserves original case and spaces, only removes truly invalid characters
   */
  private sanitizeFilename(filename: string): string {
    // Only remove or replace characters that are invalid on filesystems
    // Invalid chars: < > : " / \ | ? * and control characters (0-31)
    let sanitized = filename
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Replace invalid chars with underscore
      .replace(/_{2,}/g, '_')                    // Replace multiple underscores with single
      .trim();                                   // Remove leading/trailing whitespace

    // Limit total length to 200 chars to avoid "filename too long" errors
    // This is well within the 255 char limit for most filesystems
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200).trim();
    }

    // Remove trailing dots or underscores (Windows doesn't like these)
    sanitized = sanitized.replace(/[_\.]+$/, '');

    // If somehow the filename is empty after sanitization, use a default
    if (!sanitized) {
      sanitized = 'untitled';
    }

    return sanitized;
  }

  /**
   * Update job and emit event
   */
  private updateJob(jobId: string, updates: Partial<AnalysisJob>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    Object.assign(job, updates);

    // Emit WebSocket event
    this.eventEmitter.emit('analysis.progress', {
      jobId,
      ...updates,
    });
  }
}
