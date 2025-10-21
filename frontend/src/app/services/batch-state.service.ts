import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DownloadOptions } from '../models/download.model';

export interface PendingJob {
  id: string;
  url: string;
  displayName: string;
  uploadDate: string;
  options: DownloadOptions;
  loading: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class BatchStateService {
  private pendingJobsSubject = new BehaviorSubject<PendingJob[]>([]);
  private pendingJobIdCounter = 0;
  private readonly STORAGE_KEY = 'clippy_pending_jobs';
  private readonly COUNTER_KEY = 'clippy_pending_job_counter';

  constructor() {
    // Load pending jobs from localStorage on service initialization
    this.loadFromStorage();
  }

  /**
   * Load pending jobs from localStorage
   */
  private loadFromStorage(): void {
    try {
      const storedJobs = localStorage.getItem(this.STORAGE_KEY);
      const storedCounter = localStorage.getItem(this.COUNTER_KEY);

      if (storedJobs) {
        const jobs = JSON.parse(storedJobs) as PendingJob[];
        this.pendingJobsSubject.next(jobs);
      }

      if (storedCounter) {
        this.pendingJobIdCounter = parseInt(storedCounter, 10);
      }
    } catch (error) {
      console.error('Error loading pending jobs from storage:', error);
    }
  }

  /**
   * Save pending jobs to localStorage
   */
  private saveToStorage(): void {
    try {
      const jobs = this.pendingJobsSubject.value;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(jobs));
      localStorage.setItem(this.COUNTER_KEY, this.pendingJobIdCounter.toString());
    } catch (error) {
      console.error('Error saving pending jobs to storage:', error);
    }
  }

  /**
   * Get the current pending jobs as an observable
   */
  getPendingJobs(): Observable<PendingJob[]> {
    return this.pendingJobsSubject.asObservable();
  }

  /**
   * Get the current pending jobs value
   */
  getPendingJobsValue(): PendingJob[] {
    return this.pendingJobsSubject.value;
  }

  /**
   * Add a pending job to the queue
   */
  addPendingJob(job: Omit<PendingJob, 'id'>): string {
    const jobId = `pending-${this.pendingJobIdCounter++}`;
    const newJob: PendingJob = { ...job, id: jobId };
    const currentJobs = this.pendingJobsSubject.value;
    this.pendingJobsSubject.next([...currentJobs, newJob]);
    this.saveToStorage();
    return jobId;
  }

  /**
   * Update a pending job
   */
  updatePendingJob(jobId: string, updates: Partial<PendingJob>): void {
    const currentJobs = this.pendingJobsSubject.value;
    const jobIndex = currentJobs.findIndex(j => j.id === jobId);
    if (jobIndex >= 0) {
      const updatedJobs = [...currentJobs];
      updatedJobs[jobIndex] = { ...updatedJobs[jobIndex], ...updates };
      this.pendingJobsSubject.next(updatedJobs);
      this.saveToStorage();
    }
  }

  /**
   * Remove a pending job from the queue
   */
  removePendingJob(jobId: string): void {
    const currentJobs = this.pendingJobsSubject.value;
    const filteredJobs = currentJobs.filter(j => j.id !== jobId);
    this.pendingJobsSubject.next(filteredJobs);
    this.saveToStorage();
  }

  /**
   * Clear all pending jobs
   */
  clearPendingJobs(): void {
    this.pendingJobsSubject.next([]);
    this.saveToStorage();
  }

  /**
   * Check if there are any pending jobs
   */
  hasPendingJobs(): boolean {
    return this.pendingJobsSubject.value.length > 0;
  }
}