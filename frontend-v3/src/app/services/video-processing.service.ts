import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, of, firstValueFrom } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { VideoJob, VideoTask, VideoJobSettings, QueueStats, ProcessingWebSocketMessage } from '../models/video-processing.model';
import { WebsocketService, TaskStarted, TaskProgress, TaskCompleted, TaskFailed } from './websocket.service';
import { LibraryService, BackendJobRequest, BackendTask, BackendTaskType } from './library.service';

@Injectable({
  providedIn: 'root'
})
export class VideoProcessingService {
  private readonly API_BASE = 'http://localhost:3000/api';

  private http = inject(HttpClient);
  private websocketService = inject(WebsocketService);
  private libraryService = inject(LibraryService);

  private jobs$ = new BehaviorSubject<VideoJob[]>([]);
  private activeJobId$ = new BehaviorSubject<string | null>(null);
  private queueStats$ = new BehaviorSubject<QueueStats>(this.calculateStats([]));
  private progressUpdates$ = new Subject<ProcessingWebSocketMessage>();

  // Map backend job IDs to frontend job IDs
  private jobIdMap = new Map<string, string>();
  private wsUnsubscribes: (() => void)[] = [];

  constructor() {
    // Connect to WebSocket and set up event handlers
    this.setupWebSocket();

    // Restore queue from backend on initialization
    this.restoreQueueFromBackend();
  }

  private setupWebSocket(): void {
    this.websocketService.connect();

    // Subscribe to task events
    this.wsUnsubscribes.push(
      this.websocketService.onTaskStarted((event) => this.handleTaskStarted(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskProgress((event) => this.handleTaskProgress(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskCompleted((event) => this.handleTaskCompleted(event))
    );
    this.wsUnsubscribes.push(
      this.websocketService.onTaskFailed((event) => this.handleTaskFailed(event))
    );
  }

  /**
   * Restore queue from backend on initialization
   * This ensures queue persists across page refreshes
   */
  private async restoreQueueFromBackend(): Promise<void> {
    console.log('[VideoProcessingService] Starting queue restoration...');
    try {
      console.log(`[VideoProcessingService] Fetching from ${this.API_BASE}/queue/jobs`);
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/queue/jobs`)
      );

      console.log('[VideoProcessingService] Response received:', response);

      if (response.success && Array.isArray(response.jobs)) {
        const backendJobs = response.jobs;
        console.log(`[VideoProcessingService] Found ${backendJobs.length} backend jobs:`, backendJobs);

        // Convert backend jobs to frontend format
        const frontendJobs: VideoJob[] = backendJobs.map((backendJob: any) => {
          const frontendJob = this.mapBackendToFrontendJob(backendJob);

          // Map backend job ID to frontend job ID for WebSocket updates
          this.jobIdMap.set(backendJob.id, frontendJob.id);

          return frontendJob;
        });

        console.log(`[VideoProcessingService] Converted to ${frontendJobs.length} frontend jobs:`, frontendJobs);

        // Update the jobs observable
        this.jobs$.next(frontendJobs);
        this.updateStats();
        console.log('[VideoProcessingService] Updated jobs$ observable');

        // Determine active job
        const activeJob = frontendJobs.find(j => j.status === 'processing');
        if (activeJob) {
          this.activeJobId$.next(activeJob.id);
          console.log('[VideoProcessingService] Set active job:', activeJob.id);
        }

        console.log(`✅ [VideoProcessingService] Restored ${frontendJobs.length} jobs from backend queue`);
      } else {
        console.log('[VideoProcessingService] No jobs to restore or invalid response');
      }
    } catch (error) {
      console.error('❌ [VideoProcessingService] Failed to restore queue from backend:', error);
      // Don't throw - allow the app to continue with empty queue
    }
  }

  /**
   * Map a backend QueueJob to frontend VideoJob format
   */
  private mapBackendToFrontendJob(backendJob: any): VideoJob {
    // Create frontend job structure
    const frontendJob: VideoJob = {
      id: this.generateId(), // Generate new frontend ID
      videoId: backendJob.videoId,
      videoUrl: backendJob.url,
      videoPath: backendJob.videoPath,
      videoName: backendJob.displayName || 'Unknown',
      status: this.mapBackendStatus(backendJob.status),
      addedAt: new Date(backendJob.createdAt),
      startedAt: backendJob.startedAt ? new Date(backendJob.startedAt) : undefined,
      completedAt: backendJob.completedAt ? new Date(backendJob.completedAt) : undefined,
      settings: this.extractSettingsFromBackendJob(backendJob),
      tasks: this.mapBackendTasksToFrontend(backendJob.tasks, backendJob.currentTaskIndex),
      progress: backendJob.progress || 0
    };

    return frontendJob;
  }

  /**
   * Map backend job status to frontend status
   */
  private mapBackendStatus(backendStatus: string): VideoJob['status'] {
    switch (backendStatus) {
      case 'pending':
        return 'queued';
      case 'processing':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'cancelled':
        return 'failed';
      default:
        return 'queued';
    }
  }

  /**
   * Extract settings from backend job tasks
   */
  private extractSettingsFromBackendJob(backendJob: any): VideoJobSettings {
    const tasks = backendJob.tasks || [];
    const settings: VideoJobSettings = {
      fixAspectRatio: false,
      normalizeAudio: false,
      transcribe: false,
      aiAnalysis: false
    };

    tasks.forEach((task: any) => {
      switch (task.type) {
        case 'fix-aspect-ratio':
          settings.fixAspectRatio = true;
          settings.aspectRatio = task.options?.aspectRatio || '16:9';
          break;
        case 'normalize-audio':
          settings.normalizeAudio = true;
          settings.audioLevel = task.options?.audioLevel;
          break;
        case 'transcribe':
          settings.transcribe = true;
          settings.whisperModel = task.options?.model || 'base';
          settings.whisperLanguage = task.options?.language;
          break;
        case 'analyze':
          settings.aiAnalysis = true;
          settings.aiModel = task.options?.aiModel;
          settings.customInstructions = task.options?.customInstructions;
          break;
      }
    });

    return settings;
  }

  /**
   * Map backend tasks to frontend task format with current status
   */
  private mapBackendTasksToFrontend(backendTasks: any[], currentTaskIndex: number): VideoTask[] {
    return backendTasks.map((backendTask: any, index: number) => {
      const taskType = this.mapBackendToFrontendTaskType(backendTask.type);
      let status: VideoTask['status'] = 'pending';

      if (index < currentTaskIndex) {
        status = 'completed';
      } else if (index === currentTaskIndex) {
        status = 'in-progress';
      }

      return {
        id: this.generateId(),
        type: taskType,
        name: this.getTaskName(taskType, backendTask.options),
        status,
        progress: status === 'completed' ? 100 : (status === 'in-progress' ? 0 : 0),
        estimatedTime: this.getEstimatedTime(taskType)
      };
    });
  }

  /**
   * Get human-readable task name
   */
  private getTaskName(taskType: VideoTask['type'], options?: any): string {
    switch (taskType) {
      case 'download':
        return 'Download Video';
      case 'import':
        return 'Import to Database';
      case 'aspect-ratio':
        return `Fix Aspect Ratio (${options?.aspectRatio || '16:9'})`;
      case 'normalize-audio':
        return 'Normalize Audio';
      case 'transcribe':
        return `Transcribe (${options?.model || 'base'})`;
      case 'ai-analysis':
        return `AI Analysis (${options?.aiModel || 'Unknown'})`;
      default:
        return 'Unknown Task';
    }
  }

  /**
   * Get estimated time for a task type
   */
  private getEstimatedTime(taskType: VideoTask['type']): number {
    switch (taskType) {
      case 'download':
        return 30;
      case 'import':
        return 10;
      case 'aspect-ratio':
        return 45;
      case 'normalize-audio':
        return 20;
      case 'transcribe':
        return 60;
      case 'ai-analysis':
        return 30;
      default:
        return 15;
    }
  }

  private handleTaskStarted(event: TaskStarted): void {
    const jobId = this.jobIdMap.get(event.jobId);
    if (!jobId) return;

    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    const task = job.tasks.find(t => t.type === taskType);
    if (task) {
      task.status = 'in-progress';
      task.startedAt = new Date();
      task.progress = 0;
    }

    job.status = 'processing';
    if (!job.startedAt) {
      job.startedAt = new Date();
    }
    this.activeJobId$.next(jobId);

    this.jobs$.next([...jobs]);
    this.updateStats();
  }

  private handleTaskProgress(event: TaskProgress): void {
    const jobId = this.jobIdMap.get(event.jobId);
    if (!jobId) return;

    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    const task = job.tasks.find(t => t.type === taskType);
    if (task) {
      task.progress = event.progress === -1 ? 0 : event.progress;
    }

    // Update overall job progress
    this.updateJobProgress(job);

    this.jobs$.next([...jobs]);
    this.updateStats();

    // Emit progress update
    this.progressUpdates$.next({
      jobId,
      taskId: task?.id,
      type: 'progress',
      data: { progress: event.progress, status: 'in-progress' }
    });
  }

  private handleTaskCompleted(event: TaskCompleted): void {
    const jobId = this.jobIdMap.get(event.jobId);
    if (!jobId) return;

    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    const task = job.tasks.find(t => t.type === taskType);
    if (task) {
      task.status = 'completed';
      task.progress = 100;
      task.completedAt = new Date();
    }

    // Check if all tasks are completed
    if (job.tasks.every(t => t.status === 'completed')) {
      job.status = 'completed';
      job.completedAt = new Date();
      job.progress = 100;
      this.activeJobId$.next(null);

      // Remove completed job from the jobs list after a short delay
      // This prevents the flash of the item reappearing
      setTimeout(() => {
        const currentJobs = this.jobs$.value;
        const filteredJobs = currentJobs.filter(j => j.id !== jobId);
        this.jobs$.next(filteredJobs);
        this.updateStats();
        console.log('Removed completed job from VideoProcessingService:', jobId);
      }, 500);
    } else {
      this.updateJobProgress(job);
    }

    this.jobs$.next([...jobs]);
    this.updateStats();
  }

  private handleTaskFailed(event: TaskFailed): void {
    const jobId = this.jobIdMap.get(event.jobId);
    if (!jobId) return;

    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    const taskType = this.mapBackendToFrontendTaskType(event.type);
    const task = job.tasks.find(t => t.type === taskType);
    if (task) {
      task.status = 'failed';
      task.error = event.error?.message || 'Unknown error';
    }

    job.status = 'failed';
    this.activeJobId$.next(null);

    this.jobs$.next([...jobs]);
    this.updateStats();
  }

  private mapBackendToFrontendTaskType(backendType: string | undefined): VideoTask['type'] {
    if (!backendType) return 'import';

    const mapping: Record<string, VideoTask['type']> = {
      'analyze': 'ai-analysis',
      'download': 'download',
      'import': 'import',
      'fix-aspect': 'aspect-ratio',
      'fix-aspect-ratio': 'aspect-ratio',
      'normalize': 'normalize-audio',
      'normalize-audio': 'normalize-audio',
      'transcribe': 'transcribe'
    };

    return mapping[backendType] || 'import';
  }

  private updateJobProgress(job: VideoJob): void {
    const totalTasks = job.tasks.length;
    if (totalTasks === 0) {
      job.progress = 0;
      return;
    }

    const completedTasks = job.tasks.filter(t => t.status === 'completed').length;
    const inProgressTask = job.tasks.find(t => t.status === 'in-progress');
    const inProgressContribution = inProgressTask ? (inProgressTask.progress / 100) : 0;

    job.progress = ((completedTasks + inProgressContribution) / totalTasks) * 100;
  }

  getJobs(): Observable<VideoJob[]> {
    return this.jobs$.asObservable();
  }

  getActiveJobId(): Observable<string | null> {
    return this.activeJobId$.asObservable();
  }

  getQueueStats(): Observable<QueueStats> {
    return this.queueStats$.asObservable();
  }

  getProgressUpdates(): Observable<ProcessingWebSocketMessage> {
    return this.progressUpdates$.asObservable();
  }

  /**
   * Translate a backend job ID to the corresponding frontend job ID
   */
  getFrontendJobId(backendJobId: string): string | undefined {
    return this.jobIdMap.get(backendJobId);
  }

  addJob(videoUrl: string, videoName: string, settings: VideoJobSettings, videoId?: string, videoPath?: string): VideoJob {
    const job: VideoJob = {
      id: this.generateId(),
      videoId, // Store the actual video ID from library
      videoUrl,
      videoPath,
      videoName,
      status: 'queued',
      addedAt: new Date(),
      settings,
      tasks: this.createTasks(settings, !!videoUrl),
      progress: 0
    };

    const currentJobs = this.jobs$.value;
    this.jobs$.next([...currentJobs, job]);
    this.updateStats();

    return job;
  }

  /**
   * Process all queued jobs by sending them to the backend
   * Returns an Observable that emits a map of frontend job ID -> backend job ID
   */
  processQueue(): Observable<Map<string, string>> {
    const queuedJobs = this.jobs$.value.filter(j => j.status === 'queued');
    if (queuedJobs.length === 0) return of(new Map());

    // Get current library ID
    const currentLibrary = this.libraryService.currentLibrary();
    const libraryId = currentLibrary?.id;

    // Convert jobs to backend format
    const backendJobs: BackendJobRequest[] = queuedJobs.map(job => {
      const tasks = this.convertSettingsToBackendTasksWithOptions(job.settings, !!job.videoUrl);

      if (job.videoUrl) {
        return {
          url: job.videoUrl,
          displayName: job.videoName,
          libraryId, // Pass library ID for downloads
          tasks
        };
      } else {
        return {
          videoId: job.videoId || job.id, // Use actual video ID from library
          displayName: job.videoName,
          libraryId,
          tasks
        };
      }
    });

    // Submit to backend and return the job ID mapping
    return this.libraryService.createBulkJobs(backendJobs).pipe(
      map((response) => {
        const frontendToBackend = new Map<string, string>();

        if (response.success) {
          const jobIds = response.data.jobIds;

          // Map backend job IDs to frontend job IDs
          queuedJobs.forEach((job, index) => {
            if (index < jobIds.length) {
              this.jobIdMap.set(jobIds[index], job.id);
              frontendToBackend.set(job.id, jobIds[index]);
            }
          });

          console.log(`${jobIds.length} jobs submitted to backend`);
        } else {
          console.error('Failed to create jobs');
        }

        return frontendToBackend;
      }),
      catchError((error) => {
        console.error('Failed to submit jobs:', error);
        // Mark jobs as failed
        const jobs = this.jobs$.value;
        queuedJobs.forEach(qj => {
          const job = jobs.find(j => j.id === qj.id);
          if (job) {
            job.status = 'failed';
          }
        });
        this.jobs$.next([...jobs]);
        this.updateStats();
        return of(new Map<string, string>());
      })
    );
  }

  private convertSettingsToBackendTasks(settings: VideoJobSettings, isUrl: boolean): string[] {
    const tasks: string[] = [];

    if (isUrl) {
      tasks.push('download');
    }

    if (settings.fixAspectRatio) {
      tasks.push('fix-aspect-ratio');
    }

    if (settings.normalizeAudio) {
      tasks.push('normalize-audio');
    }

    if (settings.transcribe) {
      tasks.push('transcribe');
    }

    if (settings.aiAnalysis) {
      tasks.push('analyze');
    }

    return tasks;
  }

  private convertSettingsToBackendTasksWithOptions(settings: VideoJobSettings, isUrl: boolean): BackendTask[] {
    const tasks: BackendTask[] = [];

    if (isUrl) {
      tasks.push({ type: 'download' });
      tasks.push({ type: 'import' });
    }

    if (settings.fixAspectRatio) {
      tasks.push({
        type: 'fix-aspect-ratio',
        options: {
          aspectRatio: settings.aspectRatio || '16:9'
        }
      });
    }

    if (settings.normalizeAudio) {
      tasks.push({
        type: 'normalize-audio',
        options: {
          level: settings.audioLevel
        }
      });
    }

    if (settings.transcribe) {
      tasks.push({
        type: 'transcribe',
        options: {
          model: settings.whisperModel || 'base',
          language: settings.whisperLanguage
        }
      });
    }

    if (settings.aiAnalysis) {
      // Parse model string: "provider:model" (e.g., "ollama:cogito:14b")
      const modelValue = settings.aiModel || 'ollama:qwen2.5:7b';
      let aiProvider = 'ollama';
      let aiModel = modelValue;

      if (modelValue.includes(':')) {
        const firstColon = modelValue.indexOf(':');
        const possibleProvider = modelValue.substring(0, firstColon);
        if (['ollama', 'claude', 'openai'].includes(possibleProvider)) {
          aiProvider = possibleProvider;
          aiModel = modelValue.substring(firstColon + 1);
        }
      }

      console.log('Sending to backend - provider:', aiProvider, 'model:', aiModel);
      tasks.push({
        type: 'analyze',
        options: {
          aiModel,
          aiProvider,
          customInstructions: settings.customInstructions
        }
      });
    }

    return tasks;
  }

  private createTasks(settings: VideoJobSettings, isUrl: boolean): VideoTask[] {
    const tasks: VideoTask[] = [];

    if (isUrl) {
      tasks.push({
        id: this.generateId(),
        type: 'download',
        name: 'Download Video',
        status: 'pending',
        progress: 0,
        estimatedTime: 30
      });

      tasks.push({
        id: this.generateId(),
        type: 'import',
        name: 'Import to Database',
        status: 'pending',
        progress: 0,
        estimatedTime: 10
      });
    }

    if (settings.fixAspectRatio) {
      tasks.push({
        id: this.generateId(),
        type: 'aspect-ratio',
        name: `Fix Aspect Ratio (${settings.aspectRatio || '16:9'})`,
        status: 'pending',
        progress: 0,
        estimatedTime: 45
      });
    }

    if (settings.normalizeAudio) {
      tasks.push({
        id: this.generateId(),
        type: 'normalize-audio',
        name: 'Normalize Audio',
        status: 'pending',
        progress: 0,
        estimatedTime: 20
      });
    }

    if (settings.transcribe) {
      tasks.push({
        id: this.generateId(),
        type: 'transcribe',
        name: `Transcribe (${settings.whisperModel || 'base'})`,
        status: 'pending',
        progress: 0,
        estimatedTime: 60
      });
    }

    if (settings.aiAnalysis) {
      tasks.push({
        id: this.generateId(),
        type: 'ai-analysis',
        name: `AI Analysis (${settings.aiModel || 'gpt-3.5-turbo'})`,
        status: 'pending',
        progress: 0,
        estimatedTime: 30
      });
    }

    return tasks;
  }

  removeJob(jobId: string): void {
    const currentJobs = this.jobs$.value;
    this.jobs$.next(currentJobs.filter(job => job.id !== jobId));
    this.updateStats();
  }

  updateJobNameByUrl(url: string, name: string): void {
    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.videoUrl === url);
    if (job) {
      job.videoName = name;
      this.jobs$.next([...jobs]);
    }
  }

  pauseJob(jobId: string): void {
    this.updateJobStatus(jobId, 'paused');
  }

  resumeJob(jobId: string): void {
    this.updateJobStatus(jobId, 'queued');
  }

  retryJob(jobId: string): void {
    const job = this.jobs$.value.find(j => j.id === jobId);
    if (job) {
      job.status = 'queued';
      job.progress = 0;
      job.tasks.forEach(task => {
        task.status = 'pending';
        task.progress = 0;
        task.error = undefined;
      });
      this.jobs$.next([...this.jobs$.value]);
      this.updateStats();
    }
  }

  updateBatchSettings(jobIds: string[], settings: Partial<VideoJobSettings>): void {
    const jobs = this.jobs$.value;
    jobIds.forEach(id => {
      const job = jobs.find(j => j.id === id);
      if (job && job.status === 'queued') {
        job.settings = { ...job.settings, ...settings };
        job.tasks = this.createTasks(job.settings, !!job.videoUrl);
      }
    });
    this.jobs$.next([...jobs]);
  }

  updateJobFromTaskTypes(jobId: string, taskTypes: string[], taskConfigs?: Map<string, any>): void {
    console.log('updateJobFromTaskTypes called:', { jobId, taskTypes });
    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    console.log('Found job:', job ? { id: job.id, status: job.status } : 'NOT FOUND');
    if (job && job.status === 'queued') {
      console.log('Updating job settings...');
      // Convert task types to settings
      job.settings = {
        ...job.settings,
        fixAspectRatio: taskTypes.includes('fix-aspect-ratio'),
        normalizeAudio: taskTypes.includes('normalize-audio'),
        transcribe: taskTypes.includes('transcribe'),
        aiAnalysis: taskTypes.includes('ai-analyze')
      };

      // Extract config values if provided
      if (taskConfigs) {
        // Get transcribe config
        const transcribeConfig = taskConfigs.get('transcribe');
        if (transcribeConfig) {
          job.settings.whisperModel = transcribeConfig.model || 'base';
          job.settings.whisperLanguage = transcribeConfig.language;
        }

        // Get AI analyze config - keep full model string with provider
        const aiConfig = taskConfigs.get('ai-analyze');
        if (aiConfig && aiConfig.aiModel) {
          console.log('Saving AI model:', aiConfig.aiModel);
          job.settings.aiModel = aiConfig.aiModel;
          job.settings.customInstructions = aiConfig.customInstructions;
        }

        // Get fix aspect ratio config
        const aspectConfig = taskConfigs.get('fix-aspect-ratio');
        if (aspectConfig) {
          job.settings.aspectRatio = aspectConfig.targetRatio;
        }

        // Get normalize audio config
        const audioConfig = taskConfigs.get('normalize-audio');
        if (audioConfig) {
          job.settings.audioLevel = audioConfig.targetLevel;
        }
      }

      // Recreate tasks
      job.tasks = this.createTasks(job.settings, !!job.videoUrl);
      this.jobs$.next([...jobs]);
      this.updateStats();
    }
  }

  clearCompleted(): void {
    const currentJobs = this.jobs$.value;
    this.jobs$.next(currentJobs.filter(job => job.status !== 'completed'));
    this.updateStats();
  }

  clearAll(): void {
    this.jobs$.next([]);
    this.activeJobId$.next(null);
    this.updateStats();
  }

  private updateJobStatus(jobId: string, status: VideoJob['status']): void {
    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      job.status = status;
      if (status === 'completed') {
        job.completedAt = new Date();
      }
      this.jobs$.next([...jobs]);
      this.updateStats();
    }
  }

  private calculateStats(jobs: VideoJob[]): QueueStats {
    const stats: QueueStats = {
      totalJobs: jobs.length,
      completedJobs: jobs.filter(j => j.status === 'completed').length,
      failedJobs: jobs.filter(j => j.status === 'failed').length,
      processingJobs: jobs.filter(j => j.status === 'processing').length,
      queuedJobs: jobs.filter(j => j.status === 'queued').length,
      averageProcessingTime: 0,
      estimatedTimeRemaining: 0
    };

    // Calculate average processing time
    const completedJobs = jobs.filter(j => j.status === 'completed' && j.startedAt && j.completedAt);
    if (completedJobs.length > 0) {
      const totalTime = completedJobs.reduce((sum, job) => {
        return sum + (job.completedAt!.getTime() - job.startedAt!.getTime());
      }, 0);
      stats.averageProcessingTime = totalTime / completedJobs.length / 1000; // in seconds
    }

    // Estimate remaining time
    const pendingTasks = jobs
      .filter(j => j.status === 'queued' || j.status === 'processing')
      .flatMap(j => j.tasks)
      .filter(t => t.status === 'pending' || t.status === 'in-progress');

    stats.estimatedTimeRemaining = pendingTasks.reduce((sum, task) => sum + (task.estimatedTime || 0), 0);

    return stats;
  }

  private updateStats(): void {
    this.queueStats$.next(this.calculateStats(this.jobs$.value));
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }
}