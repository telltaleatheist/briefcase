import { Component, OnInit, OnDestroy, Inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatRadioModule } from '@angular/material/radio';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule, MatExpansionPanel } from '@angular/material/expansion';
import { MatDividerModule } from '@angular/material/divider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { DownloadProgressService, VideoProcessingJob } from '../../services/download-progress.service';
import { DatabaseLibraryService, DatabaseVideo } from '../../services/database-library.service';
import { Subscription } from 'rxjs';

interface AnalysisJob {
  id: string;
  status: string;
  progress: number;
  currentPhase: string;
  error?: string;
  videoPath?: string;
  transcriptPath?: string;
  analysisPath?: string;
  input?: string;
  customInstructions?: string;
  aiModel?: string;
  expanded?: boolean;
}

@Component({
  selector: 'app-video-analysis',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatRadioModule,
    MatProgressBarModule,
    MatExpansionModule,
    MatDividerModule,
    MatTabsModule,
    MatDialogModule,
    MatTooltipModule,
  ],
  templateUrl: './video-analysis.component.html',
  styleUrls: ['./video-analysis.component.scss']
})
export class VideoAnalysisComponent implements OnInit, OnDestroy {
  analysisForm: FormGroup;
  currentJob: AnalysisJob | null = null;
  isProcessing = false;
  availableOllamaModels: string[] = [];
  processingJobs: VideoProcessingJob[] = [];
  private jobsSubscription?: Subscription;

  // Video library integration
  libraryVideos: DatabaseVideo[] = [];
  filteredLibraryVideos: DatabaseVideo[] = [];
  isLoadingLibrary = false;
  librarySearchQuery = '';

  // Drag and drop
  isDraggingFile = false;

  @ViewChild(MatExpansionPanel) advancedPanel!: MatExpansionPanel;

  private pollingInterval: any = null;

  constructor(
    private fb: FormBuilder,
    private snackBar: MatSnackBar,
    private dialog: MatDialog,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private downloadProgressService: DownloadProgressService,
    private databaseLibraryService: DatabaseLibraryService,
    private router: Router,
  ) {
    this.analysisForm = this.createForm();
  }

  async ngOnInit(): Promise<void> {
    // Subscribe to download/processing jobs from the unified service
    this.jobsSubscription = this.downloadProgressService.jobs$.subscribe(jobsMap => {
      this.processingJobs = Array.from(jobsMap.values());
    });

    // Check for navigation state with video path
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || (history.state?.navigationId ? history.state : null);

    if (state && state['videoPath']) {
      // Pre-populate the form with the video path from navigation
      this.analysisForm.patchValue({
        inputType: 'file',
        input: state['videoPath']
      });

      // Show a notification
      if (state['videoTitle']) {
        this.notificationService.toastOnly('info', 'Video Ready', `Ready to analyze: ${state['videoTitle']}`);
      }
    }

    // Load available Ollama models
    await this.loadAvailableOllamaModels();

    // Load saved settings (AI model, etc.)
    await this.loadSettings();

    // Check for any active jobs and restore state
    await this.checkForActiveJobs();

    // Load library videos when in file mode with no file selected
    await this.loadLibraryVideos();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    if (this.jobsSubscription) {
      this.jobsSubscription.unsubscribe();
    }
  }

  createForm(): FormGroup {
    return this.fb.group({
      inputType: ['url', Validators.required],
      input: ['', Validators.required],
      customInstructions: [''], // Custom instructions for AI analysis
      aiModel: ['ollama:qwen2.5:7b', Validators.required], // Format: provider:model
      apiKey: [''], // API key for Claude/OpenAI
      ollamaEndpoint: ['http://localhost:11434'],
      whisperModel: ['base'],
      language: ['en'],
    });
  }

  /**
   * Check if the selected model needs an API key
   */
  needsApiKey(): boolean {
    const model = this.analysisForm.get('aiModel')?.value || '';
    return model.startsWith('claude:') || model.startsWith('openai:');
  }

  /**
   * Get the appropriate API key label based on selected provider
   */
  getApiKeyLabel(): string {
    const model = this.analysisForm.get('aiModel')?.value || '';
    if (model.startsWith('claude:')) {
      return 'Claude API Key';
    } else if (model.startsWith('openai:')) {
      return 'OpenAI API Key';
    }
    return 'API Key';
  }

  /**
   * Handle model change - auto-update aiProvider field and load appropriate API key
   */
  async onModelChange(): Promise<void> {
    const model = this.analysisForm.get('aiModel')?.value || '';

    // Extract provider from model string (format: provider:model)
    let provider = 'ollama';
    if (model.startsWith('claude:')) {
      provider = 'claude';
    } else if (model.startsWith('openai:')) {
      provider = 'openai';
    }

    // Store provider for backend (though we can also parse it from aiModel)
    this.analysisForm.patchValue({ aiProvider: provider }, { emitEvent: false });

    // Load the appropriate API key when switching models
    try {
      const settings = await (window as any).electron?.getSettings();
      if (settings) {
        if (provider === 'claude' && settings.claudeApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.claudeApiKey });
        } else if (provider === 'openai' && settings.openaiApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.openaiApiKey });
        } else if (provider === 'ollama') {
          this.analysisForm.patchValue({ apiKey: '' });
        }
      }
    } catch (error) {
      console.error('Failed to load API key for provider:', error);
    }
  }

  async onSubmit(): Promise<void> {
    if (this.analysisForm.invalid) {
      this.notificationService.warning('Form Incomplete', 'Please fill in all required fields');
      return;
    }

    const formValue = this.analysisForm.value;

    try {
      // First, check if a report already exists
      const checkUrl = await this.backendUrlService.getApiUrl('/analysis/check-existing-report');
      const existingCheck = await fetch(checkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: formValue.input,
          inputType: formValue.inputType,
          outputPath: formValue.outputPath
        }),
      });

      if (!existingCheck.ok) {
        throw new Error('Failed to check for existing report');
      }

      const existingData = await existingCheck.json();

      // If report exists, show dialog
      if (existingData.exists) {
        const action = await this.showExistingReportDialog(existingData.reportName, existingData.stats);

        if (action === 'cancel') {
          return; // User cancelled
        }

        if (action === 'new') {
          // Generate new filename with timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
          const baseName = existingData.reportName.replace('.txt', '');
          formValue.customReportName = `${baseName}_${timestamp}_${Date.now()}.txt`;
        }

        // For 'overwrite', we don't need to do anything special - just proceed
      }

      this.isProcessing = true;

      // Auto-save settings when starting analysis
      await this.saveSettings();

      // Parse provider and model from combined format (provider:model)
      const fullModel = formValue.aiModel || '';
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

      // Prepare request with separated provider and model
      const requestData = {
        ...formValue,
        aiProvider: provider,
        aiModel: modelName,
      };

      // Start analysis via API (backend will check model availability)
      const startUrl = await this.backendUrlService.getApiUrl('/analysis/start');
      const response = await fetch(startUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
      });

      if (!response.ok) {
        const errorData = await response.json();

        // Check if it's a model unavailability error (HTTP 412)
        if (response.status === 412 && errorData.instructions) {
          this.showModelUnavailableDialog(formValue.aiModel, errorData.instructions);
          this.isProcessing = false;
          return;
        }

        throw new Error(errorData.message || 'Failed to start analysis');
      }

      const result = await response.json();

      // Save job details including form data for display in accordion
      this.currentJob = {
        id: result.jobId,
        status: 'pending',
        progress: 0,
        currentPhase: 'Starting analysis...',
        input: formValue.input,
        customInstructions: formValue.customInstructions,
        aiModel: formValue.aiModel,
        expanded: false
      };

      this.notificationService.success('Analysis Started', 'Video analysis has been queued');

      // Clear form fields
      this.analysisForm.patchValue({
        input: '',
        customInstructions: ''
      });

      // Start polling for progress updates
      this.startPolling();

    } catch (error: any) {
      // Use notification service for detailed error reporting
      this.notificationService.error('Analysis Start Failed', error.message || 'Failed to start video analysis');
      this.isProcessing = false;
    }
  }

  /**
   * Start polling for job progress updates (REST polling - simple and reliable)
   */
  private startPolling(): void {
    // Clear any existing polling
    this.stopPolling();

    console.log('[Video Analysis] Starting REST polling for job:', this.currentJob?.id);

    // Poll every 500ms
    this.pollingInterval = setInterval(async () => {
      if (!this.currentJob) {
        this.stopPolling();
        return;
      }

      try {
        const jobUrl = await this.backendUrlService.getApiUrl(`/analysis/job/${this.currentJob.id}`);
        const response = await fetch(jobUrl);

        if (!response.ok) {
          console.error('[Video Analysis] Failed to fetch job status:', response.status);
          return;
        }

        const data = await response.json();

        if (data.success && data.job) {
          console.log('[Video Analysis] Polled job status:', data.job);

          // Update the entire job object
          this.currentJob = {
            ...this.currentJob,
            ...data.job
          };

          // Check if job is complete
          if (data.job.status === 'completed') {
            this.isProcessing = false;
            this.stopPolling();
            this.notificationService.success('Analysis Complete', 'Video analysis finished successfully');
          } else if (data.job.status === 'failed') {
            this.isProcessing = false;
            this.stopPolling();
            // Use notification service for errors with full error details
            const errorMessage = data.job.error || 'Unknown error occurred during analysis';
            this.notificationService.error('Analysis Failed', errorMessage);
          }
        }
      } catch (error: any) {
        console.error('[Video Analysis] Polling error:', error);
      }
    }, 500);
  }

  /**
   * Stop polling for progress updates
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      console.log('[Video Analysis] Stopping REST polling');
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async browseFile(): Promise<void> {
    try {
      // Use Electron dialog API to select file
      const result = await (window as any).electron?.selectVideoFile();

      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        this.analysisForm.patchValue({ input: filePath });
        this.notificationService.success('File Selected', filePath);
      }
    } catch (error) {
      console.error('Error selecting file:', error);
      this.notificationService.error('File Selection Failed', 'Could not select file');
    }
  }

  /**
   * Handle file drag over event
   */
  onFileDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = true;
  }

  /**
   * Handle file drag leave event
   */
  onFileDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = false;
  }

  /**
   * Handle file drop event
   */
  async onFileDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    // Check for Electron API
    const electron = (window as any).electron;
    if (!electron || !electron.getFilePathFromFile) {
      this.notificationService.error(
        'Not Available',
        'Drag and drop only works in Electron app'
      );
      return;
    }

    // Get the first file
    const file = files[0];

    // Validate file type
    const validExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
    const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));

    if (!validExtensions.includes(ext)) {
      this.notificationService.error(
        'Invalid File Type',
        'Please drop a video file (.mp4, .mov, .avi, etc.)'
      );
      return;
    }

    try {
      // Use Electron's webUtils to get the real file path
      const filePath = electron.getFilePathFromFile(file);
      this.analysisForm.patchValue({ input: filePath });
      this.notificationService.toastOnly('success', 'File Selected', file.name);
    } catch (error) {
      console.error('Failed to get file path:', error);
      this.notificationService.error('Error', 'Failed to process dropped file');
    }
  }

  async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      this.analysisForm.patchValue({ input: text });
      this.notificationService.success('Pasted', 'URL pasted from clipboard');
    } catch (error) {
      this.notificationService.error('Paste Failed', 'Could not paste from clipboard');
    }
  }

  getProgressColor(): string {
    if (!this.currentJob) return 'primary';

    if (this.currentJob.status === 'completed') return 'accent';
    if (this.currentJob.status === 'failed') return 'warn';

    return 'primary';
  }

  getStatusIcon(): string {
    if (!this.currentJob) return 'info';

    switch (this.currentJob.status) {
      case 'downloading': return 'cloud_download';
      case 'extracting': return 'music_note';
      case 'transcribing': return 'mic';
      case 'analyzing': return 'psychology';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'hourglass_empty';
    }
  }

  /**
   * Load available Ollama models from the backend
   */
  private async loadAvailableOllamaModels(): Promise<void> {
    try {
      console.log('[Video Analysis] Loading available Ollama models...');
      const modelsUrl = await this.backendUrlService.getApiUrl('/analysis/models');
      console.log('[Video Analysis] Fetching from URL:', modelsUrl);

      const response = await fetch(modelsUrl);
      console.log('[Video Analysis] Response status:', response.status, response.statusText);

      if (!response.ok) {
        console.warn('[Video Analysis] Failed to fetch Ollama models, response not OK:', response.status);
        return;
      }

      const data = await response.json();
      console.log('[Video Analysis] Response data:', data);

      if (data.success && data.connected && data.models) {
        // Extract model names from the response
        this.availableOllamaModels = data.models.map((model: any) => model.name);
        console.log(`[Video Analysis] Found ${this.availableOllamaModels.length} Ollama models:`, this.availableOllamaModels);

        // If the current model is not in the available models list, update it to the first available model
        const currentModel = this.analysisForm.get('aiModel')?.value || '';
        if (currentModel.startsWith('ollama:')) {
          const modelName = currentModel.replace('ollama:', '');
          if (!this.availableOllamaModels.includes(modelName)) {
            // Set to first available Ollama model, or Claude if no Ollama models available
            if (this.availableOllamaModels.length > 0) {
              this.analysisForm.patchValue({ aiModel: `ollama:${this.availableOllamaModels[0]}` });
            } else {
              // Default to Claude if no Ollama models available
              this.analysisForm.patchValue({ aiModel: 'claude:claude-3-5-sonnet-20241022' });
            }
          }
        }
      } else {
        console.warn('[Video Analysis] Ollama not connected or no models available. Response:', {
          success: data.success,
          connected: data.connected,
          models: data.models
        });
        // If Ollama not connected and current model is Ollama, switch to Claude
        const currentModel = this.analysisForm.get('aiModel')?.value || '';
        if (currentModel.startsWith('ollama:')) {
          this.analysisForm.patchValue({ aiModel: 'claude:claude-3-5-sonnet-20241022' });
        }
      }
    } catch (error) {
      console.error('[Video Analysis] Error loading Ollama models:', error);
      // Continue without Ollama models - user can still use Claude/OpenAI
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      // Load settings from electron-store
      const settings = await (window as any).electron?.getSettings();

      if (settings) {
        // Load last used model (now in format provider:model)
        if (settings.lastUsedModel) {
          this.analysisForm.patchValue({ aiModel: settings.lastUsedModel });
        }

        // Load the appropriate API key based on last used model
        const lastModel = settings.lastUsedModel || '';
        if (lastModel.startsWith('claude:') && settings.claudeApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.claudeApiKey });
        } else if (lastModel.startsWith('openai:') && settings.openaiApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.openaiApiKey });
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
      // Continue with defaults if loading fails
    }
  }

  async saveSettings(): Promise<void> {
    try {
      const model = this.analysisForm.get('aiModel')?.value || '';
      const apiKey = this.analysisForm.get('apiKey')?.value;

      // Extract provider from model string (format: provider:model)
      let provider = 'ollama';
      if (model.startsWith('claude:')) {
        provider = 'claude';
      } else if (model.startsWith('openai:')) {
        provider = 'openai';
      }

      // Save to electron-store
      const updates: any = {
        lastUsedProvider: provider,
        lastUsedModel: model, // Save full format: provider:model
      };

      // Save API key if provided and not masked
      if (apiKey && apiKey !== '***') {
        if (provider === 'claude') {
          updates.claudeApiKey = apiKey;
        } else if (provider === 'openai') {
          updates.openaiApiKey = apiKey;
        }
      }

      await (window as any).electron?.updateSettings(updates);
      this.notificationService.success('Settings Saved', 'Analysis preferences have been updated');

      // Close the advanced options accordion
      if (this.advancedPanel) {
        this.advancedPanel.close();
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.notificationService.error('Save Failed', 'Could not save settings');
    }
  }

  async openAnalysisFile(): Promise<void> {
    if (this.currentJob?.analysisPath) {
      // Open file in default application using electron API
      try {
        await (window as any).electron?.openFile(this.currentJob.analysisPath);
      } catch (error) {
        this.notificationService.error('Open Failed', 'Could not open analysis file');
      }
    }
  }

  async openTranscriptFile(): Promise<void> {
    if (this.currentJob?.transcriptPath) {
      try {
        await (window as any).electron?.openFile(this.currentJob.transcriptPath);
      } catch (error) {
        this.notificationService.error('Open Failed', 'Could not open transcript file');
      }
    }
  }

  showModelUnavailableDialog(model: string, instructions: string): void {
    const dialogRef = this.dialog.open(ModelUnavailableDialog, {
      width: '600px',
      data: { model, instructions }
    });
  }

  async showExistingReportDialog(reportName: string, stats: any): Promise<string> {
    const dialogRef = this.dialog.open(ExistingReportDialog, {
      width: '750px',
      maxWidth: '90vw',
      data: { reportName, stats },
      disableClose: true // Prevent closing by clicking outside
    });

    const result = await dialogRef.afterClosed().toPromise();
    return result || 'cancel';
  }

  /**
   * Check for any active jobs on component init
   */
  private async checkForActiveJobs(): Promise<void> {
    try {
      const jobsUrl = await this.backendUrlService.getApiUrl('/analysis/jobs');
      const response = await fetch(jobsUrl);
      if (!response.ok) {
        // Backend may not be ready yet during startup - silently ignore
        console.log('[Video Analysis] Backend not ready yet, skipping active job check');
        return;
      }

      const data = await response.json();
      if (data.success && data.jobs && data.jobs.length > 0) {
        // Find the first non-completed job
        const activeJob = data.jobs.find((job: AnalysisJob) =>
          job.status !== 'completed' && job.status !== 'failed'
        );

        if (activeJob) {
          console.log('[Video Analysis] Found active job on init:', activeJob.id);
          this.currentJob = activeJob;
          this.isProcessing = true;
          this.startPolling();
        }
      }
    } catch (error) {
      // Backend may not be ready yet during startup - silently ignore
      console.log('[Video Analysis] Backend not ready yet, skipping active job check');
    }
  }

  getPhaseDescription(phase: string): string {
    const descriptions: {[key: string]: string} = {
      'Starting analysis...': 'Initializing video analysis pipeline',
      'Downloading video...': 'Fetching video from URL',
      'Extracting audio...': 'Extracting audio track from video file',
      'Loading Whisper model (base)...': 'Loading AI transcription model into memory',
      'Transcribing audio (this may take a few minutes)...': 'Converting speech to text using Whisper AI',
      'Transcription complete, formatting results...': 'Generating transcript file with timestamps',
      'Starting AI analysis...': 'Initializing Ollama AI model for content analysis',
      'Analyzing transcript...': 'AI is reading and analyzing the transcript content',
      'Finding interesting sections...': 'AI is identifying notable quotes and moments',
      'Analysis complete...': 'Finalizing analysis report'
    };
    return descriptions[phase] || phase || 'Processing...';
  }

  toggleJobDetails(): void {
    if (this.currentJob) {
      this.currentJob.expanded = !this.currentJob.expanded;
    }
  }

  // Helper methods for unified job queue
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
        return 'cloud_download';
      case 'importing':
        return 'file_download';
      case 'transcribing':
        return 'mic';
      case 'analyzing':
        return 'psychology';
      default:
        return 'hourglass_empty';
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
        return 'Failed';
      default:
        return 'Processing';
    }
  }

  getRelativeTime(date: Date): string {
    const now = new Date();
    const diff = Math.floor((now.getTime() - new Date(date).getTime()) / 1000);

    if (diff < 60) {
      return 'just now';
    } else if (diff < 3600) {
      const mins = Math.floor(diff / 60);
      return `${mins}m ago`;
    } else if (diff < 86400) {
      const hours = Math.floor(diff / 3600);
      return `${hours}h ago`;
    } else {
      const days = Math.floor(diff / 86400);
      return `${days}d ago`;
    }
  }

  /**
   * Load videos from library for quick selection
   */
  async loadLibraryVideos() {
    try {
      this.isLoadingLibrary = true;
      // Load first 50 videos sorted by date (most recent first)
      const response = await this.databaseLibraryService.getVideos(50, 0);
      this.libraryVideos = response.videos;
      this.filteredLibraryVideos = response.videos;
    } catch (error) {
      console.error('Failed to load library videos:', error);
      // Silently fail - library might not be initialized yet
    } finally {
      this.isLoadingLibrary = false;
    }
  }

  /**
   * Filter library videos based on search query
   */
  onLibrarySearchChange() {
    if (!this.librarySearchQuery.trim()) {
      this.filteredLibraryVideos = this.libraryVideos;
      return;
    }

    const query = this.librarySearchQuery.toLowerCase();
    this.filteredLibraryVideos = this.libraryVideos.filter(video =>
      video.filename.toLowerCase().includes(query) ||
      (video.date_folder && video.date_folder.toLowerCase().includes(query))
    );
  }

  /**
   * Select a video from library and set it as the input
   */
  selectLibraryVideo(video: DatabaseVideo) {
    // Set the video path as input
    this.analysisForm.patchValue({
      inputType: 'file',
      input: video.current_path
    });

    this.notificationService.success('Video Selected', video.filename);
  }

  /**
   * Format file size helper
   */
  formatFileSize(bytes: number | null): string {
    return this.databaseLibraryService.formatFileSize(bytes);
  }

  /**
   * Format duration helper
   */
  formatDuration(seconds: number | null): string {
    return this.databaseLibraryService.formatDuration(seconds);
  }

  /**
   * Format date helper
   */
  formatDate(dateString: string | null): string {
    if (!dateString) return 'Unknown';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  }
}

// Dialog component for model unavailable
@Component({
  selector: 'model-unavailable-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <div class="model-dialog">
      <h2 mat-dialog-title>
        <mat-icon>error_outline</mat-icon>
        AI Model Not Available
      </h2>
      <mat-dialog-content>
        <p class="dialog-message">
          The AI model <strong>{{ data.model }}</strong> is not currently available on your system.
        </p>

        <div class="instructions-box">
          <h3>Installation Instructions:</h3>
          <pre>{{ data.instructions }}</pre>
        </div>

        <p class="dialog-note">
          After installing the model, try starting the analysis again.
        </p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-raised-button color="primary" mat-dialog-close>
          <mat-icon>check</mat-icon>
          OK
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .model-dialog {
      h2 {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--primary-orange);
        margin: 0;
      }

      mat-icon {
        color: var(--primary-orange);
      }
    }

    .dialog-message {
      margin: 1rem 0;
      font-size: 1rem;
      color: var(--text-primary);
    }

    .instructions-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--border-radius);
      padding: 1rem;
      margin: 1rem 0;

      h3 {
        margin: 0 0 0.5rem 0;
        font-size: 0.9rem;
        color: var(--primary-orange);
      }

      pre {
        background: var(--bg-primary);
        padding: 1rem;
        border-radius: 4px;
        font-family: 'Courier New', monospace;
        font-size: 0.875rem;
        line-height: 1.6;
        color: var(--text-primary);
        white-space: pre-wrap;
        margin: 0;
      }
    }

    .dialog-note {
      font-size: 0.9rem;
      color: var(--text-secondary);
      font-style: italic;
      margin: 1rem 0 0 0;
    }

    mat-dialog-actions {
      padding: 1rem 0 0 0;
      margin: 0;
    }
  `]
})
export class ModelUnavailableDialog {
  constructor(@Inject(MAT_DIALOG_DATA) public data: any) {}
}

// Dialog component for existing report
@Component({
  selector: 'existing-report-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <div class="existing-report-dialog">
      <div class="dialog-header">
        <div class="header-icon">
          <mat-icon>description</mat-icon>
        </div>
        <div class="header-content">
          <h2>Report Already Exists</h2>
          <p class="filename">{{ data.reportName }}</p>
        </div>
      </div>

      <mat-dialog-content>
        <div class="file-info">
          <mat-icon>schedule</mat-icon>
          <span class="info-text">Last modified: {{ formatDate(data.stats.mtime) }}</span>
        </div>

        <div class="action-prompt">
          <p>Choose how to proceed:</p>
        </div>
      </mat-dialog-content>

      <mat-dialog-actions>
        <button mat-stroked-button class="cancel-btn" [mat-dialog-close]="'cancel'">
          <mat-icon>close</mat-icon>
          Cancel
        </button>
        <button mat-raised-button class="overwrite-btn" [mat-dialog-close]="'overwrite'">
          <mat-icon>sync</mat-icon>
          Replace Existing
        </button>
        <button mat-raised-button class="new-btn" [mat-dialog-close]="'new'">
          <mat-icon>add_circle_outline</mat-icon>
          Save as New
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .existing-report-dialog {
      width: 750px;
      max-width: 90vw;
    }

    .dialog-header {
      display: flex;
      align-items: flex-start;
      gap: 1.25rem;
      padding: 2.5rem 2.5rem 2rem 2.5rem;
      background: linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-card) 100%);
      border-bottom: 2px solid var(--primary-orange);

      .header-icon {
        background: var(--primary-orange);
        border-radius: 12px;
        width: 56px;
        height: 56px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-shadow: 0 4px 12px rgba(255, 107, 53, 0.3);

        mat-icon {
          color: white;
          font-size: 32px;
          width: 32px;
          height: 32px;
        }
      }

      .header-content {
        flex: 1;
        min-width: 0;

        h2 {
          margin: 0;
          font-size: 1.75rem;
          font-weight: 600;
          color: var(--text-primary);
          line-height: 1.3;
        }

        .filename {
          margin: 0.75rem 0 0 0;
          font-size: 1rem;
          color: var(--primary-orange);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
    }

    mat-dialog-content {
      padding: 2.5rem;
      margin: 0;
      overflow: visible !important;
      max-height: none !important;
    }

    .file-info {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2.5rem;

      mat-icon {
        color: var(--primary-orange);
        font-size: 24px;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
      }

      .info-text {
        font-size: 1.05rem;
        color: var(--text-secondary);
      }
    }

    .action-prompt {
      padding: 1.5rem 0 0 0;
      border-top: 1px solid var(--border-color);

      p {
        margin: 0;
        font-size: 1.1rem;
        color: var(--text-primary);
        font-weight: 500;
      }
    }

    mat-dialog-actions {
      padding: 0 2.5rem 2.5rem 2.5rem;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;

      button {
        white-space: nowrap;
        font-size: 0.875rem;
        font-weight: 600;
        padding: 0 1.5rem !important;
        height: 40px !important;
        line-height: 40px !important;
        border-radius: 4px !important;

        mat-icon {
          font-size: 20px;
          width: 20px;
          height: 20px;
          margin-right: 0.25rem;
        }
      }

      .cancel-btn {
        // Material default stroked button styling
      }

      .overwrite-btn,
      .new-btn {
        background: var(--primary-orange) !important;
        color: white !important;

        &:hover {
          background: var(--dark-orange) !important;
        }
      }
    }

    @media (max-width: 600px) {
      .existing-report-dialog {
        min-width: 100%;
      }

      mat-dialog-actions {
        grid-template-columns: 1fr;

        button {
          width: 100%;
        }
      }
    }
  `]
})
export class ExistingReportDialog {
  constructor(@Inject(MAT_DIALOG_DATA) public data: any) {}

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString();
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}
