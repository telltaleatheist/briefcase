import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { VideoProcessingQueueService } from '../../services/video-processing-queue.service';
import { ProcessType, ProcessConfig } from '../../models/video-processing.model';
import { AiSetupHelperService, AIAvailability } from '../../services/ai-setup-helper.service';
import { AiSetupWizardComponent } from '../ai-setup-wizard/ai-setup-wizard.component';
import { AiSetupTooltipComponent } from '../ai-setup-tooltip/ai-setup-tooltip.component';
import { BatchApiService } from '../../services/batch-api.service';
import { catchError, of } from 'rxjs';

export interface VideoAnalysisDialogData {
  mode?: 'analyze' | 'transcribe' | 'import' | 'download';
  selectedVideos?: any[];
  videoPath?: string;
  videoTitle?: string;
}

@Component({
  selector: 'app-video-analysis-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule
  ],
  templateUrl: './video-analysis-dialog.component.html',
  styleUrls: ['./video-analysis-dialog.component.scss']
})
export class VideoAnalysisDialogComponent implements OnInit {
  analysisForm: FormGroup;
  availableOllamaModels: string[] = [];
  isDraggingFile = false;
  aiAvailability: AIAvailability | null = null;
  showAiSetupPrompt = false;

  // Title fetching for URLs
  fetchedVideoTitle: string = '';
  fetchedUploadDate: string = '';
  isFetchingTitle = false;

  constructor(
    private fb: FormBuilder,
    private dialogRef: MatDialogRef<VideoAnalysisDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: VideoAnalysisDialogData,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private videoProcessingQueueService: VideoProcessingQueueService,
    private aiSetupHelper: AiSetupHelperService,
    private dialog: MatDialog,
    private batchApiService: BatchApiService
  ) {
    this.analysisForm = this.createForm();
  }

  async ngOnInit(): Promise<void> {
    // Check AI availability first
    this.aiAvailability = await this.aiSetupHelper.checkAIAvailability();

    // Load available Ollama models
    await this.loadAvailableOllamaModels();

    // Load saved settings
    await this.loadSettings();

    // Set default transcribe state based on whether video has transcript
    // If single video with transcript, leave unchecked; otherwise check by default
    const shouldDefaultTranscribe = !this.allVideosHaveTranscripts();

    // Pre-populate form based on dialog data
    if (this.data.mode === 'transcribe') {
      this.analysisForm.patchValue({ transcribe: true });
    } else if (this.data.mode === 'analyze') {
      this.analysisForm.patchValue({ aiAnalysis: true, transcribe: true });
    } else {
      // Set default transcribe state
      this.analysisForm.patchValue({ transcribe: shouldDefaultTranscribe });
    }

    // If video path provided, set it
    if (this.data.videoPath) {
      this.analysisForm.patchValue({
        inputType: 'file',
        input: this.data.videoPath
      });
    }

    // If this is for URL import or download, default to URL input
    if (this.data.mode === 'import' || this.data.mode === 'download') {
      this.analysisForm.patchValue({ inputType: 'url' });
    }

    // Update validation based on whether we have selected videos
    this.updateInputValidation();

    // Check if we should show AI setup prompt
    this.checkAndPromptAISetup();

    // Watch URL changes to fetch title automatically (for download mode)
    if (this.data.mode === 'download' || this.data.mode === 'import') {
      this.analysisForm.get('input')?.valueChanges.subscribe((url: string) => {
        if (url && url.trim() && this.analysisForm.get('inputType')?.value === 'url') {
          this.fetchVideoTitle(url);
        }
      });
    }

    // Watch aiAnalysis checkbox - auto-select transcribe and manage disabled state
    this.analysisForm.get('aiAnalysis')?.valueChanges.subscribe((selected: boolean) => {
      const transcribeControl = this.analysisForm.get('transcribe');

      if (selected) {
        // Always auto-check transcribe when AI analysis is selected
        transcribeControl?.patchValue(true, { emitEvent: false });

        // Disable transcribe control if required (no transcript or multiple files)
        if (this.shouldDisableTranscribeWhenAISelected()) {
          transcribeControl?.disable({ emitEvent: false });
        } else {
          transcribeControl?.enable({ emitEvent: false });
        }
      } else {
        // Re-enable transcribe when AI analysis is unchecked
        transcribeControl?.enable({ emitEvent: false });
      }
    });
  }

  createForm(): FormGroup {
    return this.fb.group({
      inputType: ['url', Validators.required],
      input: [''], // Don't require if selectedVideos provided
      // Processing options as checkboxes
      processVideo: [false],
      normalizeAudio: [false],
      aiAnalysis: [false],
      transcribe: [false],
      customInstructions: [''],
      aiModel: ['ollama:qwen2.5:7b', Validators.required],
      apiKey: [''],
      ollamaEndpoint: ['http://localhost:11434'],
      whisperModel: ['base'],
      language: ['en'],
    });
  }

  isAIAnalysisEnabled(): boolean {
    return this.analysisForm.get('aiAnalysis')?.value === true;
  }

  isTranscriptionEnabled(): boolean {
    return this.analysisForm.get('transcribe')?.value === true;
  }

  isImportOnly(): boolean {
    // Import only means no processing options are selected
    return !this.analysisForm.get('processVideo')?.value &&
           !this.analysisForm.get('normalizeAudio')?.value &&
           !this.analysisForm.get('aiAnalysis')?.value &&
           !this.analysisForm.get('transcribe')?.value;
  }

  /**
   * Check if videos are already in library (not new imports)
   */
  isFromLibrary(): boolean {
    // If mode is 'import', these are NEW videos being imported, not from library
    if (this.data.mode === 'import') {
      return false;
    }
    // Otherwise, if we have selectedVideos, they're from the library
    return !!(this.data.selectedVideos && this.data.selectedVideos.length > 0);
  }

  /**
   * Check if all selected videos have transcripts
   */
  allVideosHaveTranscripts(): boolean {
    if (!this.data.selectedVideos || this.data.selectedVideos.length === 0) {
      return false;
    }
    // has_transcript is 0 or 1 (SQLite boolean)
    return this.data.selectedVideos.every(video => video.has_transcript === 1);
  }

  /**
   * Check if transcribe should be disabled when AI is selected
   * Returns true if transcribe is REQUIRED (should be disabled)
   */
  shouldDisableTranscribeWhenAISelected(): boolean {
    // For multiple files, transcribe is required
    if (this.data.selectedVideos && this.data.selectedVideos.length > 1) {
      return true;
    }

    // For single file, only required if no transcript exists
    if (this.data.selectedVideos && this.data.selectedVideos.length === 1) {
      return !this.allVideosHaveTranscripts();
    }

    // For new imports (no selectedVideos), transcribe is required
    return true;
  }

  /**
   * Check if transcribe checkbox should be disabled
   * It's disabled when:
   * 1. AI analysis is selected AND
   * 2. Either there are multiple files OR no video has a transcript
   */
  isTranscribeDisabled(): boolean {
    const aiAnalysisSelected = this.analysisForm.get('aiAnalysis')?.value;
    if (!aiAnalysisSelected) {
      return false;
    }

    return this.shouldDisableTranscribeWhenAISelected();
  }

  /**
   * Convert checkbox selections to ProcessConfig array for the new queue service
   */
  private getProcessConfigs(): ProcessConfig[] {
    const processes: ProcessConfig[] = [];
    const formValue = this.analysisForm.getRawValue();

    // IMPORTANT: If input is a URL (not a local file), add download as FIRST task
    const isUrl = formValue.inputType === 'url' && formValue.input && formValue.input.trim();
    if (isUrl && !this.data.selectedVideos) {
      try {
        new URL(formValue.input); // Validate it's actually a URL

        // Add download task as the FIRST child process
        processes.push({
          type: 'download' as ProcessType,
          config: {
            downloadUrl: formValue.input,
            postTitle: this.fetchedVideoTitle || '',
            outputDir: undefined, // Backend will use default library path
            quality: '1080',
            convertToMp4: true
          }
        });

        console.log('[VideoAnalysisDialog] Added download task for URL:', formValue.input);
      } catch (e) {
        console.warn('[VideoAnalysisDialog] Input is not a valid URL, skipping download task');
      }
    }

    // Process video (aspect ratio fix)
    if (formValue.processVideo) {
      processes.push({
        type: 'process' as ProcessType,
        config: {}
      });
    }

    // Normalize audio
    if (formValue.normalizeAudio) {
      processes.push({
        type: 'normalize' as ProcessType,
        config: {}
      });
    }

    // Transcribe (if selected without AI analysis, or with AI analysis)
    if (formValue.transcribe) {
      processes.push({
        type: 'transcribe' as ProcessType,
        config: {
          whisperModel: formValue.whisperModel || 'base',
          language: formValue.language || 'en'
        }
      });
    }

    // AI Analysis
    if (formValue.aiAnalysis) {
      const aiModel = formValue.aiModel || '';
      processes.push({
        type: 'analyze' as ProcessType,
        config: {
          aiModel: aiModel,
          apiKey: formValue.apiKey,
          ollamaEndpoint: formValue.ollamaEndpoint || 'http://localhost:11434',
          customInstructions: formValue.customInstructions || ''
        }
      });
    }

    return processes;
  }

  needsApiKey(): boolean {
    const model = this.analysisForm.get('aiModel')?.value || '';
    return model.startsWith('claude:') || model.startsWith('openai:');
  }

  getApiKeyLabel(): string {
    const model = this.analysisForm.get('aiModel')?.value || '';
    if (model.startsWith('claude:')) {
      return 'Claude API Key';
    } else if (model.startsWith('openai:')) {
      return 'OpenAI API Key';
    }
    return 'API Key';
  }

  getSubmitButtonText(): string {
    const mode = this.analysisForm.get('mode')?.value;
    if (mode === 'import-only') {
      return 'OK';
    }
    return 'Add to Queue';
  }

  getSubmitButtonIcon(): string {
    const mode = this.analysisForm.get('mode')?.value;
    if (mode === 'import-only') {
      return 'check';
    }
    return 'add_to_queue';
  }

  /**
   * Fetch video title from URL (reusing logic from batch downloads)
   */
  private fetchVideoTitle(url: string): void {
    if (!url || !url.trim()) {
      return;
    }

    this.isFetchingTitle = true;
    this.batchApiService.getVideoInfo(url)
      .pipe(
        catchError(err => {
          console.warn('Could not fetch video title:', err);
          return of(null);
        })
      )
      .subscribe(info => {
        this.isFetchingTitle = false;
        if (info && info.title) {
          this.fetchedVideoTitle = info.title;
          this.fetchedUploadDate = info.uploadDate || '';
        } else {
          this.fetchedVideoTitle = '';
          this.fetchedUploadDate = '';
        }
      });
  }

  /**
   * Generate sanitized filename (reusing logic from batch downloads)
   */
  private generateSanitizedFilename(title: string): string {
    // Normalize and clean the title
    const sanitized = title
      .normalize('NFD')               // Normalize Unicode characters
      .replace(/[\u0300-\u036f]/g, '') // Remove accent marks
      .replace(/[^\w\s.-]/g, '')      // Remove filesystem-incompatible characters
      .replace(/\s+/g, ' ')            // Collapse multiple spaces
      .trim()
      .substring(0, 200);             // Limit filename length

    return sanitized;
  }

  async onModelChange(): Promise<void> {
    const model = this.analysisForm.get('aiModel')?.value || '';
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
          this.analysisForm.patchValue({ apiKey: settings.claudeApiKey });
        } else if (provider === 'openai' && settings.openaiApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.openaiApiKey });
        } else if (provider === 'ollama') {
          this.analysisForm.patchValue({ apiKey: '' });
        }
      }
    } catch (error) {
      console.error('Failed to load API key:', error);
    }
  }

  async onSubmit(): Promise<void> {
    if (this.analysisForm.invalid) {
      this.notificationService.warning('Form Incomplete', 'Please fill in all required fields');
      return;
    }

    const formValue = this.analysisForm.value;
    const processConfigs = this.getProcessConfigs();

    // Auto-save settings
    await this.saveSettings();

    // Handle import-only mode - directly import videos without processing queue
    if (processConfigs.length === 0) {
      if (this.data.selectedVideos && this.data.selectedVideos.length > 0) {
        try {
          const videoPaths = this.data.selectedVideos.map(v => v.current_path);
          const importUrl = await this.backendUrlService.getApiUrl('/database/import');

          const response = await fetch(importUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPaths })
          });

          const result = await response.json();

          if (result.success) {
            this.notificationService.success(
              'Videos Imported',
              `Successfully imported ${result.importedCount} video${result.importedCount !== 1 ? 's' : ''}`
            );
          } else {
            this.notificationService.error('Import Failed', result.error || 'Failed to import videos');
          }
        } catch (error: any) {
          console.error('Error importing videos:', error);
          this.notificationService.error('Import Failed', error.message || 'Failed to import videos');
        }
      }

      this.dialogRef.close({ success: true });
      return;
    }

    // Add videos to processing queue with multiple child processes
    const jobIds: string[] = [];

    if (this.data.selectedVideos && this.data.selectedVideos.length > 0) {
      // Process each selected video
      for (const video of this.data.selectedVideos) {
        const jobId = this.videoProcessingQueueService.addVideoJob({
          videoId: video.id,
          videoPath: video.current_path,
          displayName: video.filename || 'Unknown',
          processes: processConfigs
        });

        jobIds.push(jobId);

        // Don't auto-submit - let user start queue manually
        // this.videoProcessingQueueService.submitJob(jobId);
      }

      // Notification removed - queue panel shows status
    } else {
      // Single video/URL
      let displayName = 'Video Analysis';
      if (formValue.inputType === 'url') {
        // Use fetched title if available (same logic as batch downloads)
        if (this.fetchedVideoTitle) {
          const title = this.generateSanitizedFilename(this.fetchedVideoTitle);
          if (this.fetchedUploadDate) {
            displayName = `${this.fetchedUploadDate} ${title}`;
          } else {
            displayName = title;
          }
        } else {
          // Fallback to hostname if title not fetched
          try {
            const url = new URL(formValue.input);
            displayName = url.hostname.replace('www.', '') + ' video';
          } catch {
            displayName = formValue.input.substring(0, 30) + '...';
          }
        }
      } else {
        const parts = formValue.input.split(/[/\\]/);
        displayName = parts[parts.length - 1] || 'Local video';
      }

      const jobId = this.videoProcessingQueueService.addVideoJob({
        videoPath: formValue.input,
        displayName: displayName,
        processes: processConfigs
      });

      jobIds.push(jobId);

      // Don't auto-submit - let user start queue manually
      // this.videoProcessingQueueService.submitJob(jobId);

      // Notification removed - queue panel shows status
    }

    // Close the dialog
    this.dialogRef.close({ success: true, jobIds });
  }

  async browseFile(): Promise<void> {
    try {
      const result = await (window as any).electron?.showOpenDialog({
        properties: ['openFile', 'openDirectory'],
        title: 'Select Video File or Folder',
        filters: [
          { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];

        // Check if it's a directory
        const electron = (window as any).electron;
        const isDir = await electron?.isDirectory(selectedPath);

        if (isDir) {
          // Handle folder selection - scan for videos
          await this.handleFolderSelection(selectedPath);
        } else {
          // Handle single file selection
          this.analysisForm.patchValue({ input: selectedPath });
          this.notificationService.toastOnly('success', 'File Selected', selectedPath);
        }
      }
    } catch (error) {
      console.error('Error selecting file:', error);
      this.notificationService.error('File Selection Failed', 'Could not select file');
    }
  }

  onFileDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = true;
  }

  onFileDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = false;
  }

  async onFileDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = false;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    const electron = (window as any).electron;
    if (!electron || !electron.getFilePathFromFile) {
      this.notificationService.error('Not Available', 'Drag and drop only works in Electron app');
      return;
    }

    const file = files[0];
    const filePath = electron.getFilePathFromFile(file);

    try {
      // Check if it's a directory
      const isDir = await electron?.isDirectory(filePath);

      if (isDir) {
        // Handle folder drop - scan for videos
        await this.handleFolderSelection(filePath);
      } else {
        // Handle single file drop
        const validExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
        const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));

        if (!validExtensions.includes(ext)) {
          this.notificationService.error('Invalid File Type', 'Please drop a video file or folder');
          return;
        }

        this.analysisForm.patchValue({ input: filePath });
        this.notificationService.toastOnly('success', 'File Selected', file.name);
      }
    } catch (error) {
      console.error('Failed to get file path:', error);
      this.notificationService.error('Error', 'Failed to process dropped file');
    }
  }

  async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      this.analysisForm.patchValue({ input: text });
    } catch (error) {
      this.notificationService.error('Paste Failed', 'Could not paste from clipboard');
    }
  }

  /**
   * Handle folder selection - scan for videos and import them
   */
  private async handleFolderSelection(folderPath: string): Promise<void> {
    try {
      this.notificationService.toastOnly('info', 'Scanning Folder', 'Searching for video files...');

      const scanUrl = await this.backendUrlService.getApiUrl('/database/scan-directory');
      const response = await fetch(scanUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directoryPath: folderPath })
      });

      const result = await response.json();

      if (!result.success) {
        this.notificationService.error('Scan Failed', result.error || 'Failed to scan folder');
        return;
      }

      if (result.total === 0) {
        this.notificationService.toastOnly('info', 'No Videos Found', 'No video files found in the selected folder');
        return;
      }

      if (result.videos.length === 0) {
        this.notificationService.toastOnly(
          'info',
          'All Videos Imported',
          `Found ${result.total} video${result.total !== 1 ? 's' : ''}, but all have already been imported`
        );
        return;
      }

      // Prepare videos for import
      const videosToImport = result.videos.map((video: any) => ({
        current_path: video.fullPath,
        filename: video.filename
      }));

      const processConfigs = this.getProcessConfigs();

      // If no processing modes selected, import directly
      if (processConfigs.length === 0) {
        const videoPaths = videosToImport.map((v: any) => v.current_path);
        const importUrl = await this.backendUrlService.getApiUrl('/database/import');

        const importResponse = await fetch(importUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPaths })
        });

        const importResult = await importResponse.json();

        if (importResult.success) {
          this.notificationService.success(
            'Videos Imported',
            `Successfully imported ${importResult.importedCount} video${importResult.importedCount !== 1 ? 's' : ''} from folder`
          );
        } else {
          this.notificationService.error('Import Failed', importResult.error || 'Failed to import videos');
        }

        this.dialogRef.close({ success: true });
      } else {
        // Add each video to processing queue with multiple child processes
        const jobIds: string[] = [];

        for (const video of videosToImport) {
          const jobId = this.videoProcessingQueueService.addVideoJob({
            videoId: video.id,
            videoPath: video.current_path,
            displayName: video.filename || 'Unknown',
            processes: processConfigs
          });
          jobIds.push(jobId);

          // Submit job immediately
          this.videoProcessingQueueService.submitJob(jobId);
        }

        const totalProcesses = processConfigs.length;
        this.notificationService.success(
          'Videos Added to Queue',
          `Added ${videosToImport.length} video${videosToImport.length !== 1 ? 's' : ''} to processing queue with ${totalProcesses} process${totalProcesses !== 1 ? 'es' : ''} each`
        );

        this.dialogRef.close({ success: true });
      }
    } catch (error: any) {
      console.error('Error handling folder selection:', error);
      this.notificationService.error('Folder Scan Failed', error.message || 'Failed to scan folder');
    }
  }

  cancel(): void {
    this.dialogRef.close({ success: false });
  }

  private async loadAvailableOllamaModels(): Promise<void> {
    try {
      const modelsUrl = await this.backendUrlService.getApiUrl('/analysis/models');
      const response = await fetch(modelsUrl);

      if (!response.ok) {
        return;
      }

      const data = await response.json();
      if (data.success && data.connected && data.models) {
        this.availableOllamaModels = data.models.map((model: any) => model.name);
      }
    } catch (error) {
      console.error('Error loading Ollama models:', error);
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = await (window as any).electron?.getSettings();
      if (settings) {
        if (settings.lastUsedModel) {
          this.analysisForm.patchValue({ aiModel: settings.lastUsedModel });
        }

        const lastModel = settings.lastUsedModel || '';
        if (lastModel.startsWith('claude:') && settings.claudeApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.claudeApiKey });
        } else if (lastModel.startsWith('openai:') && settings.openaiApiKey) {
          this.analysisForm.patchValue({ apiKey: settings.openaiApiKey });
        }
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  private async saveSettings(): Promise<void> {
    try {
      const model = this.analysisForm.get('aiModel')?.value || '';
      const apiKey = this.analysisForm.get('apiKey')?.value;

      let provider = 'ollama';
      if (model.startsWith('claude:')) {
        provider = 'claude';
      } else if (model.startsWith('openai:')) {
        provider = 'openai';
      }

      const updates: any = {
        lastUsedProvider: provider,
        lastUsedModel: model,
      };

      if (apiKey && apiKey !== '***') {
        if (provider === 'claude') {
          updates.claudeApiKey = apiKey;
        } else if (provider === 'openai') {
          updates.openaiApiKey = apiKey;
        }
      }

      await (window as any).electron?.updateSettings(updates);
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  /**
   * Update input field validation based on whether videos are selected
   */
  private updateInputValidation(): void {
    const inputControl = this.analysisForm.get('input');

    // If we have selected videos from library, input field is not required
    if (this.data.selectedVideos && this.data.selectedVideos.length > 0) {
      inputControl?.clearValidators();
    } else {
      // Otherwise, input is required for URL/file selection
      inputControl?.setValidators([Validators.required]);
    }

    inputControl?.updateValueAndValidity();
  }

  /**
   * Check if AI setup is needed and show prompt
   */
  private checkAndPromptAISetup(): void {
    // Only check if AI analysis is selected
    if (!this.analysisForm.get('aiAnalysis')?.value) {
      return;
    }

    // If no AI provider is available, show setup prompt
    if (this.aiAvailability && !this.hasAnyAIProvider()) {
      this.showAiSetupPrompt = true;
    }
  }

  /**
   * Check if any AI provider is available
   */
  hasAnyAIProvider(): boolean {
    if (!this.aiAvailability) return false;

    return (this.aiAvailability.hasOllama && this.aiAvailability.ollamaModels.length > 0) ||
           this.aiAvailability.hasClaudeKey ||
           this.aiAvailability.hasOpenAIKey;
  }

  /**
   * Open the AI setup wizard
   */
  openAISetupWizard(): void {
    const dialogRef = this.dialog.open(AiSetupWizardComponent, {
      width: '800px',
      maxWidth: '90vw',
      maxHeight: '80vh',
      disableClose: false,
      data: { forceSetup: false }
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (result?.completed) {
        // Refresh AI availability
        this.aiAvailability = await this.aiSetupHelper.checkAIAvailability();

        // Reload models
        await this.loadAvailableOllamaModels();

        // Hide the prompt
        this.showAiSetupPrompt = false;

        this.notificationService.success('AI Setup Complete', 'You can now use AI features!');
      } else if (result?.skipped) {
        this.showAiSetupPrompt = false;
      }
    });
  }

  /**
   * Dismiss AI setup prompt
   */
  dismissAISetupPrompt(): void {
    this.showAiSetupPrompt = false;
  }

  /**
   * Get friendly message about AI setup needs
   */
  getAISetupMessage(): string {
    if (!this.aiAvailability) {
      return 'Checking AI availability...';
    }

    const aiAnalysisSelected = this.analysisForm.get('aiAnalysis')?.value;
    const transcribeSelected = this.analysisForm.get('transcribe')?.value;

    if (transcribeSelected && !aiAnalysisSelected) {
      return 'Transcription does not require AI setup. However, you can optionally use AI for enhanced transcription quality.';
    }

    if (aiAnalysisSelected) {
      return 'AI analysis requires either Ollama (free, runs locally) or an API key for Claude/ChatGPT. Click "Set Up AI" to get started!';
    }

    return 'Some features require AI setup.';
  }
}
