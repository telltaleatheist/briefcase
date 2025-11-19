import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { VideoJob, VideoTask, VideoJobSettings, QueueStats, ProcessingWebSocketMessage } from '../models/video-processing.model';
import { WebsocketService, TaskStarted, TaskProgress, TaskCompleted, TaskFailed } from './websocket.service';
import { LibraryService, BackendJobRequest, BackendTask, BackendTaskType } from './library.service';

@Injectable({
  providedIn: 'root'
})
export class VideoProcessingService {
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
   */
  processQueue(): void {
    const queuedJobs = this.jobs$.value.filter(j => j.status === 'queued');
    if (queuedJobs.length === 0) return;

    // Convert jobs to backend format
    const backendJobs: BackendJobRequest[] = queuedJobs.map(job => {
      const tasks = this.convertSettingsToBackendTasksWithOptions(job.settings, !!job.videoUrl);

      if (job.videoUrl) {
        return {
          url: job.videoUrl,
          displayName: job.videoName,
          tasks
        };
      } else {
        return {
          videoId: job.videoId || job.id, // Use actual video ID from library
          displayName: job.videoName,
          tasks
        };
      }
    });

    // Submit to backend
    this.libraryService.createBulkJobs(backendJobs).subscribe({
      next: (response) => {
        if (response.success) {
          const jobIds = response.data.jobIds;

          // Map backend job IDs to frontend job IDs
          queuedJobs.forEach((job, index) => {
            if (index < jobIds.length) {
              this.jobIdMap.set(jobIds[index], job.id);
            }
          });

          console.log(`${jobIds.length} jobs submitted to backend`);
        } else {
          console.error('Failed to create jobs');
        }
      },
      error: (error) => {
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
      }
    });
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
          audioLevel: settings.audioLevel
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
      tasks.push({
        type: 'analyze',
        options: {
          aiModel: settings.aiModel || 'llama3',
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

  updateJobFromTaskTypes(jobId: string, taskTypes: string[]): void {
    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (job && job.status === 'queued') {
      // Convert task types to settings
      job.settings = {
        ...job.settings,
        fixAspectRatio: taskTypes.includes('fix-aspect-ratio'),
        normalizeAudio: taskTypes.includes('normalize-audio'),
        transcribe: taskTypes.includes('transcribe'),
        aiAnalysis: taskTypes.includes('ai-analyze')
      };
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