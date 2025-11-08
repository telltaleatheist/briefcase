import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatBadgeModule } from '@angular/material/badge';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
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
  templateUrl: './download-queue.component.html',
  styleUrls: ['./download-queue.component.scss']
})
export class DownloadQueueComponent implements OnInit, OnDestroy {
  batchProgress: BatchProgress | null = null;
  processingJobs: VideoProcessingJob[] = [];
  isOpen = false;
  private progressInterval: any;
  private jobsSubscription?: Subscription;

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private downloadProgressService: DownloadProgressService
  ) {}

  ngOnInit() {
    // Subscribe to processing jobs (analysis jobs only, NOT batch downloads)
    this.jobsSubscription = this.downloadProgressService.jobs$.subscribe(jobsMap => {
      this.processingJobs = Array.from(jobsMap.values());
      console.log('[DownloadQueueComponent] Jobs updated, count:', this.processingJobs.length, 'jobs:', this.processingJobs);
    });

    // NOTE: Batch progress polling is for batch downloads, not analysis jobs
    // this.startProgressPolling();
  }

  ngOnDestroy() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    if (this.jobsSubscription) {
      this.jobsSubscription.unsubscribe();
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const clickedInside = target.closest('.download-queue-container');
    if (!clickedInside && this.isOpen) {
      this.isOpen = false;
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
    // Count active analysis jobs only
    const activeJobs = this.processingJobs.filter(job =>
      job.stage !== 'completed' && job.stage !== 'failed'
    ).length;

    return activeJobs;
  }

  get hasActiveItems(): boolean {
    return this.activeItemsCount > 0;
  }

  togglePanel() {
    this.isOpen = !this.isOpen;
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

  clearCompleted() {
    this.downloadProgressService.clearCompletedJobs();
  }

  getJobStatusIcon(stage: string): string {
    switch (stage) {
      case 'completed':
        return 'check_circle';
      case 'failed':
        return 'error';
      case 'downloading':
        return 'download';
      case 'importing':
        return 'input';
      case 'transcribing':
        return 'subtitles';
      case 'analyzing':
        return 'psychology';
      default:
        return 'pending';
    }
  }

  getJobStatusText(job: VideoProcessingJob): string {
    switch (job.stage) {
      case 'downloading':
        return 'Downloading';
      case 'importing':
        return 'Importing';
      case 'transcribing':
        return 'Transcribing';
      case 'analyzing':
        return 'AI Analysis';
      case 'completed':
        return 'Completed';
      case 'failed':
        return job.error || 'Failed';
      default:
        return 'Processing';
    }
  }

  getRelativeTime(date: Date): string {
    const now = new Date();
    const diff = Math.floor((now.getTime() - new Date(date).getTime()) / 1000);

    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
}
