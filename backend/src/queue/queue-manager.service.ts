// Queue Manager Service - Executes task-based jobs with configurable concurrency

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaEventService } from '../media/media-event.service';
import { MediaOperationsService } from '../media/media-operations.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { DatabaseService } from '../database/database.service';
import {
  QueueJob,
  QueueStatus,
  Task,
  TaskResult,
} from '../common/interfaces/task.interface';
import { v4 as uuidv4 } from 'uuid';

// Active task tracking
export interface ActiveTask {
  taskId: string;
  jobId: string;
  taskIndex: number;
  type: string;
  pool: 'main' | 'ai';
  progress: number;
  message: string;
  startedAt: Date;
  lastProgressAt: Date;  // Track when we last received progress update
}

@Injectable()
export class QueueManagerService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(QueueManagerService.name);

  // Unified job queue (no more separate batch/analysis queues)
  private jobQueue = new Map<string, QueueJob>();

  // Track cancelled job IDs for in-flight task cancellation
  private cancelledJobs = new Set<string>();

  // Task pools - tracks actively running tasks
  private mainPool = new Map<string, ActiveTask>();  // Max 5 concurrent
  private aiPool: ActiveTask | null = null;           // Max 1 concurrent

  // Queue processing state
  private processing = false;

  // Watchdog timer for detecting stuck tasks
  private watchdogInterval: NodeJS.Timeout | null = null;
  private readonly WATCHDOG_INTERVAL_MS = 60000;  // Check every minute
  private readonly AI_TASK_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes for AI tasks
  private readonly MAIN_TASK_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes for other tasks

  // Concurrency limits (5+1 model)
  private readonly MAX_MAIN_CONCURRENT = 5;  // 5 general tasks
  private readonly MAX_AI_CONCURRENT = 1;     // 1 AI task

  constructor(
    private readonly mediaOps: MediaOperationsService,
    private readonly eventService: MediaEventService,
    private readonly libraryManager: LibraryManagerService,
    private readonly databaseService: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Lifecycle hook - called when the module is initialized
   * Starts the watchdog timer to detect stuck tasks
   */
  onModuleInit() {
    this.startWatchdog();
  }

  /**
   * Start the watchdog timer
   */
  private startWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }

    this.watchdogInterval = setInterval(() => {
      this.checkForStuckTasks();
    }, this.WATCHDOG_INTERVAL_MS);

    this.logger.log('Watchdog started - will check for stuck tasks every minute');
  }

  /**
   * Check for tasks that have been running too long
   */
  private checkForStuckTasks() {
    const now = new Date();

    // Check AI pool
    if (this.aiPool) {
      const runningMs = now.getTime() - this.aiPool.startedAt.getTime();
      const lastProgressMs = now.getTime() - this.aiPool.lastProgressAt.getTime();

      if (runningMs > this.AI_TASK_TIMEOUT_MS) {
        this.logger.warn(
          `⚠️ AI task ${this.aiPool.taskId} has been running for ${Math.round(runningMs / 60000)} minutes ` +
          `(last progress: ${Math.round(lastProgressMs / 1000)}s ago at ${this.aiPool.progress}%)`
        );
      } else if (lastProgressMs > 5 * 60 * 1000) {  // 5 minutes without progress
        this.logger.warn(
          `⚠️ AI task ${this.aiPool.taskId} hasn't reported progress in ${Math.round(lastProgressMs / 60000)} minutes ` +
          `(stuck at ${this.aiPool.progress}%)`
        );
      }
    }

    // Check main pool
    for (const [taskId, task] of this.mainPool.entries()) {
      const runningMs = now.getTime() - task.startedAt.getTime();
      const lastProgressMs = now.getTime() - task.lastProgressAt.getTime();

      if (runningMs > this.MAIN_TASK_TIMEOUT_MS) {
        this.logger.warn(
          `⚠️ Main task ${taskId} (${task.type}) has been running for ${Math.round(runningMs / 60000)} minutes ` +
          `(last progress: ${Math.round(lastProgressMs / 1000)}s ago at ${task.progress}%)`
        );
      }
    }
  }

  /**
   * Update progress for an active task (called by event handlers)
   */
  updateTaskProgress(jobId: string, progress: number, message?: string): void {
    // Update AI pool if matching
    if (this.aiPool?.jobId === jobId) {
      this.aiPool.progress = progress;
      this.aiPool.lastProgressAt = new Date();
      if (message) this.aiPool.message = message;
    }

    // Update main pool if matching
    const mainTask = this.mainPool.get(jobId);
    if (mainTask) {
      mainTask.progress = progress;
      mainTask.lastProgressAt = new Date();
      if (message) mainTask.message = message;
    }
  }

  /**
   * Calculate the nearest Sunday date folder name
   * Returns date in YYYY-MM-DD format
   */
  private calculateSundayFolder(date: Date = new Date()): string {
    const d = new Date(date);
    const dayOfWeek = d.getDay(); // 0 = Sunday
    const sunday = new Date(d);
    sunday.setDate(d.getDate() - dayOfWeek);

    // Format as YYYY-MM-DD
    return sunday.toISOString().split('T')[0];
  }

  /**
   * Get the output directory for a download job
   * If libraryId is specified, uses that library's clips folder
   * Otherwise uses active library or falls back to default
   * Note: The downloader service already adds a Sunday subfolder
   */
  private getDownloadOutputDir(libraryId?: string): string | undefined {
    // Get the target library
    let library;
    if (libraryId) {
      const allLibraries = this.libraryManager.getAllLibraries();
      library = allLibraries.find(lib => lib.id === libraryId);
    } else {
      library = this.libraryManager.getActiveLibrary();
    }

    if (!library) {
      this.logger.warn('No library found for download output directory');
      return undefined;
    }

    // Return the library's clips folder path
    // The downloader service will add the Sunday subfolder automatically
    return library.clipsFolderPath;
  }

  /**
   * Lifecycle hook - called when the module is being destroyed
   * Clears all queues on application shutdown
   */
  onModuleDestroy() {
    // Stop the watchdog
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }

    // Mark all pending and processing jobs as failed
    for (const job of this.jobQueue.values()) {
      if (job.status === 'pending' || job.status === 'processing') {
        job.status = 'failed';
        job.error = 'Application shutdown - job cancelled';
      }
    }

    // Clear the queue and pools
    this.jobQueue.clear();
    this.mainPool.clear();
    this.aiPool = null;

    // Reset processing flag
    this.processing = false;
  }

  /**
   * Add a job to the queue
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

    // Add to unified queue
    this.jobQueue.set(jobId, fullJob);

    // Start processing if not already running
    setImmediate(() => this.processQueue());

    this.logger.log(`Added job ${jobId} with ${job.tasks.length} tasks`);

    return jobId;
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): QueueJob | undefined {
    return this.jobQueue.get(jobId);
  }

  /**
   * Get all jobs in the queue
   */
  getAllJobs(): QueueJob[] {
    return Array.from(this.jobQueue.values());
  }

  /**
   * Get main pool status (for API/monitoring)
   */
  getMainPool(): Map<string, ActiveTask> {
    return this.mainPool;
  }

  /**
   * Get AI pool status (for API/monitoring)
   */
  getAIPool(): ActiveTask | null {
    return this.aiPool;
  }

  /**
   * Delete a job
   */
  deleteJob(jobId: string): boolean {
    const deleted = this.jobQueue.delete(jobId);
    if (deleted) {
      this.logger.log(`Deleted job ${jobId}`);
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

    // Add to cancelled set so running tasks can check
    this.cancelledJobs.add(jobId);

    job.status = 'cancelled';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();

    // Remove from pools if active
    this.mainPool.delete(jobId);
    if (this.aiPool?.jobId === jobId) {
      this.aiPool = null;
    }

    this.logger.log(`Cancelled job ${jobId}`);

    // Emit cancellation event
    this.eventService.emit('job.cancelled', {
      jobId,
      videoId: job.videoId,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  /**
   * Check if a job has been cancelled
   */
  isJobCancelled(jobId: string): boolean {
    return this.cancelledJobs.has(jobId);
  }

  /**
   * Clear completed/failed jobs
   */
  clearCompletedJobs(): void {
    for (const [jobId, job] of this.jobQueue.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        this.jobQueue.delete(jobId);
      }
    }

    this.logger.log('Cleared completed/failed jobs');
  }

  /**
   * Get unified queue status
   */
  getQueueStatus() {
    const jobs = Array.from(this.jobQueue.values());

    return {
      mainPool: {
        active: this.mainPool.size,
        maxConcurrent: this.MAX_MAIN_CONCURRENT,
        tasks: Array.from(this.mainPool.values()),
      },
      aiPool: {
        active: this.aiPool ? 1 : 0,
        maxConcurrent: this.MAX_AI_CONCURRENT,
        task: this.aiPool,
      },
      queue: {
        total: jobs.length,
        pending: jobs.filter(j => j.status === 'pending').length,
        processing: jobs.filter(j => j.status === 'processing').length,
        completed: jobs.filter(j => j.status === 'completed').length,
        failed: jobs.filter(j => j.status === 'failed').length,
      },
    };
  }


  /**
   * Unified queue processing with 5+1 pool model
   * Main loop that fills both pools with tasks
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return; // Already processing
    }

    this.processing = true;

    try {
      while (true) {
        // Fill main pool (up to 5 concurrent tasks)
        while (this.mainPool.size < this.MAX_MAIN_CONCURRENT) {
          const nextTask = this.getNextMainTask();
          if (!nextTask) break;

          // Execute task without awaiting (parallel execution)
          this.executeTask(nextTask, 'main').catch(err => {
            this.logger.error(`Main pool task failed: \${err.message}`);
          });
        }

        // Fill AI pool (up to 1 concurrent task)
        if (!this.aiPool) {
          const nextTask = this.getNextAITask();
          if (nextTask) {
            // Execute task without awaiting (parallel execution)
            this.executeTask(nextTask, 'ai').catch(err => {
              this.logger.error(`AI pool task failed: \${err.message}`);
            });
          }
        }

        // Check if queue is empty and all pools are empty
        if (this.jobQueue.size === 0 && this.mainPool.size === 0 && !this.aiPool) {
          break; // Nothing left to do
        }

        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get next non-AI task from any job
   */
  private getNextMainTask(): { task: Task; job: QueueJob } | null {
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      if (!currentTask) continue;

      // Skip if this task is already running
      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

      // Check if any previous task in this job is still running
      // Tasks must be sequential within a job
      let previousTaskRunning = false;
      for (let i = 0; i < job.currentTaskIndex; i++) {
        if (this.isTaskRunning(job.id, i)) {
          previousTaskRunning = true;
          break;
        }
      }
      if (previousTaskRunning) {
        continue; // Wait for previous tasks to complete
      }

      // Only return non-AI tasks
      if (currentTask.type !== 'analyze') {
        return { task: currentTask, job };
      }
    }
    return null;
  }

  /**
   * Get next AI task from any job
   */
  private getNextAITask(): { task: Task; job: QueueJob } | null {
    this.logger.debug(`getNextAITask: Checking ${this.jobQueue.size} jobs`);
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      this.logger.debug(`getNextAITask: Job ${job.id} currentTaskIndex=${job.currentTaskIndex}, task=${currentTask?.type}`);
      if (!currentTask) continue;

      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

      // Only return AI tasks
      if (currentTask.type === 'analyze') {
        this.logger.log(`getNextAITask: Found analyze task for job ${job.id}`);
        // Check if any previous task in this job is still running
        // Tasks must be sequential within a job
        let previousTaskRunning = false;
        for (let i = 0; i < job.currentTaskIndex; i++) {
          if (this.isTaskRunning(job.id, i)) {
            previousTaskRunning = true;
            break;
          }
        }

        if (previousTaskRunning) {
          continue; // Wait for previous tasks to complete
        }

        return { task: currentTask, job };
      }
    }
    return null;
  }

  /**
   * Check if a specific task is already running
   */
  private isTaskRunning(jobId: string, taskIndex: number): boolean {
    // Check main pool
    for (const activeTask of this.mainPool.values()) {
      if (activeTask.jobId === jobId && activeTask.taskIndex === taskIndex) {
        return true;
      }
    }

    // Check AI pool
    if (this.aiPool?.jobId === jobId && this.aiPool.taskIndex === taskIndex) {
      return true;
    }

    return false;
  }

  /**
   * Execute a task in the appropriate pool
   */
  private async executeTask(
    { task, job }: { task: Task; job: QueueJob },
    pool: 'main' | 'ai',
  ): Promise<void> {
    // Check if job was cancelled before starting
    if (this.isJobCancelled(job.id)) {
      this.logger.log(`Job ${job.id} was cancelled, skipping task ${task.type}`);
      // Clean up cancelled job from set after acknowledging
      this.cancelledJobs.delete(job.id);
      setImmediate(() => this.processQueue());
      return;
    }

    // Use job.id for progress tracking so frontend can map it correctly
    const taskId = job.id;
    const now = new Date();
    const activeTask: ActiveTask = {
      taskId,
      jobId: job.id,
      taskIndex: job.currentTaskIndex,
      type: task.type,
      pool,
      progress: 0,
      message: 'Starting...',
      startedAt: now,
      lastProgressAt: now,
    };

    // Add to appropriate pool
    if (pool === 'main') {
      this.mainPool.set(taskId, activeTask);
    } else {
      this.aiPool = activeTask;
    }

    // Update job status
    if (job.status === 'pending') {
      job.status = 'processing';
      job.startedAt = new Date();
    }

    job.currentPhase = `\${task.type} (\${job.currentTaskIndex + 1}/\${job.tasks.length})`;

    this.logger.log(
      `[\${pool.toUpperCase()} POOL] Starting task \${taskId}: \${task.type} for job \${job.id}`,
    );

    // Emit task started event (will be added in Step 5)
    this.eventService.emit('task.started', {
      taskId,
      jobId: job.id,
      videoId: job.videoId,
      type: task.type,
      pool,
      timestamp: new Date().toISOString(),
    });

    try {
      // Execute the task
      const result = await this.executeTaskLogic(job, task, taskId);

      // Check if job was cancelled during execution
      if (this.isJobCancelled(job.id)) {
        this.logger.log(`Job ${job.id} was cancelled during ${task.type} execution`);
        this.cancelledJobs.delete(job.id);
        // Don't process results - just clean up and return
        return;
      }

      if (!result.success) {
        throw new Error(result.error || 'Task failed');
      }

      // Update last_processed_date for tasks that process the video
      // (not for get-info or download which don't have a video ID yet)
      const processingTasks = ['import', 'transcribe', 'analyze', 'fix-aspect-ratio', 'normalize-audio', 'process-video'];
      if (job.videoId && processingTasks.includes(task.type)) {
        try {
          this.databaseService.updateLastProcessedDate(job.videoId);
        } catch (err) {
          this.logger.warn(`Failed to update last_processed_date for video ${job.videoId}: ${err}`);
        }
      }

      // Emit task completed event
      this.eventService.emit('task.completed', {
        taskId,
        jobId: job.id,
        videoId: job.videoId,
        type: task.type,
        result: result.data,
        duration: (Date.now() - activeTask.startedAt.getTime()) / 1000,
        timestamp: new Date().toISOString(),
      });

      // Move to next task in job
      job.currentTaskIndex++;
      job.progress = Math.round((job.currentTaskIndex / job.tasks.length) * 100);

      // Check if job is complete
      if (job.currentTaskIndex >= job.tasks.length) {
        job.status = 'completed';
        job.progress = 100;
        job.currentPhase = 'Completed';
        job.completedAt = new Date();

        this.logger.log(`Job ${job.id} completed successfully`);

        // Emit job completed event for saved-links and other listeners (via EventEmitter2)
        const eventData = {
          jobId: job.id,
          status: 'completed',
          downloadedPath: job.videoPath,
        };
        this.logger.log(`Emitting job.completed event: ${JSON.stringify(eventData)}`);
        this.eventEmitter.emit('job.completed', eventData);

        // Remove from queue after a delay
        setTimeout(() => this.jobQueue.delete(job.id), 5000);
      }
    } catch (error) {
      // Task failed
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.completedAt = new Date();

      this.logger.error(`Task \${taskId} failed: \${job.error}`);

      // Emit task failed event
      this.eventService.emit('task.failed', {
        taskId,
        jobId: job.id,
        videoId: job.videoId,
        type: task.type,
        error: {
          code: 'TASK_FAILED',
          message: job.error,
        },
        canRetry: false,
        timestamp: new Date().toISOString(),
      });

      // Remove failed job from queue after a delay (like completed jobs)
      // This ensures the UI can show the failure state before removal
      setTimeout(() => {
        this.jobQueue.delete(job.id);
        this.logger.log(`Removed failed job \${job.id} from queue`);
      }, 5000);
    } finally {
      // Remove from pool
      if (pool === 'main') {
        this.mainPool.delete(taskId);
      } else {
        this.aiPool = null;
      }

      // Continue processing
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Execute task logic and update database flags
   */
  private async executeTaskLogic(
    job: QueueJob,
    task: Task,
    taskId: string,
  ): Promise<TaskResult> {
    let result: TaskResult;

    switch (task.type) {
      case 'get-info':
        if (!job.url) {
          return { success: false, error: 'No URL provided for get-info task' };
        }
        result = await this.mediaOps.getVideoInfo(job.url, taskId);
        if (result.success && result.data) {
          job.videoInfo = result.data;
          job.displayName = job.displayName || result.data.title;
        }
        break;

      case 'download':
        if (!job.url) {
          return { success: false, error: 'No URL provided for download task' };
        }

        // Determine output directory based on library
        const outputDir = this.getDownloadOutputDir(job.libraryId);
        if (outputDir) {
          this.logger.log(`[${taskId}] Download output directory: ${outputDir}`);
        }

        result = await this.mediaOps.downloadVideo(
          job.url,
          {
            ...task.options,
            displayName: job.displayName,
            outputDir: outputDir,
          },
          taskId,
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

        // Switch to target library if specified (import uses active library)
        if (job.libraryId) {
          const currentLibrary = this.libraryManager.getActiveLibrary();
          if (!currentLibrary || currentLibrary.id !== job.libraryId) {
            this.logger.log(`[${taskId}] Switching to target library: ${job.libraryId}`);
            await this.libraryManager.switchLibrary(job.libraryId);
          }
        }

        result = await this.mediaOps.importToLibrary(job.videoPath, task.options, taskId);
        if (result.success && result.data) {
          job.videoId = result.data.videoId;
        }
        break;

      case 'fix-aspect-ratio':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for fix-aspect-ratio task',
          };
        }
        result = await this.mediaOps.fixAspectRatio(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        // UPDATE DATABASE FLAG
        if (result.success && job.videoId) {
          try {
            await this.mediaOps.setVideoFlag(job.videoId, 'aspect_ratio_fixed', 1);
          } catch (error) {
            this.logger.warn(
              `Failed to update aspect_ratio_fixed flag: \${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
        break;

      case 'normalize-audio':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for normalize-audio task',
          };
        }
        result = await this.mediaOps.normalizeAudio(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        // UPDATE DATABASE FLAG
        if (result.success && job.videoId) {
          try {
            await this.mediaOps.setVideoFlag(job.videoId, 'audio_normalized', 1);
          } catch (error) {
            this.logger.warn(
              `Failed to update audio_normalized flag: \${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
        break;

      case 'process-video':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for process-video task',
          };
        }
        result = await this.mediaOps.processVideo(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data && result.data.outputPath) {
          job.videoPath = result.data.outputPath;
        }
        // UPDATE DATABASE FLAGS based on what was processed
        if (result.success && job.videoId && task.options) {
          try {
            if (task.options.fixAspectRatio) {
              await this.mediaOps.setVideoFlag(job.videoId, 'aspect_ratio_fixed', 1);
            }
            if (task.options.normalizeAudio) {
              await this.mediaOps.setVideoFlag(job.videoId, 'audio_normalized', 1);
            }
          } catch (error) {
            this.logger.warn(
              `Failed to update video flags: \${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
        break;

      case 'transcribe':
        if (!job.videoId && !job.videoPath) {
          return { success: false, error: 'No video ID or path available for transcribe task' };
        }
        result = await this.mediaOps.transcribeVideo(
          job.videoId || job.videoPath!,
          task.options,
          taskId,
        );
        if (result.success && result.data) {
          job.transcriptPath = result.data.transcriptPath;
        }
        // Note: has_transcript flag is automatically set by database trigger
        break;

      case 'analyze':
        if (!job.videoId) {
          return { success: false, error: 'No video ID available for analyze task' };
        }
        if (!task.options || !task.options.aiModel) {
          return { success: false, error: 'AI model is required for analyze task' };
        }
        result = await this.mediaOps.analyzeVideo(job.videoId, task.options as any, taskId);
        if (result.success && result.data) {
          job.analysisPath = result.data.analysisPath;
        }
        // Note: has_analysis flag is automatically set by database trigger
        break;

      default:
        return { success: false, error: `Unknown task type: \${(task as any).type}` };
    }

    return result;
  }
}
