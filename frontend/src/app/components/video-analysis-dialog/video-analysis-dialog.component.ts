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
import { AnalysisQueueService } from '../../services/analysis-queue.service';
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
    private analysisQueueService: AnalysisQueueService,
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

    // Pre-populate form based on dialog data
    if (this.data.mode === 'transcribe') {
      this.analysisForm.patchValue({ mode: 'transcribe-only' });
    } else if (this.data.mode === 'analyze') {
      this.analysisForm.patchValue({ mode: 'full' });
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

    // If videos are from library (not being imported), change default from 'import-only' to 'transcribe-only'
    // since import doesn't make sense for videos already in library
    // Check for mode !== 'import' because drag/drop passes both selectedVideos AND mode='import'
    if (this.isFromLibrary() && this.data.mode !== 'import' && this.analysisForm.get('mode')?.value === 'import-only') {
      this.analysisForm.patchValue({ mode: 'transcribe-only' });
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
  }

  createForm(): FormGroup {
    return this.fb.group({
      inputType: ['url', Validators.required],
      input: [''], // Don't require if selectedVideos provided
      mode: ['import-only', Validators.required],
      customInstructions: [''],
      aiModel: ['ollama:qwen2.5:7b', Validators.required],
      apiKey: [''],
      ollamaEndpoint: ['http://localhost:11434'],
      whisperModel: ['base'],
      language: ['en'],
    });
  }

  isAIAnalysisEnabled(): boolean {
    return this.analysisForm.get('mode')?.value === 'full';
  }

  isTranscriptionEnabled(): boolean {
    const mode = this.analysisForm.get('mode')?.value;
    return mode === 'transcribe-only' || mode === 'full';
  }

  isImportOnly(): boolean {
    return this.analysisForm.get('mode')?.value === 'import-only';
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

    // Auto-save settings
    await this.saveSettings();

    // Handle import-only mode - directly import videos without analysis queue
    if (formValue.mode === 'import-only') {
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

    // For transcribe/analyze modes, prepare job data to return
    // Don't add to queue here - let parent component do it after dialog closes
    let jobsToAdd: any[] = [];

    // If we have selected videos from library, prepare each one
    if (this.data.selectedVideos && this.data.selectedVideos.length > 0) {
      jobsToAdd = this.data.selectedVideos.map(video => ({
        input: video.current_path,
        inputType: 'file',
        mode: formValue.mode,
        aiModel: formValue.aiModel,
        apiKey: formValue.apiKey,
        ollamaEndpoint: formValue.ollamaEndpoint,
        whisperModel: formValue.whisperModel,
        language: formValue.language,
        customInstructions: formValue.customInstructions,
        displayName: video.filename || 'Unknown',
        videoId: video.id,  // Include video ID for progress tracking
        loading: false
      }));
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

      jobsToAdd = [{
        input: formValue.input,
        inputType: formValue.inputType,
        mode: formValue.mode,
        aiModel: formValue.aiModel,
        apiKey: formValue.apiKey,
        ollamaEndpoint: formValue.ollamaEndpoint,
        whisperModel: formValue.whisperModel,
        language: formValue.language,
        customInstructions: formValue.customInstructions,
        displayName: displayName,
        loading: false
      }];
    }

    // Close the dialog and return job data for parent to add
    this.dialogRef.close({ success: true, jobsToAdd });
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

      // If mode is import-only, import directly
      const formValue = this.analysisForm.value;
      if (formValue.mode === 'import-only') {
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
        // For transcribe/analyze modes, add to analysis queue
        for (const video of videosToImport) {
          this.analysisQueueService.addPendingJob({
            input: video.current_path,
            inputType: 'file',
            mode: formValue.mode,
            aiModel: formValue.aiModel,
            apiKey: formValue.apiKey,
            ollamaEndpoint: formValue.ollamaEndpoint,
            whisperModel: formValue.whisperModel,
            language: formValue.language,
            customInstructions: formValue.customInstructions,
            displayName: video.filename || 'Unknown',
            videoId: video.id,  // Include video ID for progress tracking (if available)
            loading: false
          });
        }

        this.notificationService.success(
          'Videos Added to Queue',
          `Added ${videosToImport.length} video${videosToImport.length !== 1 ? 's' : ''} to the analysis queue`
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
    const mode = this.analysisForm.get('mode')?.value;

    // Only check if mode requires AI (full analysis or transcription)
    if (mode === 'import-only' || mode === 'process-only') {
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

    const mode = this.analysisForm.get('mode')?.value;

    if (mode === 'transcribe-only') {
      return 'Transcription does not require AI setup. However, you can optionally use AI for enhanced transcription quality.';
    }

    if (mode === 'full') {
      return 'AI analysis requires either Ollama (free, runs locally) or an API key for Claude/ChatGPT. Click "Set Up AI" to get started!';
    }

    return 'Some features require AI setup.';
  }
}
