// backend/src/common/job-state-manager.service.ts
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Job, JobStatus } from './interfaces/download.interface';
import { MediaEventService } from '../media/media-event.service';
import { MediaProcessingService } from '@/media/media-processing.service';

@Injectable()
export class JobStateManagerService {
  private readonly logger = new Logger(JobStateManagerService.name);
  
  // State transition validation map
  private readonly validTransitions: Record<JobStatus, JobStatus[]> = {
    'queued': ['downloading', 'failed'],
    'downloading': ['downloaded', 'failed'],
    'downloaded': ['processing', 'failed'],
    'processing': ['transcribing', 'completed', 'failed'],
    'transcribing': ['completed', 'failed'],
    'completed': ['failed'],
    'failed': ['queued']
  };
  
  constructor(
    @Inject(forwardRef(() => MediaEventService))
    private eventService: MediaEventService
  ) {}

  /**
   * Update job status with validation of transitions
   */
  updateJobStatus(job: Job, newStatus: JobStatus, task: string, emitEvent = true): boolean {
    const oldStatus = job.status;
    
    // Log the transition
    this.logger.log(`Considering job ${job.id} status update from ${oldStatus} to ${newStatus}: ${task}`);
    
    if (newStatus === 'failed') {
    }
    else if (oldStatus === 'failed' && newStatus === 'queued') {
    }
    // Check for backward transitions and block them
    else if (this.isBackwardTransition(oldStatus, newStatus)) {
      this.logger.warn(
        `Backward state transition rejected: ${job.id} from ${oldStatus} to ${newStatus} - jobs can only move forward in the workflow`
      );
      return false;
    }
    
    // Validate state transition using the valid transitions map
    if (!this.isValidTransition(oldStatus, newStatus)) {
      this.logger.warn(
        `Invalid state transition rejected: ${job.id} from ${oldStatus} to ${newStatus}`
      );
      return false;
    }
    
    this.logger.log(`Updating job ${job.id} status from ${oldStatus} to ${newStatus}: ${task}`);
    
    // Update job state
    job.status = newStatus;
    job.currentTask = task;
    
    // Reset progress when changing state (except for completion)
    if (newStatus !== 'completed') {
      job.progress = 0;
    }
    
    // Set timestamps based on state
    if (newStatus === 'downloading' && !job.downloadStartTime) {
      job.downloadStartTime = new Date().toISOString();
    } else if (newStatus === 'downloaded' && !job.downloadEndTime) {
      job.downloadEndTime = new Date().toISOString();
    } else if (newStatus === 'processing' && !job.processingStartTime) {
      job.processingStartTime = new Date().toISOString();
    } else if ((newStatus === 'completed' || newStatus === 'failed') && 
               !job.processingEndTime) {
      job.processingEndTime = new Date().toISOString();
    }
    
    // Emit event if requested
    if (emitEvent) {
      this.eventService.emitJobStatusUpdate(job.id, newStatus, task);
    }
    
    return true;
  }
    
  private isBackwardTransition(from: JobStatus, to: JobStatus): boolean {
    // Define the linear progression of states
    const stateOrder: JobStatus[] = [
      'queued',
      'downloading', 
      'downloaded',
      'processing',
      'transcribing',
      'completed'
    ];
    
    // Get the indices of the states in our progression
    const fromIndex = stateOrder.indexOf(from);
    const toIndex = stateOrder.indexOf(to);
    
    // If either state is not in our progression, it's not a backward transition
    // This handles 'failed' state which can transition from any state
    if (fromIndex === -1 || toIndex === -1) return false;
    
    // If the to-index is less than from-index, it's going backward
    return toIndex < fromIndex;
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
  
  /**
   * Check if a state transition is valid
   */
  private isValidTransition(from: JobStatus, to: JobStatus): boolean {
    // Same state is always valid
    if (from === to) return true;
    
    // Check if the transition is in our allowed transitions map
    return this.validTransitions[from]?.includes(to) || false;
  }
}
