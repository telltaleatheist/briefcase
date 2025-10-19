// backend/src/common/job-state-manager.service.ts
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Job, JobStatus } from './interfaces/download.interface';
import { MediaEventService } from '../media/media-event.service';
import { MediaProcessingService } from '@/media/media-processing.service';

export interface JobStateTransitions {
  [fromState: string]: JobStatus[];
}

interface Result<T> {
  success: boolean;
  result?: T;
  error?: string;
}

@Injectable()
export class JobStateManagerService {
  private readonly VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
    'queued': ['downloading', 'failed'],
    'downloading': ['downloaded', 'failed'],
    'downloaded': ['processing', 'transcribing', 'failed'],
    'processing': ['transcribing', 'completed', 'failed'],
    'transcribing': ['completed', 'failed'],
    'completed': ['failed'],
    'failed': ['queued']
  };
  
  constructor(
    @Inject(forwardRef(() => MediaEventService))
    private eventService: MediaEventService
  ) {}

  validateStateTransition(from: JobStatus, to: JobStatus): boolean {
    const allowedTransitions = this.VALID_TRANSITIONS[from] || [];
    return allowedTransitions.includes(to);
  }

  private getInitialProgressForState(status: JobStatus): number {
    switch (status) {
      case 'queued': return 0;
      case 'downloading': return 0;
      case 'processing': return 0;
      case 'transcribing': return 0;
      case 'completed': return 100;
      case 'failed': return 0;
      default: return 0;
    }
  }

  /**
   * Update job status with validation of transitions
   */
  updateJobStatus(job: Job, newStatus: JobStatus, task: string): Result<Job> {
    const oldStatus = job.status;

    // Validate the transition
    if (!this.validateStateTransition(oldStatus, newStatus)) {
      return {
        success: false,
        error: `Invalid state transition from ${oldStatus} to ${newStatus}`
      };
    }

    // Update job state
    job.status = newStatus;
    job.currentTask = task;

    // Set progress based on state
    job.progress = this.getProgressForState(newStatus);

    // Update timestamps
    this.updateJobTimestamps(job, newStatus);

    return {
      success: true,
      result: job
    };
  }

  private getProgressForState(status: JobStatus): number {
    switch (status) {
      case 'queued': return 0;
      case 'downloading': return 0;
      case 'processing': return 0;
      case 'transcribing': return 0;
      case 'completed': return 100;
      case 'failed': return 0;
      default: return 0;
    }
  }
    
  private updateJobTimestamps(job: Job, newStatus: JobStatus): void {
    const now = new Date().toISOString();

    switch (newStatus) {
      case 'downloading':
        job.downloadStartTime = now;
        break;
      case 'completed':
      case 'failed':
        // Ensure end timestamps are set
        if (!job.processingEndTime) {
          job.processingEndTime = now;
        }
        break;
    }
  }

  /**
   * Update job progress without changing state
   */
  updateJobProgress(job: Job, progress: number, task: string, emitEvent = true): void {
    job.progress = Math.max(0, Math.min(100, progress));
    
    if (task) {
      job.currentTask = task;
    }
    
    if (emitEvent) {
      // Emit both general job progress and specific event based on state
      this.eventService.emitJobProgress(job.id, job.progress, job.status, job.currentTask);
      
      switch (job.status) {
        case 'downloading':
          this.eventService.emitDownloadProgress(job.progress, job.currentTask, job.id);
          break;
        case 'processing':
          this.eventService.emitProcessingProgress(job.progress, job.currentTask, job.id);
          break;
        case 'transcribing':
          this.eventService.emitTranscriptionProgress(job.progress, job.currentTask, job.id);
          break;
      }
    }
  }
}