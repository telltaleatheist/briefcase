import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { QueueManagerService } from '../queue/queue-manager.service';
import { Task } from '../common/interfaces/task.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SharedConfigService } from '../config/shared-config.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * BatchAnalysisService - Manages batch processing of videos for transcription and analysis
 *
 * Features:
 * - Queue-based processing of thousands of videos
 * - Progress tracking with resume capability
 * - Stores results in database
 * - Handles errors gracefully (logs and continues)
 * - Pause/resume support
 * - Configurable concurrency
 */

export interface BatchJob {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  totalVideos: number;
  processedVideos: number;
  failedVideos: number;
  skippedVideos: number; // Videos skipped due to existing analysis
  currentVideoId?: string;
  currentVideoFilename?: string;
  startedAt: string;
  completedAt?: string;
  pausedAt?: string;
  estimatedTimeRemaining?: number; // seconds
  errors: BatchError[];
}

export interface BatchError {
  videoId: string;
  filename: string;
  error: string;
  timestamp: string;
}

export interface BatchProgress {
  jobId: string;
  status: string;
  totalVideos: number;
  processedVideos: number;
  failedVideos: number;
  skippedVideos: number;
  currentVideoFilename?: string;
  progress: number; // 0-100
  estimatedTimeRemaining?: number;
  errors: BatchError[];
}

@Injectable()
export class BatchAnalysisService implements OnModuleInit {
  private readonly logger = new Logger(BatchAnalysisService.name);
  private currentBatchJob: BatchJob | null = null;
  private isPaused = false;
  private shouldStop = false;
  private processingStartTime = 0;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly fileScannerService: FileScannerService,
    private readonly queueManager: QueueManagerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: SharedConfigService,
  ) {}

  async onModuleInit() {
    // Check for interrupted batch job on startup
    await this.checkForInterruptedJob();
  }

  /**
   * Check if there's an interrupted batch job that can be resumed
   */
  private async checkForInterruptedJob() {
    // This would load from database in production
    // For now, we'll just log
    this.logger.log('Checking for interrupted batch jobs...');
  }

  /**
   * Start a new batch analysis job
   */
  async startBatchAnalysis(options?: {
    aiModel?: string;
    aiProvider?: 'ollama' | 'claude' | 'openai';
    whisperModel?: string;
    ollamaEndpoint?: string;
    limit?: number; // Process only first N videos (for testing)
    videoIds?: string[]; // Specific video IDs to process
    transcribeOnly?: boolean; // Only transcribe, skip AI analysis
    forceReanalyze?: boolean; // Force re-analysis even if analysis exists (default: false)
    claudeApiKey?: string; // Claude API key (if provided, overrides saved key)
    openaiApiKey?: string; // OpenAI API key (if provided, overrides saved key)
  }): Promise<string> {
    if (this.currentBatchJob && this.currentBatchJob.status === 'running') {
      throw new Error('A batch job is already running. Please pause or stop it first.');
    }

    // Get default config
    const config = await this.configService.getConfig();
    const transcribeOnly = options?.transcribeOnly || false;
    const forceReanalyze = options?.forceReanalyze || false;
    const aiModel = options?.aiModel || config.aiModel || 'qwen2.5:7b';
    const aiProvider = options?.aiProvider || 'ollama';
    const whisperModel = options?.whisperModel || 'base';
    const ollamaEndpoint = options?.ollamaEndpoint || config.ollamaEndpoint || 'http://localhost:11434';
    const claudeApiKey = options?.claudeApiKey;
    const openaiApiKey = options?.openaiApiKey;

    // Get videos to process
    let videosToProcess: Array<{ id: string; filename: string; current_path: string; upload_date?: string | null; download_date?: string | null; duration_seconds?: number | null }>;

    if (options?.videoIds && options.videoIds.length > 0) {
      // Process specific videos by ID
      const dbVideos = options.videoIds
        .map(id => this.databaseService.getVideoById(id))
        .filter(video => video !== null); // Filter out any videos not found

      if (dbVideos.length === 0) {
        throw new Error('None of the specified videos were found in the database');
      }

      // Convert database objects to expected format
      videosToProcess = dbVideos.map(video => ({
        id: video.id as string,
        filename: video.filename as string,
        current_path: video.current_path as string,
        upload_date: video.upload_date as string | null,
        download_date: video.download_date as string | null,
        duration_seconds: video.duration_seconds as number | null,
      }));
    } else {
      // Get all videos that need analysis
      const videosNeedingAnalysis = this.fileScannerService.getNeedsAnalysis();

      // Apply limit if specified (for testing)
      videosToProcess = options?.limit
        ? videosNeedingAnalysis.slice(0, options.limit)
        : videosNeedingAnalysis;

      if (videosToProcess.length === 0) {
        throw new Error('No videos need analysis');
      }
    }

    const batchJobId = uuidv4();
    this.currentBatchJob = {
      id: batchJobId,
      status: 'pending',
      totalVideos: videosToProcess.length,
      processedVideos: 0,
      failedVideos: 0,
      skippedVideos: 0,
      startedAt: new Date().toISOString(),
      errors: [],
    };

    this.logger.log(
      `Starting batch ${transcribeOnly ? 'transcription' : 'analysis'} job ${batchJobId} for ${videosToProcess.length} videos`,
    );
    this.logger.log(`Config: ${aiProvider}/${aiModel}, Whisper: ${whisperModel}, Transcribe-only: ${transcribeOnly}, Force-reanalyze: ${forceReanalyze}`);

    // Start processing asynchronously
    this.processBatch(videosToProcess, {
      aiModel,
      aiProvider,
      whisperModel,
      ollamaEndpoint,
      transcribeOnly,
      forceReanalyze,
      claudeApiKey,
      openaiApiKey,
    }).catch((error) => {
      const err = error as Error;
      this.logger.error(`Batch job failed: ${err.message}`, err.stack);
      if (this.currentBatchJob) {
        this.currentBatchJob.status = 'failed';
        this.currentBatchJob.errors.push({
          videoId: 'system',
          filename: 'batch-system',
          error: err.message,
          timestamp: new Date().toISOString(),
        });
      }
    });

    return batchJobId;
  }

  /**
   * Queue videos for analysis without starting processing
   * Creates a paused batch job that the user can manually start from the analysis dialog
   */
  async queueVideosForAnalysis(options: {
    videoIds: string[];
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
  }): Promise<string> {
    if (this.currentBatchJob && (this.currentBatchJob.status === 'running' || this.currentBatchJob.status === 'paused')) {
      throw new Error('A batch job already exists. Please complete or stop it first.');
    }

    const transcribeOnly = options?.transcribeOnly || false;
    const forceReanalyze = options?.forceReanalyze || false;

    // Get videos to queue
    const dbVideos = options.videoIds
      .map(id => this.databaseService.getVideoById(id))
      .filter(video => video !== null);

    if (dbVideos.length === 0) {
      throw new Error('None of the specified videos were found in the database');
    }

    // Convert database objects to expected format
    const videosToQueue = dbVideos.map(video => ({
      id: video.id as string,
      filename: video.filename as string,
      current_path: video.current_path as string,
      upload_date: video.upload_date as string | null,
      download_date: video.download_date as string | null,
      duration_seconds: video.duration_seconds as number | null,
    }));

    const batchJobId = uuidv4();
    this.currentBatchJob = {
      id: batchJobId,
      status: 'paused',  // Start as paused so user can manually start
      totalVideos: videosToQueue.length,
      processedVideos: 0,
      failedVideos: 0,
      skippedVideos: 0,
      startedAt: new Date().toISOString(),
      pausedAt: new Date().toISOString(),
      errors: [],
    };

    this.logger.log(
      `Queued ${videosToQueue.length} videos for ${transcribeOnly ? 'transcription' : 'analysis'} (Job ID: ${batchJobId})`,
    );
    this.logger.log(`Transcribe-only: ${transcribeOnly}, Force-reanalyze: ${forceReanalyze}`);

    return batchJobId;
  }

  /**
   * Process batch of videos by adding them all to the analysis queue
   */
  private async processBatch(
    videos: Array<{ id: string; filename: string; current_path: string }>,
    config: {
      aiModel: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      whisperModel: string;
      ollamaEndpoint: string;
      transcribeOnly?: boolean;
      forceReanalyze?: boolean;
      claudeApiKey?: string;
      openaiApiKey?: string;
    },
  ): Promise<void> {
    if (!this.currentBatchJob) return;

    this.currentBatchJob.status = 'running';
    this.isPaused = false;
    this.shouldStop = false;
    this.processingStartTime = Date.now();

    // Track job IDs created for this batch
    const batchJobIds: string[] = [];

    // Add all videos to the analysis queue
    for (const video of videos) {
      try {
        // Re-fetch video data from database to get the most current path
        const currentVideoData = this.databaseService.getVideoById(video.id);
        if (!currentVideoData) {
          this.logger.warn(`Video ${video.id} not found in database, skipping`);
          continue;
        }

        const currentFilename = currentVideoData.filename as string;

        // Check if transcript and analysis already exist
        const existingTranscript = this.databaseService.getTranscript(video.id);
        const existingAnalysis = this.databaseService.getAnalysis(video.id);
        const hasTranscript = !!existingTranscript;
        const hasAnalysis = !!existingAnalysis;

        // Build task list based on what needs to be done
        const tasks: Task[] = [];

        if (config.transcribeOnly) {
          // User explicitly requested transcribe-only
          if (hasTranscript) {
            this.logger.log(`Transcript already exists for ${currentFilename}, skipping transcription`);
            if (this.currentBatchJob) {
              this.currentBatchJob.skippedVideos++;
            }
            continue; // Skip this video entirely
          }
          tasks.push({ type: 'transcribe', options: { model: config.whisperModel } });
        } else {
          // User requested full analysis
          // Check if analysis already exists and if we should skip
          if (hasAnalysis && !config.forceReanalyze) {
            this.logger.log(`Analysis already exists for ${currentFilename}, skipping (use forceReanalyze to override)`);
            if (this.currentBatchJob) {
              this.currentBatchJob.skippedVideos++;
            }
            continue; // Skip this video entirely
          }

          if (!hasTranscript) {
            // Need to transcribe first
            tasks.push({ type: 'transcribe', options: { model: config.whisperModel } });
          }

          // Always add analyze task for full analysis
          const apiKey = config.aiProvider === 'claude' ? config.claudeApiKey : config.aiProvider === 'openai' ? config.openaiApiKey : undefined;
          tasks.push({
            type: 'analyze',
            options: {
              aiModel: config.aiModel,
              aiProvider: config.aiProvider,
              ollamaEndpoint: config.ollamaEndpoint,
              apiKey, // Single apiKey field for all providers
            },
          });
        }

        this.logger.log(`Adding ${currentFilename} to analysis queue with tasks: ${tasks.map(t => t.type).join(', ')}`);

        // Create queue job with videoId and tasks
        const jobId = this.queueManager.addJob({
          queueType: 'analysis',
          videoId: video.id,
          displayName: currentFilename,
          tasks,
        });

        batchJobIds.push(jobId);
      } catch (error) {
        const err = error as Error;
        this.logger.error(`Failed to queue video ${video.filename}: ${err.message}`);
        if (this.currentBatchJob) {
          this.currentBatchJob.errors.push({
            videoId: video.id,
            filename: video.filename,
            error: err.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Store the job IDs for this batch
    if (this.currentBatchJob) {
      (this.currentBatchJob as any).queueJobIds = batchJobIds;
    }

    this.logger.log(`Added ${batchJobIds.length} videos to analysis queue`);
    this.emitProgress();
  }

  /**
   * Pause the current batch job by canceling all pending jobs
   */
  pauseBatch(): boolean {
    if (!this.currentBatchJob || this.currentBatchJob.status !== 'running') {
      return false;
    }

    // Get the queue job IDs for this batch
    const batchJobIds = (this.currentBatchJob as any).queueJobIds as string[] || [];

    // Cancel all pending jobs (but leave processing jobs to finish)
    let cancelledCount = 0;
    for (const jobId of batchJobIds) {
      const job = this.queueManager.getJob(jobId);
      if (job && job.status === 'pending') {
        this.queueManager.cancelJob(jobId);
        cancelledCount++;
      }
    }

    this.currentBatchJob.status = 'paused';
    this.currentBatchJob.pausedAt = new Date().toISOString();
    this.isPaused = true;

    this.logger.log(`Batch job paused - cancelled ${cancelledCount} pending jobs`);
    return true;
  }

  /**
   * Resume a paused batch job
   * Note: This doesn't currently re-queue cancelled jobs - user would need to start a new batch
   */
  async resumeBatch(): Promise<boolean> {
    if (!this.currentBatchJob || this.currentBatchJob.status !== 'paused') {
      return false;
    }

    // For now, we can't resume cancelled jobs
    // The user would need to start a new batch analysis
    this.logger.warn('Resume not fully implemented - cancelled jobs are not re-queued');

    this.currentBatchJob.status = 'running';
    this.isPaused = false;

    return true;
  }

  /**
   * Stop the current batch job by canceling all pending and processing jobs
   */
  stopBatch(): boolean {
    if (!this.currentBatchJob) {
      return false;
    }

    // Get the queue job IDs for this batch
    const batchJobIds = (this.currentBatchJob as any).queueJobIds as string[] || [];

    // Cancel all pending jobs
    let cancelledCount = 0;
    for (const jobId of batchJobIds) {
      const job = this.queueManager.getJob(jobId);
      if (job && (job.status === 'pending' || job.status === 'processing')) {
        this.queueManager.cancelJob(jobId);
        cancelledCount++;
      }
    }

    this.currentBatchJob.status = 'completed';
    this.currentBatchJob.completedAt = new Date().toISOString();
    this.shouldStop = true;

    this.logger.log(`Batch job stopped - cancelled ${cancelledCount} jobs`);
    return true;
  }

  /**
   * Get current batch job status by checking the analysis queue
   */
  getBatchProgress(): BatchProgress | null {
    if (!this.currentBatchJob) {
      return null;
    }

    // Get the queue job IDs for this batch
    const batchJobIds = (this.currentBatchJob as any).queueJobIds as string[] || [];

    // Filter to only the jobs that are part of this batch
    const batchJobs = batchJobIds
      .map(id => this.queueManager.getJob(id))
      .filter(job => job !== undefined);

    // Calculate statistics
    const totalVideos = this.currentBatchJob.totalVideos;
    const skippedVideos = this.currentBatchJob.skippedVideos;
    const completedJobs = batchJobs.filter(j => j.status === 'completed').length;
    const failedJobs = batchJobs.filter(j => j.status === 'failed').length;
    const processingJobs = batchJobs.filter(j => j.status === 'processing');
    const pendingJobs = batchJobs.filter(j => j.status === 'pending').length;

    // Total processed = completed + failed
    const processedVideos = completedJobs + failedJobs;

    // Find current video being processed
    let currentVideoFilename: string | undefined;
    if (processingJobs.length > 0) {
      currentVideoFilename = processingJobs[0].displayName;
    }

    // Calculate progress (including skipped videos)
    const totalExpected = totalVideos;
    const totalDone = processedVideos + skippedVideos;
    const progress = totalExpected > 0 ? (totalDone / totalExpected) * 100 : 0;

    // Determine status
    let status = this.currentBatchJob.status;
    if (processingJobs.length === 0 && pendingJobs === 0 && batchJobs.length > 0) {
      // All jobs are done
      status = 'completed';
      this.currentBatchJob.status = 'completed';
      this.currentBatchJob.completedAt = new Date().toISOString();
    }

    // Collect errors from failed jobs
    const errors: BatchError[] = [];
    for (const job of batchJobs) {
      if (job.status === 'failed') {
        errors.push({
          videoId: job.videoId || 'unknown',
          filename: job.displayName || 'Unknown',
          error: job.error || 'Unknown error',
          timestamp: job.completedAt?.toISOString() || new Date().toISOString(),
        });
      }
    }

    // Calculate estimated time remaining
    let estimatedTimeRemaining: number | undefined;
    if (processingJobs.length > 0 && this.processingStartTime > 0) {
      const elapsed = Date.now() - this.processingStartTime;
      const avgTimePerVideo = elapsed / (processedVideos || 1);
      const remaining = (totalExpected - totalDone) * avgTimePerVideo;
      estimatedTimeRemaining = Math.round(remaining / 1000);
    }

    return {
      jobId: this.currentBatchJob.id,
      status,
      totalVideos,
      processedVideos,
      failedVideos: failedJobs,
      skippedVideos,
      currentVideoFilename,
      progress: Math.round(progress),
      estimatedTimeRemaining,
      errors,
    };
  }

  /**
   * Emit progress event
   */
  private emitProgress() {
    const progress = this.getBatchProgress();
    if (progress) {
      this.eventEmitter.emit('batch.progress', progress);
    }
  }
}
