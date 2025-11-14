import { Component, OnInit, OnDestroy, HostListener, ChangeDetectorRef, NgZone, ViewChild, AfterViewInit } from '@angular/core';
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
import { MatDialog } from '@angular/material/dialog';
import { BatchProgress, DatabaseLibraryService } from '../../services/database-library.service';
import { DownloadProgressService, VideoProcessingJob } from '../../services/download-progress.service';
import { AnalysisQueueService, PendingAnalysisJob } from '../../services/analysis-queue.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { Subscription, interval } from 'rxjs';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import { AnalysisNotesDialogComponent } from './analysis-notes-dialog.component';
import {
  ItemDisplayConfig,
  ItemProgress,
  ListItem,
  SelectionMode,
  ContextMenuAction,
  CascadeItem,
  CascadeChild,
  CascadeChildStatus,
  ChildrenConfig
} from '../../libs/cascade/src/lib/types/cascade.types';

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
    MatTooltipModule,
    CascadeListComponent
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
  private jobAddedSubscription?: Subscription;
  availableOllamaModels: string[] = [];

  // ViewChild for cascade list to control expansion
  @ViewChild(CascadeListComponent) cascadeList?: CascadeListComponent<any>;

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
  private pollingSubscription: Subscription | null = null;
  isProcessing = false;

  // Auto-queue processing (sequential, one-at-a-time)
  private autoProcessQueue = false;

  // Memoization caches for expensive calculations
  private jobStagesCache = new Map<string, { key: string; stages: CascadeChild[] }>();
  private masterProgressCache = new Map<string, { key: string; progress: number }>();

  // Item-list configuration
  SelectionMode = SelectionMode;

  jobDisplayConfig: ItemDisplayConfig = {
    primaryField: 'displayName',
    secondaryField: 'subtitle',
    renderSecondary: (item: any) => this.formatJobSubtitle(item)
  };

  // Cascade children configuration for showing job stages
  childrenConfig: ChildrenConfig = {
    enabled: true,
    expandable: true,
    defaultExpanded: false, // Don't expand all by default
    showMasterProgress: true,
    generator: (item: any) => this.generateJobStages(item),
    masterProgressCalculator: (item: any) => this.calculateMasterProgress(item)
  };

  constructor(
    private databaseLibraryService: DatabaseLibraryService,
    private downloadProgressService: DownloadProgressService,
    public analysisQueueService: AnalysisQueueService,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private dialog: MatDialog
  ) {}

  async ngOnInit() {
    // Subscribe to processing jobs (analysis jobs only, NOT batch downloads)
    this.jobsSubscription = this.downloadProgressService.jobs$.subscribe(jobsMap => {
      console.log('[DownloadQueue] jobs$ emission received, count:', jobsMap.size);
      this.processingJobs = Array.from(jobsMap.values());
      console.log('[DownloadQueue] processingJobs updated, count:', this.processingJobs.length);

      // The observable subscription should automatically run in Angular zone
      // and trigger change detection when processingJobs array reference changes
    });

    // Subscribe to pending jobs from the queue service
    this.pendingJobsSubscription = this.analysisQueueService.getPendingJobs().subscribe(jobs => {
      this.pendingJobs = jobs;

      // Expand only the first item after the view updates
      setTimeout(() => {
        this.expandFirstItemOnly();
      }, 0);

      // Angular will automatically detect changes - no manual trigger needed
    });

    // Subscribe to job added event to auto-open the queue
    this.jobAddedSubscription = this.analysisQueueService.jobAdded$.subscribe(() => {
      this.isOpen = true;
      // Angular will detect the change automatically
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
    if (this.jobAddedSubscription) {
      this.jobAddedSubscription.unsubscribe();
    }
    this.stopPolling();
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
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
    // Poll every 5 seconds (less aggressive)
    this.progressInterval = setInterval(async () => {
      try {
        this.batchProgress = await this.databaseLibraryService.getBatchProgress();
      } catch (error) {
        console.error('Failed to fetch batch progress:', error);
      }
    }, 5000);

    // Also fetch immediately
    this.databaseLibraryService.getBatchProgress().then(progress => {
      this.batchProgress = progress;
    }).catch(error => {
      console.error('Failed to fetch initial batch progress:', error);
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
    // Clean up caches for completed jobs before removing them
    const completedJobs = this.getCompletedJobs();
    completedJobs.forEach(job => {
      this.jobStagesCache.delete(job.id);
      this.masterProgressCache.delete(job.id);
    });
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

    // Enable auto-processing mode (sequential, one-at-a-time)
    this.autoProcessQueue = true;

    // Start only the first pending job
    await this.startNextPendingJob();

    // Start polling to track progress
    if (!this.pollingSubscription) {
      this.isProcessing = true;
      this.startPolling();
    }

    // Toast notification removed - dialog is already visible showing queue status
    // Angular change detection will automatically update the UI
  }

  /**
   * Start the next pending job in the queue (used for sequential processing)
   */
  private async startNextPendingJob(): Promise<void> {
    const jobs = this.analysisQueueService.getCurrentPendingJobs();

    if (jobs.length === 0) {
      console.log('[DownloadQueue] No more pending jobs to start');
      this.autoProcessQueue = false;
      return;
    }

    // Only start if there are no active jobs (ensures one-at-a-time)
    const activeJobs = this.processingJobs.filter(job =>
      job.stage !== 'completed' && job.stage !== 'failed'
    );

    if (activeJobs.length > 0) {
      console.log('[DownloadQueue] Job already processing, waiting for completion');
      return;
    }

    const job = jobs[0]; // Always take the first pending job

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
        videoId: job.videoId, // Include videoId for tracking
      };

      console.log('[DownloadQueue] Starting job:', job.displayName);
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
        displayName: job.displayName, // Preserve the fetched title
        customInstructions: job.customInstructions,
        aiModel: job.aiModel,
        mode: job.mode, // Preserve mode to show correct progress bar children
        videoId: job.videoId, // Include videoId for progress tracking in library
        expanded: false
      };

      this.downloadProgressService.addOrUpdateAnalysisJob(analysisJob);
    } catch (error: any) {
      console.error('[DownloadQueue] Failed to start job:', error);
      this.notificationService.error('Failed to Start Job', error.message || `Failed to start analysis for ${job.displayName}`);

      // Remove the failed job from pending and try the next one
      this.analysisQueueService.removePendingJob(job.id);

      // Try starting the next job if auto-processing is enabled
      if (this.autoProcessQueue && jobs.length > 1) {
        setTimeout(() => this.startNextPendingJob(), 1000);
      }
    }
  }

  removePendingJob(jobId: string): void {
    this.analysisQueueService.removePendingJob(jobId);
    // Clean up caches for removed job
    this.jobStagesCache.delete(jobId);
    this.masterProgressCache.delete(jobId);
    // Notification removed - user is already in the queue panel
    // The subscription to getPendingJobs() will automatically update pendingJobs
  }

  clearQueue(): void {
    this.analysisQueueService.clearPendingJobs();
    // Clear caches for all jobs
    this.jobStagesCache.clear();
    this.masterProgressCache.clear();
    // Disable auto-processing when user manually clears the queue
    this.autoProcessQueue = false;
    // Notification removed - user is already in the queue panel
  }

  clearAll(): void {
    // Clear both pending and completed jobs
    this.analysisQueueService.clearPendingJobs();
    this.downloadProgressService.clearCompletedJobs();
    // Clear caches for all jobs
    this.jobStagesCache.clear();
    this.masterProgressCache.clear();
    // Disable auto-processing when user manually clears all
    this.autoProcessQueue = false;
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

    // The subscription to getPendingJobs() will automatically update pendingJobs
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
    let mode = 'Full Analysis';
    if (job.mode === 'transcribe-only') {
      mode = 'Transcribe Only';
    } else if (job.mode === 'process-only') {
      mode = 'Process Video';
    }

    if (job.aiModel && job.mode !== 'process-only') {
      const modelParts = job.aiModel.split(':');
      const modelName = modelParts.length > 1 ? modelParts[1] : job.aiModel;
      return `${mode} • ${modelName}`;
    }

    return mode;
  }

  getJobTitle(job: VideoProcessingJob): string {
    // Prefer displayName if available (preserves fetched title)
    if (job.displayName) {
      return job.displayName;
    }

    // Fallback: Try to extract a clean title from filename or URL
    if (job.filename && job.filename !== 'Video Analysis') {
      let title = job.filename;

      // If it's a file path, extract just the filename
      if (title.includes('/') || title.includes('\\')) {
        const parts = title.split(/[/\\]/);
        title = parts[parts.length - 1] || title;
      }

      // Remove common video extensions
      title = title.replace(/\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|mp3|wav|m4a|aac|ogg)$/i, '');

      // Replace underscores and hyphens with spaces
      title = title.replace(/[_-]+/g, ' ');

      // Clean up multiple spaces
      title = title.replace(/\s+/g, ' ').trim();

      return title || 'Processing Video';
    }

    if (job.url) {
      // Try to extract title from URL
      try {
        const url = new URL(job.url);
        const pathParts = url.pathname.split('/').filter(p => p);
        if (pathParts.length > 0) {
          let title = pathParts[pathParts.length - 1];
          title = title.replace(/\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|mp3|wav|m4a|aac|ogg)$/i, '');
          title = title.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
          return title || 'Processing Video';
        }
      } catch {
        // Not a valid URL, might be a file path
        if (job.url.includes('/') || job.url.includes('\\')) {
          const parts = job.url.split(/[/\\]/);
          const filename = parts[parts.length - 1];
          if (filename) {
            let title = filename.replace(/\.(mp4|mkv|avi|mov|webm|m4v|flv|wmv|mp3|wav|m4a|aac|ogg)$/i, '');
            title = title.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
            return title || 'Processing Video';
          }
        }
      }
    }

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
    // Angular will automatically detect the Set mutation
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

    // Run polling OUTSIDE Angular zone to avoid triggering change detection every 2s
    this.ngZone.runOutsideAngular(() => {
      const intervalId = setInterval(async () => {
        const activeJobs = this.processingJobs.filter(job =>
          job.stage !== 'completed' && job.stage !== 'failed'
        );

        if (activeJobs.length === 0) {
          // Re-enter zone for these operations
          this.ngZone.run(() => {
            if (this.autoProcessQueue && this.hasPendingJobs()) {
              console.log('[DownloadQueue] Job completed, starting next pending job');
              this.startNextPendingJob();
            } else {
              console.log('[DownloadQueue] No active jobs, stopping polling');
              this.stopPolling();
              this.isProcessing = false;
              this.autoProcessQueue = false;
            }
          });
          return;
        }

        for (const job of activeJobs) {
          try {
            const backendJobId = job.id.replace('analysis-', '');
            const jobUrl = await this.backendUrlService.getApiUrl(`/analysis/job/${backendJobId}`);
            const response = await fetch(jobUrl);

            if (!response.ok) {
              console.error('[DownloadQueue] Failed to fetch job status for', job.id, ':', response.status);
              continue;
            }

            const data = await response.json();

            if (data.success && data.job) {
              const previousStatus = job.stage;

              // Only update and trigger change detection if status actually changed
              const newStatus = data.job.status?.toLowerCase() || '';
              const statusChanged = previousStatus !== newStatus || job.progress !== data.job.progress;

              if (statusChanged) {
                // Re-enter Angular zone only when we have actual updates
                this.ngZone.run(() => {
                  this.downloadProgressService.addOrUpdateAnalysisJob(data.job);

                  const isNewCompletion = (newStatus === 'completed' && previousStatus !== 'completed');
                  const isNewFailure = (newStatus === 'failed' && previousStatus !== 'failed');

                  if (isNewCompletion) {
                    this.notificationService.success('Analysis Complete', `Finished: ${job.filename || 'Video'}`);
                  } else if (isNewFailure) {
                    const errorMessage = data.job.error || 'Unknown error occurred during analysis';
                    this.notificationService.error('Analysis Failed', errorMessage);
                  }
                });
              }
            }
          } catch (error: any) {
            console.error('[DownloadQueue] Polling error for job', job.id, ':', error);
          }
        }
      }, 2000);

      // Store the interval ID for cleanup
      this.pollingSubscription = {
        unsubscribe: () => clearInterval(intervalId)
      } as Subscription;
    });
  }

  private stopPolling(): void {
    if (this.pollingSubscription) {
      console.log('[DownloadQueue] Stopping REST polling');
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
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

  // Combine pending and active jobs into one unified list
  get allJobsAsListItems(): ListItem[] {
    const pending = this.pendingJobs.map(job => ({
      ...job,
      displayName: job.displayName || 'Unknown',
      isPending: true
    }));

    const active = this.processingJobs
      .filter(job => job.stage !== 'completed' && job.stage !== 'failed')
      .map(job => ({
        ...job,
        displayName: this.getJobTitle(job),
        isPending: false
      }));

    return [...pending, ...active];
  }

  /**
   * Get completed jobs formatted as list items
   */
  getCompletedJobsAsListItems(): ListItem[] {
    return this.getCompletedJobs().map(job => ({
      ...job,
      displayName: this.getJobTitle(job),
      isPending: false,
      isCompleted: true
    }));
  }

  // Check if a job is pending (hasn't started yet)
  isJobPending(item: any): boolean {
    return item.isPending === true;
  }

  /**
   * Expand only the first item in the queue, collapse all others
   */
  private expandFirstItemOnly(): void {
    if (!this.cascadeList) return;

    const allJobs = this.allJobsAsListItems;
    if (allJobs.length === 0) return;

    // Clear all expanded items first
    this.cascadeList.expandedItems.clear();

    // Expand only the first item if it has children
    const firstJob = allJobs[0];
    if (this.cascadeList.hasChildren(firstJob)) {
      this.cascadeList.expandedItems.add(firstJob.id);
    }
  }

  /**
   * Open notes dialog to edit custom instructions for a pending job
   */
  openNotesDialog(job: any): void {
    const dialogRef = this.dialog.open(AnalysisNotesDialogComponent, {
      width: '600px',
      data: {
        jobTitle: job.displayName || 'Analysis Job',
        currentNotes: job.customInstructions || ''
      }
    });

    dialogRef.afterClosed().subscribe(notes => {
      if (notes !== undefined) {
        // Update the job's custom instructions
        this.analysisQueueService.updateJobCustomInstructions(job.id, notes);

        if (notes) {
          this.notificationService.toastOnly('success', 'Notes Saved', 'Custom instructions updated');
        } else {
          this.notificationService.toastOnly('info', 'Notes Cleared', 'Custom instructions removed');
        }
      }
    });
  }

  // Remove a job from the queue
  removeJob(jobId: string): void {
    // Check if it's a pending job
    const pendingJob = this.pendingJobs.find(j => j.id === jobId);
    if (pendingJob) {
      this.removePendingJob(jobId);
    }
  }

  /**
   * Handle reordering of jobs via drag and drop
   */
  onJobsReordered(reorderedItems: any[]): void {
    // Filter to only get the pending jobs (processing jobs can't be reordered)
    const pendingJobIds = new Set(this.pendingJobs.map(j => j.id));
    const reorderedPendingJobs = reorderedItems
      .filter(item => pendingJobIds.has(item.id))
      .map(item => this.pendingJobs.find(j => j.id === item.id)!)
      .filter(job => job !== undefined);

    // Update the order in the analysis queue service
    if (reorderedPendingJobs.length > 0) {
      this.analysisQueueService.reorderJobs(reorderedPendingJobs);
    }
  }

  // Format subtitle for job items
  formatJobSubtitle(job: any): string {
    // For pending jobs, show mode and AI model
    if ('mode' in job && 'aiModel' in job) {
      let mode = 'Full Analysis';
      if (job.mode === 'transcribe-only') {
        mode = 'Transcribe Only';
      } else if (job.mode === 'process-only') {
        mode = 'Process Video';
      }

      if (job.mode === 'process-only') {
        return mode;
      }

      const model = this.formatModelName(job.aiModel);
      return `${mode} • ${model}`;
    }

    // For active jobs, show status
    if ('stage' in job) {
      return this.getJobStatusText(job);
    }

    return 'Processing';
  }

  // Format AI model name for display
  formatModelName(modelString: string): string {
    if (!modelString) return 'Unknown';

    // Remove provider prefix
    const model = modelString.split(':')[1] || modelString;

    // Format common models
    if (model.includes('claude')) {
      if (model.includes('sonnet-4')) return 'Claude Sonnet 4.5';
      if (model.includes('3-5-sonnet')) return 'Claude 3.5 Sonnet';
      if (model.includes('3-5-haiku')) return 'Claude 3.5 Haiku';
      return 'Claude';
    }
    if (model.includes('gpt-4')) return 'GPT-4';
    if (model.includes('gpt-3.5')) return 'GPT-3.5';
    if (model.includes('qwen')) return 'Qwen';

    return model;
  }

  // Progress mapper for active jobs
  // NOTE: Return null so the master progress bar (calculated from children) is shown instead
  jobProgressMapper = (item: any): ItemProgress | null => {
    // All jobs should use master progress bar from their children
    // Regular progress bar is not used for queue items
    return null;
  };

  /**
   * Generate ghost items (children) for a job based on its stages
   * Uses memoization to avoid expensive recalculations on every change detection cycle
   */
  generateJobStages(job: any): CascadeChild[] {
    // Create a cache key based on properties that affect the stages
    const isPending = job.isPending === true;
    const isUrlJob = job.inputType === 'url' || job.url;
    const mode = job.mode || 'full';
    const currentStage = job.stage || 'pending';
    const progress = job.progress || 0;

    const cacheKey = `${job.id}|${isPending}|${isUrlJob}|${mode}|${currentStage}|${progress}`;

    // Check cache first
    const cached = this.jobStagesCache.get(job.id);
    if (cached && cached.key === cacheKey) {
      return cached.stages;
    }

    const children: CascadeChild[] = [];

    // Determine what stages this job will go through

    // For pending jobs, we need to determine stages from the job config
    // For active jobs, we track actual progress through stages

    if (isPending) {
      // PENDING JOBS: Show all planned stages based on mode

      if (mode === 'process-only') {
        // Process-only mode: Only show processing stage
        children.push({
          id: `${job.id}-process`,
          parentId: job.id,
          label: 'Process Video',
          icon: 'aspect_ratio',
          status: 'pending',
          progress: { value: 0 }
        });
      } else if (mode === 'transcribe-only') {
        // Transcribe-only mode
        // Stage 1: Download/Import (only if URL)
        if (isUrlJob) {
          children.push({
            id: `${job.id}-download`,
            parentId: job.id,
            label: 'Download & Import',
            icon: 'download',
            status: 'pending',
            progress: { value: 0 }
          });
        }

        // Stage 2: Transcribe
        children.push({
          id: `${job.id}-transcribe`,
          parentId: job.id,
          label: 'Transcribe',
          icon: 'subtitles',
          status: 'pending',
          progress: { value: 0 }
        });
      } else {
        // Full mode (transcribe + analyze)
        // Stage 1: Download/Import (only if URL)
        if (isUrlJob) {
          children.push({
            id: `${job.id}-download`,
            parentId: job.id,
            label: 'Download & Import',
            icon: 'download',
            status: 'pending',
            progress: { value: 0 }
          });
        }

        // Stage 2: Transcribe
        children.push({
          id: `${job.id}-transcribe`,
          parentId: job.id,
          label: 'Transcribe',
          icon: 'subtitles',
          status: 'pending',
          progress: { value: 0 }
        });

        // Stage 3: Analyze
        children.push({
          id: `${job.id}-analyze`,
          parentId: job.id,
          label: 'Analyze',
          icon: 'psychology',
          status: 'pending',
          progress: { value: 0 }
        });
      }
    } else {
      // ACTIVE JOBS: Show stages based on actual progress
      const currentStage = job.stage;
      const progress = job.progress || 0;

      // Determine which stages have been completed, which is active, and which are pending
      const stages: Array<{
        id: string;
        label: string;
        icon: string;
        stageName: string;
      }> = [];

      // Add stages based on mode
      if (mode === 'process-only') {
        // Process-only mode: Only show processing stage
        stages.push({ id: 'process', label: 'Process Video', icon: 'aspect_ratio', stageName: 'processing' });
      } else if (mode === 'transcribe-only') {
        // Transcribe-only mode
        if (isUrlJob) {
          stages.push({ id: 'download', label: 'Download & Import', icon: 'download', stageName: 'downloading' });
        }
        stages.push({ id: 'transcribe', label: 'Transcribe', icon: 'subtitles', stageName: 'transcribing' });
      } else {
        // Full mode (default if mode not specified)
        if (isUrlJob) {
          stages.push({ id: 'download', label: 'Download & Import', icon: 'download', stageName: 'downloading' });
        }
        stages.push({ id: 'transcribe', label: 'Transcribe', icon: 'subtitles', stageName: 'transcribing' });
        stages.push({ id: 'analyze', label: 'Analyze', icon: 'psychology', stageName: 'analyzing' });
      }

      // Map current stage to determine status of each child
      stages.forEach((stage, index) => {
        let status: CascadeChildStatus = 'pending';
        let stageProgress = 0;

        // Determine status based on current stage
        if (currentStage === 'completed') {
          status = 'completed';
          stageProgress = 100;
        } else if (currentStage === 'failed') {
          // If the job failed, mark the current stage as failed, others as pending
          status = index === 0 || stages[index - 1]?.stageName === currentStage ? 'failed' : 'pending';
          stageProgress = status === 'failed' ? progress : 0;
        } else if (stage.stageName === currentStage) {
          status = 'active';
          stageProgress = progress;
        } else {
          // Check if this stage is before or after the current stage
          const currentStageIndex = stages.findIndex(s => s.stageName === currentStage);
          if (currentStageIndex !== -1 && index < currentStageIndex) {
            status = 'completed';
            stageProgress = 100;
          } else {
            status = 'pending';
            stageProgress = 0;
          }
        }

        children.push({
          id: `${job.id}-${stage.id}`,
          parentId: job.id,
          label: stage.label,
          icon: stage.icon,
          status: status,
          progress: {
            value: stageProgress,
            indeterminate: status === 'active' && stageProgress < 5 // Show spinner when active but no progress yet
          }
        });
      });
    }

    // Store in cache before returning
    this.jobStagesCache.set(job.id, { key: cacheKey, stages: children });

    return children;
  }

  /**
   * Calculate master progress as the average of all child stage progress
   * Uses memoization to avoid expensive recalculations on every change detection cycle
   */
  calculateMasterProgress(job: any): number {
    // Create a cache key (same as generateJobStages since it depends on the same properties)
    const isPending = job.isPending === true;
    const isUrlJob = job.inputType === 'url' || job.url;
    const mode = job.mode || 'full';
    const currentStage = job.stage || 'pending';
    const progress = job.progress || 0;

    const cacheKey = `${job.id}|${isPending}|${isUrlJob}|${mode}|${currentStage}|${progress}`;

    // Check cache first
    const cached = this.masterProgressCache.get(job.id);
    if (cached && cached.key === cacheKey) {
      return cached.progress;
    }

    // Calculate progress
    const children = this.generateJobStages(job);

    if (children.length === 0) {
      this.masterProgressCache.set(job.id, { key: cacheKey, progress: 0 });
      return 0;
    }

    const totalProgress = children.reduce((sum, child) => {
      return sum + (child.progress?.value || 0);
    }, 0);

    const result = Math.round(totalProgress / children.length);

    // Store in cache before returning
    this.masterProgressCache.set(job.id, { key: cacheKey, progress: result });

    return result;
  }
}
