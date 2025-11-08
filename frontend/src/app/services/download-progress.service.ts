import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { SocketService } from './socket.service';
import { DownloadProgress } from '../models/download.model';
import { MatDialog } from '@angular/material/dialog';
import { DuplicateVideoDialogComponent } from '../components/library/duplicate-video-dialog.component';

export interface VideoProcessingJob {
  id: string;
  filename: string;
  url?: string;
  stage: 'downloading' | 'importing' | 'transcribing' | 'analyzing' | 'completed' | 'failed';
  progress: number; // 0-100
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

@Injectable({
  providedIn: 'root'
})
export class DownloadProgressService {
  private jobs = new BehaviorSubject<Map<string, VideoProcessingJob>>(new Map());
  public jobs$ = this.jobs.asObservable();

  constructor(
    private socketService: SocketService,
    private dialog: MatDialog
  ) {
    console.log('[DownloadProgressService] Service instantiated - setting up WebSocket listeners');
    this.setupListeners();
  }

  private setupListeners() {
    console.log('[DownloadProgressService] Setting up WebSocket listeners');

    // NOTE: Download events are for batch downloads, not analysis jobs
    // Analysis jobs are tracked via addOrUpdateAnalysisJob() method

    // this.socketService.onDownloadStarted().subscribe(data => {
    //   console.log('[DownloadProgressService] Download started event received:', data);
    //   const jobId = data.jobId || this.generateJobId();
    //   const job = {
    //     id: jobId,
    //     filename: this.extractFilename(data.url),
    //     url: data.url,
    //     stage: 'downloading' as const,
    //     progress: 0,
    //     startedAt: new Date()
    //   };
    //   console.log('[DownloadProgressService] Adding job to queue:', job);
    //   this.addJob(job);
    // });

    // this.socketService.onDownloadProgress().subscribe((data: DownloadProgress) => {
    //   console.log('[DownloadProgressService] Download progress event received:', data);
    //   if (data.jobId) {
    //     this.updateJobProgress(data.jobId, data.progress, data.task);
    //   } else {
    //     console.warn('[DownloadProgressService] Progress event missing jobId:', data);
    //   }
    // });

    // this.socketService.onDownloadCompleted().subscribe(data => {
    //   console.log('[DownloadProgressService] Download completed event received:', data);
    //   if (data.jobId) {
    //     const job = this.getJob(data.jobId);
    //     if (job) {
    //       job.filename = this.extractFilename(data.outputFile);
    //       job.stage = 'completed';
    //       job.progress = 100;
    //       job.completedAt = new Date();
    //       console.log('[DownloadProgressService] Marking job as completed:', job);
    //       this.updateJob(job);
    //     } else {
    //       console.warn('[DownloadProgressService] Job not found for completion event:', data.jobId);
    //     }
    //   } else {
    //     console.warn('[DownloadProgressService] Completion event missing jobId:', data);
    //   }
    // });

    // this.socketService.onDownloadFailed().subscribe(data => {
    //   console.log('[DownloadProgressService] Download failed event received:', data);
    //   if (data.jobId) {
    //     const job = this.getJob(data.jobId);
    //     if (job) {
    //       job.stage = 'failed';
    //       job.error = data.error;
    //       job.completedAt = new Date();
    //       console.log('[DownloadProgressService] Marking job as failed:', job);
    //       this.updateJob(job);
    //     } else {
    //       console.warn('[DownloadProgressService] Job not found for failure event:', data.jobId);
    //     }
    //   } else {
    //     console.warn('[DownloadProgressService] Failure event missing jobId:', data);
    //   }
    // });

    // NOTE: Batch queue updates are NOT tracked here
    // The batch download system is separate and has its own UI
    // this.socketService.onBatchQueueUpdated().subscribe(data => {
    //   console.log('[DownloadProgressService] Batch queue updated event received:', data);
    //   this.handleBatchQueueUpdate(data);
    // });

    // NOTE: Individual job status updates are for batch downloads, not analysis jobs
    // this.socketService.onJobStatusUpdated().subscribe(data => {
    //   console.log('[DownloadProgressService] Job status update event received:', data);
    //   this.handleJobStatusUpdate(data);
    // });

    // NOTE: Library download duplicate detection is for batch downloads, not analysis jobs
    // this.socketService.onLibraryDownloadDuplicate().subscribe(data => {
    //   console.log('[DownloadProgressService] Duplicate video detected:', data);
    //   this.handleDuplicateDetection(data);
    // });

    console.log('[DownloadProgressService] All WebSocket listeners registered');
  }

  /**
   * Handle duplicate video detection - show dialog and send user choice back to backend
   */
  private handleDuplicateDetection(data: { jobId: string; videoId: string; filename: string }) {
    // Open the duplicate dialog
    const dialogRef = this.dialog.open(DuplicateVideoDialogComponent, {
      width: '500px',
      disableClose: true, // User must choose an action
      data: {
        jobId: data.jobId,
        videoId: data.videoId,
        filename: data.filename
      }
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.action) {
        console.log('[DownloadProgressService] User chose action:', result.action, 'for job', data.jobId);

        // Send user's choice back to backend
        this.socketService.sendLibraryDownloadUserAction(data.jobId, result.action);

        // If user chose to cancel, mark the job as failed
        if (result.action === 'cancel') {
          const job = this.getJob(data.jobId);
          if (job) {
            job.stage = 'failed';
            job.error = 'Cancelled by user: Video already exists';
            job.completedAt = new Date();
            this.updateJob(job);
          }
        }
        // If user chose to replace, the backend will continue the pipeline
      }
    });
  }

  /**
   * Handle batch queue updates - sync jobs from batch system to download queue
   */
  private handleBatchQueueUpdate(queueData: any) {
    // Only track jobs that are library downloads (have our jobId format: download-*)
    const allJobs = [
      ...(queueData.queuedJobs || []),
      ...(queueData.downloadingJobs || []),
      ...(queueData.downloadedJobs || []),
      ...(queueData.processingJobs || []),
      ...(queueData.transcribingJobs || []),
      ...(queueData.completedJobs || []),
      ...(queueData.failedJobs || [])
    ];

    const currentJobs = this.jobs.value;

    allJobs.forEach((batchJob: any) => {
      // Only track jobs that start with 'download-' (library downloads)
      if (batchJob.id && batchJob.id.startsWith('download-')) {
        const existingJob = currentJobs.get(batchJob.id);

        // Map batch job status to our stages
        let stage: VideoProcessingJob['stage'] = 'downloading';
        if (batchJob.status === 'downloading') stage = 'downloading';
        else if (batchJob.status === 'transcribing') stage = 'transcribing';
        else if (batchJob.status === 'processing') stage = 'analyzing';
        else if (batchJob.status === 'completed') stage = 'completed';
        else if (batchJob.status === 'failed') stage = 'failed';

        if (existingJob) {
          // Update existing job
          existingJob.stage = stage;
          existingJob.progress = batchJob.progress || 0;
          existingJob.error = batchJob.error;
          if (batchJob.displayName) {
            existingJob.filename = batchJob.displayName;
          }
          if (stage === 'completed' || stage === 'failed') {
            existingJob.completedAt = new Date();
          }
        } else {
          // Create new job if it doesn't exist
          const newJob: VideoProcessingJob = {
            id: batchJob.id,
            filename: batchJob.displayName || batchJob.url || 'Downloading...',
            url: batchJob.url,
            stage: stage,
            progress: batchJob.progress || 0,
            error: batchJob.error,
            startedAt: new Date(),
            completedAt: (stage === 'completed' || stage === 'failed') ? new Date() : undefined
          };
          currentJobs.set(batchJob.id, newJob);
          console.log('[DownloadProgressService] Created new job from batch queue:', newJob);
        }
      }
    });

    this.jobs.next(new Map(currentJobs));
  }

  /**
   * Handle individual job status updates
   */
  private handleJobStatusUpdate(data: { jobId: string; status: string; task: string }) {
    // Only track jobs that start with 'download-' (library downloads)
    if (!data.jobId || !data.jobId.startsWith('download-')) {
      return;
    }

    let job = this.getJob(data.jobId);

    // If job doesn't exist yet, create it
    if (!job) {
      job = {
        id: data.jobId,
        filename: 'Downloading...',
        stage: 'downloading',
        progress: 0,
        startedAt: new Date()
      };
      this.addJob(job);
    }

    // Map status to stage
    const statusLower = data.status.toLowerCase();
    if (statusLower === 'downloading') job.stage = 'downloading';
    else if (statusLower === 'importing') job.stage = 'importing';
    else if (statusLower === 'transcribing') job.stage = 'transcribing';
    else if (statusLower === 'analyzing') job.stage = 'analyzing';
    else if (statusLower === 'processing') job.stage = 'analyzing'; // Legacy support
    else if (statusLower === 'completed') job.stage = 'completed';
    else if (statusLower === 'failed') job.stage = 'failed';

    if (job.stage === 'completed' || job.stage === 'failed') {
      job.completedAt = new Date();
    }

    this.updateJob(job);
  }

  addJob(job: VideoProcessingJob) {
    const currentJobs = this.jobs.value;
    currentJobs.set(job.id, job);
    this.jobs.next(new Map(currentJobs));
  }

  updateJob(job: VideoProcessingJob) {
    const currentJobs = this.jobs.value;
    currentJobs.set(job.id, job);
    this.jobs.next(new Map(currentJobs));
  }

  updateJobProgress(jobId: string, progress: number, task?: string) {
    const job = this.getJob(jobId);
    if (job) {
      job.progress = progress;

      // Infer stage from task description
      if (task) {
        const taskLower = task.toLowerCase();
        if (taskLower.includes('download')) {
          job.stage = 'downloading';
        } else if (taskLower.includes('transcrib')) {
          job.stage = 'transcribing';
        } else if (taskLower.includes('analyz') || taskLower.includes('ai')) {
          job.stage = 'analyzing';
        }
      }

      this.updateJob(job);
    }
  }

  updateJobStage(jobId: string, stage: VideoProcessingJob['stage']) {
    const job = this.getJob(jobId);
    if (job) {
      job.stage = stage;
      if (stage === 'completed' || stage === 'failed') {
        job.completedAt = new Date();
      }
      this.updateJob(job);
    }
  }

  getJob(jobId: string): VideoProcessingJob | undefined {
    return this.jobs.value.get(jobId);
  }

  removeJob(jobId: string) {
    const currentJobs = this.jobs.value;
    currentJobs.delete(jobId);
    this.jobs.next(new Map(currentJobs));
  }

  clearCompletedJobs() {
    const currentJobs = this.jobs.value;
    const activeJobs = new Map(
      Array.from(currentJobs.entries()).filter(([_, job]) =>
        job.stage !== 'completed' && job.stage !== 'failed'
      )
    );
    this.jobs.next(activeJobs);
  }

  /**
   * Add or update an analysis job (from video-analysis component)
   */
  addOrUpdateAnalysisJob(analysisJob: any) {
    const jobId = `analysis-${analysisJob.id}`;
    const currentJobs = this.jobs.value;

    // Map analysis job status to our stages
    let stage: VideoProcessingJob['stage'] = 'analyzing';
    const status = analysisJob.status?.toLowerCase() || '';

    if (status === 'downloading') stage = 'downloading';
    else if (status === 'extracting' || status === 'importing') stage = 'importing';
    else if (status === 'transcribing') stage = 'transcribing';
    else if (status === 'analyzing' || status === 'processing') stage = 'analyzing';
    else if (status === 'completed') stage = 'completed';
    else if (status === 'failed') stage = 'failed';

    const job: VideoProcessingJob = {
      id: jobId,
      filename: analysisJob.input || 'Video Analysis',
      stage: stage,
      progress: analysisJob.progress || 0,
      error: analysisJob.error,
      startedAt: new Date(),
      completedAt: (stage === 'completed' || stage === 'failed') ? new Date() : undefined
    };

    currentJobs.set(jobId, job);
    this.jobs.next(new Map(currentJobs));
    console.log('[DownloadProgressService] Added/updated analysis job:', job);
  }

  /**
   * Remove an analysis job
   */
  removeAnalysisJob(analysisJobId: string) {
    const jobId = `analysis-${analysisJobId}`;
    this.removeJob(jobId);
  }

  private extractFilename(pathOrUrl: string): string {
    if (!pathOrUrl) return 'Unknown';
    const parts = pathOrUrl.split('/');
    return parts[parts.length - 1] || 'Downloading...';
  }

  private generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
