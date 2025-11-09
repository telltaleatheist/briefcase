import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { AnalysisQueueService } from '../../services/analysis-queue.service';

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

  constructor(
    private fb: FormBuilder,
    private dialogRef: MatDialogRef<VideoAnalysisDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: VideoAnalysisDialogData,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private analysisQueueService: AnalysisQueueService
  ) {
    this.analysisForm = this.createForm();
  }

  async ngOnInit(): Promise<void> {
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

    // Update validation based on whether we have selected videos
    this.updateInputValidation();
  }

  createForm(): FormGroup {
    return this.fb.group({
      inputType: ['url', Validators.required],
      input: [''], // Don't require if selectedVideos provided
      mode: ['full', Validators.required],
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

    // If we have selected videos from library, add each one
    if (this.data.selectedVideos && this.data.selectedVideos.length > 0) {
      for (const video of this.data.selectedVideos) {
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
          loading: false
        });
      }

      // Toast notification removed - download queue dialog shows the status
    } else {
      // Single video/URL
      let displayName = 'Video Analysis';
      if (formValue.inputType === 'url') {
        try {
          const url = new URL(formValue.input);
          displayName = url.hostname.replace('www.', '') + ' video';
        } catch {
          displayName = formValue.input.substring(0, 30) + '...';
        }
      } else {
        const parts = formValue.input.split(/[/\\]/);
        displayName = parts[parts.length - 1] || 'Local video';
      }

      this.analysisQueueService.addPendingJob({
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
      });

      // Toast notification removed - download queue dialog shows the status
    }

    // Close the dialog
    this.dialogRef.close({ success: true });
  }

  async browseFile(): Promise<void> {
    try {
      const result = await (window as any).electron?.selectVideoFile();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        this.analysisForm.patchValue({ input: filePath });
        this.notificationService.toastOnly('success', 'File Selected', filePath);
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
    const validExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
    const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));

    if (!validExtensions.includes(ext)) {
      this.notificationService.error('Invalid File Type', 'Please drop a video file (.mp4, .mov, .avi, etc.)');
      return;
    }

    try {
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
    } catch (error) {
      this.notificationService.error('Paste Failed', 'Could not paste from clipboard');
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
}
