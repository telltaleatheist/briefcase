import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, interval, Subscription } from 'rxjs';
import { BackendUrlService } from './backend-url.service';

export interface AnalysisBatchJob {
  id: string;
  videoId: string;
  filename: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  queueJobId?: string; // ID of the queue job on the backend
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface BatchAnalysisState {
  isRunning: boolean;
  jobs: AnalysisBatchJob[];
  totalVideos: number;
  completedVideos: number;
  failedVideos: number;
  currentVideo?: string;
  options: {
    transcribeOnly: boolean;
    forceReanalyze: boolean;
    aiProvider?: 'ollama' | 'claude' | 'openai';
    aiModel?: string;
    whisperModel?: string;
    claudeApiKey?: string;
    openaiApiKey?: string;
  };
}

/**
 * Frontend Batch Analysis Service
 * Manages batch analysis by sending videos to the queue one at a time
 * This avoids payload size limits and gives better progress tracking
 */
@Injectable({
  providedIn: 'root'
})
export class FrontendBatchAnalysisService {
  private baseUrl: string | null = null;
  private baseUrlPromise: Promise<string> | null = null;

  private batchState = new BehaviorSubject<BatchAnalysisState | null>(null);
  public batchState$ = this.batchState.asObservable();

  private processingSubscription: Subscription | null = null;
  private maxConcurrentJobs = 1; // Process one at a time for analysis

  constructor(
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {}

  /**
   * Get base URL (cached)
   */
  private async getBaseUrl(): Promise<string> {
    if (this.baseUrl) {
      return this.baseUrl;
    }

    if (!this.baseUrlPromise) {
      this.baseUrlPromise = this.backendUrlService.getBackendUrl();
    }

    this.baseUrl = await this.baseUrlPromise;
    return this.baseUrl;
  }

  /**
   * Start batch analysis
   */
  async startBatchAnalysis(videos: Array<{ id: string; filename: string }>, options: {
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
    aiProvider?: 'ollama' | 'claude' | 'openai';
    aiModel?: string;
    whisperModel?: string;
    claudeApiKey?: string;
    openaiApiKey?: string;
  }): Promise<void> {
    // Stop any existing batch
    this.stopBatchAnalysis();

    // Create batch jobs
    const jobs: AnalysisBatchJob[] = videos.map(v => ({
      id: `batch-${Date.now()}-${v.id}`,
      videoId: v.id,
      filename: v.filename,
      status: 'pending'
    }));

    // Initialize batch state
    const state: BatchAnalysisState = {
      isRunning: true,
      jobs,
      totalVideos: videos.length,
      completedVideos: 0,
      failedVideos: 0,
      options: {
        transcribeOnly: options.transcribeOnly || false,
        forceReanalyze: options.forceReanalyze || false,
        aiProvider: options.aiProvider,
        aiModel: options.aiModel,
        whisperModel: options.whisperModel,
        claudeApiKey: options.claudeApiKey,
        openaiApiKey: options.openaiApiKey
      }
    };

    this.batchState.next(state);

    // Start processing
    this.startProcessing();
  }

  /**
   * Stop batch analysis
   */
  stopBatchAnalysis(): void {
    if (this.processingSubscription) {
      this.processingSubscription.unsubscribe();
      this.processingSubscription = null;
    }

    const state = this.batchState.value;
    if (state) {
      state.isRunning = false;
      this.batchState.next(state);
    }
  }

  /**
   * Get current batch state
   */
  getCurrentState(): BatchAnalysisState | null {
    return this.batchState.value;
  }

  /**
   * Start processing jobs
   */
  private startProcessing(): void {
    // Poll every 2 seconds to check if we can send more jobs
    this.processingSubscription = interval(2000).subscribe(() => {
      this.processNextJobs();
    });

    // Process immediately
    this.processNextJobs();
  }

  /**
   * Process next available jobs (up to maxConcurrentJobs)
   */
  private async processNextJobs(): Promise<void> {
    const state = this.batchState.value;
    if (!state || !state.isRunning) {
      return;
    }

    // Check how many jobs are currently processing
    const processingCount = state.jobs.filter(j => j.status === 'processing' || j.status === 'queued').length;
    const availableSlots = this.maxConcurrentJobs - processingCount;

    if (availableSlots <= 0) {
      return; // All slots full, wait for jobs to complete
    }

    // Get next pending jobs
    const pendingJobs = state.jobs.filter(j => j.status === 'pending').slice(0, availableSlots);

    if (pendingJobs.length === 0) {
      // Check if all jobs are done
      const activeJobs = state.jobs.filter(j => j.status === 'processing' || j.status === 'queued' || j.status === 'pending');
      if (activeJobs.length === 0) {
        // All done!
        state.isRunning = false;
        this.batchState.next(state);
        this.stopBatchAnalysis();
      }
      return;
    }

    // Send each job to the queue
    for (const job of pendingJobs) {
      this.sendJobToQueue(job);
    }
  }

  /**
   * Send a single job to the backend queue
   */
  private async sendJobToQueue(job: AnalysisBatchJob): Promise<void> {
    const state = this.batchState.value;
    if (!state) return;

    try {
      // Mark as queued
      job.status = 'queued';
      job.startedAt = new Date();
      state.currentVideo = job.filename;
      this.batchState.next(state);

      // Build tasks based on options
      const tasks: any[] = [];

      if (state.options.transcribeOnly) {
        tasks.push({ type: 'transcribe', options: { model: state.options.whisperModel || 'base' } });
      } else {
        // Check if transcript exists - the backend will handle this, but we add both tasks
        tasks.push({ type: 'transcribe', options: { model: state.options.whisperModel || 'base' } });
        tasks.push({
          type: 'analyze',
          options: {
            aiModel: state.options.aiModel || 'qwen2.5:7b',
            aiProvider: state.options.aiProvider || 'ollama',
            apiKey: state.options.aiProvider === 'claude' ? state.options.claudeApiKey : state.options.openaiApiKey
          }
        });
      }

      // Send to queue
      const baseUrl = await this.getBaseUrl();
      const response = await firstValueFrom(
        this.http.post<{ success: boolean; jobId: string }>(`${baseUrl}/queue/add`, {
          queueType: 'analysis',
          videoId: job.videoId,
          displayName: job.filename,
          tasks
        })
      );

      if (response.success) {
        job.queueJobId = response.jobId;
        job.status = 'processing';
        this.batchState.next(state);

        // Start monitoring this job
        this.monitorJob(job);
      } else {
        throw new Error('Failed to add job to queue');
      }
    } catch (error) {
      console.error(`Failed to queue video ${job.filename}:`, error);
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.completedAt = new Date();
      state.failedVideos++;
      this.batchState.next(state);
    }
  }

  /**
   * Monitor a job until completion
   */
  private monitorJob(job: AnalysisBatchJob): void {
    const checkInterval = setInterval(async () => {
      const state = this.batchState.value;
      if (!state || !job.queueJobId) {
        clearInterval(checkInterval);
        return;
      }

      try {
        // Check job status
        const baseUrl = await this.getBaseUrl();
        const response = await firstValueFrom(
          this.http.get<{ success: boolean; job: any }>(`${baseUrl}/queue/job/${job.queueJobId}`)
        );

        if (response.success && response.job) {
          const queueJob = response.job;

          if (queueJob.status === 'completed') {
            job.status = 'completed';
            job.completedAt = new Date();
            state.completedVideos++;
            clearInterval(checkInterval);
            this.batchState.next(state);
          } else if (queueJob.status === 'failed') {
            job.status = 'failed';
            job.error = queueJob.error || 'Analysis failed';
            job.completedAt = new Date();
            state.failedVideos++;
            clearInterval(checkInterval);
            this.batchState.next(state);
          }
        }
      } catch (error) {
        console.error(`Error monitoring job ${job.filename}:`, error);
        clearInterval(checkInterval);
        job.status = 'failed';
        job.error = 'Failed to monitor job status';
        job.completedAt = new Date();
        state.failedVideos++;
        this.batchState.next(state);
      }
    }, 3000); // Check every 3 seconds
  }
}
