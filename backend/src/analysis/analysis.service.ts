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
import { LibraryManagerService } from '../database/library-manager.service';
import { FileScannerService } from '../database/file-scanner.service';
import { DatabaseService } from '../database/database.service';
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
  tags?: { people: string[]; topics: string[] }; // Extracted tags from analysis
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
  mode?: 'full' | 'transcribe-only' | 'analysis-only'; // Analysis mode: full, transcription only, or analysis only (using existing transcript)
  aiModel: string;
  aiProvider?: 'ollama' | 'claude' | 'openai'; // AI provider to use
  apiKey?: string; // API key for Claude/OpenAI
  ollamaEndpoint: string;
  whisperModel?: string;
  language?: string;
  outputPath?: string;
  customReportName?: string; // Custom name for the report file
  customInstructions?: string; // Custom instructions for AI analysis
  existingTranscriptText?: string; // For 'analysis-only' mode: plain text transcript
  existingTranscriptSrt?: string; // For 'analysis-only' mode: SRT format transcript
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
    private libraryManagerService: LibraryManagerService,
    private fileScannerService: FileScannerService,
    private databaseService: DatabaseService,
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
      // Determine output paths - use library clips folder for videos only
      let videosPath: string;
      const activeLibrary = this.libraryManagerService.getActiveLibrary();

      if (activeLibrary) {
        // Save videos to library clips folder
        this.logger.log(`Using active library clips folder: ${activeLibrary.clipsFolderPath}`);
        videosPath = activeLibrary.clipsFolderPath;
      } else {
        // Fallback to default output path if no library is active
        this.logger.warn('No active library found, using default output path');
        const baseOutputPath = request.outputPath || this.getDefaultOutputPath();
        videosPath = path.join(baseOutputPath, 'videos');
      }

      // Create videos directory
      await fs.mkdir(videosPath, { recursive: true });

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

      // Determine mode
      const mode = request.mode || 'full';
      this.logger.log(`Analysis mode: ${mode} (request.mode=${request.mode})`);

      let transcriptPath: string | undefined;
      let txtTranscriptPath: string | undefined;
      let transcriptText: string = '';
      let transcriptSrt: string = '';
      let audioPath: string | undefined;

      // Phase 2 & 3: Extract audio and transcribe (only if not analysis-only mode)
      if (mode === 'analysis-only') {
        // Use existing transcript from request
        this.logger.log('Using existing transcript from database for analysis-only mode');
        transcriptText = request.existingTranscriptText!;
        transcriptSrt = request.existingTranscriptSrt!;

        this.updateJob(jobId, {
          progress: 60,
          currentPhase: 'Using existing transcript...',
        });
      } else {
        // Extract audio (20-30%)
        const job2 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          status: 'extracting',
          progress: 20,
          currentPhase: 'Extracting audio...',
          timing: { ...job2?.timing, extractionStart: new Date() },
        });

        audioPath = await this.extractAudio(videoPath, jobId);

        const job3 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          progress: 30,
          audioPath,
          timing: { ...job3?.timing, extractionEnd: new Date() },
        });

        // Transcribe (30-60%)
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

        transcriptText = transcriptResult.text;
        transcriptSrt = transcriptResult.srt;

        const job5 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          progress: 60,
          timing: { ...job5?.timing, transcriptionEnd: new Date() },
        });
      }
      let analysisOutputPath: string | undefined;
      let analysisResult: any;

      if (mode === 'transcribe-only') {
        // Skip AI analysis, jump to finalization
        this.logger.log('Skipping AI analysis in transcribe-only mode');
        this.updateJob(jobId, {
          progress: 95,
          currentPhase: 'Transcription complete...',
        });
      } else {
        this.logger.log('Starting AI analysis phase');
        // Phase 4: AI Analysis (60-95%)
        const job6 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          status: 'analyzing',
          progress: 60,
          currentPhase: `Analyzing with ${request.aiModel}...`,
          timing: { ...job6?.timing, analysisStart: new Date() },
        });

        // Create temp directory for analysis output
        const os = require('os');
        const tmpDir = os.tmpdir();
        const sanitizedTitle = this.sanitizeFilename(videoTitle);
        const reportFileName = request.customReportName || `${sanitizedTitle}.txt`;
        analysisOutputPath = path.join(tmpDir, `${jobId}_${reportFileName}`);

        // Parse SRT to get segments (needed for timestamp correlation)
        const segments = this.parseSrtToSegments(transcriptSrt);

        analysisResult = await this.pythonBridge.analyze(
          request.ollamaEndpoint,
          request.aiModel,
          transcriptText,
          segments,
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
          videoTitle,
        );

        const job7 = this.jobs.get(jobId);
        this.updateJob(jobId, {
          progress: 95,
          tags: analysisResult?.tags || { people: [], topics: [] },
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

      // Auto-import to library if we have an active library and downloaded a video
      let videoId: string | undefined;
      if (activeLibrary && request.inputType === 'url' && videoPath) {
        try {
          this.logger.log(`Auto-importing video to library: ${videoPath}`);
          const importResult = await this.fileScannerService.importVideos([videoPath]);

          if (importResult.imported.length > 0) {
            videoId = importResult.imported[0];
            this.logger.log(`Successfully imported video to library with ID: ${videoId}`);
          } else if (importResult.errors.length > 0) {
            this.logger.warn(`Failed to import video to library: ${importResult.errors.join(', ')}`);
          }
        } catch (error) {
          this.logger.error(`Error during auto-import: ${(error as Error).message}`);
          // Don't fail the entire job if import fails
        }
      } else if (request.inputType === 'file') {
        // For file input, try to find video in database by path
        try {
          const videos = await this.databaseService.getAllVideos();
          const video = videos.find((v: any) => v.current_path === videoPath || v.file_path === videoPath);
          if (video) {
            videoId = video.id;
            this.logger.log(`Found existing video in database with ID: ${videoId}`);
          }
        } catch (error) {
          this.logger.warn(`Could not find video in database: ${(error as Error).message}`);
        }
      }

      // Save transcript and analysis to database if video is in library
      if (videoId) {
        try {
          // Save transcript if we have one (not in analysis-only mode)
          if (mode !== 'analysis-only' && transcriptText && transcriptSrt) {
            this.logger.log(`Saving transcript to database for video ${videoId}`);
            this.databaseService.insertTranscript({
              videoId,
              plainText: transcriptText,
              srtFormat: transcriptSrt,
              whisperModel: request.whisperModel || 'base',
              language: request.language || 'en',
            });
          }

          // Save analysis if we have one (not in transcribe-only mode)
          if (mode !== 'transcribe-only' && analysisOutputPath) {
            const analysisText = await fs.readFile(analysisOutputPath, 'utf-8');
            this.logger.log(`Saving analysis to database for video ${videoId}`);
            this.databaseService.insertAnalysis({
              videoId,
              aiAnalysis: analysisText,
              sectionsCount: analysisResult?.sections_count || 0,
              aiModel: request.aiModel,
              aiProvider: request.aiProvider || 'ollama',
            });
          }

          this.logger.log(`Successfully saved transcript/analysis to database for video ${videoId}`);
        } catch (error) {
          this.logger.error(`Failed to save transcript/analysis to database: ${(error as Error).message}`);
          // Don't fail the entire job if database save fails
        }
      } else {
        this.logger.warn('Video not found in database - transcript/analysis not saved');
      }

      // Clean up temporary files
      if (audioPath) {
        await fs.unlink(audioPath).catch(() => {});
      }
      if (analysisOutputPath) {
        await fs.unlink(analysisOutputPath).catch(() => {});
      }

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
   * IMPORTANT: Creates temporary WAV file in system tmp directory, NOT in library location
   */
  private async extractAudio(videoPath: string, jobId: string): Promise<string> {
    const os = require('os');
    const tmpDir = os.tmpdir();

    // Create unique filename in tmp directory to avoid conflicts
    const audioFilename = `${jobId}_${Date.now()}_audio.wav`;
    const audioPath = path.join(tmpDir, audioFilename);

    this.logger.log(`Extracting audio to temporary file: ${audioPath}`);

    // Use FFmpeg to extract audio
    return new Promise((resolve, reject) => {
      const ffmpeg = require('fluent-ffmpeg');

      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .format('wav')
        .on('end', () => {
          this.logger.log(`Audio extraction complete: ${audioPath}`);
          resolve(audioPath);
        })
        .on('error', (err: Error) => {
          this.logger.error(`Audio extraction failed: ${err.message}`);
          reject(err);
        })
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
   * Parse SRT format to segments array (for AI analysis timestamp correlation)
   */
  private parseSrtToSegments(srtContent: string): any[] {
    const segments: any[] = [];
    const blocks = srtContent.split('\n\n').filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;

      // Line 0: sequence number
      // Line 1: timestamp (00:00:01,500 --> 00:00:04,200)
      // Line 2+: text
      const timestampLine = lines[1];
      const textLines = lines.slice(2);

      const match = timestampLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (match) {
        const startHours = parseInt(match[1]);
        const startMinutes = parseInt(match[2]);
        const startSeconds = parseInt(match[3]);
        const startMs = parseInt(match[4]);

        const endHours = parseInt(match[5]);
        const endMinutes = parseInt(match[6]);
        const endSeconds = parseInt(match[7]);
        const endMs = parseInt(match[8]);

        const start = startHours * 3600 + startMinutes * 60 + startSeconds + startMs / 1000;
        const end = endHours * 3600 + endMinutes * 60 + endSeconds + endMs / 1000;

        segments.push({
          start,
          end,
          text: textLines.join(' ')
        });
      }
    }

    return segments;
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
