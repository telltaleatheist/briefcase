// Queue Manager Service - Executes task-based jobs with configurable concurrency

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaEventService } from '../media/media-event.service';
import { MediaOperationsService } from '../media/media-operations.service';
import { LibraryManagerService } from '../database/library-manager.service';
import { DatabaseService } from '../database/database.service';
import { FileScannerService } from '../database/file-scanner.service';
import { ClipExtractorService } from '../library/clip-extractor.service';
import { LibraryService } from '../library/library.service';
import {
  QueueJob,
  QueueStatus,
  Task,
  TaskResult,
} from '../common/interfaces/task.interface';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    private readonly clipExtractor: ClipExtractorService,
    private readonly fileScannerService: FileScannerService,
    private readonly libraryService: LibraryService,
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
   * Mon-Wed go back to previous Sunday, Thu-Sat go forward to next Sunday.
   * Returns date in YYYY-MM-DD format
   */
  private getNearestSunday(date: Date = new Date()): string {
    const d = new Date(date);
    const dayOfWeek = d.getDay(); // 0 = Sunday
    const sundayDate = new Date(d);

    if (dayOfWeek === 0) {
      // Already Sunday, use current day
    } else if (dayOfWeek <= 3) {
      // Monday-Wednesday: go back to previous Sunday
      sundayDate.setDate(d.getDate() - dayOfWeek);
    } else {
      // Thursday-Saturday: go forward to next Sunday
      sundayDate.setDate(d.getDate() + (7 - dayOfWeek));
    }

    const year = sundayDate.getFullYear();
    const month = String(sundayDate.getMonth() + 1).padStart(2, '0');
    const day = String(sundayDate.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
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
  addJob(job: Omit<QueueJob, 'id' | 'createdAt' | 'status' | 'progress' | 'currentPhase' | 'currentTaskIndex'>, options?: { paused?: boolean }): string {
    const jobId = uuidv4();
    const paused = options?.paused ?? false;

    const fullJob: QueueJob = {
      ...job,
      id: jobId,
      status: paused ? 'paused' : 'pending',
      progress: 0,
      currentPhase: paused ? 'Paused — waiting to start' : 'Waiting in queue...',
      currentTaskIndex: 0,
      createdAt: new Date(),
    };

    // Add to unified queue
    this.jobQueue.set(jobId, fullJob);

    // Start processing if not already running (skip if paused)
    if (!paused) {
      setImmediate(() => this.processQueue());
    }

    this.logger.log(`Added job ${jobId} with ${job.tasks.length} tasks${paused ? ' (paused)' : ''}`);

    return jobId;
  }

  /**
   * Start one or more paused jobs — sets status to 'pending' and kicks the queue
   */
  startJobs(jobIds: string[]): number {
    let startedCount = 0;
    for (const jobId of jobIds) {
      const job = this.jobQueue.get(jobId);
      if (job && job.status === 'paused') {
        job.status = 'pending';
        job.currentPhase = 'Waiting in queue...';
        startedCount++;
        this.logger.log(`Started paused job ${jobId}`);
      }
    }
    if (startedCount > 0) {
      setImmediate(() => this.processQueue());
    }
    return startedCount;
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
        paused: jobs.filter(j => j.status === 'paused').length,
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
      if (currentTask.type !== 'analyze' && currentTask.type !== 'analyze-webpage') {
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
      if (currentTask.type === 'analyze' || currentTask.type === 'analyze-webpage') {
        this.logger.log(`getNextAITask: Found ${currentTask.type} task for job ${job.id}`);
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
      const processingTasks = ['import', 'transcribe', 'analyze', 'analyze-webpage', 'fix-aspect-ratio', 'normalize-audio', 'process-video'];
      if (job.videoId && processingTasks.includes(task.type)) {
        try {
          this.databaseService.updateLastProcessedDate(job.videoId);
        } catch (err) {
          this.logger.warn(`Failed to update last_processed_date for video ${job.videoId}: ${err}`);
        }
      }

      // Regenerate thumbnail after file-modifying tasks
      const thumbnailRegenTasks = ['fix-aspect-ratio', 'normalize-audio', 'process-video'];
      if (job.videoId && thumbnailRegenTasks.includes(task.type) && job.videoPath) {
        await this.mediaOps.regenerateThumbnail(job.videoId, job.videoPath);
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

        // Check for duplicate: does a video with this source URL already exist?
        const existingVideo = this.databaseService.findVideoByUrl(job.url);
        if (existingVideo && existingVideo.current_path) {
          const existingPath = existingVideo.current_path;
          const fileExists = fs.existsSync(existingPath);

          if (fileExists) {
            this.logger.log(`[${taskId}] Duplicate detected: video with URL "${job.url}" already exists at "${existingPath}" (id: ${existingVideo.id})`);

            // Use existing file path and video ID - skip actual download
            job.videoPath = existingPath;
            job.videoId = existingVideo.id;
            job.displayName = job.displayName || existingVideo.filename;

            // Update download_date to current so it appears recent
            this.databaseService.updateVideoMetadata(
              existingVideo.id,
              undefined,  // uploadDate
              new Date().toISOString(),  // downloadDate
            );

            // Mark remaining tasks that already have results as skippable
            // by setting videoId so import task can be skipped
            result = {
              success: true,
              data: {
                videoPath: existingPath,
                title: existingVideo.filename,
                duplicate: true,
                existingVideoId: existingVideo.id,
              },
            };
            break;
          } else {
            this.logger.log(`[${taskId}] Found DB entry for URL "${job.url}" but file missing at "${existingPath}" - proceeding with download`);
          }
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
        // If videoId is already set (e.g., from duplicate detection), skip import
        if (job.videoId) {
          this.logger.log(`[${taskId}] Skipping import - video already exists in library (id: ${job.videoId})`);
          result = { success: true, data: { videoId: job.videoId, skipped: true } };
          break;
        }

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
        // Skip if already fixed (duplicate detection)
        if (job.videoId) {
          const videoForAR = this.databaseService.findVideoById(job.videoId);
          if (videoForAR && videoForAR.aspect_ratio_fixed) {
            this.logger.log(`[${taskId}] Skipping fix-aspect-ratio - already fixed (id: ${job.videoId})`);
            result = { success: true, data: { skipped: true } };
            break;
          }
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
        // Skip if already normalized (duplicate detection)
        if (job.videoId) {
          const videoForAN = this.databaseService.findVideoById(job.videoId);
          if (videoForAN && videoForAN.audio_normalized) {
            this.logger.log(`[${taskId}] Skipping normalize-audio - already normalized (id: ${job.videoId})`);
            result = { success: true, data: { skipped: true } };
            break;
          }
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

        // Clear existing transcript if one exists (user explicitly queued a new transcription)
        if (job.videoId) {
          const existingTranscript = this.databaseService.getTranscript(job.videoId);
          if (existingTranscript) {
            this.logger.log(`[${taskId}] Clearing existing transcript before re-transcribing (id: ${job.videoId})`);
            this.databaseService.deleteTranscript(job.videoId);
          }
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

        // Always run analysis — if the video already has one, mediaOps.analyzeVideo
        // will clear it before re-running (via processAnalyzePhase cleanup logic)
        result = await this.mediaOps.analyzeVideo(job.videoId, task.options as any, taskId);
        if (result.success && result.data) {
          job.analysisPath = result.data.analysisPath;
        }
        // Note: has_analysis flag is automatically set by database trigger
        break;

      case 'analyze-webpage':
        if (!job.videoId) {
          return { success: false, error: 'No video ID available for analyze-webpage task' };
        }
        if (!task.options || !task.options.aiModel) {
          return { success: false, error: 'AI model is required for analyze-webpage task' };
        }
        result = await this.mediaOps.analyzeWebpage(job.videoId, task.options as any, taskId);
        break;

      case 'export-clip':
        result = await this.executeExportClip(job, task, taskId);
        break;

      default:
        return { success: false, error: `Unknown task type: \${(task as any).type}` };
    }

    return result;
  }

  /**
   * Execute export-clip task logic
   * Replicates the flow from LibraryController.extractClipFromPath() / overwriteVideoWithClip()
   */
  private async executeExportClip(
    job: QueueJob,
    task: Task,
    taskId: string,
  ): Promise<TaskResult> {
    const opts = task.options as any;

    // Fallback: resolve videoPath/videoId from the job context if not in task options
    // (e.g., trim-opener injects export-clip before videoPath is known at queue time)
    if (!opts.videoPath && job.videoPath) opts.videoPath = job.videoPath;
    if (!opts.videoId && job.videoId) opts.videoId = job.videoId;

    this.logger.log(`[EXPORT-CLIP] ========== Starting export-clip task ==========`);
    this.logger.log(`[EXPORT-CLIP] Job ID: ${job.id}`);
    this.logger.log(`[EXPORT-CLIP] Video path: ${opts?.videoPath}`);
    this.logger.log(`[EXPORT-CLIP] Time range: ${opts?.startTime} - ${opts?.endTime}`);
    this.logger.log(`[EXPORT-CLIP] Re-encode: ${opts?.reEncode}`);
    this.logger.log(`[EXPORT-CLIP] Quality: ${opts?.quality || 'medium'}`);
    this.logger.log(`[EXPORT-CLIP] Title: ${opts?.title || opts?.description || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Category: ${opts?.category || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Custom directory: ${opts?.customDirectory || '(default)'}`);
    this.logger.log(`[EXPORT-CLIP] Scale: ${opts?.scale || '1.0 (none)'}`);
    this.logger.log(`[EXPORT-CLIP] Mute sections: ${opts?.muteSections?.length || 0}`);
    this.logger.log(`[EXPORT-CLIP] Crop aspect ratio: ${opts?.cropAspectRatio || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Output suffix: ${opts?.outputSuffix || '(none)'}`);
    this.logger.log(`[EXPORT-CLIP] Overwrite mode: ${opts?.isOverwrite || false}`);

    if (!opts || !opts.videoPath) {
      this.logger.error(`[EXPORT-CLIP] FAILED: No videoPath provided`);
      return { success: false, error: 'No videoPath provided for export-clip task' };
    }

    if (!fs.existsSync(opts.videoPath)) {
      this.logger.error(`[EXPORT-CLIP] FAILED: Video file not found at ${opts.videoPath}`);
      return { success: false, error: `Video file not found: ${opts.videoPath}` };
    }

    // Overwrite mode: extract to temp, replace original, clear metadata
    if (opts.isOverwrite && opts.videoId) {
      this.logger.log(`[EXPORT-CLIP] Using OVERWRITE mode for video ${opts.videoId}`);
      return this.executeExportClipOverwrite(opts, taskId);
    }

    // Regular export mode
    this.logger.log(`[EXPORT-CLIP] Using regular export mode`);
    try {
      // Find parent video for linking
      let parentVideoId: string | undefined;
      try {
        const allVideos = this.databaseService.getAllVideos({ includeChildren: true });
        const clipsRoot = this.libraryService.getLibraryPaths().clipsDir;
        const normalizedVideoPath = path.normalize(opts.videoPath);

        const sourceVideo = allVideos.find((v: any) => {
          if (!v.current_path) return false;
          const dbAbsolutePath = this.databaseService.toAbsolutePath(String(v.current_path), clipsRoot);
          return path.normalize(dbAbsolutePath) === normalizedVideoPath;
        });

        if (sourceVideo && sourceVideo.id) {
          if (sourceVideo.parent_id) {
            parentVideoId = String(sourceVideo.parent_id);
            this.logger.log(`[EXPORT-CLIP] Source video is a child — linking to parent: ${parentVideoId}`);
          } else {
            parentVideoId = String(sourceVideo.id);
            this.logger.log(`[EXPORT-CLIP] Source video found — will link as child of: ${parentVideoId}`);
          }
        } else {
          this.logger.log(`[EXPORT-CLIP] No source video found in library for path`);
        }
      } catch (err) {
        this.logger.warn(`[EXPORT-CLIP] Could not find source video for linking: ${(err as Error).message}`);
      }

      // Generate clip filename
      const originalFilename = path.basename(opts.videoPath);
      const parentVideo = parentVideoId
        ? this.databaseService.getVideoById(parentVideoId)
        : null;

      const clipFilename = this.clipExtractor.generateClipFilename(
        originalFilename,
        opts.startTime,
        opts.endTime,
        opts.category,
        opts.description || opts.title,
        parentVideo?.upload_date ?? undefined,
      );
      this.logger.log(`[EXPORT-CLIP] Generated filename: ${clipFilename}`);

      // Determine output directory
      let outputDir: string;
      if (opts.customDirectory) {
        outputDir = opts.customDirectory.replace(/[\\/]+$/, '');
        this.logger.log(`[EXPORT-CLIP] Using custom output directory: ${outputDir}`);
      } else {
        const activeLibrary = this.libraryManager.getActiveLibrary();
        if (!activeLibrary) {
          this.logger.error(`[EXPORT-CLIP] FAILED: No active library`);
          return { success: false, error: 'No active library' };
        }
        const weekFolder = this.getNearestSunday(new Date());
        outputDir = path.join(activeLibrary.clipsFolderPath, weekFolder);
        this.logger.log(`[EXPORT-CLIP] Using weekly folder: ${outputDir}`);
      }

      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        this.logger.log(`[EXPORT-CLIP] Created output directory`);
      }

      const outputPath = path.join(outputDir, clipFilename);
      this.logger.log(`[EXPORT-CLIP] Full output path: ${outputPath}`);

      // Emit initial progress
      this.eventService.emitTaskProgress(taskId, 'export-clip', 0, 'Starting export...');
      this.updateTaskProgress(job.id, 0, 'Starting export...');
      this.logger.log(`[EXPORT-CLIP] Starting FFmpeg extraction (reEncode=${opts.reEncode})...`);

      // Extract the clip with progress
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: opts.videoPath,
        startTime: opts.startTime,
        endTime: opts.endTime,
        outputPath,
        reEncode: opts.reEncode,
        quality: opts.quality || 'medium',
        scale: opts.scale,
        cropAspectRatio: opts.cropAspectRatio,
        muteSections: opts.muteSections,
        outputSuffix: opts.outputSuffix,
        metadata: {
          title: opts.title,
          description: opts.description,
          category: opts.category,
        },
        onProgress: (progress: number) => {
          const message = `Exporting... ${progress}%`;
          this.eventService.emitTaskProgress(taskId, 'export-clip', progress, message);
          this.updateTaskProgress(job.id, progress, message);
        },
      });

      if (!extractionResult.success) {
        this.logger.error(`[EXPORT-CLIP] FFmpeg extraction FAILED: ${extractionResult.error}`);
        return { success: false, error: extractionResult.error || 'Failed to extract clip' };
      }

      const finalOutputPath = extractionResult.outputPath || outputPath;
      const fileSizeMB = extractionResult.fileSize ? (extractionResult.fileSize / 1024 / 1024).toFixed(2) : '?';
      this.logger.log(`[EXPORT-CLIP] Extraction complete: ${finalOutputPath}`);
      this.logger.log(`[EXPORT-CLIP] Duration: ${extractionResult.duration}s, Size: ${fileSizeMB} MB`);

      // Auto-import the clip into the library
      this.logger.log(`[EXPORT-CLIP] Auto-importing clip to library...`);
      try {
        const importResult = await this.fileScannerService.importVideos(
          [finalOutputPath],
          undefined,
          parentVideoId,
        );

        if (importResult.imported.length > 0) {
          const videoId = importResult.imported[0];
          this.databaseService.updateLastProcessedDate(videoId);
          this.logger.log(`[EXPORT-CLIP] Imported to library as video ID: ${videoId}${parentVideoId ? ` (child of ${parentVideoId})` : ''}`);
        } else {
          this.logger.warn(`[EXPORT-CLIP] Import returned no video IDs (skipped: ${importResult.skipped.length}, errors: ${importResult.errors.length})`);
        }
      } catch (importError) {
        this.logger.error(`[EXPORT-CLIP] Failed to import exported clip: ${(importError as Error).message}`);
      }

      this.eventService.emitTaskProgress(taskId, 'export-clip', 100, 'Export complete');
      this.updateTaskProgress(job.id, 100, 'Export complete');
      this.logger.log(`[EXPORT-CLIP] ========== Export complete ==========`);

      return {
        success: true,
        data: {
          outputPath: finalOutputPath,
          duration: extractionResult.duration,
          fileSize: extractionResult.fileSize,
        },
      };
    } catch (error) {
      this.logger.error(`[EXPORT-CLIP] Unexpected error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Handle overwrite mode for export-clip: extract to temp, replace original, clear metadata
   */
  private async executeExportClipOverwrite(
    opts: any,
    taskId: string,
  ): Promise<TaskResult> {
    try {
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Looking up video ${opts.videoId}...`);
      const video = this.databaseService.getVideoById(opts.videoId);
      if (!video) {
        this.logger.error(`[EXPORT-CLIP] [OVERWRITE] Video not found in database: ${opts.videoId}`);
        return { success: false, error: 'Video not found in database' };
      }

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Preserving original metadata`);
      // Store original metadata to preserve after overwrite
      const originalMetadata = {
        uploadDate: video.upload_date,
        downloadDate: video.download_date,
        addedAt: video.added_at,
        sourceUrl: video.source_url,
        aiDescription: video.ai_description,
        suggestedTitle: video.suggested_title,
      };

      this.eventService.emitTaskProgress(taskId, 'export-clip', 0, 'Extracting to temp file...');
      this.updateTaskProgress(taskId, 0, 'Extracting to temp file...');

      // Create temp file
      const tempDir = os.tmpdir();
      const originalExt = path.extname(opts.videoPath);
      const tempFilename = `briefcase_temp_${Date.now()}${originalExt}`;
      const tempPath = path.join(tempDir, tempFilename);
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Extracting to temp: ${tempPath}`);

      // Extract clip to temp
      const extractionResult = await this.clipExtractor.extractClip({
        videoPath: opts.videoPath,
        startTime: opts.startTime,
        endTime: opts.endTime,
        outputPath: tempPath,
        reEncode: opts.reEncode || false,
        quality: opts.quality || 'medium',
        scale: opts.scale,
        cropAspectRatio: opts.cropAspectRatio,
        muteSections: opts.muteSections,
        onProgress: (progress: number) => {
          // Scale to 0-80% for extraction phase
          const scaledProgress = Math.round(progress * 0.8);
          const message = `Extracting... ${progress}%`;
          this.eventService.emitTaskProgress(taskId, 'export-clip', scaledProgress, message);
          this.updateTaskProgress(taskId, scaledProgress, message);
        },
      });

      if (!extractionResult.success) {
        this.logger.error(`[EXPORT-CLIP] [OVERWRITE] Extraction FAILED: ${extractionResult.error}`);
        try { fs.unlinkSync(tempPath); } catch (_) {}
        return { success: false, error: extractionResult.error || 'Failed to extract clip' };
      }

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Extraction complete, replacing original...`);
      this.eventService.emitTaskProgress(taskId, 'export-clip', 85, 'Replacing original file...');
      this.updateTaskProgress(taskId, 85, 'Replacing original file...');

      // Delete original and copy temp
      fs.unlinkSync(opts.videoPath);
      fs.copyFileSync(tempPath, opts.videoPath);
      try { fs.unlinkSync(tempPath); } catch (_) {}
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Original replaced`);

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Clearing metadata...`);
      this.eventService.emitTaskProgress(taskId, 'export-clip', 90, 'Clearing metadata...');
      this.updateTaskProgress(taskId, 90, 'Clearing metadata...');

      // Clear all metadata
      this.databaseService.deleteTranscript(opts.videoId);
      this.databaseService.deleteAnalysisSections(opts.videoId);
      this.databaseService.deleteCustomMarkers(opts.videoId);
      this.databaseService.deleteAnalysis(opts.videoId);

      // Recalculate file hash
      let newFileHash: string | null = null;
      try {
        const stats = fs.statSync(opts.videoPath);
        newFileHash = await this.fileScannerService.quickHashFile(opts.videoPath, stats.size);
      } catch (_) {}

      // Update video record
      const newDuration = extractionResult.duration || 0;
      const db = (this.databaseService as any)['db'];
      if (db) {
        const nowIso = new Date().toISOString();
        const updateFields = newFileHash
          ? `duration_seconds = ?, file_size_bytes = ?, file_hash = ?, has_transcript = 0, has_analysis = 0, last_processed_date = ?, upload_date = ?, download_date = ?, added_at = ?, source_url = ?, ai_description = ?, suggested_title = ?`
          : `duration_seconds = ?, file_size_bytes = ?, has_transcript = 0, has_analysis = 0, last_processed_date = ?, upload_date = ?, download_date = ?, added_at = ?, source_url = ?, ai_description = ?, suggested_title = ?`;

        const params = newFileHash
          ? [newDuration, extractionResult.fileSize || 0, newFileHash, nowIso, originalMetadata.uploadDate, originalMetadata.downloadDate, originalMetadata.addedAt, originalMetadata.sourceUrl, originalMetadata.aiDescription, originalMetadata.suggestedTitle, opts.videoId]
          : [newDuration, extractionResult.fileSize || 0, nowIso, originalMetadata.uploadDate, originalMetadata.downloadDate, originalMetadata.addedAt, originalMetadata.sourceUrl, originalMetadata.aiDescription, originalMetadata.suggestedTitle, opts.videoId];

        db.prepare(`UPDATE videos SET ${updateFields} WHERE id = ?`).run(...params);
      }

      // Regenerate the thumbnail from the new file contents. Without this,
      // the library keeps showing the pre-overwrite thumbnail forever.
      this.eventService.emitTaskProgress(taskId, 'export-clip', 95, 'Regenerating thumbnail...');
      this.updateTaskProgress(taskId, 95, 'Regenerating thumbnail...');
      try {
        await this.mediaOps.regenerateThumbnail(opts.videoId, opts.videoPath);
      } catch (thumbErr) {
        this.logger.warn(`[EXPORT-CLIP] [OVERWRITE] Thumbnail regeneration failed (non-fatal): ${(thumbErr as Error).message}`);
      }

      // Notify all frontends (library view + any open Scout editor) that the
      // file at this path has changed so they can cache-bust their video URL
      // and refetch thumbnails. The path itself is unchanged, but reusing the
      // existing video-path-updated event gives us the refresh behavior Scout
      // already implements for replaced videos.
      this.eventService.emitVideoPathUpdated(opts.videoId, opts.videoPath, opts.videoPath);

      this.eventService.emitTaskProgress(taskId, 'export-clip', 100, 'Overwrite complete');
      this.updateTaskProgress(taskId, 100, 'Overwrite complete');
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] ========== Overwrite complete ==========`);

      return {
        success: true,
        data: { outputPath: opts.videoPath, duration: newDuration, overwritten: true },
      };
    } catch (error) {
      this.logger.error(`[EXPORT-CLIP] [OVERWRITE] Unexpected error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }
}
