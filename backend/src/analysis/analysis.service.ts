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

// Extended request interface to track job state
interface AnalysisRequestWithState extends AnalysisRequest {
  transcriptText?: string;
  transcriptSrt?: string;
  videoPath?: string;
  videoTitle?: string;
  audioPath?: string;
  phase?: 'download' | 'transcribe' | 'analyze' | 'finalize';
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private jobs = new Map<string, AnalysisJob>();

  // Queue management for concurrency control
  private pendingQueue: Array<{ jobId: string; request: AnalysisRequestWithState }> = [];
  private activeTranscriptions = 0;
  private activeAnalyses = 0;
  private readonly MAX_CONCURRENT_TRANSCRIPTIONS = 1;
  private readonly MAX_CONCURRENT_ANALYSES = 1;
  private isProcessing = false; // Prevent concurrent processNextInQueue calls

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
   * Start a new analysis job (adds to queue)
   */
  async startAnalysis(request: AnalysisRequest): Promise<string> {
    const jobId = uuidv4();

    const job: AnalysisJob = {
      id: jobId,
      status: 'pending',
      progress: 0,
      currentPhase: 'Waiting in queue...',
      createdAt: new Date(),
      timing: {},
    };

    this.jobs.set(jobId, job);

    // Determine initial phase based on mode and input type
    const mode = request.mode || 'full';
    let initialPhase: 'download' | 'transcribe' | 'analyze' | 'finalize';

    if (mode === 'analysis-only') {
      initialPhase = 'analyze';
    } else if (request.inputType === 'file') {
      // Local files skip download and go straight to transcribe
      initialPhase = 'transcribe';
    } else {
      // URLs need download first
      initialPhase = 'download';
    }

    // Add to pending queue with phase tracking
    const requestWithState: AnalysisRequestWithState = {
      ...request,
      phase: initialPhase,
    };

    this.pendingQueue.push({ jobId, request: requestWithState });
    this.logger.log(`Job ${jobId} added to queue at phase '${initialPhase}'. Queue length: ${this.pendingQueue.length}`);

    // Try to process next job in queue (use setImmediate to allow synchronous code to complete first)
    setImmediate(() => this.processNextInQueue());

    return jobId;
  }

  /**
   * Process the next job in queue if resources are available
   * Jobs are processed phase by phase, re-entering the queue between phases
   * Priority: finalize > analyze > transcribe (complete jobs before starting new ones)
   */
  private processNextInQueue(): void {
    if (this.pendingQueue.length === 0) {
      return;
    }

    // Priority 1: Finalize jobs (quick, no resources needed)
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const { jobId, request } = this.pendingQueue[i];
      if ((request.phase || 'download') === 'finalize') {
        this.pendingQueue.splice(i, 1);
        this.logger.log(`Starting job ${jobId} at phase 'finalize'`);
        this.processJobPhase(jobId, request).catch((error) => {
          this.logger.error(`Job ${jobId} failed at phase 'finalize': ${(error as Error).message}`);
          this.updateJob(jobId, { status: 'failed', error: (error as Error).message });
          setImmediate(() => this.processNextInQueue());
        });
        return;
      }
    }

    // Priority 2: Analyze jobs (complete jobs that finished transcribing)
    if (this.activeAnalyses < this.MAX_CONCURRENT_ANALYSES) {
      for (let i = 0; i < this.pendingQueue.length; i++) {
        const { jobId, request } = this.pendingQueue[i];
        if ((request.phase || 'download') === 'analyze') {
          this.activeAnalyses++;
          this.pendingQueue.splice(i, 1);
          this.logger.log(`Starting job ${jobId} at phase 'analyze'. Active: ${this.activeTranscriptions}/${this.MAX_CONCURRENT_TRANSCRIPTIONS} transcriptions, ${this.activeAnalyses}/${this.MAX_CONCURRENT_ANALYSES} analyses`);
          this.processJobPhase(jobId, request).catch((error) => {
            this.logger.error(`Job ${jobId} failed at phase 'analyze': ${(error as Error).message}`);
            this.updateJob(jobId, { status: 'failed', error: (error as Error).message });
            this.activeAnalyses--;
            setImmediate(() => this.processNextInQueue());
          });
          return;
        }
      }
    }

    // Priority 3: Transcribe/Download jobs (start new jobs)
    if (this.activeTranscriptions < this.MAX_CONCURRENT_TRANSCRIPTIONS) {
      for (let i = 0; i < this.pendingQueue.length; i++) {
        const { jobId, request } = this.pendingQueue[i];
        const phase = request.phase || 'download';
        if (phase === 'download' || phase === 'transcribe') {
          this.activeTranscriptions++;
          this.pendingQueue.splice(i, 1);
          this.logger.log(`Starting job ${jobId} at phase '${phase}'. Active: ${this.activeTranscriptions}/${this.MAX_CONCURRENT_TRANSCRIPTIONS} transcriptions, ${this.activeAnalyses}/${this.MAX_CONCURRENT_ANALYSES} analyses`);
          this.processJobPhase(jobId, request).catch((error) => {
            this.logger.error(`Job ${jobId} failed at phase '${phase}': ${(error as Error).message}`);
            this.updateJob(jobId, { status: 'failed', error: (error as Error).message });
            this.activeTranscriptions--;
            setImmediate(() => this.processNextInQueue());
          });
          return;
        }
      }
    }

    // No job could be started due to resource constraints
    this.logger.debug(`No jobs can start. Active: ${this.activeTranscriptions}/${this.MAX_CONCURRENT_TRANSCRIPTIONS} transcriptions, ${this.activeAnalyses}/${this.MAX_CONCURRENT_ANALYSES} analyses. Queue: ${this.pendingQueue.length}`);
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
   * Re-add job to queue at the next phase
   */
  private requeueJobForNextPhase(jobId: string, request: AnalysisRequestWithState, nextPhase: 'download' | 'transcribe' | 'analyze' | 'finalize'): void {
    request.phase = nextPhase;
    this.pendingQueue.push({ jobId, request });
    this.logger.log(`Job ${jobId} re-queued for phase '${nextPhase}'. Queue length: ${this.pendingQueue.length}`);
    setImmediate(() => this.processNextInQueue());
  }

  /**
   * Process a single phase of a job
   */
  private async processJobPhase(
    jobId: string,
    request: AnalysisRequestWithState,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const phase = request.phase || 'download';
    const mode = request.mode || 'full';

    this.logger.log(`Processing job ${jobId} at phase '${phase}'`);

    try {
      if (phase === 'download') {
        // Phase 1: Download/prepare video
        await this.processDownloadPhase(jobId, request);

        // DON'T release transcription slot yet - transcribe phase needs it
        // Just move directly to transcribe without re-queuing
        this.logger.log(`Download phase complete for job ${jobId}, moving to transcribe...`);

        // Continue directly to transcribe phase without releasing the slot
        await this.processTranscribePhase(jobId, request);

        // NOW release transcription slot after both download and transcribe are done
        this.activeTranscriptions--;
        this.logger.log(`Transcription phase complete for job ${jobId}. Active transcriptions: ${this.activeTranscriptions}/${this.MAX_CONCURRENT_TRANSCRIPTIONS}`);

        // Move to appropriate next phase based on mode
        if (mode === 'transcribe-only') {
          this.requeueJobForNextPhase(jobId, request, 'finalize');
        } else {
          this.requeueJobForNextPhase(jobId, request, 'analyze');
        }
      } else if (phase === 'transcribe') {
        // This is for local files that start directly at transcribe (skipping download)
        // Set up videoPath and videoTitle if not already set
        if (!request.videoPath) {
          request.videoPath = request.input;
          request.videoTitle = path.basename(request.input, path.extname(request.input));
        }

        await this.processTranscribePhase(jobId, request);

        // Release transcription slot
        this.activeTranscriptions--;
        this.logger.log(`Transcription phase complete for job ${jobId}. Active transcriptions: ${this.activeTranscriptions}/${this.MAX_CONCURRENT_TRANSCRIPTIONS}`);

        // Move to appropriate next phase based on mode
        if (mode === 'transcribe-only') {
          this.requeueJobForNextPhase(jobId, request, 'finalize');
        } else {
          this.requeueJobForNextPhase(jobId, request, 'analyze');
        }
      } else if (phase === 'analyze') {
        // Phase 3: AI Analysis
        await this.processAnalyzePhase(jobId, request);

        // Release analysis slot
        this.activeAnalyses--;
        this.logger.log(`Analysis phase complete for job ${jobId}. Active analyses: ${this.activeAnalyses}/${this.MAX_CONCURRENT_ANALYSES}`);

        // Move to finalize
        this.requeueJobForNextPhase(jobId, request, 'finalize');
      } else if (phase === 'finalize') {
        // Phase 4: Finalize
        await this.processFinalizePhase(jobId, request);

        this.logger.log(`Job ${jobId} completed successfully`);

        // Process next job in queue
        setImmediate(() => this.processNextInQueue());
      }
    } catch (error: any) {
      // Release resources on error
      if (phase === 'download' || phase === 'transcribe') {
        this.activeTranscriptions--;
      } else if (phase === 'analyze') {
        this.activeAnalyses--;
      }

      this.logger.error(`Job ${jobId} failed at phase '${phase}': ${(error as Error).message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Process download phase
   */
  private async processDownloadPhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    // Determine output paths - use library clips folder for videos only
    let videosPath: string;
    const activeLibrary = this.libraryManagerService.getActiveLibrary();

    if (activeLibrary) {
      videosPath = activeLibrary.clipsFolderPath;
    } else {
      const baseOutputPath = request.outputPath || this.getDefaultOutputPath();
      videosPath = path.join(baseOutputPath, 'videos');
    }

    await fs.mkdir(videosPath, { recursive: true });

    if (request.inputType === 'url') {
      this.updateJob(jobId, {
        status: 'downloading',
        progress: 5,
        currentPhase: 'Downloading video (fast mode)...',
        timing: { ...job.timing, downloadStart: new Date() },
      });

      const downloadResult = await this.downloadVideo(request.input, videosPath, jobId);
      request.videoPath = downloadResult.path;
      request.videoTitle = downloadResult.title;

      this.updateJob(jobId, {
        progress: 20,
        videoPath: downloadResult.path,
        timing: { ...job.timing, downloadEnd: new Date() },
      });
    } else {
      request.videoPath = request.input;
      request.videoTitle = path.basename(request.input, path.extname(request.input));

      this.updateJob(jobId, {
        status: 'extracting',
        progress: 5,
        currentPhase: 'Preparing local video...',
        videoPath: request.input,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      this.updateJob(jobId, { progress: 20 });
    }
  }

  /**
   * Process transcribe phase
   */
  private async processTranscribePhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const mode = request.mode || 'full';

    if (mode === 'analysis-only') {
      // Use existing transcript
      request.transcriptText = request.existingTranscriptText!;
      request.transcriptSrt = request.existingTranscriptSrt!;

      this.updateJob(jobId, {
        progress: 60,
        currentPhase: 'Using existing transcript...',
      });
      return;
    }

    // Extract audio
    this.updateJob(jobId, {
      status: 'extracting',
      progress: 20,
      currentPhase: 'Extracting audio...',
      timing: { ...job.timing, extractionStart: new Date() },
    });

    const audioPath = await this.extractAudio(request.videoPath!, jobId);
    request.audioPath = audioPath;

    this.updateJob(jobId, {
      progress: 30,
      audioPath,
      timing: { ...job.timing, extractionEnd: new Date() },
    });

    // Transcribe
    this.updateJob(jobId, {
      status: 'transcribing',
      progress: 30,
      currentPhase: 'Transcribing audio (this may take a few minutes)...',
      timing: { ...job.timing, transcriptionStart: new Date() },
    });

    this.logger.log(`Transcription started for job ${jobId}`);

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

    request.transcriptText = transcriptResult.text;
    request.transcriptSrt = transcriptResult.srt;

    this.updateJob(jobId, {
      progress: 60,
      timing: { ...job.timing, transcriptionEnd: new Date() },
    });

    // Clean up audio file
    if (audioPath) {
      await fs.unlink(audioPath).catch(() => {});
    }
  }

  /**
   * Process analyze phase
   */
  private async processAnalyzePhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    this.updateJob(jobId, {
      status: 'analyzing',
      progress: 60,
      currentPhase: `Analyzing with ${request.aiModel}...`,
      timing: { ...job.timing, analysisStart: new Date() },
    });

    this.logger.log(`Analysis started for job ${jobId}`);

    // Prepare AI model (preload if not loaded, unload others if different model)
    if (request.aiProvider === 'ollama' || !request.aiProvider) {
      try {
        await this.ollama.prepareModel(request.aiModel, request.ollamaEndpoint);
      } catch (error: any) {
        this.logger.warn(`Failed to prepare model ${request.aiModel}: ${(error as Error).message}. Continuing anyway...`);
      }
    }

    // Create temp directory for analysis output
    const os = require('os');
    const tmpDir = os.tmpdir();
    const sanitizedTitle = this.sanitizeFilename(request.videoTitle!);
    const reportFileName = request.customReportName || `${sanitizedTitle}.txt`;
    const analysisOutputPath = path.join(tmpDir, `${jobId}_${reportFileName}`);

    // Parse SRT to get segments
    const segments = this.parseSrtToSegments(request.transcriptSrt!);

    const analysisResult = await this.pythonBridge.analyze(
      request.ollamaEndpoint,
      request.aiModel,
      request.transcriptText!,
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
      request.videoTitle!,
    );

    // Read and save analysis
    const analysisText = await fs.readFile(analysisOutputPath, 'utf-8');

    // Save to request for finalize phase
    (request as any).analysisText = analysisText;
    (request as any).analysisResult = analysisResult;
    (request as any).analysisOutputPath = analysisOutputPath;

    this.updateJob(jobId, {
      progress: 95,
      tags: (analysisResult as any)?.tags || { people: [], topics: [] },
      timing: { ...job.timing, analysisEnd: new Date() },
    });

    // Keep-alive will maintain the model in memory for the next job in queue
    this.logger.log(`Analysis complete for job ${jobId}. Model ${request.aiModel} will stay loaded for ${this.ollama['KEEP_ALIVE_DURATION'] / 60000} minutes.`);
  }

  /**
   * Process finalize phase
   */
  private async processFinalizePhase(jobId: string, request: AnalysisRequestWithState): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Job not found');

    const mode = request.mode || 'full';

    this.updateJob(jobId, {
      progress: 98,
      currentPhase: mode === 'transcribe-only' ? 'Finalizing transcription...' : 'Finalizing analysis...',
    });

    // Calculate timing
    const timing = job.timing || {};
    const totalDuration = (new Date().getTime() - job.createdAt.getTime()) / 1000;

    // Auto-import to library if needed
    let videoId: string | undefined;
    const activeLibrary = this.libraryManagerService.getActiveLibrary();

    if (activeLibrary && request.videoPath) {
      // Try to import the video regardless of input type (URL or file)
      try {
        const importResult = await this.fileScannerService.importVideos([request.videoPath]);
        if (importResult.imported.length > 0) {
          videoId = importResult.imported[0];
          this.logger.log(`Video imported to library with ID: ${videoId}`);
        }
      } catch (error) {
        this.logger.error(`Error during auto-import: ${(error as Error).message}`);

        // Fallback: try to find existing video in database
        try {
          const videos = await this.databaseService.getAllVideos();
          const video = videos.find((v: any) => v.current_path === request.videoPath || v.file_path === request.videoPath);
          if (video) {
            videoId = video.id;
            this.logger.log(`Found existing video in database with ID: ${videoId}`);
          }
        } catch (findError) {
          this.logger.warn(`Could not find video in database: ${(findError as Error).message}`);
        }
      }
    }

    // Save to database if video found
    if (videoId) {
      if (mode !== 'analysis-only' && request.transcriptText && request.transcriptSrt) {
        this.databaseService.insertTranscript({
          videoId,
          plainText: request.transcriptText,
          srtFormat: request.transcriptSrt,
          whisperModel: request.whisperModel || 'base',
          language: request.language || 'en',
        });
      }

      if (mode !== 'transcribe-only' && (request as any).analysisText) {
        this.databaseService.insertAnalysis({
          videoId,
          aiAnalysis: (request as any).analysisText,
          sectionsCount: (request as any).analysisResult?.sections_count || 0,
          aiModel: request.aiModel,
          aiProvider: request.aiProvider || 'ollama',
        });
      }
    }

    // Clean up temp files
    if ((request as any).analysisOutputPath) {
      await fs.unlink((request as any).analysisOutputPath).catch(() => {});
    }

    // Complete
    const completionMessage = mode === 'transcribe-only'
      ? 'Transcription complete!'
      : `Analysis complete! Found ${(request as any).analysisResult?.sections_count || 0} interesting sections.`;

    this.updateJob(jobId, {
      status: 'completed',
      progress: 100,
      currentPhase: completionMessage,
      completedAt: new Date(),
      timing: { ...timing, totalDuration },
    });
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
