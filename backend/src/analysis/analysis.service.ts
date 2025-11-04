import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PythonBridgeService } from './python-bridge.service';
import { OllamaService } from './ollama.service';
import { AIProviderService } from './ai-provider.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { DownloaderService } from '../downloader/downloader.service';
import { PathService } from '../path/path.service';
import { SharedConfigService } from '../config/shared-config.service';
import { LibraryService } from '../library/library.service';
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
  timing?: {
    downloadStart?: Date;
    downloadEnd?: Date;
    extractionStart?: Date;
    extractionEnd?: Date;
    transcriptionStart?: Date;
    transcriptionEnd?: Date;
    analysisStart?: Date;
    analysisEnd?: Date;
    totalDuration?: number; // in seconds
  };
}

export interface AnalysisRequest {
  input: string; // URL or file path
  inputType: 'url' | 'file';
  mode?: 'full' | 'transcribe-only'; // Analysis mode: full analysis or transcription only
  aiModel: string;
  aiProvider?: 'ollama' | 'claude' | 'openai'; // AI provider to use
  apiKey?: string; // API key for Claude/OpenAI
  ollamaEndpoint: string;
  whisperModel?: string;
  language?: string;
  outputPath?: string;
  customReportName?: string; // Custom name for the report file
  customInstructions?: string; // Custom instructions for AI analysis
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private jobs = new Map<string, AnalysisJob>();

  constructor(
    private pythonBridge: PythonBridgeService,
    private ollama: OllamaService,
    private aiProvider: AIProviderService,
    private ffmpeg: FfmpegService,
    private downloader: DownloaderService,
    private pathService: PathService,
    private eventEmitter: EventEmitter2,
    private configService: SharedConfigService,
    private libraryService: LibraryService,
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
      timing: {},
    };

    this.jobs.set(jobId, job);

    // Start processing asynchronously
    this.processAnalysis(jobId, request).catch((error) => {
      this.logger.error(`Analysis job ${jobId} failed: ${(error as Error).message}`);
      this.updateJob(jobId, {
        status: 'failed',
        error: (error as Error).message,
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
      this.logger.warn(`Error cleaning up job ${jobId}: ${(error as Error).message || 'Unknown error'}`);
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
          timing: { ...job.timing, downloadStart: new Date() },
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
          timing: { ...job.timing, downloadEnd: new Date() },
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
      const job2 = this.jobs.get(jobId);
      this.updateJob(jobId, {
        status: 'extracting',
        progress: 20,
        currentPhase: 'Extracting audio...',
        timing: { ...job2?.timing, extractionStart: new Date() },
      });

      const audioPath = await this.extractAudio(videoPath, jobId);

      const job3 = this.jobs.get(jobId);
      this.updateJob(jobId, {
        progress: 30,
        audioPath,
        timing: { ...job3?.timing, extractionEnd: new Date() },
      });

      // Phase 3: Transcribe (30-60%)
      const job4 = this.jobs.get(jobId);
      this.updateJob(jobId, {
        status: 'transcribing',
        progress: 30,
        currentPhase: 'Transcribing audio (this may take a few minutes)...',
        timing: { ...job4?.timing, transcriptionStart: new Date() },
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

      const job5 = this.jobs.get(jobId);
      this.updateJob(jobId, {
        progress: 60,
        transcriptPath,
        timing: { ...job5?.timing, transcriptionEnd: new Date() },
      });

      // Check if we should skip AI analysis (transcribe-only mode)
      const mode = request.mode || 'full';
      let analysisOutputPath: string | undefined;
      let analysisResult: any;

      if (mode === 'transcribe-only') {
        // Skip AI analysis, jump to finalization
        this.updateJob(jobId, {
          progress: 95,
          currentPhase: 'Transcription complete...',
        });
      } else {
        // Phase 4: AI Analysis (60-95%)
        const job6 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          status: 'analyzing',
          progress: 60,
          currentPhase: `Analyzing with ${request.aiModel}...`,
          timing: { ...job6?.timing, analysisStart: new Date() },
        });

        // Use custom report name if provided, otherwise use sanitized title
        const reportFileName = request.customReportName || `${sanitizedTitle}.txt`;
        analysisOutputPath = path.join(
          reportsPath,
          reportFileName,
        );

        analysisResult = await this.pythonBridge.analyze(
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
          request.customInstructions,
          request.aiProvider,
          request.apiKey,
        );

        const job7 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          progress: 95,
          analysisPath: analysisOutputPath,
          timing: { ...job7?.timing, analysisEnd: new Date() },
        });
      }

      // Phase 5: Finalize (95-100%)
      this.updateJob(jobId, {
        progress: 98,
        currentPhase: mode === 'transcribe-only' ? 'Finalizing transcription...' : 'Finalizing analysis...',
      });

      // Calculate total duration and timing information
      const job8 = this.jobs.get(jobId);
      const timing = job8?.timing || {};
      const totalDuration = job8
        ? (new Date().getTime() - job8.createdAt.getTime()) / 1000
        : 0;

      // Calculate individual phase durations
      const transcriptionDuration = timing.transcriptionStart && timing.transcriptionEnd
        ? (timing.transcriptionEnd.getTime() - timing.transcriptionStart.getTime()) / 1000
        : 0;

      const analysisDuration = timing.analysisStart && timing.analysisEnd
        ? (timing.analysisEnd.getTime() - timing.analysisStart.getTime()) / 1000
        : 0;

      // Append timing footer to the analysis report (only for full analysis)
      if (mode === 'full' && analysisOutputPath) {
        try {
          const timingFooter = this.generateTimingFooter(
            transcriptionDuration,
            analysisDuration,
            totalDuration,
            request.whisperModel || 'base',
            request.aiModel
          );
          await fs.appendFile(analysisOutputPath, timingFooter, 'utf-8');
        } catch (error) {
          this.logger.warn(`Failed to append timing footer: ${error}`);
        }
      }

      // Clean up temporary audio file
      await fs.unlink(audioPath).catch(() => {});

      // Complete
      const completionMessage = mode === 'transcribe-only'
        ? 'Transcription complete!'
        : `Analysis complete! Found ${analysisResult?.sections_count || 0} interesting sections.`;

      this.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        currentPhase: completionMessage,
        completedAt: new Date(),
        timing: { ...timing, totalDuration },
      });

      // Add to library (only if full analysis or if we have transcript)
      if (mode === 'full' && analysisOutputPath) {
        try {
          const analysis = await this.libraryService.createAnalysis({
            title: videoTitle,
            videoPath: videoPath,
            transcriptSrtPath: transcriptPath,
            transcriptTxtPath: txtTranscriptPath,
            analysisReportPath: analysisOutputPath,
            analysisModel: request.aiModel,
            transcriptionModel: request.whisperModel || 'base',
          });
          this.logger.log(`Added analysis to library for job ${jobId}`);

          // Parse analysis report and generate metadata JSON
          try {
            const { parseAnalysisReport, extractCategories, saveAnalysisMetadata } =
              await import('../library/parsers/analysis-parser');

            const parsedMetadata = await parseAnalysisReport(
              analysis.files.analysis,
              analysis.id,
              analysis.title,
              analysis.createdAt
            );

            // Save parsed metadata to JSON file
            await saveAnalysisMetadata(analysis.files.analysisMetadata, parsedMetadata);

            // Extract and update categories
            const categories = extractCategories(parsedMetadata);
            if (categories.length > 0) {
              analysis.metadata.categories = categories;
              await this.libraryService.updateAnalysis(analysis.id, {});
            }

            this.logger.log(`Generated metadata JSON for analysis ${analysis.id}`);
          } catch (parseError) {
            this.logger.warn(`Failed to generate metadata JSON: ${(parseError as Error).message}`);
            // Don't fail the job if metadata generation fails
          }
        } catch (error) {
          this.logger.warn(`Failed to add analysis to library: ${(error as Error).message}`);
          // Don't fail the job if library addition fails
        }
      } else if (mode === 'transcribe-only') {
        this.logger.log(`Transcription-only mode: Skipped library creation for job ${jobId}`);
      }

      this.logger.log(`Analysis job ${jobId} completed successfully`);
    } catch (error: any) {
      this.logger.error(`Analysis job ${jobId} failed: ${(error as Error).message || 'Unknown error'}`);
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
    // Try to get from config first
    const configOutputDir = this.configService.getOutputDir();
    if (configOutputDir) {
      return configOutputDir;
    }

    // Fallback to default location
    const homeDir = require('os').homedir();
    return path.join(homeDir, 'Downloads', 'clippy');
  }

  /**
   * Generate timing footer for analysis report
   */
  private generateTimingFooter(
    transcriptionDuration: number,
    analysisDuration: number,
    totalDuration: number,
    whisperModel: string,
    aiModel: string,
  ): string {
    const formatDuration = (seconds: number): string => {
      if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
      }
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
    };

    return `\n${'='.repeat(80)}\n` +
           `PERFORMANCE METRICS\n` +
           `${'='.repeat(80)}\n\n` +
           `Transcription (${whisperModel} model):\n` +
           `  Duration: ${formatDuration(transcriptionDuration)}\n\n` +
           `AI Analysis (${aiModel}):\n` +
           `  Duration: ${formatDuration(analysisDuration)}\n\n` +
           `Total Processing Time: ${formatDuration(totalDuration)}\n` +
           `${'='.repeat(80)}\n`;
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
