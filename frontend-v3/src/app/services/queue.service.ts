import { Injectable, inject, signal, computed, effect, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Observable, of } from 'rxjs';
import { map, tap, catchError } from 'rxjs/operators';
import {
  QueueJob,
  QueueTask,
  QueueStats,
  JobState,
  TaskState,
  createQueueJob,
  createQueueTask,
  isJobDone,
  areAllTasksDone,
  hasFailedTask,
  calculateJobProgress
} from '../models/queue-job.model';
import { TaskType } from '../models/task.model';
import { WebsocketService, TaskStarted, TaskProgress, TaskCompleted, TaskFailed } from './websocket.service';
import { LibraryService, BackendJobRequest, BackendTask } from './library.service';

const STORAGE_KEY = 'clipchimp-queue-jobs';
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable({
  providedIn: 'root'
})
export class QueueService implements OnDestroy {
  private readonly API_BASE = 'http://localhost:3000/api';

  private http = inject(HttpClient);
  private websocketService = inject(WebsocketService);
  private libraryService = inject(LibraryService);

  // Single source of truth for all jobs
  private jobs = signal<QueueJob[]>([]);

  // Map backend job IDs to frontend job IDs
  private backendToFrontendIdMap = new Map<string, string>();
  private frontendToBackendIdMap = new Map<string, string>();

  // WebSocket unsubscribe functions
  private wsUnsubscribes: (() => void)[] = [];

  // Public readonly computed views
  readonly allJobs = this.jobs.asReadonly();

  readonly pendingJobs = computed(() =>
    this.jobs().filter(j => j.state === 'pending')
  );

  readonly processingJobs = computed(() =>
    this.jobs().filter(j => j.state === 'processing')
  );

  readonly completedJobs = computed(() =>
    this.jobs().filter(j => j.state === 'completed' || j.state === 'failed')
  );

  readonly stats = computed<QueueStats>(() => {
    const all = this.jobs();
    return {
      pending: all.filter(j => j.state === 'pending').length,
      processing: all.filter(j => j.state === 'processing').length,
      completed: all.filter(j => j.state === 'completed').length,
      failed: all.filter(j => j.state === 'failed').length,
      total: all.length
    };
  });

  constructor() {
    console.log('[QueueService] Constructor called');

    // Load persisted jobs (with expiry filter)
    this.loadFromStorage();
    console.log('[QueueService] After loadFromStorage:', this.jobs().length, 'jobs');

    // Set up WebSocket handlers
    this.setupWebSocketHandlers();

    // Restore processing jobs from backend on init
    this.restoreFromBackend();

    // Persist on any change
    effect(() => {
      const currentJobs = this.jobs();
      console.log('[QueueService] Effect triggered, saving', currentJobs.length, 'jobs');
      this.saveToStorage(currentJobs);
    });
  }

  ngOnDestroy(): void {
    this.wsUnsubscribes.forEach(unsub => unsub());
  }

  // ==================== PUBLIC STATE MUTATIONS ====================

  /**
   * Add a new job to the queue
   */
  addJob(partial: Partial<QueueJob> & { title: string }): QueueJob {
    const job = createQueueJob(partial);
    console.log('[QueueService] addJob called:', job);
    console.log('[QueueService] Current jobs before add:', this.jobs().length);
    this.jobs.update(jobs => [...jobs, job]);
    console.log('[QueueService] Jobs after add:', this.jobs().length);
    console.log('[QueueService] Pending jobs after add:', this.pendingJobs().length);
    return job;
  }

  /**
   * Add multiple jobs at once
   */
  addJobs(partials: (Partial<QueueJob> & { title: string })[]): QueueJob[] {
    const newJobs = partials.map(p => createQueueJob(p));
    this.jobs.update(jobs => [...jobs, ...newJobs]);
    return newJobs;
  }

  /**
   * Update a job's state
   */
  updateJobState(jobId: string, newState: JobState): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updates: Partial<QueueJob> = { state: newState };

        if (newState === 'processing' && !job.startedAt) {
          updates.startedAt = Date.now();
        }

        if (newState === 'completed' || newState === 'failed') {
          updates.completedAt = Date.now();
        }

        return { ...job, ...updates };
      })
    );
  }

  /**
   * Update a job's error message
   */
  updateJobError(jobId: string, errorMessage: string): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, errorMessage } : job
      )
    );
  }

  /**
   * Update a task's state within a job
   */
  updateTaskState(jobId: string, taskType: TaskType, newState: TaskState, errorMessage?: string): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updatedTasks = job.tasks.map(task => {
          if (task.type !== taskType) return task;
          return {
            ...task,
            state: newState,
            progress: newState === 'completed' ? 100 : task.progress,
            errorMessage
          };
        });

        return { ...job, tasks: updatedTasks };
      })
    );
  }

  /**
   * Reset a job to its default pending state (clear errors, timestamps)
   * Used when stopping processing and moving jobs back to pending
   */
  resetJobToDefault(jobId: string): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;
        return {
          ...job,
          state: 'pending' as JobState,
          errorMessage: undefined,
          startedAt: undefined,
          completedAt: undefined
        };
      })
    );
  }

  /**
   * Reset a task to its default pending state (progress 0, no errors)
   * Used when stopping processing and moving jobs back to pending
   */
  resetTaskToDefault(jobId: string, taskType: TaskType): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updatedTasks = job.tasks.map(task => {
          if (task.type !== taskType) return task;
          return {
            ...task,
            state: 'pending' as TaskState,
            progress: 0,
            errorMessage: undefined
          };
        });

        return { ...job, tasks: updatedTasks };
      })
    );
  }

  /**
   * Update a task's progress within a job
   */
  updateTaskProgress(jobId: string, taskType: TaskType, progress: number, eta?: number, taskLabel?: string): void {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        const updatedTasks = job.tasks.map(task => {
          if (task.type !== taskType) return task;
          // Don't update completed tasks
          if (task.state === 'completed') return task;
          return {
            ...task,
            state: 'running' as TaskState,
            progress: Math.max(0, Math.min(100, progress)),
            // Preserve existing eta/taskLabel if new values are undefined
            eta: eta !== undefined ? eta : task.eta,
            taskLabel: taskLabel || task.taskLabel
          };
        });

        return { ...job, tasks: updatedTasks };
      })
    );
  }

  /**
   * Update job title (e.g., when metadata is resolved)
   */
  updateJobTitle(jobId: string, title: string, titleResolved = true): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, title, titleResolved } : job
      )
    );
  }

  /**
   * Update job by URL (for title resolution before job ID is assigned)
   */
  updateJobByUrl(url: string, updates: Partial<QueueJob>): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.url === url ? { ...job, ...updates } : job
      )
    );
  }

  /**
   * Update job's videoId (e.g., when video is imported and assigned a database ID)
   */
  updateJobVideoId(jobId: string, videoId: string): void {
    console.log(`[QueueService] Updating job ${jobId} with videoId: ${videoId}`);
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, videoId } : job
      )
    );
  }

  /**
   * Update all tasks for a job (e.g., when reconfiguring from modal)
   */
  updateJobTasks(jobId: string, tasks: QueueTask[]): void {
    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === jobId ? { ...job, tasks } : job
      )
    );
  }

  /**
   * Set backend job ID mapping
   */
  setBackendJobId(frontendJobId: string, backendJobId: string): void {
    this.backendToFrontendIdMap.set(backendJobId, frontendJobId);
    this.frontendToBackendIdMap.set(frontendJobId, backendJobId);

    this.jobs.update(jobs =>
      jobs.map(job =>
        job.id === frontendJobId ? { ...job, backendJobId } : job
      )
    );
  }

  /**
   * Get frontend job ID from backend job ID
   */
  getFrontendJobId(backendJobId: string): string | undefined {
    return this.backendToFrontendIdMap.get(backendJobId);
  }

  /**
   * Get backend job ID from frontend job ID
   */
  getBackendJobId(frontendJobId: string): string | undefined {
    return this.frontendToBackendIdMap.get(frontendJobId);
  }

  /**
   * Remove a job from the queue
   */
  removeJob(jobId: string): void {
    const backendId = this.frontendToBackendIdMap.get(jobId);
    if (backendId) {
      this.backendToFrontendIdMap.delete(backendId);
      this.frontendToBackendIdMap.delete(jobId);
    }
    this.jobs.update(jobs => jobs.filter(job => job.id !== jobId));
  }

  /**
   * Clear all completed/failed jobs
   */
  clearCompleted(): void {
    const completedIds = this.jobs()
      .filter(j => j.state === 'completed' || j.state === 'failed')
      .map(j => j.id);

    // Clean up ID maps
    completedIds.forEach(id => {
      const backendId = this.frontendToBackendIdMap.get(id);
      if (backendId) {
        this.backendToFrontendIdMap.delete(backendId);
        this.frontendToBackendIdMap.delete(id);
      }
    });

    this.jobs.update(jobs =>
      jobs.filter(job => job.state !== 'completed' && job.state !== 'failed')
    );
  }

  /**
   * Clear all jobs
   */
  clearAll(): void {
    this.backendToFrontendIdMap.clear();
    this.frontendToBackendIdMap.clear();
    this.jobs.set([]);
  }

  /**
   * Clear all pending jobs
   */
  clearPending(): void {
    const pendingIds = this.jobs()
      .filter(j => j.state === 'pending')
      .map(j => j.id);

    // Clean up ID maps
    pendingIds.forEach(id => {
      const backendId = this.frontendToBackendIdMap.get(id);
      if (backendId) {
        this.backendToFrontendIdMap.delete(backendId);
        this.frontendToBackendIdMap.delete(id);
      }
    });

    this.jobs.update(jobs => jobs.filter(job => job.state !== 'pending'));
    console.log(`[QueueService] Cleared ${pendingIds.length} pending jobs`);
  }

  /**
   * Stop all processing and move processing jobs back to pending
   * Also cancels jobs on the backend
   */
  stopProcessing(): Observable<void> {
    const processingJobs = this.processingJobs();
    if (processingJobs.length === 0) {
      return of(undefined);
    }

    console.log(`[QueueService] Stopping ${processingJobs.length} processing jobs`);

    // Get backend job IDs to cancel
    const backendJobIds = processingJobs
      .map(job => this.frontendToBackendIdMap.get(job.id))
      .filter((id): id is string => !!id);

    // Move all processing jobs back to pending state immediately
    processingJobs.forEach(job => {
      // Reset job state and clear any errors/timestamps
      this.resetJobToDefault(job.id);
      // Reset ALL task states and progress back to pending
      // This includes completed, running, and failed tasks
      job.tasks.forEach(task => {
        this.resetTaskToDefault(job.id, task.type);
      });
    });

    // Cancel on backend
    if (backendJobIds.length > 0) {
      return this.http.post<any>(`${this.API_BASE}/queue/cancel-all`, { jobIds: backendJobIds }).pipe(
        tap(() => console.log('[QueueService] Backend jobs cancelled')),
        map(() => undefined),
        catchError(error => {
          console.error('[QueueService] Failed to cancel backend jobs:', error);
          return of(undefined);
        })
      );
    }

    return of(undefined);
  }

  // ==================== BACKEND INTEGRATION ====================

  /**
   * Submit pending jobs to the backend for processing
   * Returns a map of frontend job ID -> backend job ID
   */
  submitPendingJobs(): Observable<Map<string, string>> {
    const pendingJobs = this.pendingJobs();
    if (pendingJobs.length === 0) return of(new Map());

    // Get current library ID - REQUIRED for processing
    const currentLibrary = this.libraryService.currentLibrary();
    if (!currentLibrary?.id) {
      console.error('[QueueService] Cannot submit jobs: No library configured');

      // Mark all pending jobs as failed
      pendingJobs.forEach(job => {
        this.updateJobState(job.id, 'failed');
        this.updateJobError(job.id, 'No library configured. Please create a library first.');
      });

      return of(new Map());
    }
    const libraryId = currentLibrary.id;

    // IMMEDIATELY move jobs to 'processing' state
    // This prevents editing and shows them in the processing section right away
    const jobIds = pendingJobs.map(job => job.id);
    jobIds.forEach(id => this.updateJobState(id, 'processing'));
    console.log(`[QueueService] Moved ${jobIds.length} jobs to processing state`);

    // Convert to backend format
    const backendJobs: BackendJobRequest[] = pendingJobs.map(job => {
      const tasks = this.convertTasksToBackendFormat(job.tasks, !!job.url);

      if (job.url) {
        return {
          url: job.url,
          displayName: job.title,
          libraryId,
          tasks
        };
      } else {
        return {
          videoId: job.videoId || job.id,
          displayName: job.title,
          libraryId,
          tasks
        };
      }
    });

    return this.libraryService.createBulkJobs(backendJobs).pipe(
      map(response => {
        const frontendToBackend = new Map<string, string>();

        if (response.success) {
          const jobIds = response.data.jobIds;

          pendingJobs.forEach((job, index) => {
            if (index < jobIds.length) {
              const backendJobId = jobIds[index];
              this.setBackendJobId(job.id, backendJobId);
              frontendToBackend.set(job.id, backendJobId);
            }
          });

          console.log(`[QueueService] ${jobIds.length} jobs submitted to backend`);
        } else {
          console.error('[QueueService] Failed to create jobs');
          // Revert jobs back to pending so user can try again
          pendingJobs.forEach(job => {
            this.updateJobState(job.id, 'pending');
            this.updateJobError(job.id, 'Failed to submit job to backend');
          });
        }

        return frontendToBackend;
      }),
      catchError(error => {
        console.error('[QueueService] Failed to submit jobs:', error);
        // Revert jobs back to pending so user can try again
        pendingJobs.forEach(job => {
          this.updateJobState(job.id, 'pending');
          this.updateJobError(job.id, error.message || 'Unknown error');
        });
        return of(new Map<string, string>());
      })
    );
  }

  /**
   * Restore processing jobs from backend on initialization
   */
  private async restoreFromBackend(): Promise<void> {
    console.log('[QueueService] Restoring jobs from backend...');
    try {
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/queue/jobs`)
      );

      if (response.success && Array.isArray(response.jobs)) {
        const backendJobs = response.jobs;
        console.log(`[QueueService] Found ${backendJobs.length} backend jobs`);

        // Create a set of backend job IDs for quick lookup
        const backendJobIds = new Set(backendJobs.map((j: any) => j.id));

        // First: Reset orphaned processing jobs to pending
        // These are jobs that were processing when the app closed, but the backend
        // no longer has them (e.g., backend restarted and lost its in-memory queue)
        const currentJobs = this.jobs();
        let orphanedCount = 0;
        currentJobs.forEach(job => {
          if (job.state === 'processing' && job.backendJobId && !backendJobIds.has(job.backendJobId)) {
            console.log(`[QueueService] Resetting orphaned processing job to pending: ${job.id} (backend: ${job.backendJobId})`);
            this.updateJobState(job.id, 'pending');
            // Clear the backend job ID since it no longer exists
            this.frontendToBackendIdMap.delete(job.id);
            this.backendToFrontendIdMap.delete(job.backendJobId);
            job.backendJobId = undefined;
            // Reset task states too
            job.tasks.forEach(task => {
              if (task.state === 'running') {
                this.updateTaskState(job.id, task.type, 'pending');
              }
            });
            orphanedCount++;
          }
        });
        if (orphanedCount > 0) {
          console.log(`[QueueService] Reset ${orphanedCount} orphaned processing jobs to pending`);
        }

        // Second: Sync with backend jobs
        backendJobs.forEach((backendJob: any) => {
          // Check if we already have this job (by backend ID)
          const existingJob = this.jobs().find(j => j.backendJobId === backendJob.id);
          if (existingJob) {
            // Update existing job state
            const newState = this.mapBackendStatus(backendJob.status);
            if (existingJob.state !== newState) {
              this.updateJobState(existingJob.id, newState);
            }
          } else {
            // Create new job from backend data
            const frontendJob = this.mapBackendToFrontendJob(backendJob);
            this.setBackendJobId(frontendJob.id, backendJob.id);
            this.jobs.update(jobs => [...jobs, frontendJob]);
          }
        });

        console.log(`[QueueService] Queue restored with ${this.jobs().length} total jobs`);
      } else {
        // Backend returned no jobs - reset any processing jobs to pending
        const currentJobs = this.jobs();
        let resetCount = 0;
        currentJobs.forEach(job => {
          if (job.state === 'processing') {
            console.log(`[QueueService] No backend jobs - resetting processing job to pending: ${job.id}`);
            this.updateJobState(job.id, 'pending');
            if (job.backendJobId) {
              this.frontendToBackendIdMap.delete(job.id);
              this.backendToFrontendIdMap.delete(job.backendJobId);
              job.backendJobId = undefined;
            }
            job.tasks.forEach(task => {
              if (task.state === 'running') {
                this.updateTaskState(job.id, task.type, 'pending');
              }
            });
            resetCount++;
          }
        });
        if (resetCount > 0) {
          console.log(`[QueueService] Reset ${resetCount} processing jobs to pending (no backend jobs found)`);
        }
      }
    } catch (error) {
      console.error('[QueueService] Failed to restore from backend:', error);
      // On error, also reset processing jobs to pending so user can retry
      const currentJobs = this.jobs();
      currentJobs.forEach(job => {
        if (job.state === 'processing') {
          console.log(`[QueueService] Backend error - resetting processing job to pending: ${job.id}`);
          this.updateJobState(job.id, 'pending');
          job.tasks.forEach(task => {
            if (task.state === 'running') {
              this.updateTaskState(job.id, task.type, 'pending');
            }
          });
        }
      });
    }
  }

  // ==================== WEBSOCKET HANDLERS ====================

  private setupWebSocketHandlers(): void {
    this.websocketService.connect();

    this.wsUnsubscribes.push(
      this.websocketService.onTaskStarted(event => this.handleTaskStarted(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskProgress(event => this.handleTaskProgress(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskCompleted(event => this.handleTaskCompleted(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskFailed(event => this.handleTaskFailed(event))
    );
  }

  private handleTaskStarted(event: TaskStarted): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) {
      console.log('[QueueService] task.started for unknown job:', event.jobId);
      return;
    }

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    console.log(`[QueueService] Task started: ${taskType} for job ${jobId}`);

    // Update job to processing state
    this.updateJobState(jobId, 'processing');

    // Update task state (unless it's a sub-task like get-info or import)
    if (!['get-info', 'import'].includes(event.type)) {
      this.updateTaskState(jobId, taskType, 'running');
    }
  }

  private handleTaskProgress(event: TaskProgress): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) return;

    const taskType = this.mapBackendToFrontendTaskType(event.type || '');
    const progress = event.progress === -1 ? 0 : event.progress;

    // Handle process-video which combines aspect-ratio and normalize-audio
    if (event.type === 'process-video') {
      this.updateTaskProgress(jobId, 'fix-aspect-ratio', progress, event.eta, event.taskLabel);
      this.updateTaskProgress(jobId, 'normalize-audio', progress, event.eta, event.taskLabel);
    } else {
      this.updateTaskProgress(jobId, taskType, progress, event.eta, event.taskLabel);
    }
  }

  private handleTaskCompleted(event: TaskCompleted): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) {
      console.log('[QueueService] task.completed for unknown job:', event.jobId);
      return;
    }

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    console.log(`[QueueService] Task completed: ${taskType} for job ${jobId}`);

    // Capture videoId from the event if present (sent by backend after import)
    if (event.videoId) {
      this.updateJobVideoId(jobId, event.videoId);
    }

    // Handle process-video which combines aspect-ratio and normalize-audio
    if (event.type === 'process-video') {
      this.updateTaskState(jobId, 'fix-aspect-ratio', 'completed');
      this.updateTaskState(jobId, 'normalize-audio', 'completed');
    } else {
      this.updateTaskState(jobId, taskType, 'completed');
    }

    // Check if all tasks are completed
    const job = this.jobs().find(j => j.id === jobId);
    if (job && areAllTasksDone(job)) {
      const finalState = hasFailedTask(job) ? 'failed' : 'completed';
      this.updateJobState(jobId, finalState);
      console.log(`[QueueService] Job ${jobId} ${finalState}`);
    }
  }

  private handleTaskFailed(event: TaskFailed): void {
    const jobId = this.backendToFrontendIdMap.get(event.jobId);
    if (!jobId) {
      console.log('[QueueService] task.failed for unknown job:', event.jobId);
      return;
    }

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    const errorMessage = event.error?.message || 'Unknown error';
    console.log(`[QueueService] Task failed: ${taskType} for job ${jobId}: ${errorMessage}`);

    // Handle process-video which combines aspect-ratio and normalize-audio
    if (event.type === 'process-video') {
      this.updateTaskState(jobId, 'fix-aspect-ratio', 'failed', errorMessage);
      this.updateTaskState(jobId, 'normalize-audio', 'failed', errorMessage);
    } else {
      this.updateTaskState(jobId, taskType, 'failed', errorMessage);
    }

    // Mark job as failed
    this.updateJobState(jobId, 'failed');
    this.updateJobError(jobId, errorMessage);
  }

  // ==================== PERSISTENCE ====================

  private loadFromStorage(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;

      const jobs: QueueJob[] = JSON.parse(saved);
      const now = Date.now();

      // Filter out expired completed jobs
      const validJobs = jobs.filter(job => {
        // Keep pending/processing jobs
        if (job.state === 'pending' || job.state === 'processing') {
          return true;
        }
        // Keep completed/failed jobs within retention period
        if (job.completedAt) {
          return now - job.completedAt < RETENTION_MS;
        }
        // If no completedAt, use createdAt as fallback
        return now - job.createdAt < RETENTION_MS;
      });

      // Restore ID mappings
      validJobs.forEach(job => {
        if (job.backendJobId) {
          this.backendToFrontendIdMap.set(job.backendJobId, job.id);
          this.frontendToBackendIdMap.set(job.id, job.backendJobId);
        }
      });

      this.jobs.set(validJobs);
      console.log(`[QueueService] Loaded ${validJobs.length} jobs from storage (${jobs.length - validJobs.length} expired)`);
    } catch (error) {
      console.error('[QueueService] Failed to load from storage:', error);
    }
  }

  private saveToStorage(jobs: QueueJob[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    } catch (error) {
      console.error('[QueueService] Failed to save to storage:', error);
    }
  }

  // ==================== HELPERS ====================

  /**
   * Map backend task type to frontend TaskType
   */
  private mapBackendToFrontendTaskType(backendType: string): TaskType {
    const mapping: Record<string, TaskType> = {
      'download': 'download-import',
      'get-info': 'download-import',
      'import': 'download-import',
      'fix-aspect': 'fix-aspect-ratio',
      'fix-aspect-ratio': 'fix-aspect-ratio',
      'process-video': 'fix-aspect-ratio',
      'normalize': 'normalize-audio',
      'normalize-audio': 'normalize-audio',
      'transcribe': 'transcribe',
      'analyze': 'ai-analyze'
    };

    return mapping[backendType] || 'download-import';
  }

  /**
   * Map backend job status to frontend JobState
   */
  private mapBackendStatus(backendStatus: string): JobState {
    switch (backendStatus) {
      case 'pending':
        return 'pending';
      case 'processing':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'cancelled':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Convert backend job to frontend QueueJob
   */
  private mapBackendToFrontendJob(backendJob: any): QueueJob {
    const tasks: QueueTask[] = this.mapBackendTasksToFrontend(
      backendJob.tasks || [],
      backendJob.currentTaskIndex
    );

    return createQueueJob({
      title: backendJob.displayName || 'Unknown',
      state: this.mapBackendStatus(backendJob.status),
      url: backendJob.url,
      videoId: backendJob.videoId,
      videoPath: backendJob.videoPath,
      backendJobId: backendJob.id,
      tasks,
      createdAt: new Date(backendJob.createdAt).getTime(),
      startedAt: backendJob.startedAt ? new Date(backendJob.startedAt).getTime() : undefined,
      completedAt: backendJob.completedAt ? new Date(backendJob.completedAt).getTime() : undefined
    });
  }

  /**
   * Map backend tasks to frontend format
   */
  private mapBackendTasksToFrontend(backendTasks: any[], currentTaskIndex: number): QueueTask[] {
    const frontendTasks: QueueTask[] = [];
    const seenTypes = new Set<TaskType>();

    // Group download-related tasks into single task
    const downloadTaskTypes = ['get-info', 'download', 'import'];
    const hasDownloadTasks = backendTasks.some(t => downloadTaskTypes.includes(t.type));

    if (hasDownloadTasks) {
      let downloadState: TaskState = 'pending';
      let downloadProgress = 0;

      for (let i = 0; i < backendTasks.length; i++) {
        const task = backendTasks[i];
        if (!downloadTaskTypes.includes(task.type)) continue;

        if (i < currentTaskIndex) {
          downloadState = 'completed';
          downloadProgress = 100;
        } else if (i === currentTaskIndex) {
          downloadState = 'running';
          if (task.type === 'download') {
            downloadProgress = task.progress || 0;
          }
        }
      }

      frontendTasks.push({
        type: 'download-import',
        options: {},
        state: downloadState,
        progress: downloadProgress
      });
      seenTypes.add('download-import');
    }

    // Add other tasks
    for (let i = 0; i < backendTasks.length; i++) {
      const backendTask = backendTasks[i];
      if (downloadTaskTypes.includes(backendTask.type)) continue;

      const taskType = this.mapBackendToFrontendTaskType(backendTask.type);
      if (seenTypes.has(taskType)) continue;
      seenTypes.add(taskType);

      let state: TaskState = 'pending';
      if (i < currentTaskIndex) {
        state = 'completed';
      } else if (i === currentTaskIndex) {
        state = 'running';
      }

      frontendTasks.push({
        type: taskType,
        options: backendTask.options || {},
        state,
        progress: state === 'completed' ? 100 : (state === 'running' ? backendTask.progress || 0 : 0)
      });
    }

    return frontendTasks;
  }

  /**
   * Convert frontend tasks to backend format
   */
  private convertTasksToBackendFormat(tasks: QueueTask[], isUrl: boolean): BackendTask[] {
    const backendTasks: BackendTask[] = [];

    if (isUrl) {
      backendTasks.push({ type: 'get-info' });
      backendTasks.push({ type: 'download' });
      backendTasks.push({ type: 'import' });
    }

    const hasAspectRatio = tasks.some(t => t.type === 'fix-aspect-ratio');
    const hasNormalizeAudio = tasks.some(t => t.type === 'normalize-audio');

    // Combine aspect-ratio and normalize-audio into single process-video task
    if (hasAspectRatio && hasNormalizeAudio) {
      const aspectTask = tasks.find(t => t.type === 'fix-aspect-ratio');
      const audioTask = tasks.find(t => t.type === 'normalize-audio');
      backendTasks.push({
        type: 'process-video',
        options: {
          fixAspectRatio: true,
          normalizeAudio: true,
          level: audioTask?.options?.['targetLevel'] || -16
        }
      });
    } else if (hasAspectRatio) {
      const task = tasks.find(t => t.type === 'fix-aspect-ratio');
      backendTasks.push({
        type: 'fix-aspect-ratio',
        options: {
          aspectRatio: task?.options?.['targetRatio'] || '16:9'
        }
      });
    } else if (hasNormalizeAudio) {
      const task = tasks.find(t => t.type === 'normalize-audio');
      backendTasks.push({
        type: 'normalize-audio',
        options: {
          level: task?.options?.['targetLevel'] || -16
        }
      });
    }

    const transcribeTask = tasks.find(t => t.type === 'transcribe');
    if (transcribeTask) {
      backendTasks.push({
        type: 'transcribe',
        options: {
          model: transcribeTask.options?.['model'] || 'base',
          language: transcribeTask.options?.['language']
        }
      });
    }

    const analyzeTask = tasks.find(t => t.type === 'ai-analyze');
    if (analyzeTask) {
      if (!analyzeTask.options?.['aiModel']) {
        throw new Error('AI analysis requires an AI model to be selected.');
      }

      // Parse provider:model string
      const modelValue = analyzeTask.options['aiModel'];
      let aiProvider = 'ollama';
      let aiModel = modelValue;

      if (modelValue.includes(':')) {
        const firstColon = modelValue.indexOf(':');
        const possibleProvider = modelValue.substring(0, firstColon);
        if (['ollama', 'claude', 'openai', 'local'].includes(possibleProvider)) {
          aiProvider = possibleProvider;
          aiModel = modelValue.substring(firstColon + 1);
        }
      }

      backendTasks.push({
        type: 'analyze',
        options: {
          aiModel,
          aiProvider,
          customInstructions: analyzeTask.options?.['customInstructions'],
          analysisGranularity: analyzeTask.options?.['analysisGranularity'] ?? 5,
          analysisQuality: analyzeTask.options?.['analysisQuality'] || 'fast'
        }
      });
    }

    return backendTasks;
  }
}
