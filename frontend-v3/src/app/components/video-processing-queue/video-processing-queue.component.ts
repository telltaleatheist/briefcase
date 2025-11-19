import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil } from 'rxjs';
import { VideoProcessingService } from '../../services/video-processing.service';
import { VideoJob, VideoTask, QueueStats, VideoJobSettings } from '../../models/video-processing.model';
import { VideoConfigDialogComponent } from '../video-config-dialog/video-config-dialog.component';

@Component({
  selector: 'app-video-processing-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, VideoConfigDialogComponent],
  templateUrl: './video-processing-queue.component.html',
  styleUrls: ['./video-processing-queue.component.scss']
})
export class VideoProcessingQueueComponent implements OnInit, OnDestroy {
  jobs: VideoJob[] = [];
  queueStats: QueueStats | null = null;
  activeJobId: string | null = null;
  selectedJobs: Set<string> = new Set();

  // Layout options
  layoutMode: 'compact' | 'detailed' | 'cards' | 'timeline' = 'detailed';

  // Dialog state
  isConfigDialogOpen = false;

  // Batch edit mode
  isBatchEditMode = false;
  batchSettings: Partial<VideoJobSettings> = {
    transcribe: true,
    aiAnalysis: true,
    normalizeAudio: false,
    fixAspectRatio: false,
    whisperModel: 'base' as const,
    aiModel: 'gpt-4' as const,
    outputQuality: 'high' as const
  };

  // Individual job editing
  editingJobId: string | null = null;
  editingJobSettings: VideoJobSettings | null = null;

  // Filter and sort
  filterStatus: 'all' | 'queued' | 'processing' | 'completed' | 'failed' = 'all';
  sortBy: 'date' | 'name' | 'progress' | 'status' = 'date';

  private destroy$ = new Subject<void>();

  constructor(private videoService: VideoProcessingService) {}

  ngOnInit(): void {
    // Subscribe to jobs
    this.videoService.getJobs()
      .pipe(takeUntil(this.destroy$))
      .subscribe(jobs => {
        this.jobs = this.sortJobs(this.filterJobs(jobs));
      });

    // Subscribe to queue stats
    this.videoService.getQueueStats()
      .pipe(takeUntil(this.destroy$))
      .subscribe(stats => {
        this.queueStats = stats;
      });

    // Subscribe to active job
    this.videoService.getActiveJobId()
      .pipe(takeUntil(this.destroy$))
      .subscribe(id => {
        this.activeJobId = id;
      });

    // Subscribe to progress updates
    this.videoService.getProgressUpdates()
      .pipe(takeUntil(this.destroy$))
      .subscribe(update => {
        // Handle real-time updates
        console.log('Progress update:', update);
      });
  }

  processQueue(): void {
    this.videoService.processQueue();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  openConfigDialog(): void {
    this.isConfigDialogOpen = true;
  }

  closeConfigDialog(): void {
    this.isConfigDialogOpen = false;
  }

  onJobConfigSubmit(config: { url: string; name: string; settings: any }): void {
    this.videoService.addJob(config.url, config.name, config.settings);
  }

  removeJob(jobId: string): void {
    this.videoService.removeJob(jobId);
    this.selectedJobs.delete(jobId);
  }

  pauseJob(jobId: string): void {
    this.videoService.pauseJob(jobId);
  }

  resumeJob(jobId: string): void {
    this.videoService.resumeJob(jobId);
  }

  retryJob(jobId: string): void {
    this.videoService.retryJob(jobId);
  }

  toggleJobSelection(jobId: string): void {
    if (this.selectedJobs.has(jobId)) {
      this.selectedJobs.delete(jobId);
    } else {
      this.selectedJobs.add(jobId);
    }
  }

  selectAllJobs(): void {
    this.jobs.forEach(job => this.selectedJobs.add(job.id));
  }

  deselectAllJobs(): void {
    this.selectedJobs.clear();
  }

  removeSelectedJobs(): void {
    this.selectedJobs.forEach(id => this.videoService.removeJob(id));
    this.selectedJobs.clear();
  }

  applyBatchSettings(): void {
    const jobIds = Array.from(this.selectedJobs);
    this.videoService.updateBatchSettings(jobIds, this.batchSettings);
    this.isBatchEditMode = false;
    this.selectedJobs.clear();
  }

  applyToAll(): void {
    const allJobIds = this.jobs.filter(j => j.status === 'queued').map(j => j.id);
    if (allJobIds.length === 0) return;

    this.videoService.updateBatchSettings(allJobIds, this.batchSettings);
    this.isBatchEditMode = false;
    this.selectedJobs.clear();
  }

  openJobEditor(job: VideoJob): void {
    if (job.status !== 'queued') return; // Only edit queued jobs
    this.editingJobId = job.id;
    this.editingJobSettings = { ...job.settings };
  }

  closeJobEditor(): void {
    this.editingJobId = null;
    this.editingJobSettings = null;
  }

  saveJobSettings(): void {
    if (!this.editingJobId || !this.editingJobSettings) return;
    this.videoService.updateBatchSettings([this.editingJobId], this.editingJobSettings);
    this.closeJobEditor();
  }

  clearCompleted(): void {
    this.videoService.clearCompleted();
  }

  clearAll(): void {
    if (confirm('Are you sure you want to clear all jobs? This action cannot be undone.')) {
      this.videoService.clearAll();
      this.selectedJobs.clear();
    }
  }

  private filterJobs(jobs: VideoJob[]): VideoJob[] {
    if (this.filterStatus === 'all') {
      return jobs;
    }
    return jobs.filter(job => job.status === this.filterStatus);
  }

  private sortJobs(jobs: VideoJob[]): VideoJob[] {
    return jobs.sort((a, b) => {
      switch (this.sortBy) {
        case 'date':
          return b.addedAt.getTime() - a.addedAt.getTime();
        case 'name':
          return a.videoName.localeCompare(b.videoName);
        case 'progress':
          return b.progress - a.progress;
        case 'status':
          return a.status.localeCompare(b.status);
        default:
          return 0;
      }
    });
  }

  getTaskIcon(taskType: VideoTask['type']): string {
    const icons: Record<VideoTask['type'], string> = {
      'download': '⬇️',
      'import': '💾',
      'aspect-ratio': '📐',
      'normalize-audio': '🔊',
      'transcribe': '💬',
      'ai-analysis': '🤖'
    };
    return icons[taskType] || '📋';
  }

  getStatusIcon(status: VideoJob['status']): string {
    const icons: Record<VideoJob['status'], string> = {
      'queued': '⏳',
      'processing': '⚡',
      'completed': '✅',
      'failed': '❌',
      'paused': '⏸️'
    };
    return icons[status] || '❓';
  }

  getStatusColor(status: VideoJob['status']): string {
    const colors: Record<VideoJob['status'], string> = {
      'queued': 'status-queued',
      'processing': 'status-processing',
      'completed': 'status-completed',
      'failed': 'status-failed',
      'paused': 'status-paused'
    };
    return colors[status] || '';
  }

  formatFileSize(bytes?: number): string {
    if (!bytes) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return 'Unknown';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  formatTime(date?: Date): string {
    if (!date) return 'N/A';
    return new Date(date).toLocaleTimeString();
  }

  getProcessingTime(job: VideoJob): string {
    if (!job.startedAt) return 'Not started';
    const end = job.completedAt || new Date();
    const diff = end.getTime() - job.startedAt.getTime();
    const seconds = Math.floor(diff / 1000);
    return this.formatDuration(seconds);
  }
}