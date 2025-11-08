import { Component, Inject, OnInit, OnDestroy, Output, EventEmitter, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatListModule } from '@angular/material/list';
import { BatchProgress, DatabaseLibraryService } from '../../services/database-library.service';
import { VideoProcessingJob, DownloadProgressService } from '../../services/download-progress.service';
import { Subscription } from 'rxjs';

interface CompletedVideo {
  filename: string;
  videoId: string;
  completedAt: Date;
  status: 'success' | 'failed' | 'skipped' | 'processing';
  error?: string;
  stage?: 'downloading' | 'transcribing' | 'analyzing';
}

@Component({
  selector: 'app-download-queue-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatListModule
  ],
  templateUrl: './download-queue-dialog.component.html',
  styleUrl: './download-queue-dialog.component.scss'
})
export class DownloadQueueDialogComponent implements OnInit, OnDestroy {
  batchProgress: BatchProgress | null = null;
  processingJobs: VideoProcessingJob[] = [];
  completedVideos: CompletedVideo[] = [];
  private progressInterval: any;
  private jobsSubscription?: Subscription;
  private lastProcessedCount = 0;

  @Output() closeDialog = new EventEmitter<void>();

  constructor(
    public dialogRef: MatDialogRef<DownloadQueueDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      batchProgress: BatchProgress | null;
      processingJobs: VideoProcessingJob[];
    },
    private databaseLibraryService: DatabaseLibraryService,
    private downloadProgressService: DownloadProgressService,
    private cdr: ChangeDetectorRef
  ) {
    this.batchProgress = data.batchProgress;
    this.processingJobs = data.processingJobs || [];
    this.lastProcessedCount = this.batchProgress?.processedVideos || 0;
  }

  ngOnInit() {
    // Subscribe to live processing jobs updates
    this.jobsSubscription = this.downloadProgressService.jobs$.subscribe(jobsMap => {
      this.processingJobs = Array.from(jobsMap.values());
      // Trigger change detection to update the UI
      this.cdr.detectChanges();
    });

    this.startProgressPolling();
  }

  ngOnDestroy() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    if (this.jobsSubscription) {
      this.jobsSubscription.unsubscribe();
    }
  }

  private startProgressPolling() {
    // Poll every 2 seconds while dialog is open
    this.progressInterval = setInterval(async () => {
      try {
        const newProgress = await this.databaseLibraryService.getBatchProgress();

        // Track newly completed videos
        if (newProgress.processedVideos && newProgress.processedVideos > this.lastProcessedCount) {
          if (this.batchProgress?.currentVideoFilename) {
            this.completedVideos.push({
              filename: this.batchProgress.currentVideoFilename,
              videoId: '',
              completedAt: new Date(),
              status: 'success'
            });
          }
          this.lastProcessedCount = newProgress.processedVideos;
        }

        // Track errors
        if (newProgress.errors && newProgress.errors.length > 0) {
          newProgress.errors.forEach(error => {
            const existingError = this.completedVideos.find(v => v.filename === error.filename);
            if (!existingError) {
              this.completedVideos.push({
                filename: error.filename,
                videoId: error.videoId,
                completedAt: new Date(error.timestamp),
                status: 'failed',
                error: error.error
              });
            }
          });
        }

        this.batchProgress = newProgress;

        // Trigger change detection to update the UI
        this.cdr.detectChanges();

        // Auto-close dialog if batch is completed or stopped
        if (!this.batchProgress.running) {
          clearInterval(this.progressInterval);
        }
      } catch (error) {
        console.error('Failed to fetch batch progress:', error);
      }
    }, 2000);

    // Also fetch immediately
    this.databaseLibraryService.getBatchProgress().then(progress => {
      this.batchProgress = progress;
      this.lastProcessedCount = progress.processedVideos || 0;
    });
  }

  async pauseBatch() {
    try {
      await this.databaseLibraryService.pauseBatch();
      this.batchProgress = await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to pause:', error);
    }
  }

  async resumeBatch() {
    try {
      await this.databaseLibraryService.resumeBatch();
      this.batchProgress = await this.databaseLibraryService.getBatchProgress();
    } catch (error) {
      console.error('Failed to resume:', error);
    }
  }

  async stopBatch() {
    try {
      await this.databaseLibraryService.stopBatch();
      this.batchProgress = await this.databaseLibraryService.getBatchProgress();
      this.close();
    } catch (error) {
      console.error('Failed to stop:', error);
    }
  }

  close() {
    this.dialogRef.close();
  }

  get sortedVideos(): CompletedVideo[] {
    return [...this.completedVideos].sort((a, b) =>
      b.completedAt.getTime() - a.completedAt.getTime()
    );
  }

  get remainingInQueue(): number {
    if (!this.batchProgress?.running) return 0;
    return (this.batchProgress.totalVideos || 0) - (this.batchProgress.processedVideos || 0);
  }

  get completedCount(): number {
    return this.batchProgress?.processedVideos || 0;
  }

  get totalCount(): number {
    return this.batchProgress?.totalVideos || 0;
  }

  formatTimeRemaining(seconds: number | undefined): string {
    if (!seconds) return 'Calculating...';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `~${hours}h ${minutes}m remaining`;
    } else if (minutes > 0) {
      return `~${minutes}m remaining`;
    } else {
      return `<1m remaining`;
    }
  }

  getCurrentStage(): string {
    if (!this.batchProgress?.currentVideoFilename) return '';
    // This would ideally come from backend
    return 'Processing...';
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'success':
      case 'completed':
        return '✓';
      case 'failed':
        return '✕';
      case 'skipped':
        return '⏭';
      case 'downloading':
        return '↓';
      case 'importing':
        return '📥';
      case 'transcribing':
        return '📝';
      case 'analyzing':
        return '🧠';
      case 'processing':
      case 'queued':
        return '⏳';
      default:
        return '?';
    }
  }

  getStatusText(video: CompletedVideo | VideoProcessingJob): string {
    const status = 'stage' in video ? video.stage : video.status;

    switch (status) {
      case 'downloading':
        return 'Downloading';
      case 'importing':
        return 'Importing';
      case 'transcribing':
        return 'Transcribing';
      case 'analyzing':
        return 'AI Analysis';
      case 'completed':
      case 'success':
        return 'Completed';
      case 'failed':
        return 'Failed';
      case 'processing':
        return 'Processing';
      case 'skipped':
        return 'Skipped';
      default:
        return 'Unknown';
    }
  }

  getActiveJobs(): VideoProcessingJob[] {
    return this.processingJobs.filter(job =>
      job.stage !== 'completed' && job.stage !== 'failed'
    );
  }

  getCompletedJobs(): VideoProcessingJob[] {
    return this.processingJobs.filter(job =>
      job.stage === 'completed' || job.stage === 'failed'
    );
  }

  getProgressPercentage(): number {
    return this.batchProgress?.progress || 0;
  }

  get hasActiveJobs(): boolean {
    return !!this.batchProgress?.running;
  }

  get statusText(): string {
    if (!this.batchProgress) return 'Idle';
    if (this.batchProgress.status === 'running') return 'Processing';
    if (this.batchProgress.status === 'paused') return 'Paused';
    return 'Idle';
  }
}
