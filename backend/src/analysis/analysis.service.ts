import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fsSync from 'fs';
import { SharedConfigService } from '../config/shared-config.service';
import { FileScannerService } from '../database/file-scanner.service';
import { DatabaseService } from '../database/database.service';
import { QueueManagerService } from '../queue/queue-manager.service';
import { isCrucibleRequired } from '../crucible/readiness.service';
import { Task } from '../common/interfaces/task.interface';
import { DEFAULT_CATEGORIES } from './prompts/analysis-prompts';
import { v4 as uuidv4 } from 'uuid';

/**
 * Batch transcription/analysis over library videos, as QUEUE jobs.
 *
 * Every transcription and analysis runs as a queue task (transcribe, analyze),
 * which is where Crucible's lanes, admission and parking live. Before P7 this
 * service also carried a second, in-process pipeline (`POST /analysis/start`:
 * its own one-job concurrency, an Ollama preload and a standalone whisper
 * transcription) that went around the queue; nothing called it, and it is gone.
 */
@Injectable()
export class AnalysisService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private eventEmitter: EventEmitter2,
    private configService: SharedConfigService,
    private fileScannerService: FileScannerService,
    private databaseService: DatabaseService,
    @Inject(forwardRef(() => QueueManagerService))
    private queueManager: QueueManagerService,
  ) {}

  onModuleInit() {
    // Initialize categories file if it doesn't exist
    this.initializeCategoriesFile();
  }

  /**
   * Start batch analysis for multiple videos
   * Returns a batch ID that can be used to track overall progress
   */
  async startBatchAnalysis(options: {
    videoIds?: string[]; // Specific video IDs to process
    aiModel?: string;
    aiProvider?: 'local' | 'ollama' | 'claude' | 'openai';
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
    forceRetranscribe?: boolean;
    limit?: number; // Process only first N videos (for testing)
    customJobId?: string; // Custom job ID from frontend (for single-video analysis in processing queue)
  }): Promise<{ batchId: string; jobIds: string[] }> {
    const batchId = uuidv4();

    // Get config
    const config = await this.configService.getConfig();
    const transcribeOnly = options?.transcribeOnly || false;
    const forceReanalyze = options?.forceReanalyze || false;
    const forceRetranscribe = options?.forceRetranscribe !== undefined ? options.forceRetranscribe : true; // Default true for batch operations

    // NO DEFAULT - user must explicitly select an AI model for analysis
    const aiModel = options?.aiModel || config.aiModel;
    const aiProvider = options?.aiProvider;

    // Validate AI model is configured if not transcribe-only
    if (!transcribeOnly && !aiModel) {
      throw new Error('AI analysis requires an AI model to be configured. Please select a model in settings.');
    }
    if (!transcribeOnly && !aiProvider) {
      throw new Error('AI analysis requires an AI provider to be configured. Please select a provider in settings.');
    }

    // Get videos to process
    let videosToProcess: Array<{ id: string; filename: string; current_path: string }>;

    if (options?.videoIds && options.videoIds.length > 0) {
      // Process specific videos by ID
      const dbVideos = options.videoIds
        .map(id => this.databaseService.getVideoById(id))
        .filter(video => video !== null);

      if (dbVideos.length === 0) {
        throw new Error('None of the specified videos were found in the database');
      }

      videosToProcess = dbVideos.map(video => ({
        id: video.id as string,
        filename: video.filename as string,
        current_path: video.current_path as string,
      }));
    } else {
      // Get all videos that need analysis
      const videosNeedingAnalysis = this.fileScannerService.getNeedsAnalysis();

      // Apply limit if specified
      videosToProcess = options?.limit
        ? videosNeedingAnalysis.slice(0, options.limit)
        : videosNeedingAnalysis;

      if (videosToProcess.length === 0) {
        throw new Error('No videos need analysis');
      }
    }


    // Submit all videos to the new queue system
    const jobIds: string[] = [];

    for (const video of videosToProcess) {
      try {
        // Check if transcript and analysis already exist
        const existingTranscript = this.databaseService.getTranscript(video.id);
        const existingAnalysis = this.databaseService.getAnalysis(video.id);
        const hasTranscript = !!existingTranscript;
        const hasAnalysis = !!existingAnalysis;

        // Build task list based on what needs to be done
        const tasks: Task[] = [];

        if (transcribeOnly) {
          // If user explicitly selected transcribe, always re-transcribe (don't skip)
          tasks.push({ type: 'transcribe', options: {} });
        } else {
          // User requested full analysis — always allow re-analysis.
          // Old analysis will be cleared by processAnalyzePhase before re-running.

          // Determine which tasks to add based on existing transcript and user preferences
          if (hasTranscript && !forceRetranscribe) {
            // Use existing transcript, only run analysis
          } else {
            // Need to transcribe (either no transcript exists, or forceRetranscribe is true)
            tasks.push({ type: 'transcribe', options: {} });
          }

          // Always add analyze task for full analysis
          tasks.push({
            type: 'analyze',
            options: {
              aiModel,
              aiProvider,
            },
          });
        }

        // Create queue job with videoId and tasks
        const createdJobId = this.queueManager.addJob({
          videoId: video.id,
          displayName: video.filename,
          tasks,
        });

        jobIds.push(createdJobId);

      } catch (error) {
        // Crucible not there: the whole batch is refused by name, never a
        // quiet batch of zero jobs.
        if (isCrucibleRequired(error)) throw error;
        this.logger.error(`Failed to queue video ${video.filename}: ${(error as Error).message}`);
      }
    }

    // Emit batch started event
    this.eventEmitter.emit('batch.started', {
      batchId,
      totalJobs: jobIds.length,
      jobIds,
    });

    // If no jobs were queued (all skipped), no need to track batch job
    if (jobIds.length === 0) {
      this.logger.log(`Batch ${batchId}: No jobs to process (all videos skipped)`);
      // Don't call updateJob - batch job was never created since no processing needed
    }

    return { batchId, jobIds };
  }

  /**
   * Batch progress, read from the queue jobs the batch created. A job the queue
   * no longer holds finished and was cleared: counted completed.
   */
  getBatchProgress(jobIds: string[]): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    progress: number;
  } {
    const stats = { total: jobIds.length, pending: 0, processing: 0, completed: 0, failed: 0, progress: 0 };
    for (const jobId of jobIds) {
      const job = this.queueManager.getJob(jobId);
      if (!job || job.status === 'completed') stats.completed++;
      else if (job.status === 'pending' || job.status === 'paused') stats.pending++;
      else if (job.status === 'failed' || job.status === 'cancelled') stats.failed++;
      else stats.processing++;
    }
    stats.progress = stats.total > 0 ? Math.round(((stats.completed + stats.failed) / stats.total) * 100) : 0;
    return stats;
  }

  /**
   * Initialize categories file with defaults if it doesn't exist
   * Called on module init to ensure categories are always available
   */
  private initializeCategoriesFile(): void {
    try {
      const configDir = this.configService.getConfigDir();
      const categoriesPath = path.join(configDir, 'analysis-categories.json');

      if (!fsSync.existsSync(categoriesPath)) {
        this.logger.log('Categories file not found, initializing with defaults');

        // Ensure directory exists
        if (!fsSync.existsSync(configDir)) {
          fsSync.mkdirSync(configDir, { recursive: true });
        }

        // Write default categories in the { categories: [...] } shape that
        // loadCategories() and config.controller expect.
        fsSync.writeFileSync(
          categoriesPath,
          JSON.stringify({ categories: DEFAULT_CATEGORIES }, null, 2),
          'utf-8'
        );

        this.logger.log(`Created categories file at: ${categoriesPath}`);
      } else {
        this.logger.log(`Categories file exists at: ${categoriesPath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to initialize categories file: ${(error as Error).message}`);
    }
  }
}
