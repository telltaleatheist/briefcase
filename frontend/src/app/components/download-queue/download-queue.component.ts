import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatBadgeModule } from '@angular/material/badge';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router } from '@angular/router';
import { BatchProgress, DatabaseLibraryService } from '../../services/database-library.service';
import { DownloadProgressService, VideoProcessingJob } from '../../services/download-progress.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-download-queue',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatBadgeModule,
    MatMenuModule,
    MatProgressBarModule
  ],
  template: `
    <button
      mat-icon-button
      [matBadge]="activeItemsCount"
      [matBadgeHidden]="activeItemsCount === 0"
      matBadgeColor="warn"
      (click)="openQueueDialog()"
      class="download-queue-button"
      [class.has-active]="hasActiveItems">
      <mat-icon>download</mat-icon>
    </button>
  `,
  styles: [`
    .download-queue-button {
      position: relative;

      ::ng-deep .mat-badge-content {
        background-color: var(--primary-orange) !important;
        color: white !important;
        font-size: 10px;
        font-weight: 600;
      }

      &.has-active mat-icon {
        color: var(--primary-orange);
        animation: pulse 2s ease-in-out infinite;
      }
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.6;
      }
    }
  `]
})
export class DownloadQueueComponent implements OnInit, OnDestroy {
  batchProgress: BatchProgress | null = null;
  processingJobs: VideoProcessingJob[] = [];
  private progressInterval: any;
  private jobsSubscription?: Subscription;

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private downloadProgressService: DownloadProgressService,
    private router: Router
  ) {}

  ngOnInit() {
    // Subscribe to processing jobs
    this.jobsSubscription = this.downloadProgressService.jobs$.subscribe(jobsMap => {
      this.processingJobs = Array.from(jobsMap.values());
    });

    // Start polling for batch progress (for transcription/analysis)
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
    // Poll every 3 seconds
    this.progressInterval = setInterval(async () => {
      try {
        this.batchProgress = await this.databaseLibraryService.getBatchProgress();
      } catch (error) {
        console.error('Failed to fetch batch progress:', error);
      }
    }, 3000);

    // Also fetch immediately
    this.databaseLibraryService.getBatchProgress().then(progress => {
      this.batchProgress = progress;
    });
  }

  get activeItemsCount(): number {
    // Count active processing jobs (download/transcribe/analyze)
    const activeJobs = this.processingJobs.filter(job =>
      job.stage !== 'completed' && job.stage !== 'failed'
    ).length;

    // Also include remaining videos in batch analysis
    const remainingInBatch = this.batchProgress?.running ?
      (this.batchProgress.totalVideos || 0) - (this.batchProgress.processedVideos || 0) : 0;

    return activeJobs + remainingInBatch;
  }

  get hasActiveItems(): boolean {
    return this.activeItemsCount > 0;
  }

  openQueueDialog() {
    // Navigate to the video analysis page where the unified processing queue is displayed
    this.router.navigate(['/analysis']);
  }
}
