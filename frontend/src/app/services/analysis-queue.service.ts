import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface PendingAnalysisJob {
  id: string;
  input: string;
  inputType: 'url' | 'file';
  mode: 'full' | 'transcribe-only';
  aiModel: string;
  apiKey?: string;
  ollamaEndpoint?: string;
  whisperModel: string;
  language: string;
  customInstructions?: string;
  displayName: string;
  loading?: boolean;
  expanded?: boolean; // Track accordion expansion state
  videoId?: string; // Optional video ID for library videos
}

@Injectable({
  providedIn: 'root'
})
export class AnalysisQueueService {
  private pendingJobs = new BehaviorSubject<PendingAnalysisJob[]>([]);
  private jobIdCounter = 0;

  constructor() {}

  /**
   * Get observable of pending jobs
   */
  getPendingJobs(): Observable<PendingAnalysisJob[]> {
    return this.pendingJobs.asObservable();
  }

  /**
   * Add a new pending job to the queue
   */
  addPendingJob(job: Omit<PendingAnalysisJob, 'id'>): string {
    const jobId = `pending-analysis-${Date.now()}-${this.jobIdCounter++}`;
    const newJob: PendingAnalysisJob = {
      ...job,
      id: jobId
    };

    const currentJobs = this.pendingJobs.value;
    this.pendingJobs.next([...currentJobs, newJob]);

    return jobId;
  }

  /**
   * Update a pending job
   */
  updatePendingJob(jobId: string, updates: Partial<PendingAnalysisJob>): void {
    const currentJobs = this.pendingJobs.value;
    const jobIndex = currentJobs.findIndex(j => j.id === jobId);

    if (jobIndex !== -1) {
      const updatedJobs = [...currentJobs];
      updatedJobs[jobIndex] = {
        ...updatedJobs[jobIndex],
        ...updates
      };
      this.pendingJobs.next(updatedJobs);
    }
  }

  /**
   * Remove a pending job from the queue
   */
  removePendingJob(jobId: string): void {
    const currentJobs = this.pendingJobs.value;
    const filteredJobs = currentJobs.filter(j => j.id !== jobId);
    this.pendingJobs.next(filteredJobs);
  }

  /**
   * Clear all pending jobs
   */
  clearPendingJobs(): void {
    this.pendingJobs.next([]);
  }

  /**
   * Get current pending jobs (synchronous)
   */
  getCurrentPendingJobs(): PendingAnalysisJob[] {
    return this.pendingJobs.value;
  }

  /**
   * Add a video to the pending queue with simplified parameters
   */
  addToPendingQueue(params: {
    videoId?: string;
    videoPath: string;
    filename: string;
    mode?: 'full' | 'transcribe-only';
    aiProvider?: 'ollama' | 'claude' | 'openai';
    aiModel?: string;
    customInstructions?: string;
  }): string {
    return this.addPendingJob({
      input: params.videoPath,
      inputType: 'file',
      mode: params.mode || 'full',
      aiModel: params.aiModel || 'ollama:qwen2.5:7b',
      whisperModel: 'base',
      language: 'en',
      customInstructions: params.customInstructions || '',
      displayName: params.filename,
      videoId: params.videoId,
      expanded: false
    });
  }

  /**
   * Toggle expansion state for a job
   */
  toggleJobExpansion(jobId: string): void {
    const currentJobs = this.pendingJobs.value;
    const jobIndex = currentJobs.findIndex(j => j.id === jobId);

    if (jobIndex !== -1) {
      const updatedJobs = [...currentJobs];
      updatedJobs[jobIndex] = {
        ...updatedJobs[jobIndex],
        expanded: !updatedJobs[jobIndex].expanded
      };
      this.pendingJobs.next(updatedJobs);
    }
  }
}