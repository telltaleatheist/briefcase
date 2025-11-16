import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import {
  VideoProcessingJob,
  ChildProcess,
  AddVideoJobParams,
  ProcessType,
  getProcessDisplayName,
  ProcessTypeConfig,
  AIAnalysisConfig,
  TranscriptionConfig
} from '../models/video-processing.model';
import { SocketService } from './socket.service';
import { BackendUrlService } from './backend-url.service';

/**
 * Service for managing video processing jobs with hierarchical parent-child structure.
 * Each parent job represents one video with multiple child processes.
 */
@Injectable({
  providedIn: 'root'
})
export class VideoProcessingQueueService {
  private readonly STORAGE_KEY = 'video-processing-queue';
  private jobs = new BehaviorSubject<Map<string, VideoProcessingJob>>(new Map());
  public jobs$ = this.jobs.asObservable();

  // Event emitted when a new job is added (for auto-opening the queue panel)
  private jobAdded = new Subject<string>();
  public jobAdded$ = this.jobAdded.asObservable();

  private jobIdCounter = 0;

  constructor(
    private socketService: SocketService,
    private backendUrlService: BackendUrlService,
    private http: HttpClient
  ) {
    console.log('[VideoProcessingQueueService] Service initialized');
    this.loadFromCache();
    this.setupProgressListeners();
  }

  /**
   * Load jobs from localStorage cache
   */
  private loadFromCache(): void {
    try {
      const cached = localStorage.getItem(this.STORAGE_KEY);
      if (cached) {
        const jobsArray: VideoProcessingJob[] = JSON.parse(cached);
        const jobsMap = new Map<string, VideoProcessingJob>();

        jobsArray.forEach(job => {
          jobsMap.set(job.id, job);
        });

        this.jobs.next(jobsMap);
        console.log('[VideoProcessingQueueService] Loaded', jobsMap.size, 'jobs from cache');
      }
    } catch (error) {
      console.error('[VideoProcessingQueueService] Failed to load cache:', error);
    }
  }

  /**
   * Save jobs to localStorage cache
   */
  private saveToCache(): void {
    try {
      const jobsMap = this.jobs.getValue();
      const jobsArray = Array.from(jobsMap.values());
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(jobsArray));
      console.log('[VideoProcessingQueueService] Saved', jobsArray.length, 'jobs to cache');
    } catch (error) {
      console.error('[VideoProcessingQueueService] Failed to save cache:', error);
    }
  }

  /**
   * Get observable of all jobs
   */
  getJobs(): Observable<Map<string, VideoProcessingJob>> {
    return this.jobs$;
  }

  /**
   * Get current jobs synchronously
   */
  getCurrentJobs(): Map<string, VideoProcessingJob> {
    return this.jobs.getValue();
  }

  /**
   * Get a specific job by ID
   */
  getJob(jobId: string): VideoProcessingJob | undefined {
    return this.jobs.getValue().get(jobId);
  }

  /**
   * Add a new video processing job with multiple child processes
   */
  addVideoJob(params: AddVideoJobParams): string {
    const parentJobId = `video-job-${Date.now()}-${this.jobIdCounter++}`;

    console.log('[VideoProcessingQueueService] Adding new video job:', parentJobId, params);

    // Create child processes from process configurations
    const childProcesses: ChildProcess[] = params.processes.map((processConfig, index) => {
      const childId = `${parentJobId}-child-${index}`;

      const child: ChildProcess = {
        id: childId,
        type: processConfig.type,
        status: 'pending',
        progress: 0,
        displayName: getProcessDisplayName(processConfig.type),
      };

      // Add type-specific configuration
      if (processConfig.config) {
        this.applyProcessConfig(child, processConfig.type, processConfig.config);
      }

      return child;
    });

    const job: VideoProcessingJob = {
      id: parentJobId,
      videoId: params.videoId,
      videoPath: params.videoPath,
      displayName: params.displayName,
      childProcesses,
      overallProgress: 0,
      overallStatus: 'pending',
      createdAt: new Date(),
      expanded: false
    };

    // Add to jobs map
    const currentJobs = this.jobs.getValue();
    currentJobs.set(parentJobId, job);
    this.jobs.next(new Map(currentJobs));
    this.saveToCache();

    console.log('[VideoProcessingQueueService] Job added:', job);

    // Emit event to notify listeners (for auto-opening queue panel)
    this.jobAdded.next(parentJobId);

    return parentJobId;
  }

  /**
   * Apply type-specific configuration to a child process
   */
  private applyProcessConfig(child: ChildProcess, type: ProcessType, config: ProcessTypeConfig): void {
    switch (type) {
      case 'analyze':
        const aiConfig = config as AIAnalysisConfig;
        child.aiModel = aiConfig.aiModel;
        child.apiKey = aiConfig.apiKey;
        child.ollamaEndpoint = aiConfig.ollamaEndpoint;
        child.customInstructions = aiConfig.customInstructions;
        break;

      case 'transcribe':
        const transcribeConfig = config as TranscriptionConfig;
        child.whisperModel = transcribeConfig.whisperModel || 'base';
        child.language = transcribeConfig.language || 'en';
        break;

      // 'process' and 'normalize' don't need additional config
    }
  }

  /**
   * Submit a job and all its child processes to the backend
   * Processes are submitted sequentially to ensure proper ordering
   */
  async submitJob(parentJobId: string): Promise<void> {
    const job = this.jobs.getValue().get(parentJobId);
    if (!job) {
      console.error('[VideoProcessingQueueService] Job not found:', parentJobId);
      return;
    }

    console.log('[VideoProcessingQueueService] Submitting job:', parentJobId);

    job.overallStatus = 'processing';
    this.updateJob(parentJobId, job);

    // Submit each child process sequentially
    for (const child of job.childProcesses) {
      // Check if job was removed before processing next child
      const currentJob = this.jobs.getValue().get(parentJobId);
      if (!currentJob) {
        console.log('[VideoProcessingQueueService] Job removed during processing:', parentJobId);
        return; // Exit gracefully
      }

      try {
        await this.submitChildProcess(parentJobId, child);

        // Wait for process to complete before submitting next one
        await this.waitForChildCompletion(parentJobId, child.id);

      } catch (error: any) {
        console.error('[VideoProcessingQueueService] Error submitting child process:', error);
        child.status = 'failed';
        child.error = error.message || 'Failed to submit process';

        // Check if job still exists before updating
        if (this.jobs.getValue().has(parentJobId)) {
          this.updateJob(parentJobId, job);

          // Stop processing further children if one fails
          job.overallStatus = 'failed';
          this.updateJob(parentJobId, job);
        }
        break;
      }
    }

    // Check if job still exists and all children completed successfully
    const finalJob = this.jobs.getValue().get(parentJobId);
    if (finalJob) {
      const allCompleted = finalJob.childProcesses.every(c => c.status === 'completed');
      if (allCompleted) {
        finalJob.overallStatus = 'completed';
        finalJob.completedAt = new Date();
        this.updateJob(parentJobId, finalJob);
        console.log('[VideoProcessingQueueService] Job completed:', parentJobId);
      }
    } else {
      console.log('[VideoProcessingQueueService] Job removed before completion:', parentJobId);
    }
  }

  /**
   * Wait for a child process to complete
   */
  private async waitForChildCompletion(parentJobId: string, childId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const job = this.jobs.getValue().get(parentJobId);
        if (!job) {
          clearInterval(checkInterval);
          console.log('[VideoProcessingQueueService] Job removed while waiting for child completion:', parentJobId);
          // Don't reject - job was removed by user, just resolve silently
          resolve();
          return;
        }

        const child = job.childProcesses.find(c => c.id === childId);
        if (!child) {
          clearInterval(checkInterval);
          reject(new Error('Child process not found'));
          return;
        }

        if (child.status === 'completed') {
          clearInterval(checkInterval);
          resolve();
        } else if (child.status === 'failed') {
          clearInterval(checkInterval);
          reject(new Error(child.error || 'Process failed'));
        }
      }, 500); // Check every 500ms
    });
  }

  /**
   * Submit a single child process to the backend
   */
  private async submitChildProcess(parentJobId: string, child: ChildProcess): Promise<void> {
    const job = this.jobs.getValue().get(parentJobId);
    if (!job) return;

    console.log('[VideoProcessingQueueService] Submitting child process:', child.type, child.id);

    child.status = 'processing';
    child.progress = 0;
    this.updateJob(parentJobId, job);

    try {
      let backendJobId: string;

      switch (child.type) {
        case 'process':
          backendJobId = await this.submitProcessing(job);
          break;

        case 'normalize':
          backendJobId = await this.submitNormalize(job);
          break;

        case 'transcribe':
          backendJobId = await this.submitTranscribe(job, child);
          break;

        case 'analyze':
          backendJobId = await this.submitAnalyze(job, child);
          break;

        default:
          throw new Error(`Unknown process type: ${child.type}`);
      }

      child.backendJobId = backendJobId;
      this.updateJob(parentJobId, job);

      console.log('[VideoProcessingQueueService] Child process submitted:', child.type, 'Backend Job ID:', backendJobId);

    } catch (error: any) {
      console.error('[VideoProcessingQueueService] Error submitting child process:', error);
      child.status = 'failed';
      child.error = error.message || 'Failed to submit';
      this.updateJob(parentJobId, job);
      throw error;
    }
  }

  /**
   * Submit aspect ratio processing (FFmpeg)
   */
  private async submitProcessing(job: VideoProcessingJob): Promise<string> {
    const url = await this.backendUrlService.getApiUrl('/ffmpeg/fix-aspect-ratio');

    const response = await this.http.post<any>(url, {
      filePath: job.videoPath
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || response.message || 'Failed to start processing');
    }

    return response.jobId || 'process-' + Date.now();
  }

  /**
   * Submit audio normalization (FFmpeg)
   */
  private async submitNormalize(job: VideoProcessingJob): Promise<string> {
    const url = await this.backendUrlService.getApiUrl('/ffmpeg/normalize-audio');

    const response = await this.http.post<any>(url, {
      filePath: job.videoPath
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || response.message || 'Failed to start normalization');
    }

    return response.jobId || 'normalize-' + Date.now();
  }

  /**
   * Submit transcription
   */
  private async submitTranscribe(job: VideoProcessingJob, child: ChildProcess): Promise<string> {
    if (!job.videoId) {
      throw new Error('Video ID required for transcription');
    }

    const url = await this.backendUrlService.getApiUrl('/analysis/transcribe');

    const response = await this.http.post<any>(url, {
      videoId: job.videoId,
      whisperModel: child.whisperModel || 'base',
      language: child.language || 'en'
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || 'Failed to start transcription');
    }

    // Backend returns { batchId, jobIds } - we need the individual jobId for progress tracking
    const jobId = response.jobIds?.[0] || response.batchId;
    console.log('[VideoProcessingQueueService] Transcribe job started - batchId:', response.batchId, 'jobId:', jobId);
    return jobId;
  }

  /**
   * Submit AI analysis
   */
  private async submitAnalyze(job: VideoProcessingJob, child: ChildProcess): Promise<string> {
    if (!job.videoId) {
      throw new Error('Video ID required for AI analysis');
    }

    const url = await this.backendUrlService.getApiUrl('/analysis/analyze');

    // Parse AI model to get provider
    const aiModel = child.aiModel || '';
    let aiProvider: 'ollama' | 'claude' | 'openai' = 'ollama';

    if (aiModel.startsWith('claude:')) {
      aiProvider = 'claude';
    } else if (aiModel.startsWith('openai:')) {
      aiProvider = 'openai';
    }

    // Check if there's a transcribe child process before this analyze child
    // If yes, we know transcription is handled separately, so don't force re-transcription
    const analyzeIndex = job.childProcesses.findIndex(c => c.id === child.id);
    const hasTranscribeChild = job.childProcesses.slice(0, analyzeIndex).some(c => c.type === 'transcribe');

    const response = await this.http.post<any>(url, {
      videoId: job.videoId,
      aiModel: aiModel,
      aiProvider: aiProvider,
      claudeApiKey: aiProvider === 'claude' ? child.apiKey : undefined,
      openaiApiKey: aiProvider === 'openai' ? child.apiKey : undefined,
      customInstructions: child.customInstructions,
      // When user adds job to queue, they want it to run - always force
      forceReanalyze: true,
      // Check if there's a transcribe child in this job - if so, use its transcript
      // Otherwise, reuse existing transcript if available
      forceRetranscribe: job.childProcesses.some(c => c.type === 'transcribe')
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || 'Failed to start AI analysis');
    }

    // Backend returns { batchId, jobIds } - we need the individual jobId for progress tracking
    const jobId = response.jobIds?.[0] || response.batchId;
    console.log('[VideoProcessingQueueService] Analyze job started - batchId:', response.batchId, 'jobId:', jobId);
    return jobId;
  }

  /**
   * Setup WebSocket listeners for progress updates
   */
  private setupProgressListeners(): void {
    console.log('[VideoProcessingQueueService] Setting up progress listeners');

    // Listen to processing progress (FFmpeg operations)
    this.socketService.onProcessingProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Processing progress received:', data);
      if (data.jobId) {
        this.updateChildProgressByBackendJobId(data.jobId, data.progress);
      } else {
        console.warn('[VideoProcessingQueueService] Processing progress missing jobId:', data);
      }
    });

    // Listen to analysis progress (AI/Whisper operations)
    this.socketService.onAnalysisProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Analysis progress received:', data);

      // Try both id and jobId fields (backend sends both)
      const backendJobId = data.jobId || data.id;

      if (backendJobId) {
        console.log('[VideoProcessingQueueService] Looking for child with backendJobId:', backendJobId);
        this.updateChildProgressByBackendJobId(backendJobId, data.progress);
      } else {
        console.warn('[VideoProcessingQueueService] Analysis progress missing jobId/id:', data);
      }
    });

    // Listen for processing failures
    this.socketService.onProcessingFailed().subscribe(data => {
      console.log('[VideoProcessingQueueService] Processing failed:', data);
      if (data.jobId) {
        this.markChildAsFailed(data.jobId, data.error);
      }
    });
  }

  /**
   * Update child process progress by backend job ID
   */
  private updateChildProgressByBackendJobId(backendJobId: string, progress: number): void {
    const currentJobs = this.jobs.getValue();
    let found = false;

    for (const [parentId, job] of currentJobs.entries()) {
      const child = job.childProcesses.find(c => c.backendJobId === backendJobId);

      if (child) {
        found = true;
        console.log(`[VideoProcessingQueueService] Updating progress for ${child.displayName}: ${progress}%`);

        child.progress = Math.min(100, Math.max(0, progress));

        // Auto-mark as completed when progress reaches 100%
        if (child.progress >= 100 && child.status === 'processing') {
          child.status = 'completed';
          console.log(`[VideoProcessingQueueService] ${child.displayName} auto-completed (progress: 100%)`);
        }

        // Recalculate parent progress
        this.recalculateProgress(job);
        this.updateJob(parentId, job);
        break;
      }
    }

    if (!found) {
      console.warn(`[VideoProcessingQueueService] ❌ No child process found with backendJobId: ${backendJobId}`);
      console.log('[VideoProcessingQueueService] 🔍 Current jobs and their backendJobIds:');

      Array.from(currentJobs.values()).forEach(j => {
        console.log(`  Job ${j.id} (${j.displayName}):`);
        j.childProcesses.forEach(c => {
          console.log(`    - ${c.type}: backendJobId = "${c.backendJobId}" (status: ${c.status})`);
        });
      });
    }
  }

  /**
   * Mark a child process as completed
   */
  private markChildAsComplete(backendJobId: string): void {
    const currentJobs = this.jobs.getValue();

    for (const [parentId, job] of currentJobs.entries()) {
      const child = job.childProcesses.find(c => c.backendJobId === backendJobId);

      if (child) {
        console.log(`[VideoProcessingQueueService] Marking ${child.displayName} as completed`);

        child.status = 'completed';
        child.progress = 100;

        this.recalculateProgress(job);
        this.updateJob(parentId, job);
        break;
      }
    }
  }

  /**
   * Mark a child process as failed
   */
  private markChildAsFailed(backendJobId: string, error: string): void {
    const currentJobs = this.jobs.getValue();

    for (const [parentId, job] of currentJobs.entries()) {
      const child = job.childProcesses.find(c => c.backendJobId === backendJobId);

      if (child) {
        console.log(`[VideoProcessingQueueService] Marking ${child.displayName} as failed:`, error);

        child.status = 'failed';
        child.error = error;

        this.recalculateProgress(job);
        this.updateJob(parentId, job);
        break;
      }
    }
  }

  /**
   * Calculate overall progress as average of all children
   */
  private recalculateProgress(job: VideoProcessingJob): void {
    if (job.childProcesses.length === 0) {
      job.overallProgress = 0;
      return;
    }

    const totalProgress = job.childProcesses.reduce((sum, child) => sum + child.progress, 0);
    job.overallProgress = Math.round(totalProgress / job.childProcesses.length);

    // Update overall status
    const allCompleted = job.childProcesses.every(c => c.status === 'completed');
    const anyFailed = job.childProcesses.some(c => c.status === 'failed');
    const anyProcessing = job.childProcesses.some(c => c.status === 'processing');

    if (allCompleted) {
      job.overallStatus = 'completed';
      job.completedAt = new Date();
    } else if (anyFailed) {
      job.overallStatus = 'failed';
    } else if (anyProcessing) {
      job.overallStatus = 'processing';
    } else {
      job.overallStatus = 'pending';
    }
  }

  /**
   * Update a job in the jobs map
   */
  private updateJob(jobId: string, job: VideoProcessingJob): void {
    const currentJobs = this.jobs.getValue();
    currentJobs.set(jobId, job);
    this.jobs.next(new Map(currentJobs));
    this.saveToCache();
  }

  /**
   * Remove a job from the queue
   */
  removeJob(jobId: string): void {
    const currentJobs = this.jobs.getValue();
    currentJobs.delete(jobId);
    this.jobs.next(new Map(currentJobs));
    this.saveToCache();
    console.log('[VideoProcessingQueueService] Job removed:', jobId);
  }

  /**
   * Clear all jobs
   */
  clearAllJobs(): void {
    this.jobs.next(new Map());
    this.saveToCache();
    console.log('[VideoProcessingQueueService] All jobs cleared');
  }

  /**
   * Toggle job expansion state
   */
  toggleJobExpansion(jobId: string): void {
    const job = this.jobs.getValue().get(jobId);
    if (job) {
      job.expanded = !job.expanded;
      this.updateJob(jobId, job);
    }
  }
}
