import { Component, OnInit, OnDestroy, HostListener, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatBadgeModule } from '@angular/material/badge';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BatchProgress, DatabaseLibraryService } from '../../services/database-library.service';
import { DownloadProgressService, VideoProcessingJob } from '../../services/download-progress.service';
import { AnalysisQueueService, PendingAnalysisJob } from '../../services/analysis-queue.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-download-queue',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatBadgeModule,
    MatMenuModule,
    MatProgressBarModule,
    MatCheckboxModule,
    MatExpansionModule,
    MatTooltipModule
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

  // Pending queue integration
  pendingJobs: PendingAnalysisJob[] = [];
  private pendingJobsSubscription?: Subscription;
  availableOllamaModels: string[] = [];

  // Bulk update settings
  bulkAIModel = '';
  bulkApiKey = '';
  bulkOllamaEndpoint = 'http://localhost:11434';
  bulkMode: 'full' | 'transcribe-only' = 'full';
  bulkCustomInstructions = '';
  bulkWhisperModel = 'base';
  bulkLanguage = 'en';

  // Checkbox selection
  selectedJobIds = new Set<string>();
  selectAllChecked = false;

  // Expanded jobs tracking
  private expandedActiveJobIds = new Set<string>();

  // Polling
  private pollingInterval: any = null;
  isProcessing = false;

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private downloadProgressService: DownloadProgressService,
    public analysisQueueService: AnalysisQueueService,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone
  ) {}

  async ngOnInit() {
    // Subscribe to processing jobs (analysis jobs only, NOT batch downloads)
    this.jobsSubscription = this.downloadProgressService.jobs$.subscribe(jobsMap => {
      this.processingJobs = Array.from(jobsMap.values());
      console.log('[DownloadQueueComponent] Jobs updated, count:', this.processingJobs.length, 'jobs:', this.processingJobs);
    });

    // Subscribe to pending jobs from the queue service
    this.pendingJobsSubscription = this.analysisQueueService.getPendingJobs().subscribe(jobs => {
      this.ngZone.run(() => {
        console.log('[DownloadQueueComponent] Pending jobs updated:', jobs.length);
        this.pendingJobs = jobs;
        this.cdr.markForCheck();
        this.cdr.detectChanges();
      });
    });

    // Subscribe to job added event to auto-open the queue
    this.analysisQueueService.jobAdded$.subscribe(() => {
      console.log('[DownloadQueueComponent] Job added, opening queue panel');
      this.isOpen = true;
      this.cdr.detectChanges();
    });

    // Load available Ollama models
    await this.loadAvailableOllamaModels();

    // Check for any active jobs
    await this.checkForActiveJobs();
  }

  ngOnDestroy() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }
    if (this.jobsSubscription) {
      this.jobsSubscription.unsubscribe();
    }
    if (this.pendingJobsSubscription) {
      this.pendingJobsSubscription.unsubscribe();
    }
    this.stopPolling();
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
    // Count pending + active analysis jobs
    const pendingCount = this.pendingJobs.length;
    const activeJobs = this.processingJobs.filter(job =>
      job.stage !== 'completed' && job.stage !== 'failed'
    ).length;

    return pendingCount + activeJobs;
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

  // Queue management methods

  hasPendingJobs(): boolean {
    return this.pendingJobs.length > 0;
  }

  async startQueue(): Promise<void> {
    if (!this.hasPendingJobs()) {
      this.notificationService.toastOnly('info', 'No Jobs', 'No pending jobs to start');
      return;
    }

    const jobs = this.analysisQueueService.getCurrentPendingJobs();

    for (const job of jobs) {
      try {
        const fullModel = job.aiModel || '';
        let provider = 'ollama';
        let modelName = fullModel;

        if (fullModel.startsWith('claude:')) {
          provider = 'claude';
          modelName = fullModel.replace('claude:', '');
        } else if (fullModel.startsWith('openai:')) {
          provider = 'openai';
          modelName = fullModel.replace('openai:', '');
        } else if (fullModel.startsWith('ollama:')) {
          provider = 'ollama';
          modelName = fullModel.replace('ollama:', '');
        }

        const requestData = {
          inputType: job.inputType,
          input: job.input,
          mode: job.mode,
          customInstructions: job.customInstructions,
          aiProvider: provider,
          aiModel: modelName,
          apiKey: job.apiKey,
          ollamaEndpoint: job.ollamaEndpoint,
          whisperModel: job.whisperModel,
          language: job.language,
        };

        const startUrl = await this.backendUrlService.getApiUrl('/analysis/start');
        const response = await fetch(startUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestData),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Failed to start analysis');
        }

        const result = await response.json();
        this.analysisQueueService.removePendingJob(job.id);

        const analysisJob: any = {
          id: result.jobId,
          status: 'pending',
          progress: 0,
          currentPhase: 'Starting analysis...',
          input: job.input,
          customInstructions: job.customInstructions,
          aiModel: job.aiModel,
          expanded: false
        };

        this.downloadProgressService.addOrUpdateAnalysisJob(analysisJob);
      } catch (error: any) {
        this.notificationService.error('Failed to Start Job', error.message || `Failed to start analysis for ${job.displayName}`);
      }
    }

    if (!this.pollingInterval) {
      this.isProcessing = true;
      this.startPolling();
    }

    // Toast notification removed - dialog is already visible showing queue status
    this.cdr.detectChanges();
  }

  removePendingJob(jobId: string): void {
    this.analysisQueueService.removePendingJob(jobId);
    // Notification removed - user is already in the queue panel

    this.ngZone.run(() => {
      this.pendingJobs = this.analysisQueueService.getCurrentPendingJobs();
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    });
  }

  clearQueue(): void {
    this.analysisQueueService.clearPendingJobs();
    // Notification removed - user is already in the queue panel
  }

  clearAll(): void {
    // Clear both pending and completed jobs
    this.analysisQueueService.clearPendingJobs();
    this.downloadProgressService.clearCompletedJobs();
    // Notification removed - user is already in the queue panel
  }

  togglePendingJobExpansion(jobId: string): void {
    this.analysisQueueService.toggleJobExpansion(jobId);
  }

  isPendingJobExpanded(jobId: string): boolean {
    const job = this.pendingJobs.find(j => j.id === jobId);
    return job?.expanded || false;
  }

  updatePendingJobModel(jobId: string, aiModel: string): void {
    this.analysisQueueService.updatePendingJob(jobId, { aiModel });
  }

  updatePendingJobInstructions(jobId: string, customInstructions: string): void {
    this.analysisQueueService.updatePendingJob(jobId, { customInstructions });
  }

  updatePendingJobMode(jobId: string, mode: 'full' | 'transcribe-only'): void {
    this.analysisQueueService.updatePendingJob(jobId, { mode });
  }

  // Bulk update methods
  bulkNeedsApiKey(): boolean {
    return this.bulkAIModel.startsWith('claude:') || this.bulkAIModel.startsWith('openai:');
  }

  getBulkApiKeyLabel(): string {
    if (this.bulkAIModel.startsWith('claude:')) {
      return 'Claude API Key';
    } else if (this.bulkAIModel.startsWith('openai:')) {
      return 'OpenAI API Key';
    }
    return 'API Key';
  }

  async onBulkModelChange(): Promise<void> {
    const model = this.bulkAIModel;
    let provider = 'ollama';
    if (model.startsWith('claude:')) {
      provider = 'claude';
    } else if (model.startsWith('openai:')) {
      provider = 'openai';
    }

    try {
      const settings = await (window as any).electron?.getSettings();
      if (settings) {
        if (provider === 'claude' && settings.claudeApiKey) {
          this.bulkApiKey = settings.claudeApiKey;
        } else if (provider === 'openai' && settings.openaiApiKey) {
          this.bulkApiKey = settings.openaiApiKey;
        } else if (provider === 'ollama') {
          this.bulkApiKey = '';
        }
      }
    } catch (error) {
      console.error('Failed to load API key for bulk update:', error);
    }
  }

  applyBulkSettings(): void {
    const jobsToUpdate = this.selectedJobIds.size > 0
      ? Array.from(this.selectedJobIds)
      : this.pendingJobs.map(j => j.id);

    this.analysisQueueService.updateMultipleJobs(jobsToUpdate, {
      aiModel: this.bulkAIModel || undefined,
      apiKey: this.bulkApiKey || undefined,
      ollamaEndpoint: this.bulkOllamaEndpoint || undefined,
      mode: this.bulkMode || undefined,
      customInstructions: this.bulkCustomInstructions || undefined,
      whisperModel: this.bulkWhisperModel || undefined,
      language: this.bulkLanguage || undefined,
    });

    this.ngZone.run(() => {
      this.pendingJobs = this.analysisQueueService.getCurrentPendingJobs();
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    });

    this.selectedJobIds.clear();
    this.selectAllChecked = false;

    this.notificationService.toastOnly('success', 'Settings Applied', `Updated ${jobsToUpdate.length} job(s)`);
  }

  // Checkbox selection methods
  toggleJobSelection(jobId: string): void {
    if (this.selectedJobIds.has(jobId)) {
      this.selectedJobIds.delete(jobId);
    } else {
      this.selectedJobIds.add(jobId);
    }
    this.updateSelectAllState();
  }

  isJobSelected(jobId: string): boolean {
    return this.selectedJobIds.has(jobId);
  }

  toggleSelectAll(): void {
    if (this.selectAllChecked) {
      this.selectedJobIds.clear();
      this.selectAllChecked = false;
    } else {
      this.pendingJobs.forEach(job => this.selectedJobIds.add(job.id));
      this.selectAllChecked = true;
    }
  }

  private updateSelectAllState(): void {
    this.selectAllChecked = this.pendingJobs.length > 0 &&
                            this.selectedJobIds.size === this.pendingJobs.length;
  }

  getSelectedCount(): number {
    return this.selectedJobIds.size;
  }

  hasSelection(): boolean {
    return this.selectedJobIds.size > 0;
  }

  getQueueJobSubtitle(job: any): string {
    const mode = job.mode === 'transcribe-only' ? 'Transcribe Only' : 'Full Analysis';

    if (job.aiModel) {
      const modelParts = job.aiModel.split(':');
      const modelName = modelParts.length > 1 ? modelParts[1] : job.aiModel;
      return `${mode} • ${modelName}`;
    }

    return mode;
  }

  getJobTitle(job: VideoProcessingJob): string {
    // Debug: log the job to see what properties are available
    console.log('[DownloadQueue] getJobTitle called with job:', job);

    // Try to extract a clean title from filename or URL
    if (job.filename && job.filename !== 'Video Analysis') {
      // Remove file extension and clean up
      const title = job.filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
      console.log('[DownloadQueue] Extracted title from filename:', title);
      return title;
    }
    if (job.url) {
      // Try to extract title from URL
      try {
        const url = new URL(job.url);
        const pathParts = url.pathname.split('/').filter(p => p);
        if (pathParts.length > 0) {
          const title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
          console.log('[DownloadQueue] Extracted title from URL:', title);
          return title;
        }
      } catch {
        // Not a valid URL, might be a file path
        if (job.url.includes('/') || job.url.includes('\\')) {
          const parts = job.url.split(/[/\\]/);
          const filename = parts[parts.length - 1];
          if (filename) {
            const title = filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
            console.log('[DownloadQueue] Extracted title from file path:', title);
            return title;
          }
        }
        console.log('[DownloadQueue] Failed to parse URL, using default');
        return 'Processing Video';
      }
    }
    console.log('[DownloadQueue] No filename or URL found, using default. Job:', job);
    return 'Processing Video';
  }

  toggleActiveJobExpansion(jobId: string): void {
    if (this.expandedActiveJobIds.has(jobId)) {
      this.expandedActiveJobIds.delete(jobId);
      console.log('[DownloadQueue] Collapsed job:', jobId);
    } else {
      this.expandedActiveJobIds.add(jobId);
      console.log('[DownloadQueue] Expanded job:', jobId);
    }
    // Manually trigger change detection to update the view
    this.cdr.detectChanges();
  }

  isActiveJobExpanded(jobId: string): boolean {
    return this.expandedActiveJobIds.has(jobId);
  }

  /**
   * TrackBy function to prevent unnecessary re-renders during polling
   */
  trackByJobId(index: number, job: VideoProcessingJob): string {
    return job.id;
  }

  // Polling methods
  private startPolling(): void {
    this.stopPolling();

    console.log('[DownloadQueue] Starting REST polling for all active jobs');

    this.pollingInterval = setInterval(async () => {
      try {
        const activeJobs = this.processingJobs.filter(job =>
          job.stage !== 'completed' && job.stage !== 'failed'
        );

        if (activeJobs.length === 0) {
          console.log('[DownloadQueue] No active jobs, stopping polling');
          this.stopPolling();
          this.isProcessing = false;
          return;
        }

        for (const job of activeJobs) {
          const backendJobId = job.id.replace('analysis-', '');
          const jobUrl = await this.backendUrlService.getApiUrl(`/analysis/job/${backendJobId}`);
          const response = await fetch(jobUrl);

          if (!response.ok) {
            console.error('[DownloadQueue] Failed to fetch job status for', job.id, ':', response.status);
            continue;
          }

          const data = await response.json();

          if (data.success && data.job) {
            this.downloadProgressService.addOrUpdateAnalysisJob(data.job);

            if (data.job.status === 'completed') {
              this.notificationService.success('Analysis Complete', `Finished: ${job.filename || 'Video'}`);
            } else if (data.job.status === 'failed') {
              const errorMessage = data.job.error || 'Unknown error occurred during analysis';
              this.notificationService.error('Analysis Failed', errorMessage);
            }
          }
        }
      } catch (error: any) {
        console.error('[DownloadQueue] Polling error:', error);
      }
    }, 500);
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      console.log('[DownloadQueue] Stopping REST polling');
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private async loadAvailableOllamaModels(): Promise<void> {
    try {
      console.log('[DownloadQueue] Loading available Ollama models...');
      const modelsUrl = await this.backendUrlService.getApiUrl('/analysis/models');
      const response = await fetch(modelsUrl);

      if (!response.ok) {
        console.warn('[DownloadQueue] Failed to fetch Ollama models');
        return;
      }

      const data = await response.json();

      if (data.success && data.connected && data.models) {
        this.availableOllamaModels = data.models.map((model: any) => model.name);
        console.log(`[DownloadQueue] Found ${this.availableOllamaModels.length} Ollama models`);
      }
    } catch (error) {
      console.error('[DownloadQueue] Error loading Ollama models:', error);
    }
  }

  private async checkForActiveJobs(): Promise<void> {
    try {
      const jobsUrl = await this.backendUrlService.getApiUrl('/analysis/jobs');
      const response = await fetch(jobsUrl);
      if (!response.ok) {
        console.log('[DownloadQueue] Backend not ready yet, skipping active job check');
        return;
      }

      const data = await response.json();
      if (data.success && data.jobs && data.jobs.length > 0) {
        const activeJobs = data.jobs.filter((job: any) =>
          job.status !== 'completed' && job.status !== 'failed'
        );

        if (activeJobs.length > 0) {
          console.log('[DownloadQueue] Found', activeJobs.length, 'active job(s) on init');
          this.isProcessing = true;

          for (const job of activeJobs) {
            this.downloadProgressService.addOrUpdateAnalysisJob(job);
          }

          this.startPolling();
        }
      }
    } catch (error) {
      console.log('[DownloadQueue] Backend not ready yet, skipping active job check');
    }
  }
}
