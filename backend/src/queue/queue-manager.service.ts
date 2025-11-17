// Queue Manager Service - Executes task-based jobs with configurable concurrency

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { MediaEventService } from '../media/media-event.service';
import { MediaOperationsService } from '../media/media-operations.service';
import {
  QueueJob,
  QueueStatus,
  Task,
  TaskResult,
} from '../common/interfaces/task.interface';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class QueueManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueManagerService.name);

  // Separate queues for batch and analysis
  private batchJobs = new Map<string, QueueJob>();
  private analysisJobs = new Map<string, QueueJob>();

  // Queue processing state
  private batchProcessing = false;
  private analysisProcessing = false;

  // Concurrency limits
  private readonly BATCH_MAX_CONCURRENCY = 15; // High concurrency for batch downloads
  private readonly ANALYSIS_MAX_CONCURRENCY = 1; // Sequential for AI-heavy work

  constructor(
    private readonly mediaOps: MediaOperationsService,
    private readonly eventService: MediaEventService,
  ) {
    this.logger.log('Queue Manager initialized');
  }

  /**
   * Lifecycle hook - called when the module is being destroyed
   * Clears all queues on application shutdown
   */
  onModuleDestroy() {
    this.logger.log('Queue Manager shutting down - clearing all queues');

    // Mark all pending and processing jobs as failed
    const allJobs = [
      ...Array.from(this.batchJobs.values()),
      ...Array.from(this.analysisJobs.values())
    ];

    for (const job of allJobs) {
      if (job.status === 'pending' || job.status === 'processing') {
        job.status = 'failed';
        job.error = 'Application shutdown - job cancelled';
        this.logger.log(`Cancelled job ${job.id} due to shutdown`);
      }
    }

    // Clear the queues
    this.batchJobs.clear();
    this.analysisJobs.clear();

    // Reset processing flags
    this.batchProcessing = false;
    this.analysisProcessing = false;

    this.logger.log('All queues cleared on shutdown');
  }

  /**
   * Add a job to a queue
   */
  addJob(job: Omit<QueueJob, 'id' | 'createdAt' | 'status' | 'progress' | 'currentPhase' | 'currentTaskIndex'>): string {
    const jobId = uuidv4();

    const fullJob: QueueJob = {
      ...job,
      id: jobId,
      status: 'pending',
      progress: 0,
      currentPhase: 'Waiting in queue...',
      currentTaskIndex: 0,
      createdAt: new Date(),
    };

    if (job.queueType === 'batch') {
      this.batchJobs.set(jobId, fullJob);
      this.logger.log(`Added job ${jobId} to batch queue`);
      this.emitQueueStatus('batch');
      // Start processing if not already running
      setImmediate(() => this.processBatchQueue());
    } else {
      this.analysisJobs.set(jobId, fullJob);
      this.logger.log(`Added job ${jobId} to analysis queue`);
      this.emitQueueStatus('analysis');
      // Start processing if not already running
      setImmediate(() => this.processAnalysisQueue());
    }

    return jobId;
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): QueueJob | undefined {
    return this.batchJobs.get(jobId) || this.analysisJobs.get(jobId);
  }

  /**
   * Get all jobs in a queue
   */
  getAllJobs(queueType: 'batch' | 'analysis'): QueueJob[] {
    const jobs = queueType === 'batch' ? this.batchJobs : this.analysisJobs;
    return Array.from(jobs.values());
  }

  /**
   * Delete a job
   */
  deleteJob(jobId: string): boolean {
    const deleted = this.batchJobs.delete(jobId) || this.analysisJobs.delete(jobId);
    if (deleted) {
      this.logger.log(`Deleted job ${jobId}`);
      this.emitQueueStatus('batch');
      this.emitQueueStatus('analysis');
    }
    return deleted;
  }

  /**
   * Cancel a job
   */
  cancelJob(jobId: string): boolean {
    const job = this.getJob(jobId);
    if (!job || job.status === 'completed' || job.status === 'failed') {
      return false;
    }

    job.status = 'cancelled';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();

    this.emitQueueStatus(job.queueType);
    return true;
  }

  /**
   * Clear completed/failed jobs
   */
  clearCompletedJobs(queueType: 'batch' | 'analysis'): void {
    const jobs = queueType === 'batch' ? this.batchJobs : this.analysisJobs;

    for (const [jobId, job] of jobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        jobs.delete(jobId);
      }
    }

    this.emitQueueStatus(queueType);
  }

  /**
   * Get queue status
   */
  getQueueStatus(queueType: 'batch' | 'analysis'): QueueStatus {
    const jobs = Array.from((queueType === 'batch' ? this.batchJobs : this.analysisJobs).values());

    const pendingJobs = jobs.filter(j => j.status === 'pending');
    const processingJobs = jobs.filter(j => j.status === 'processing');
    const completedJobs = jobs.filter(j => j.status === 'completed');
    const failedJobs = jobs.filter(j => j.status === 'failed');

    return {
      queueType,
      pendingJobs,
      processingJobs,
      completedJobs,
      failedJobs,
      activeJobCount: processingJobs.length,
      maxConcurrency: queueType === 'batch' ? this.BATCH_MAX_CONCURRENCY : this.ANALYSIS_MAX_CONCURRENCY,
    };
  }

  /**
   * Process batch queue (high concurrency)
   */
  private async processBatchQueue(): Promise<void> {
    if (this.batchProcessing) {
      return; // Already processing
    }

    this.batchProcessing = true;

    try {
      while (true) {
        const pendingJobs = Array.from(this.batchJobs.values())
          .filter(j => j.status === 'pending');

        if (pendingJobs.length === 0) {
          break; // No more pending jobs
        }

        const processingJobs = Array.from(this.batchJobs.values())
          .filter(j => j.status === 'processing');

        const availableSlots = this.BATCH_MAX_CONCURRENCY - processingJobs.length;

        if (availableSlots <= 0) {
          break; // Queue is full, wait for jobs to complete
        }

        // Start processing multiple jobs in parallel
        const jobsToStart = pendingJobs.slice(0, availableSlots);

        for (const job of jobsToStart) {
          this.processJob(job).catch(error => {
            this.logger.error(`Job ${job.id} failed: ${error.message}`);
          });
        }

        // Wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      this.batchProcessing = false;
    }
  }

  /**
   * Process analysis queue (sequential, one at a time)
   */
  private async processAnalysisQueue(): Promise<void> {
    if (this.analysisProcessing) {
      return; // Already processing
    }

    this.analysisProcessing = true;

    try {
      while (true) {
        const pendingJobs = Array.from(this.analysisJobs.values())
          .filter(j => j.status === 'pending')
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        if (pendingJobs.length === 0) {
          break; // No more pending jobs
        }

        const processingJobs = Array.from(this.analysisJobs.values())
          .filter(j => j.status === 'processing');

        if (processingJobs.length >= this.ANALYSIS_MAX_CONCURRENCY) {
          break; // Queue is full (1 job at a time)
        }

        // Process next job
        const job = pendingJobs[0];
        await this.processJob(job);
      }
    } finally {
      this.analysisProcessing = false;
    }
  }

  /**
   * Process a single job by executing its tasks sequentially
   */
  private async processJob(job: QueueJob): Promise<void> {
    this.logger.log(`Starting job ${job.id} (${job.queueType} queue)`);

    job.status = 'processing';
    job.startedAt = new Date();
    job.currentTaskIndex = 0;
    this.emitQueueStatus(job.queueType);

    try {
      // Execute each task sequentially
      for (let i = 0; i < job.tasks.length; i++) {
        job.currentTaskIndex = i;
        const task = job.tasks[i];

        this.logger.log(`Job ${job.id}: Executing task ${i + 1}/${job.tasks.length} (${task.type})`);

        job.currentPhase = `${task.type} (${i + 1}/${job.tasks.length})`;
        this.emitQueueStatus(job.queueType);

        const result = await this.executeTask(job, task);

        if (!result.success) {
          throw new Error(result.error || `Task ${task.type} failed`);
        }

        // Update progress
        job.progress = Math.round(((i + 1) / job.tasks.length) * 100);
        this.emitQueueStatus(job.queueType);
      }

      // All tasks completed successfully
      job.status = 'completed';
      job.progress = 100;
      job.currentPhase = 'Completed';
      job.completedAt = new Date();

      this.logger.log(`Job ${job.id} completed successfully`);
      this.emitQueueStatus(job.queueType);

      // Continue processing the queue
      if (job.queueType === 'batch') {
        setImmediate(() => this.processBatchQueue());
      } else {
        setImmediate(() => this.processAnalysisQueue());
      }

    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.completedAt = new Date();

      this.logger.error(`Job ${job.id} failed: ${job.error}`);
      this.emitQueueStatus(job.queueType);

      // Continue processing the queue
      if (job.queueType === 'batch') {
        setImmediate(() => this.processBatchQueue());
      } else {
        setImmediate(() => this.processAnalysisQueue());
      }
    }
  }

  /**
   * Execute a single task and update job context
   */
  private async executeTask(job: QueueJob, task: Task): Promise<TaskResult> {
    let result: TaskResult;

    switch (task.type) {
      case 'get-info':
        if (!job.url) {
          return { success: false, error: 'No URL provided for get-info task' };
        }
        result = await this.mediaOps.getVideoInfo(job.url, job.id);
        if (result.success && result.data) {
          job.videoInfo = result.data;
          job.displayName = job.displayName || result.data.title;
        }
        break;

      case 'download':
        if (!job.url) {
          return { success: false, error: 'No URL provided for download task' };
        }
        result = await this.mediaOps.downloadVideo(
          job.url,
          {
            ...task.options,
            displayName: job.displayName,
          },
          job.id,
        );
        if (result.success && result.data) {
          job.videoPath = result.data.videoPath;
          job.displayName = job.displayName || result.data.title;
        }
        break;

      case 'import':
        if (!job.videoPath) {
          return { success: false, error: 'No video path available for import task' };
        }
        result = await this.mediaOps.importToLibrary(job.videoPath, task.options, job.id);
        if (result.success && result.data) {
          job.videoId = result.data.videoId;
        }
        break;

      case 'fix-aspect-ratio':
        if (!job.videoId && !job.videoPath) {
          return { success: false, error: 'No video ID or path available for fix-aspect-ratio task' };
        }
        result = await this.mediaOps.fixAspectRatio(job.videoId || job.videoPath!, task.options, job.id);
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        break;

      case 'normalize-audio':
        if (!job.videoId && !job.videoPath) {
          return { success: false, error: 'No video ID or path available for normalize-audio task' };
        }
        result = await this.mediaOps.normalizeAudio(job.videoId || job.videoPath!, task.options, job.id);
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        break;

      case 'process-video':
        if (!job.videoId && !job.videoPath) {
          return { success: false, error: 'No video ID or path available for process-video task' };
        }
        result = await this.mediaOps.processVideo(job.videoId || job.videoPath!, task.options, job.id);
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        break;

      case 'transcribe':
        if (!job.videoId && !job.videoPath) {
          return { success: false, error: 'No video ID or path available for transcribe task' };
        }
        result = await this.mediaOps.transcribeVideo(job.videoId || job.videoPath!, task.options, job.id);
        if (result.success && result.data) {
          job.transcriptPath = result.data.transcriptPath;
        }
        break;

      case 'analyze':
        if (!job.videoId) {
          return { success: false, error: 'No video ID available for analyze task' };
        }
        if (!task.options || !task.options.aiModel) {
          return { success: false, error: 'AI model is required for analyze task' };
        }
        result = await this.mediaOps.analyzeVideo(job.videoId, task.options as any, job.id);
        if (result.success && result.data) {
          job.analysisPath = result.data.analysisPath;
        }
        break;

      default:
        return { success: false, error: `Unknown task type: ${(task as any).type}` };
    }

    return result;
  }

  /**
   * Emit queue status update
   */
  private emitQueueStatus(queueType: 'batch' | 'analysis'): void {
    const status = this.getQueueStatus(queueType);
    this.eventService.emitQueueStatusUpdated(queueType, status);
  }
}
