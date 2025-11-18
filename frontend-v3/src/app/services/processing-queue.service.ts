import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

export interface ProcessingJob {
  id: string;
  type: 'clip-extraction';
  title: string;
  progress: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  startTime?: Date;
  endTime?: Date;
  metadata?: {
    videoPath?: string;
    clipStartTime?: number;
    clipEndTime?: number;
    outputPath?: string;
    reEncode?: boolean;
  };
}

@Injectable({
  providedIn: 'root'
})
export class ProcessingQueueService {
  private jobs = new BehaviorSubject<ProcessingJob[]>([]);
  private jobIdCounter = 0;

  // Emit event when a job is added
  private jobAdded = new Subject<void>();
  public jobAdded$ = this.jobAdded.asObservable();

  constructor() {}

  /**
   * Get observable of jobs
   */
  getJobs(): Observable<ProcessingJob[]> {
    return this.jobs.asObservable();
  }

  /**
   * Add a new job to the queue
   */
  addJob(job: Omit<ProcessingJob, 'id' | 'progress' | 'status'>): string {
    const jobId = `processing-${Date.now()}-${this.jobIdCounter++}`;
    const newJob: ProcessingJob = {
      ...job,
      id: jobId,
      progress: 0,
      status: 'pending'
    };

    const currentJobs = this.jobs.value;
    this.jobs.next([...currentJobs, newJob]);

    // Emit event to potentially open queue viewer
    this.jobAdded.next();

    return jobId;
  }

  /**
   * Update a job
   */
  updateJob(jobId: string, updates: Partial<ProcessingJob>): void {
    const currentJobs = this.jobs.value;
    const jobIndex = currentJobs.findIndex(j => j.id === jobId);

    if (jobIndex !== -1) {
      const updatedJobs = [...currentJobs];
      updatedJobs[jobIndex] = {
        ...updatedJobs[jobIndex],
        ...updates
      };
      this.jobs.next(updatedJobs);
    }
  }

  /**
   * Remove a job from the queue
   */
  removeJob(jobId: string): void {
    const currentJobs = this.jobs.value;
    const filteredJobs = currentJobs.filter(j => j.id !== jobId);
    this.jobs.next(filteredJobs);
  }

  /**
   * Clear all completed/failed jobs
   */
  clearCompletedJobs(): void {
    const currentJobs = this.jobs.value;
    const activeJobs = currentJobs.filter(j => j.status === 'pending' || j.status === 'processing');
    this.jobs.next(activeJobs);
  }

  /**
   * Get current jobs (synchronous)
   */
  getCurrentJobs(): ProcessingJob[] {
    return this.jobs.value;
  }
}
