// Queue Manager Service - Executes task-based jobs with configurable concurrency

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
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
import { atomicReplaceFile } from '../common/utils/temp-file.util';
import { isParked } from '../crucible/llm/errors';
import { isAsrUnavailable } from '../crucible/asr/crucible-asr-job';
import { isTranscriptionRetryable, type WhisperRoute } from '../media/whisper.service';
import { CrucibleReadinessService, crucibleTasksIn } from '../crucible/readiness.service';
import {
  CLOUD_LANE,
  CrucibleLanesService,
  LANE_STALL_MS,
  LANE_TASK_TYPES,
  STARVATION_MS,
  parkDelayMs,
  type LanePlacement,
  type LanesStatus,
  type LaneTaskView,
} from './crucible-lanes';

// Active task tracking
export interface ActiveTask {
  taskId: string;
  jobId: string;
  taskIndex: number;
  type: string;
  /** 'lane' is a Crucible lane (P4): `lane` names which, `server` where it runs. */
  pool: 'main' | 'lane';
  lane?: string;
  server?: string;
  model?: string;
  /** Aborts a lane task's reservation and run (cancel, stall, quit). */
  abort?: AbortController;
  libraryId?: string;    // Resolved library this task operates on. The scheduler
                         // refuses to start a task for a different library while
                         // any task is in flight, so the shared DB connection is
                         // never switched out from under a running task.
  progress: number;
  message: string;
  startedAt: Date;
  lastProgressAt: Date;  // Track when we last received progress update
  abandoned?: boolean;   // Set when the watchdog force-fails a stuck task so the
                         // original executeTask promise won't double-finalize if it
                         // eventually settles.
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
  // Crucible lanes (P4): gpu:<server> ×1 each, cloud ×2. Every AI task runs
  // on one; there is no other AI pool (P7 removed the direct road's pool of 1).
  private lanePool = new Map<string, ActiveTask>();

  // Admission into the lanes is async (venue, preflight) and serialised.
  private admitting = false;
  private admitAgain = false;
  private parkTimer: NodeJS.Timeout | null = null;
  private lanesTimer: NodeJS.Timeout | null = null;
  private lanesEmitTimer: NodeJS.Timeout | null = null;
  private unsubscribeServers: (() => void) | null = null;
  private unsubscribeReadiness: (() => void) | null = null;
  private readonly LANES_REFRESH_MS = 15_000;

  // Queue processing state (kept for API compatibility, no longer used as a lock)
  private processing = false;

  // Watchdog timer for detecting stuck tasks
  private watchdogInterval: NodeJS.Timeout | null = null;
  private readonly WATCHDOG_INTERVAL_MS = 60000;  // Check every minute
  // Main-pool tasks are killed on a STALL, not on total runtime. A wall-clock
  // cap can't distinguish a wedged task from a healthy slow one, and legitimate
  // work routinely runs past any cap worth setting: a 2.5-hour broadcast is a
  // multi-GB HLS download, and transcode/transcribe scale with duration too.
  // As long as a task keeps reporting progress it is making headway and is left
  // alone; 10 minutes of total silence is the stuck signal.
  private readonly MAIN_TASK_STALL_MS = 10 * 60 * 1000;  // 10 minutes with no progress

  // Concurrency: 5 general (non-AI) tasks; AI tasks take Crucible lanes.
  private readonly MAX_MAIN_CONCURRENT = 5;

  constructor(
    private readonly mediaOps: MediaOperationsService,
    private readonly eventService: MediaEventService,
    private readonly libraryManager: LibraryManagerService,
    private readonly databaseService: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly clipExtractor: ClipExtractorService,
    private readonly fileScannerService: FileScannerService,
    private readonly libraryService: LibraryService,
    /** P4: where every AI task runs. Nothing on the main pool's path reads it. */
    private readonly lanes: CrucibleLanesService,
    /**
     * P7: is Crucible there. Asked only for jobs that carry an AI task (at the
     * door), and told how much AI work is parked waiting on it. A job with no
     * AI task never reads it.
     */
    private readonly readiness: CrucibleReadinessService,
  ) {}

  /**
   * Lifecycle hook - called when the module is initialized
   * Starts the watchdog timer to detect stuck tasks
   */
  onModuleInit() {

    this.startWatchdog();

    {
      // A server added, removed, re-ranked, paused or resumed: parked work is
      // asked again at once (§7.2 step 4), and the lane strip redrawn.
      this.unsubscribeServers = this.lanes.onServersChanged(() => {
        for (const job of this.jobQueue.values()) {
          if (job.parkedReason !== undefined) job.parkedUntil = 0;
        }
        this.processQueue();
        this.scheduleLanesEmit();
      });
      // The lane strip's reach and holder sentences go stale on their own
      // (another app starts or stops); redraw them, and re-ask parked work
      // whose server now reads free, every 15 s.
      this.lanesTimer = setInterval(() => this.scheduleLanesEmit(), this.LANES_REFRESH_MS);
      this.lanesTimer.unref?.();
      // Crucible back (started, reconnected, resumed): parked work is asked again at once.
      this.unsubscribeReadiness = this.readiness.onChange((view) => {
        if (view.state !== 'ready') return;
        let parked = false;
        for (const job of this.jobQueue.values()) {
          if (job.parkedReason !== undefined) {
            job.parkedUntil = 0;
            parked = true;
          }
        }
        if (parked) this.processQueue();
      });
    }
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

    // Crucible lanes: a STALL, not a wall clock (§7.5). A long analysis on a
    // 27B is healthy as long as chats keep answering; 15 minutes with no
    // progress event, no load event and no answered chat is the stuck signal.
    for (const task of [...this.lanePool.values()]) {
      const silentMs = now.getTime() - task.lastProgressAt.getTime();
      if (silentMs > LANE_STALL_MS) {
        this.logger.error(
          `Lane task ${task.taskId} (${task.type} on ${task.lane}) stalled: nothing from Crucible for ${Math.round(silentMs / 60000)}m. Failing it and freeing the lane.`,
        );
        this.failStuckTask(task, 'lane', `Stalled: no progress from Crucible on ${task.server ?? 'the server'} for ${Math.round(silentMs / 60000)} minutes`);
      }
    }

    // Check main pool
    for (const [taskId, task] of this.mainPool.entries()) {
      const runningMs = now.getTime() - task.startedAt.getTime();
      const lastProgressMs = now.getTime() - task.lastProgressAt.getTime();

      if (lastProgressMs > this.MAIN_TASK_STALL_MS) {
        this.logger.error(
          `⏱️ Main task ${taskId} (${task.type}) stalled: no progress for ` +
          `${Math.round(lastProgressMs / 60000)}m (running ${Math.round(runningMs / 60000)}m, stuck at ${task.progress}%). ` +
          `Failing it and freeing the slot.`
        );
        this.failStuckTask(task, 'main', `Task stalled — no progress for ${Math.round(lastProgressMs / 60000)} minutes`);
      }
    }
  }

  /**
   * Abort the running child process behind an active task. Routed by jobId via
   * the 'job.cancel-requested' event: the downloader, ffmpeg and whisper
   * services each own their processes and ignore the signal unless they hold one
   * for this jobId. Aborting is idempotent and safe if the process already
   * finished (each service no-ops on an unknown jobId/processId).
   */
  private abortActiveTask(active: ActiveTask): void {
    // A lane task's reservation (a model loading) listens to its own signal.
    try {
      active.abort?.abort();
    } catch {
      // Aborting twice is harmless.
    }
    try {
      this.eventEmitter.emit('job.cancel-requested', {
        jobId: active.jobId,
        type: active.type,
      });
    } catch (err) {
      this.logger.warn(`Failed to signal abort for job ${active.jobId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Force-fail a task the watchdog has determined is stuck. Mirrors the failure
   * path in executeTask: kill the child, mark the job failed, free the pool slot,
   * emit task.failed on both buses, schedule removal, and kick the queue so
   * waiting work proceeds. `abandoned` guards executeTask from double-emitting if
   * its promise ever settles later.
   */
  private failStuckTask(active: ActiveTask, pool: 'main' | 'lane', reason: string): void {
    active.abandoned = true;

    // Kill the stuck child so it stops consuming CPU/network instead of only
    // freeing the slot and letting it run on orphaned.
    this.abortActiveTask(active);

    const job = this.jobQueue.get(active.jobId);
    if (job && job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = reason;
      job.completedAt = new Date();
    }

    // Free the pool slot (identity-checked so we never clobber a different task).
    if (pool === 'main') {
      if (this.mainPool.get(active.taskId) === active) {
        this.mainPool.delete(active.taskId);
      }
    } else if (this.lanePool.get(active.taskId) === active) {
      this.lanePool.delete(active.taskId);
    }

    this.emitTaskFailed({
      taskId: active.taskId,
      jobId: active.jobId,
      videoId: job?.videoId,
      type: active.type,
      message: reason,
    });

    // Remove the failed job from the queue after a delay (matches executeTask).
    setTimeout(() => {
      this.jobQueue.delete(active.jobId);
      this.logger.log(`Removed timed-out job ${active.jobId} from queue`);
    }, 5000);

    // Dispatch the next waiting task into the freed slot.
    this.processQueue();
  }

  /**
   * Emit a task.failed event on BOTH event buses:
   *  - MediaEventService (Socket.IO) for live frontend updates.
   *  - EventEmitter2 for in-process listeners.
   */
  private emitTaskFailed(payload: {
    taskId: string;
    jobId: string;
    videoId?: string;
    type: string;
    message: string;
    canRetry?: boolean;
  }): void {
    const event = {
      taskId: payload.taskId,
      jobId: payload.jobId,
      videoId: payload.videoId,
      type: payload.type,
      error: {
        code: 'TASK_FAILED',
        message: payload.message,
      },
      canRetry: payload.canRetry ?? false,
      timestamp: new Date().toISOString(),
    };

    this.eventService.emit('task.failed', event);
    this.eventEmitter.emit('task.failed', event);
  }

  /**
   * Heartbeat from the services that own long-running child processes
   * (download, transcode, transcribe). MediaEventService mirrors every
   * 'task-progress' it emits onto this bus. Without it the watchdog only ever
   * saw a task's starting progress and reaped healthy long work as stalled.
   */
  @OnEvent('task.progress')
  handleTaskProgress(payload: { jobId?: string; progress?: number; message?: string }): void {
    if (!payload?.jobId || typeof payload.progress !== 'number') {
      return;
    }
    this.updateTaskProgress(payload.jobId, payload.progress, payload.message);
  }

  /**
   * Update progress for an active task (called by event handlers)
   */
  updateTaskProgress(jobId: string, progress: number, message?: string): void {
    // Update main pool if matching
    const mainTask = this.mainPool.get(jobId);
    if (mainTask) {
      mainTask.progress = progress;
      mainTask.lastProgressAt = new Date();
      if (message) mainTask.message = message;
    }

    const laneTask = this.lanePool.get(jobId);
    if (laneTask) {
      laneTask.progress = progress;
      laneTask.lastProgressAt = new Date();
      if (message) laneTask.message = message;
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
    for (const timer of [this.parkTimer, this.lanesEmitTimer]) if (timer) clearTimeout(timer);
    if (this.lanesTimer) clearInterval(this.lanesTimer);
    this.parkTimer = this.lanesEmitTimer = this.lanesTimer = null;
    this.unsubscribeServers?.();
    this.unsubscribeServers = null;
    this.unsubscribeReadiness?.();
    this.unsubscribeReadiness = null;

    // Crucible lane tasks: abort each run so its lease is released in the
    // run's own finally. Whatever that cannot finish (the process is going),
    // the quit sweep (CrucibleLanesService.beforeApplicationShutdown, which
    // Nest runs after this) gives back from the ledger.
    for (const active of this.lanePool.values()) {
      this.cancelledJobs.add(active.jobId);
      try { active.abort?.abort(); } catch { /* already aborted */ }
      try {
        this.eventEmitter.emit('job.cancel-requested', { jobId: active.jobId, type: active.type });
      } catch { /* shutting down */ }
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
    this.lanePool.clear();

    // Reset processing flag
    this.processing = false;
  }

  /**
   * Add a job to the queue
   */
  addJob(job: Omit<QueueJob, 'id' | 'createdAt' | 'status' | 'progress' | 'currentPhase' | 'currentTaskIndex'>, options?: { paused?: boolean }): string {
    const paused = options?.paused ?? false;
    // P7: a job that needs Crucible is refused at the door (CrucibleRequiredError,
    // HTTP 409) when it could never run as things stand. A staged (paused) job
    // is checked when it is started instead.
    if (!paused) this.assertCrucibleFor([job]);
    const jobId = uuidv4();

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

    this.logger.log(`Added job ${jobId} with ${job.tasks.length} tasks${paused ? ' (paused)' : ''}`);

    // Kick the queue (skip if paused)
    if (!paused) {
      setImmediate(() => this.processQueue());
    }

    return jobId;
  }

  /**
   * Start one or more paused jobs — sets status to 'pending' and kicks the queue
   */
  startJobs(jobIds: string[]): number {
    // All or none: a staged job that needs Crucible it cannot have refuses the start.
    this.assertCrucibleFor(jobIds.map((id) => this.jobQueue.get(id)).filter((j): j is QueueJob => j !== undefined && j.status === 'paused'));
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

  /** True when an AI task queued now would be accepted (readiness's gate says yes). */
  canQueueCrucibleWork(): boolean {
    try {
      this.readiness.assertCanQueue('AI work');
      return true;
    } catch {
      return false;
    }
  }

  /** Refuse jobs whose AI tasks could never run as things stand (the readiness gate). Non-AI jobs pass untouched. */
  private assertCrucibleFor(jobs: Array<Pick<QueueJob, 'tasks'>>): void {
    const needs = [...new Set(jobs.flatMap((j) => crucibleTasksIn(j.tasks)))];
    if (needs.length === 0) return;
    const what = needs.map((t) => (t === 'transcribe' ? 'Transcription' : t === 'analyze' ? 'AI analysis' : 'Webpage analysis')).join(' and ');
    this.readiness.assertCanQueue(what);
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
   * True when any task is currently running in either pool. Used to block
   * external library switch/transfer while a task could be mid-await (which
   * would swap the shared DB connection out from under it).
   */
  hasActiveTasks(): boolean {
    // Parked tasks are not here: they hold no slot, so a park never blocks a
    // library switch (§7.2 step 4).
    return this.mainPool.size > 0 || this.lanePool.size > 0;
  }

  /** Tasks holding a slot now: the main pool's and the lanes'. */
  runningTaskCount(): number {
    return this.mainPool.size + this.lanePool.size;
  }

  /** Crucible lane slots (P4), for the API and specs. */
  getLanePool(): Map<string, ActiveTask> {
    return this.lanePool;
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

    // Abort the running child process (download/transcode/transcription) so it
    // stops immediately instead of running to completion. Look the active task
    // up BEFORE freeing the slot below so we still know it's ours to abort.
    const active = this.mainPool.get(jobId) ?? this.lanePool.get(jobId);
    if (active) {
      this.abortActiveTask(active);
    }

    job.status = 'cancelled';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();
    // A parked task holds nothing on any server: cancelling it is only this.
    this.clearPark(job);
    this.scheduleParkWake();

    // Remove from pools if active
    this.mainPool.delete(jobId);
    const lane = this.lanePool.get(jobId);
    this.lanePool.delete(jobId);
    if (lane !== undefined) this.scheduleLanesEmit();

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
    // 'cancelled' belongs here with the other finished states. Leaving it out
    // meant a cancelled job could never be cleared by any means — it is not
    // running, so Stop does nothing to it, and Clear skipped it — so cancelled
    // rows accumulated in the queue forever.
    const FINISHED = new Set(['completed', 'failed', 'cancelled']);
    let cleared = 0;
    for (const [jobId, job] of this.jobQueue.entries()) {
      if (FINISHED.has(job.status)) {
        this.jobQueue.delete(jobId);
        // The cancellation set is keyed by job id and consulted by running
        // tasks; a job that no longer exists cannot be asked about again, so
        // its entry would leak for the process lifetime.
        this.cancelledJobs.delete(jobId);
        cleared++;
      }
    }

    this.logger.log(`Cleared ${cleared} finished job(s) (completed/failed/cancelled)`);
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
      // P4: Crucible lanes, where every AI task runs.
      lanePool: {
        active: this.lanePool.size,
        tasks: Array.from(this.lanePool.values()).map(({ abort: _abort, ...rest }) => rest),
        parked: jobs.filter(j => j.parkedReason !== undefined && (j.status === 'pending' || j.status === 'processing')).length,
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
   * Unified queue processing: the main pool (5) for everything that is not AI,
   * and the Crucible lanes for everything that is.
   * Event-driven: called when jobs are added or tasks complete.
   * No polling loop — executeTask's finally block re-triggers this.
   */
  private processQueue(): void {
    this.fillMainPool();
    // AI tasks go to Crucible lanes, admitted asynchronously (venue, activity,
    // reservation) so nothing here waits on the network.
    this.kickAdmission();
  }

  /** Fill the main pool (up to 5 concurrent tasks). Returns how many were dispatched. */
  private fillMainPool(): number {
    let dispatched = 0;
    while (this.mainPool.size < this.MAX_MAIN_CONCURRENT) {
      const nextTask = this.getNextMainTask();
      if (!nextTask) break;

      this.executeTask(nextTask, 'main').catch(err => {
        this.logger.error(`Main pool task failed: ${err?.message || err}`);
      });
      dispatched++;
    }
    return dispatched;
  }

  /**
   * The library all in-flight tasks (both pools) currently operate on, or
   * undefined when nothing is running. Every in-flight task shares one library
   * because canStartJobLibrary refuses to start a task for a different one.
   */
  private getInFlightLibraryId(): string | undefined {
    const first = this.mainPool.values().next().value as ActiveTask | undefined;
    if (first) return first.libraryId;
    const lane = this.lanePool.values().next().value as ActiveTask | undefined;
    return lane?.libraryId;
  }

  /**
   * Whether a job may start now without switching the shared DB connection out
   * from under a task already running against a different library. When nothing
   * is running, any library is safe to switch to. Otherwise the job must target
   * the in-flight library (the common single-library case always passes); a job
   * for another library waits until both pools drain.
   */
  private canStartJobLibrary(job: QueueJob): boolean {
    if (this.mainPool.size === 0 && this.lanePool.size === 0) {
      return true;
    }
    const target = job.libraryId ?? this.libraryManager.getActiveLibrary()?.id;
    return target === this.getInFlightLibraryId();
  }

  /**
   * Get next non-AI task from any job
   */
  private getNextMainTask(): { task: Task; job: QueueJob } | null {
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      // Don't start a task that would switch the shared DB connection out from
      // under a task already running against a different library.
      if (!this.canStartJobLibrary(job)) continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      if (!currentTask) {
        this.logger.warn(`getNextMainTask: job ${job.id} has no task at index ${job.currentTaskIndex} (tasks length: ${job.tasks.length})`);
        continue;
      }

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

      // Only non-AI tasks: every task that needs Crucible takes a lane.
      if (LANE_TASK_TYPES.has(currentTask.type)) continue;
      return { task: currentTask, job };
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

    const lane = this.lanePool.get(jobId);
    if (lane !== undefined && lane.taskIndex === taskIndex) {
      return true;
    }

    return false;
  }

  /**
   * Execute a task in the appropriate pool
   */
  private async executeTask(
    { task, job }: { task: Task; job: QueueJob },
    pool: 'main' | 'lane',
    placement?: LanePlacement,
  ): Promise<void> {
    // Check if job was cancelled before starting
    if (this.isJobCancelled(job.id)) {
      this.logger.log(`Job ${job.id} was cancelled, skipping task ${task.type}`);
      // Clean up cancelled job from set after acknowledging
      this.cancelledJobs.delete(job.id);
      this.processQueue();
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
      libraryId: job.libraryId ?? this.libraryManager.getActiveLibrary()?.id,
      progress: 0,
      message: 'Starting...',
      startedAt: now,
      lastProgressAt: now,
      ...(placement === undefined ? {} : {
        lane: placement.lane,
        server: placement.server,
        model: placement.target.model,
        abort: new AbortController(),
        message: task.type === 'transcribe'
          ? `Sending to Crucible on ${placement.server}...`
          : `Reserving ${placement.target.model} on ${placement.server}...`,
      }),
    };

    // IMPORTANT: Register in pool SYNCHRONOUSLY before any async work.
    // This prevents processQueue's inner while loop from dispatching the
    // same task again while we await the library switch below.
    if (pool === 'main') {
      this.mainPool.set(taskId, activeTask);
    } else {
      this.lanePool.set(taskId, activeTask);
      job.lane = placement!.lane;
      job.venue = placement!.server;
      this.scheduleLanesEmit();
    }

    // Update job status
    if (job.status === 'pending') {
      job.status = 'processing';
      job.startedAt = new Date();
    }

    // Set when this task parked: its own lane freeing then says nothing about
    // the server being free (someone else holds it), so nothing is re-asked.
    let parkedHere = false;
    // P5: a transcription placed on a GPU lane reserves with its asr submit
    // (a 409 there parks it), not with a model load and lease.
    const asrOnLane = placement !== undefined && task.type === 'transcribe';
    const transcribeRoute: WhisperRoute | undefined = asrOnLane
      ? { kind: 'crucible', server: placement!.server, model: placement!.target.model, signal: activeTask.abort!.signal }
      : undefined;
    try {
      const run = async (): Promise<TaskResult> => {
        // Ensure correct library is active for this job (all tasks need the right DB context)
        if (job.libraryId) {
          const currentLibrary = this.libraryManager.getActiveLibrary();
          if (!currentLibrary || currentLibrary.id !== job.libraryId) {
            this.logger.log(`[${job.id}] Switching to target library: ${job.libraryId} for task ${task.type}`);
            await this.libraryManager.switchLibrary(job.libraryId);
          }
        }

        job.currentPhase = `${task.type} (${job.currentTaskIndex + 1}/${job.tasks.length})`;

        this.logger.log(
          `[${pool.toUpperCase()} POOL] Starting task ${taskId}: ${task.type} for job ${job.id}` +
          (placement ? ` on ${placement.lane} (${placement.target.model})` : ''),
        );

        // Emit task started event
        this.eventService.emit('task.started', {
          taskId,
          jobId: job.id,
          videoId: job.videoId,
          type: task.type,
          pool,
          ...(placement ? { lane: placement.lane, venue: placement.server } : {}),
          timestamp: new Date().toISOString(),
        });

        // Execute the task
        return this.executeTaskLogic(job, task, taskId, transcribeRoute);
      };

      // A lane task RESERVES first (load + lease on its server, §7.2 step 3)
      // and only then switches library and starts, so a task that parks at
      // the door never touched the shared DB connection. The reservation is
      // held (heartbeaten) across the whole task and released when it settles.
      const result = placement === undefined || asrOnLane
        ? await run()
        : await this.lanes.runAdmitted({
            ...placement,
            signal: activeTask.abort!.signal,
            localId: job.id,
            onActivity: () => { activeTask.lastProgressAt = new Date(); },
          }, run);

      // If the watchdog force-failed this task while we were awaiting, it has
      // already finalized the job and freed the slot. Don't double-finalize.
      if (activeTask.abandoned) {
        this.logger.warn(`Task ${taskId} completed after being abandoned by the watchdog; ignoring late result`);
        return;
      }

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

      // Collect non-fatal degradations onto the job so the UI can surface them.
      if (result.warnings && result.warnings.length > 0) {
        job.warnings = [...(job.warnings ?? []), ...result.warnings];
        for (const warning of result.warnings) {
          this.logger.warn(`[${taskId}] Task warning: ${warning}`);
        }
      }

      // Update last_processed_date for tasks that process the video
      // (not for get-info or download which don't have a video ID yet)
      const processingTasks = ['import', 'transcribe', 'analyze', 'analyze-webpage', 'fix-aspect-ratio', 'strip-black-bars', 'normalize-audio', 'process-video'];
      if (job.videoId && processingTasks.includes(task.type)) {
        try {
          this.databaseService.updateLastProcessedDate(job.videoId);
        } catch (err) {
          this.logger.warn(`Failed to update last_processed_date for video ${job.videoId}: ${err}`);
        }
      }

      // Regenerate thumbnail after file-modifying tasks
      const thumbnailRegenTasks = ['fix-aspect-ratio', 'strip-black-bars', 'normalize-audio', 'process-video'];
      if (job.videoId && thumbnailRegenTasks.includes(task.type) && job.videoPath) {
        await this.mediaOps.regenerateThumbnail(job.videoId, job.videoPath);
        // Re-probe and update stored width/height/fps after a file-modifying task.
        // fix-aspect-ratio / strip-black-bars change the dimensions; without this
        // the DB keeps the pre-processing geometry and the geometry-based
        // aspect-ratio skip would re-process a genuinely-fixed video every time.
        try {
          await this.mediaOps.refreshVideoDimensions(job.videoId, job.videoPath, taskId);
        } catch (err) {
          this.logger.warn(`[${taskId}] Failed to refresh video dimensions after ${task.type}: ${err}`);
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
      job.parkCount = 0;
      job.currentTaskIndex++;
      job.progress = Math.round((job.currentTaskIndex / job.tasks.length) * 100);

      // Check if job is complete
      if (job.currentTaskIndex >= job.tasks.length) {
        job.status = 'completed';
        job.progress = 100;
        job.currentPhase = 'Completed';
        job.completedAt = new Date();

        this.logger.log(`Job ${job.id} completed successfully`);

        // Emit job completed event for in-process listeners (via EventEmitter2)
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
      // If the throw was caused by a user cancellation (the abort makes the
      // media op reject), don't report it as a failure. cancelJob already set
      // status='cancelled' and emitted job.cancelled; just clean up the
      // cancelled-set entry (avoid a Set leak) and fall through to the finally.
      if (this.isJobCancelled(job.id)) {
        this.logger.log(`Job ${job.id} was cancelled during ${task.type} execution (caught abort)`);
        this.cancelledJobs.delete(job.id);
        return;
      }

      // P4: "not now" from Crucible (a card held by someone else, a server that
      // stopped answering). PARK: the task goes back to waiting with the
      // holder's sentence and gives up its lane; nothing was saved, and the
      // previous analysis is intact. Never a failure, never a hot loop.
      if (placement !== undefined && isParked(error) && !activeTask.abandoned) {
        this.parkJob(job, error.reason, error.server ?? placement.server, activeTask.libraryId);
        parkedHere = true;
        return;
      }

      // P5/P7: Crucible stopped answering or lost the stream mid-transcription.
      // PARK, like any other "not now" from Crucible: the task is asked again
      // (a re-run reuses its upload) and is never done some other way.
      // A cancel never gets here (isJobCancelled above).
      if (asrOnLane && isTranscriptionRetryable(error) && !activeTask.abandoned) {
        const reason = isAsrUnavailable(error) ? error.message : (error as Error).message;
        this.parkJob(job, reason, placement!.server, activeTask.libraryId);
        parkedHere = true; // the server is not free because this lane is: re-ask nothing
        return;
      }

      // If the watchdog already force-failed and finalized this task, don't emit
      // a second failure or clobber state — just fall through to the finally.
      if (activeTask.abandoned) {
        this.logger.warn(`Task ${taskId} threw after being abandoned by the watchdog; suppressing duplicate failure`);
      } else {
        // Task failed
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : 'Unknown error';
        job.completedAt = new Date();

        this.logger.error(`Task ${taskId} failed: ${job.error}`);

        // Emit task failed event on both buses (Socket.IO + EventEmitter2)
        this.emitTaskFailed({
          taskId,
          jobId: job.id,
          videoId: job.videoId,
          type: task.type,
          message: job.error,
        });

        // Remove failed job from queue after a delay (like completed jobs)
        // This ensures the UI can show the failure state before removal
        setTimeout(() => {
          this.jobQueue.delete(job.id);
          this.logger.log(`Removed failed job ${job.id} from queue`);
        }, 5000);
      }
    } finally {
      // Remove from pool, but only if THIS task still owns the slot. The watchdog
      // may have already reclaimed it and started a different task there; clearing
      // unconditionally would clobber that newer task's slot tracking.
      if (pool === 'main') {
        if (this.mainPool.get(taskId) === activeTask) {
          this.mainPool.delete(taskId);
        }
      } else {
        if (this.lanePool.get(taskId) === activeTask) {
          this.lanePool.delete(taskId);
        }
        // The lane is free: anything parked on this server is asked again at
        // once (§7.2 step 4), against a fresh read of its activity.
        const server = placement!.server;
        this.lanes.forgetActivity(server);
        if (!parkedHere) {
          for (const other of this.jobQueue.values()) {
            if (other !== job && other.parkedReason !== undefined && other.parkedServer === server) other.parkedUntil = 0;
          }
        }
        this.scheduleLanesEmit();
      }

      // Dispatch next tasks
      this.processQueue();
    }
  }

  // ── Crucible lanes: admission, parking, the lane strip (P4) ──────────────

  /**
   * Run an admission pass, or ask the running one to go round again. Passes
   * are serialised: each takes lane slots synchronously, so two can never
   * admit the same task, and a slow probe never holds up processQueue.
   */
  private kickAdmission(): void {
    if (this.admitting) {
      this.admitAgain = true;
      return;
    }
    this.admitting = true;
    void (async () => {
      try {
        // The startup sweep gives back what a killed run left on a card
        // before any lane admits anything (§7.4). The main pool never waits.
        await this.lanes.ready;
        do {
          this.admitAgain = false;
          await this.admitPass();
        } while (this.admitAgain);
      } catch (err) {
        this.logger.error(`Crucible admission failed: ${(err as Error)?.message ?? err}`);
      } finally {
        this.admitting = false;
        this.scheduleParkWake();
      }
    })();
  }

  /** Test seam: resolves when no admission pass is running or pending. */
  async settleAdmission(): Promise<void> {
    await this.lanes.ready;
    for (let i = 0; i < 1000 && (this.admitting || this.admitAgain); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** AI tasks that could go to a lane now, oldest first. */
  private laneCandidates(now: number): Array<{ task: Task; job: QueueJob }> {
    const out: Array<{ task: Task; job: QueueJob }> = [];
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;
      const task = job.tasks[job.currentTaskIndex];
      if (!task || !LANE_TASK_TYPES.has(task.type)) continue;
      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;
      let previousRunning = false;
      for (let i = 0; i < job.currentTaskIndex; i++) {
        if (this.isTaskRunning(job.id, i)) { previousRunning = true; break; }
      }
      if (previousRunning) continue;
      if (job.aiWaitingIndex !== job.currentTaskIndex) {
        job.aiWaitingIndex = job.currentTaskIndex;
        job.aiWaitingSince = now;
      }
      if (job.parkedUntil !== undefined && job.parkedUntil > now) continue;
      out.push({ task, job });
    }
    return out;
  }

  /** Still the same task, still waiting, not cancelled: safe to admit after an await. */
  private stillWaiting(job: QueueJob, taskIndex: number): boolean {
    return this.jobQueue.get(job.id) === job
      && (job.status === 'pending' || job.status === 'processing')
      && job.currentTaskIndex === taskIndex
      && !this.isJobCancelled(job.id)
      && !this.isTaskRunning(job.id, taskIndex);
  }

  private async admitPass(): Promise<void> {
    const lanes = this.lanes;
    const now = lanes.now();
    const candidates = this.laneCandidates(now);
    if (candidates.length === 0) return;

    // 1. Venue, once per model per pass.
    const decisions = new Map<string, ReturnType<CrucibleLanesService['place']>>();
    let transcribeDecision: ReturnType<CrucibleLanesService['placeTranscribe']> | null = null;
    const byLane = new Map<string, Array<{ task: Task; job: QueueJob; index: number; placement: LanePlacement }>>();
    for (const { task, job } of candidates) {
      const index = job.currentTaskIndex;
      if (!this.canStartJobLibrary(job)) continue;
      if (task.type === 'transcribe') {
        // P5: the transcription venue rule, once per pass. No server that can
        // take it: the task PARKS with why (P7: there is no other transcriber).
        transcribeDecision ??= lanes.placeTranscribe();
        const answer = await transcribeDecision;
        if (!this.stillWaiting(job, index)) continue;
        if (answer.kind === 'wait') {
          this.parkJob(job, answer.reason, null);
          continue;
        }
        job.lane = answer.placement.lane;
        job.venue = answer.placement.server;
        const list = byLane.get(answer.placement.lane) ?? [];
        list.push({ task, job, index, placement: answer.placement });
        byLane.set(answer.placement.lane, list);
        continue;
      }
      let target;
      try {
        target = lanes.targetOf(task);
      } catch (err) {
        this.failWaitingJob(job, task, (err as Error).message);
        continue;
      }
      if (!decisions.has(target.model)) decisions.set(target.model, lanes.place(target));
      const answer = await decisions.get(target.model)!;
      if (!this.stillWaiting(job, index)) continue;
      if (answer.kind === 'wait') {
        this.parkJob(job, answer.reason, null);
        continue;
      }
      if (answer.kind === 'fail') {
        this.failWaitingJob(job, task, answer.reason);
        continue;
      }
      job.lane = answer.placement.lane;
      job.venue = answer.placement.server;
      const list = byLane.get(answer.placement.lane) ?? [];
      list.push({ task, job, index, placement: answer.placement });
      byLane.set(answer.placement.lane, list);
    }

    // 2. Fill each lane's free slots. A parked or waiting task on one lane
    //    never holds up another: each lane is filled on its own.
    for (const [lane, list] of byLane) {
      let free = lanes.widthOf(lane) - [...this.lanePool.values()].filter((t) => t.lane === lane).length;
      if (free <= 0) continue;
      const isGpu = lane !== CLOUD_LANE;
      const server = list[0].placement.server;
      const ordered = isGpu ? this.preferResident(list, await lanes.residentOn(server), now) : list;
      for (const c of ordered) {
        if (free <= 0) break;
        if (!this.stillWaiting(c.job, c.index) || !this.canStartJobLibrary(c.job)) continue;
        if (isGpu) {
          const busy = c.task.type === 'transcribe'
            ? await lanes.preflightJob(c.placement.server)
            : await lanes.preflight(c.placement.server, c.placement.target);
          if (!this.stillWaiting(c.job, c.index)) continue;
          if (busy !== null) {
            this.parkJob(c.job, busy, c.placement.server);
            continue;
          }
          if (!this.canStartJobLibrary(c.job)) continue;
        }
        this.admit(c.job);
        this.executeTask({ task: c.task, job: c.job }, 'lane', c.placement).catch((err) => {
          this.logger.error(`Lane task failed: ${err?.message || err}`);
        });
        free--;
      }
    }
  }

  /**
   * §7.3: tasks whose model is already on the card go first, so a queue of
   * mixed models doesn't swap the card per video. FIFO once the oldest has
   * waited {@link STARVATION_MS}, so nothing starves.
   */
  private preferResident<T extends { job: QueueJob; placement: LanePlacement }>(list: T[], resident: string | null, now: number): T[] {
    if (resident === null || list.length < 2) return list;
    const oldest = list.reduce((min, c) => Math.min(min, c.job.aiWaitingSince ?? now), now);
    if (now - oldest >= STARVATION_MS) return list;
    return [...list.filter((c) => c.placement.target.model === resident), ...list.filter((c) => c.placement.target.model !== resident)];
  }

  /**
   * Park a task: back to waiting, holding no slot, with the reason line the
   * row shows (grey, not red). Asked again after 5 s doubling to 60 s, or at
   * once when the registry changes or that server's lane frees. The library
   * it was admitted under is pinned, so it never resumes into another one.
   */
  private parkJob(job: QueueJob, reason: string, server: string | null, libraryId?: string): void {
    const now = this.lanes.now();
    const changed = job.parkedReason !== reason;
    job.parkCount = (job.parkCount ?? 0) + 1;
    job.parkedUntil = now + parkDelayMs(job.parkCount);
    job.parkedReason = reason;
    job.parkedServer = server ?? undefined;
    if (job.libraryId === undefined) {
      job.libraryId = libraryId ?? this.libraryManager.getActiveLibrary()?.id;
    }
    job.status = 'pending';
    job.currentPhase = reason;
    if (changed) {
      this.logger.log(`[${job.id}] parked: ${reason}`);
      this.eventService.emit('task.parked', {
        jobId: job.id,
        videoId: job.videoId,
        type: job.tasks[job.currentTaskIndex]?.type,
        reason,
        server,
        timestamp: new Date().toISOString(),
      });
    }
    this.scheduleParkWake();
    this.scheduleLanesEmit();
  }

  private clearPark(job: QueueJob): void {
    delete job.parkedReason;
    delete job.parkedUntil;
    delete job.parkedServer;
  }

  /** A parked task admitted to a lane: its reason line goes away. */
  private admit(job: QueueJob): void {
    if (job.parkedReason === undefined) return;
    this.clearPark(job);
    this.eventService.emit('task.unparked', {
      jobId: job.id,
      videoId: job.videoId,
      timestamp: new Date().toISOString(),
    });
  }

  /** One timer, set for the earliest parked task's next ask. Also tells readiness how much AI work waits. */
  private scheduleParkWake(): void {
    if (this.parkTimer) {
      clearTimeout(this.parkTimer);
      this.parkTimer = null;
    }
    let next = Infinity;
    let parked = 0;
    for (const job of this.jobQueue.values()) {
      if (job.parkedReason !== undefined && job.parkedUntil !== undefined && (job.status === 'pending' || job.status === 'processing')) {
        next = Math.min(next, job.parkedUntil);
        parked++;
      }
    }
    // AI work waiting on Crucible: the moment readiness asks (or starts the
    // Crucible here, once per outage, unless the user declined).
    this.readiness.noteAiWaiting(parked);
    if (next === Infinity) return;
    const delay = Math.max(0, next - this.lanes.now());
    this.parkTimer = setTimeout(() => {
      this.parkTimer = null;
      this.processQueue();
    }, delay);
    this.parkTimer.unref?.();
  }

  /** A task that can never run as configured (a model that is not one, every server refusing this computer). */
  private failWaitingJob(job: QueueJob, task: Task, reason: string): void {
    this.clearPark(job);
    job.status = 'failed';
    job.error = reason;
    job.completedAt = new Date();
    this.logger.error(`[${job.id}] ${task.type} cannot run: ${reason}`);
    this.emitTaskFailed({ taskId: job.id, jobId: job.id, videoId: job.videoId, type: task.type, message: reason });
    setTimeout(() => this.jobQueue.delete(job.id), 5000);
  }

  /** Running (false) or Paused (true) for one server: the routing record's switch (P1). */
  setServerPaused(server: string, paused: boolean): void {
    this.lanes.setPaused(server, paused);
  }

  /** The lane strip, as the queue tab draws it. */
  async getLanesStatus(): Promise<LanesStatus> {
    const running: LaneTaskView[] = [...this.lanePool.values()].map((t) => {
      const job = this.jobQueue.get(t.jobId);
      return { jobId: t.jobId, title: job?.displayName ?? job?.videoId ?? t.jobId, model: t.model ?? '', lane: t.lane ?? '' };
    });
    const waiting = new Map<string, number>();
    for (const job of this.jobQueue.values()) {
      if ((job.status === 'pending' || job.status === 'processing') && job.lane && !this.lanePool.has(job.id)
        && LANE_TASK_TYPES.has(job.tasks[job.currentTaskIndex]?.type ?? '')) {
        waiting.set(job.lane, (waiting.get(job.lane) ?? 0) + 1);
      }
    }
    return this.lanes.lanesStatus(running, waiting);
  }

  /** Redraw the lane strip soon (debounced: a burst of admissions draws once). */
  private scheduleLanesEmit(): void {
    if (this.lanesEmitTimer) return;
    this.lanesEmitTimer = setTimeout(() => {
      this.lanesEmitTimer = null;
      void this.getLanesStatus().then(
        (status) => this.eventService.emit('queue.lanes', status),
        (err) => this.logger.warn(`Could not draw the lanes: ${(err as Error).message}`),
      );
    }, 250);
    this.lanesEmitTimer.unref?.();
  }

  /**
   * Execute task logic and update database flags
   */
  private async executeTaskLogic(
    job: QueueJob,
    task: Task,
    taskId: string,
    /** P5: the engine a transcribe task was placed on; absent, the venue rule decides in place. */
    transcribeRoute?: WhisperRoute,
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

        result = await this.mediaOps.importToLibrary(job.videoPath, task.options, taskId);
        if (result.success && result.data) {
          job.videoId = result.data.videoId;

          // Persist the source URL for downloaded videos so future downloads of
          // the same URL are deduped by findVideoByUrl (the import chain never
          // sets source_url, so URL-based dedup would otherwise never match).
          if (job.url && job.videoId) {
            try {
              this.databaseService.updateVideoSourceUrl(job.videoId, job.url);
            } catch (err) {
              this.logger.warn(`[${taskId}] Failed to persist source_url for video ${job.videoId}: ${err}`);
            }
          }
        }
        break;

      case 'fix-aspect-ratio':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for fix-aspect-ratio task',
          };
        }
        // Skip ONLY when the video is already ~16:9 by its actual dimensions.
        // The aspect_ratio_fixed flag alone is NOT trustworthy: videos were found
        // flagged=1 while still vertical (a past run set the flag without the file
        // being converted, or the file was later re-downloaded). Trusting the flag
        // permanently blocked the fix ("instantly finished, no change"). Decide by
        // geometry, matching the HTTP /fix-aspect-ratio endpoint. Stored dimensions
        // are refreshed after every file-modifying task (see post-task hook), so a
        // genuinely fixed video reads as 16:9 here and is correctly skipped.
        if (job.videoId) {
          const videoForAR = this.databaseService.findVideoById(job.videoId) as any;
          if (videoForAR) {
            const w = Number(videoForAR.width);
            const h = Number(videoForAR.height);
            const isSixteenNine = w > 0 && h > 0 && Math.abs(w / h - 16 / 9) <= 0.01;
            if (isSixteenNine) {
              this.logger.log(`[${taskId}] Skipping fix-aspect-ratio - already 16:9 (${w}x${h}, id: ${job.videoId})`);
              result = { success: true, data: { skipped: true } };
              break;
            }
            if (videoForAR.aspect_ratio_fixed) {
              this.logger.warn(`[${taskId}] aspect_ratio_fixed=1 but dimensions are ${w}x${h} (not 16:9) — stale flag, re-processing (id: ${job.videoId})`);
            }
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
        // UPDATE DATABASE FLAG — a failed flag write fails the task: the video
        // was re-encoded but skip-detection would re-encode it again on every
        // future run (fallback audit #5).
        if (result.success && job.videoId) {
          try {
            await this.mediaOps.setVideoFlag(job.videoId, 'aspect_ratio_fixed', 1);
          } catch (error) {
            return {
              success: false,
              error: `Aspect ratio was fixed, but recording that on video ${job.videoId} failed (${error instanceof Error ? error.message : 'Unknown error'}). Without the flag the video would be re-encoded on every future run — fix the database issue and re-run.`,
            };
          }
        }
        break;

      case 'strip-black-bars':
        if (!job.videoId && !job.videoPath) {
          return {
            success: false,
            error: 'No video ID or path available for strip-black-bars task',
          };
        }
        result = await this.executeStripBlackBars(job, taskId);
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
        // UPDATE DATABASE FLAG — failure fails the task (see aspect-ratio note).
        if (result.success && job.videoId) {
          try {
            await this.mediaOps.setVideoFlag(job.videoId, 'audio_normalized', 1);
          } catch (error) {
            return {
              success: false,
              error: `Audio was normalized, but recording that on video ${job.videoId} failed (${error instanceof Error ? error.message : 'Unknown error'}). Without the flag the video would be re-processed on every future run — fix the database issue and re-run.`,
            };
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
        // UPDATE DATABASE FLAGS based on what was processed — failure fails
        // the task (see aspect-ratio note).
        if (result.success && job.videoId && task.options) {
          try {
            if (task.options.fixAspectRatio) {
              await this.mediaOps.setVideoFlag(job.videoId, 'aspect_ratio_fixed', 1);
            }
            if (task.options.normalizeAudio) {
              await this.mediaOps.setVideoFlag(job.videoId, 'audio_normalized', 1);
            }
          } catch (error) {
            return {
              success: false,
              error: `Video was processed, but recording the done-flags on video ${job.videoId} failed (${error instanceof Error ? error.message : 'Unknown error'}). Without them the video would be re-encoded on every future run — fix the database issue and re-run.`,
            };
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
          taskId,
          transcribeRoute,
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
        return { success: false, error: `Unknown task type: ${(task as any).type}` };
    }

    return result;
  }

  /**
   * Execute strip-black-bars: crop center 9:16 portrait, blur-fill to 16:9, overwrite original
   */
  private async executeStripBlackBars(
    job: QueueJob,
    taskId: string,
  ): Promise<TaskResult> {
    try {
      const videoId = job.videoId;
      if (!videoId) {
        return { success: false, error: 'No video ID for strip-black-bars' };
      }

      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        return { success: false, error: `Video not found: ${videoId}` };
      }

      const videoPath = video.current_path as string;
      if (!videoPath || !fs.existsSync(videoPath)) {
        return { success: false, error: `Video file not found: ${videoPath}` };
      }

      this.logger.log(`[STRIP-BARS] Processing: ${videoPath}`);
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 0, 'Starting strip bars...');
      this.updateTaskProgress(taskId, 0, 'Starting strip bars...');

      // Extract to temp file with strip-black-bars filter
      const tempDir = os.tmpdir();
      const originalExt = path.extname(videoPath);
      const tempPath = path.join(tempDir, `briefcase_strip_${Date.now()}${originalExt}`);

      const extractionResult = await this.clipExtractor.extractClip({
        videoPath,
        startTime: null,
        endTime: null,
        outputPath: tempPath,
        reEncode: true,
        quality: 'high',
        stripBlackBars: true,
        onProgress: (progress: number) => {
          const scaled = Math.round(progress * 0.8);
          this.eventService.emitTaskProgress(taskId, 'strip-black-bars', scaled, `Processing... ${progress}%`);
          this.updateTaskProgress(taskId, scaled, `Processing... ${progress}%`);
        },
      });

      if (!extractionResult.success) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        return { success: false, error: extractionResult.error || 'Strip bars failed' };
      }

      // Replace original file atomically. NEVER unlink the original before the
      // replacement is safely in place — a crash between unlink and copy would
      // destroy irreplaceable media. atomicReplaceFile copies the temp into a
      // sibling in the destination dir, then renames over the original.
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 85, 'Replacing original...');
      this.updateTaskProgress(taskId, 85, 'Replacing original...');
      atomicReplaceFile(tempPath, videoPath);

      // Update file size and hash in database
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 90, 'Updating metadata...');
      this.updateTaskProgress(taskId, 90, 'Updating metadata...');
      // Recompute the identity metadata from the NEW file and write it. The
      // on-disk file has already been atomically swapped above, so the DB row
      // MUST be updated to describe the new file: file_hash is the app's
      // dedup/identity key and a stale hash silently corrupts dedup. We do NOT
      // swallow a failure here (the old behavior only warned, leaving the row
      // describing the OLD file while the bytes on disk are the NEW file) — the
      // swap itself succeeded and is correct, but an un-reconciled row is a real
      // integrity error, so we surface it as a failed task. Never fall back to
      // leaving the old identity in place.
      try {
        const stats = fs.statSync(videoPath);
        const newHash = await this.fileScannerService.quickHashFile(videoPath, stats.size);
        const newDuration = extractionResult.duration || 0;
        const db = this.databaseService.getDatabase();
        db.prepare(
          `UPDATE videos SET duration_seconds = ?, file_size_bytes = ?, file_hash = ?, last_processed_date = ? WHERE id = ?`
        ).run(newDuration, stats.size, newHash, new Date().toISOString(), videoId);
      } catch (err) {
        throw new Error(
          `Strip-black-bars swapped the file but FAILED to update its identity metadata ` +
          `(file_hash/size/duration) for video ${videoId}: ${(err as Error).message}. The ` +
          `on-disk file is the new stripped file; the DB row still describes the OLD file and ` +
          `must be re-scanned/re-hashed.`,
        );
      }

      // Regenerate thumbnail
      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 95, 'Regenerating thumbnail...');
      this.updateTaskProgress(taskId, 95, 'Regenerating thumbnail...');
      try {
        await this.mediaOps.regenerateThumbnail(videoId, videoPath);
      } catch (err) {
        this.logger.warn(`[STRIP-BARS] Thumbnail regen failed (non-fatal): ${(err as Error).message}`);
      }

      // Notify frontends
      this.eventService.emitVideoPathUpdated(videoId, videoPath, videoPath);

      this.eventService.emitTaskProgress(taskId, 'strip-black-bars', 100, 'Strip bars complete');
      this.updateTaskProgress(taskId, 100, 'Strip bars complete');
      this.logger.log(`[STRIP-BARS] Complete: ${videoPath}`);

      return { success: true, data: { outputPath: videoPath } };
    } catch (error) {
      this.logger.error(`[STRIP-BARS] Error: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
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

    // Non-fatal degradations surfaced on the job (task still succeeds).
    const exportWarnings: string[] = [];

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
            // Source is already a child clip — don't create nested children
            this.logger.log(`[EXPORT-CLIP] Source video is a child clip — skipping parent linking`);
          } else {
            parentVideoId = String(sourceVideo.id);
            this.logger.log(`[EXPORT-CLIP] Source video found — will link as child of: ${parentVideoId}`);
          }
        } else {
          this.logger.log(`[EXPORT-CLIP] No source video found in library for path`);
        }
      } catch (err) {
        // Non-fatal, but surfaced: the clip will export without its
        // connection edge to the source video.
        const warning = `Clip exported without a link to its source video — the source lookup failed (${(err as Error).message}). You can connect them manually from the inspector.`;
        this.logger.warn(`[EXPORT-CLIP] ${warning}`);
        exportWarnings.push(warning);
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
        trimEndSeconds: opts.trimEndSeconds,
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

      // Auto-import the clip into the library. Import failure fails the task:
      // reporting "Export complete" for a clip that never appears in the app
      // is a lie (fallback audit #4). The extracted file stays on disk either
      // way — the error names its path so nothing is lost.
      try {
        this.logger.log(`[EXPORT-CLIP] Auto-importing clip to library...`);
        const importResult = await this.fileScannerService.importVideos(
          [finalOutputPath],
          undefined,
          parentVideoId,
        );

        if (importResult.imported.length > 0) {
          const videoId = importResult.imported[0];
          this.databaseService.updateLastProcessedDate(videoId);
          this.logger.log(`[EXPORT-CLIP] Imported to library as video ID: ${videoId}${parentVideoId ? ` (child of ${parentVideoId})` : ''}`);
        } else if (importResult.skipped.length > 0) {
          // Already in the library (e.g. re-export of an identical clip) — not a failure.
          this.logger.log(`[EXPORT-CLIP] Clip already present in library (skipped by import)`);
        } else {
          const importErrors = importResult.errors.join('; ');
          throw new Error(importErrors || 'import returned no video ID');
        }
      } catch (importError) {
        const message =
          `Clip was extracted to ${finalOutputPath} but could not be imported into the library: ` +
          `${(importError as Error).message}. The file is intact on disk — fix the issue and import it manually.`;
        this.logger.error(`[EXPORT-CLIP] ${message}`);
        return { success: false, error: message };
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
        warnings: exportWarnings.length > 0 ? exportWarnings : undefined,
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
        trimEndSeconds: opts.trimEndSeconds,
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

      // Replace the original atomically. NEVER unlink the original before the
      // replacement is in place — a crash mid-swap would destroy the source video.
      atomicReplaceFile(tempPath, opts.videoPath);
      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Original replaced`);

      this.logger.log(`[EXPORT-CLIP] [OVERWRITE] Clearing metadata...`);
      this.eventService.emitTaskProgress(taskId, 'export-clip', 90, 'Clearing metadata...');
      this.updateTaskProgress(taskId, 90, 'Clearing metadata...');

      // Recalculate the file hash from the NEW contents BEFORE the DB transaction
      // (hashing is async and cannot run inside a better-sqlite3 transaction).
      // file_hash is the app's dedup/identity key: the file has already been
      // swapped, so the row MUST carry the new hash. We do NOT fall back to
      // leaving the old hash in place (the old behavior swallowed a hashing
      // failure and then silently omitted file_hash from the UPDATE, leaving the
      // row describing the OLD file). The swap itself is correct and intact, but
      // an un-reconciled identity is a real integrity error, so we surface it as
      // a failed task instead.
      let newFileHash: string;
      try {
        const stats = fs.statSync(opts.videoPath);
        newFileHash = await this.fileScannerService.quickHashFile(opts.videoPath, stats.size);
      } catch (err) {
        throw new Error(
          `Export-clip overwrite swapped the file but FAILED to recompute its identity hash ` +
          `for video ${opts.videoId}: ${(err as Error).message}. The on-disk file is the new ` +
          `clip; the DB row still describes the OLD file and must be re-scanned/re-hashed.`,
        );
      }

      // Clear all stale metadata AND update the video record in ONE transaction so
      // we can never leave the row half-cleared (e.g. transcript deleted but the
      // record still flagged has_transcript, or vice-versa).
      const newDuration = extractionResult.duration || 0;
      const db = this.databaseService.getDatabase();
      const nowIso = new Date().toISOString();
      const clearAndUpdate = db.transaction(() => {
        // These helpers each open their own prepared statements against the same
        // connection and participate in this transaction.
        this.databaseService.deleteTranscript(opts.videoId);
        this.databaseService.deleteAnalysisSections(opts.videoId);
        this.databaseService.deleteCustomMarkers(opts.videoId);
        this.databaseService.deleteAnalysis(opts.videoId);
        db.prepare(
          `UPDATE videos SET duration_seconds = ?, file_size_bytes = ?, file_hash = ?, has_transcript = 0, has_analysis = 0, last_processed_date = ?, upload_date = ?, download_date = ?, added_at = ?, source_url = ?, ai_description = ?, suggested_title = ? WHERE id = ?`
        ).run(
          newDuration,
          extractionResult.fileSize || 0,
          newFileHash,
          nowIso,
          originalMetadata.uploadDate,
          originalMetadata.downloadDate,
          originalMetadata.addedAt,
          originalMetadata.sourceUrl,
          originalMetadata.aiDescription,
          originalMetadata.suggestedTitle,
          opts.videoId,
        );
      });
      clearAndUpdate();

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
