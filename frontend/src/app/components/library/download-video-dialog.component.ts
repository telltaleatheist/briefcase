import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
// MatProgressSpinnerModule removed - dialog closes immediately
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';
import { ApiService } from '../../services/api.service';
import { DownloadProgressService } from '../../services/download-progress.service';
import { VideoProcessingQueueService } from '../../services/video-processing-queue.service';
import { firstValueFrom } from 'rxjs';

interface DialogData {
  activeLibrary: any;
}

interface OllamaModel {
  name: string;
  size: number;
}

interface ApiKeysConfig {
  claudeApiKey?: string;
  openaiApiKey?: string;
  lastUsedProvider?: 'ollama' | 'claude' | 'openai';
  lastUsedModel?: string;
}

@Component({
  selector: 'app-download-video-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatSelectModule,
    MatIconModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>cloud_download</mat-icon>
      Download Video from URL
    </h2>

    <mat-dialog-content>
      <div class="dialog-content">
        <p class="description">
          Enter a URL to download a video and optionally transcribe or analyze it with AI.
        </p>

        <!-- URL Input -->
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Video URL</mat-label>
          <input matInput
                 [(ngModel)]="url"
                 placeholder="https://www.youtube.com/watch?v=..."
                 (ngModelChange)="onUrlChange()">
          <mat-icon matPrefix>link</mat-icon>
          <mat-hint>Supports YouTube, Vimeo, TikTok, Reddit, and many other platforms</mat-hint>
        </mat-form-field>

        <!-- URL Validation Status -->
        <div class="url-status" *ngIf="urlValidationMessage">
          <mat-icon [class.valid]="urlValid" [class.invalid]="!urlValid">
            {{ urlValid ? 'check_circle' : 'error' }}
          </mat-icon>
          <span>{{ urlValidationMessage }}</span>
        </div>

        <!-- Processing Options -->
        <div class="options-section">
          <h3>Processing Options</h3>

          <mat-checkbox [(ngModel)]="transcribeAfterDownload">
            <strong>Transcribe after download</strong>
            <div class="checkbox-description">Generate a text transcript using Whisper</div>
          </mat-checkbox>

          <mat-checkbox [(ngModel)]="analyzeAfterDownload" [disabled]="!transcribeAfterDownload">
            <strong>AI Analysis after transcription</strong>
            <div class="checkbox-description">Run AI analysis to extract topics, people, and interesting moments</div>
          </mat-checkbox>

          <div class="info-box" *ngIf="analyzeAfterDownload && transcribeAfterDownload">
            <mat-icon>info</mat-icon>
            <span>The video will be downloaded, transcribed, and analyzed automatically. You can monitor progress from the library page.</span>
          </div>
        </div>

        <!-- AI Model Selection (only if analyzing) -->
        <div class="ai-provider-section" *ngIf="analyzeAfterDownload && transcribeAfterDownload">
          <h3>
            <mat-icon>psychology</mat-icon>
            AI Model
          </h3>

          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Select AI Model</mat-label>
            <mat-select [(ngModel)]="selectedModelFull" (selectionChange)="onModelChange()">
              <mat-select-trigger>
                {{ getDisplayName(selectedModelFull) }}
              </mat-select-trigger>
              <mat-optgroup label="Claude (API - Requires Key)">
                <mat-option value="claude:claude-sonnet-4-20250514">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>Claude Sonnet 4.5 (Newest)</span>
                  </div>
                </mat-option>
                <mat-option value="claude:claude-3-5-sonnet-20241022">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>Claude 3.5 Sonnet (Recommended)</span>
                  </div>
                </mat-option>
                <mat-option value="claude:claude-3-5-haiku-20241022">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>Claude 3.5 Haiku (Faster)</span>
                  </div>
                </mat-option>
              </mat-optgroup>
              <mat-optgroup label="ChatGPT / OpenAI (API - Requires Key)">
                <mat-option value="openai:gpt-4o">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>GPT-4o (Best)</span>
                  </div>
                </mat-option>
                <mat-option value="openai:gpt-4o-mini">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>GPT-4o Mini (Faster)</span>
                  </div>
                </mat-option>
                <mat-option value="openai:gpt-4-turbo">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>GPT-4 Turbo</span>
                  </div>
                </mat-option>
                <mat-option value="openai:gpt-3.5-turbo">
                  <div class="model-option">
                    <mat-icon>cloud</mat-icon>
                    <span>GPT-3.5 Turbo (Faster, Cheaper)</span>
                  </div>
                </mat-option>
              </mat-optgroup>
              <mat-optgroup label="Ollama (Local - No API Key)">
                <mat-option *ngIf="ollamaModels.length === 0" disabled value="">No Ollama models installed</mat-option>
                <mat-option *ngFor="let model of ollamaModels" [value]="'ollama:' + model.name">
                  <div class="model-option">
                    <mat-icon>computer</mat-icon>
                    <span>{{ model.name }}</span>
                  </div>
                </mat-option>
              </mat-optgroup>
            </mat-select>
            <mat-hint *ngIf="loadingModels">Loading available Ollama models...</mat-hint>
          </mat-form-field>

          <!-- API Key Input for Claude -->
          <div *ngIf="selectedProvider === 'claude'" class="api-key-section">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Claude API Key</mat-label>
              <input matInput
                     [(ngModel)]="claudeApiKey"
                     [type]="showClaudeKey ? 'text' : 'password'"
                     placeholder="sk-ant-...">
              <button mat-icon-button matSuffix (click)="showClaudeKey = !showClaudeKey" type="button">
                <mat-icon>{{ showClaudeKey ? 'visibility_off' : 'visibility' }}</mat-icon>
              </button>
              <mat-hint *ngIf="hasClaudeKey && claudeApiKey === '***'">Using saved API key</mat-hint>
              <mat-hint *ngIf="!hasClaudeKey">Get your API key from console.anthropic.com</mat-hint>
            </mat-form-field>
          </div>

          <!-- API Key Input for OpenAI -->
          <div *ngIf="selectedProvider === 'openai'" class="api-key-section">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>OpenAI API Key</mat-label>
              <input matInput
                     [(ngModel)]="openaiApiKey"
                     [type]="showOpenAiKey ? 'text' : 'password'"
                     placeholder="sk-...">
              <button mat-icon-button matSuffix (click)="showOpenAiKey = !showOpenAiKey" type="button">
                <mat-icon>{{ showOpenAiKey ? 'visibility_off' : 'visibility' }}</mat-icon>
              </button>
              <mat-hint *ngIf="hasOpenAiKey && openaiApiKey === '***'">Using saved API key</mat-hint>
              <mat-hint *ngIf="!hasOpenAiKey">Get your API key from platform.openai.com</mat-hint>
            </mat-form-field>
          </div>
        </div>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="download()" [disabled]="!url">
        <mat-icon>cloud_download</mat-icon>
        Download
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-content {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 200px;
    }

    .description {
      margin: 0 0 8px 0;
      color: var(--text-secondary);
    }

    .full-width {
      width: 100%;
    }

    .url-status {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 14px;

      mat-icon {
        font-size: 20px;
        width: 20px;
        height: 20px;

        &.valid {
          color: #4caf50;
        }

        &.invalid {
          color: #f44336;
        }
      }
    }

    .options-section, .ai-provider-section {
      display: flex;
      flex-direction: column;
      gap: 12px;

      h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0 0 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);

        mat-icon {
          color: var(--primary-color, #1976d2);
          font-size: 18px;
          width: 18px;
          height: 18px;
        }
      }

      mat-checkbox {
        ::ng-deep .mdc-label {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
      }

      .checkbox-description {
        font-size: 12px;
        font-weight: normal;
        color: var(--text-secondary);
      }

      .model-option {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;

        mat-icon {
          font-size: 16px;
          width: 16px;
          height: 16px;
        }
      }

      .api-key-section {
        margin-top: 12px;
      }
    }

    .info-box {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 12px;
      background-color: rgba(33, 150, 243, 0.1);
      border-left: 3px solid #2196f3;
      border-radius: 4px;
      font-size: 13px;
      line-height: 1.4;

      mat-icon {
        color: #2196f3;
        font-size: 20px;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        display: flex;
        align-items: center;
        gap: 8px;
      }
    }
  `]
})
export class DownloadVideoDialogComponent implements OnInit {
  url = '';
  urlValid = false;
  urlValidationMessage = '';
  videoTitle = '';
  fetchingTitle = false;

  transcribeAfterDownload = true;
  analyzeAfterDownload = false;

  // AI Model Selection
  selectedProvider: 'ollama' | 'claude' | 'openai' = 'ollama';
  selectedModel: string = '';
  selectedModelFull: string = ''; // Full model string in format "provider:model"
  ollamaModels: OllamaModel[] = [];
  loadingModels = false;

  // API Keys
  claudeApiKey: string = '';
  openaiApiKey: string = '';
  hasClaudeKey = false;
  hasOpenAiKey = false;
  showClaudeKey = false;
  showOpenAiKey = false;

  constructor(
    private dialogRef: MatDialogRef<DownloadVideoDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: DialogData,
    private apiService: ApiService,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private downloadProgressService: DownloadProgressService,
    private videoProcessingQueueService: VideoProcessingQueueService
  ) {}

  async ngOnInit(): Promise<void> {
    // Load Ollama models first
    await this.loadOllamaModels();
    // Then load API keys which may set the provider and model
    await this.loadApiKeys();
  }

  onUrlChange() {
    // Reset validation
    this.urlValidationMessage = '';
    this.urlValid = false;
    this.videoTitle = '';

    if (!this.url) {
      return;
    }

    // Basic URL validation
    try {
      new URL(this.url);
      this.urlValid = true;
      this.urlValidationMessage = 'Valid URL';

      // Fetch video title in the background
      this.fetchVideoTitle();
    } catch {
      this.urlValid = false;
      this.urlValidationMessage = 'Invalid URL format';
    }
  }

  /**
   * Fetch video title from backend
   */
  private async fetchVideoTitle(): Promise<void> {
    if (!this.url || !this.urlValid) {
      return;
    }

    this.fetchingTitle = true;
    try {
      const url = await this.backendUrlService.getApiUrl(`/downloader/info?url=${encodeURIComponent(this.url)}`);
      const response = await firstValueFrom(
        this.http.get<{ title?: string; error?: string }>(url)
      );

      if (response.title && !response.error) {
        // Create a sanitized filename from the title
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        this.videoTitle = `${date} ${this.sanitizeFilename(response.title)}`;
        this.urlValidationMessage = `Valid URL - ${response.title}`;
      } else {
        // Keep as valid URL but couldn't fetch title
        this.videoTitle = '';
        this.urlValidationMessage = 'Valid URL';
      }
    } catch (error) {
      console.warn('Could not fetch video title:', error);
      // Don't change the valid status, just couldn't fetch title
      this.videoTitle = '';
    } finally {
      this.fetchingTitle = false;
    }
  }

  /**
   * Sanitize filename to remove invalid characters
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // Remove invalid filename characters
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .trim()
      .substring(0, 200); // Limit length
  }

  async download() {
    if (!this.url || !this.urlValid) {
      return;
    }

    if (!this.data.activeLibrary) {
      this.dialogRef.close({ success: false, error: 'No active library selected' });
      return;
    }

    // Wait for title fetching to complete if it's still in progress
    if (this.fetchingTitle) {
      console.log('[DownloadVideoDialog] Waiting for title to finish fetching...');
      // Wait up to 10 seconds for title fetching
      const maxWait = 10000;
      const startTime = Date.now();
      while (this.fetchingTitle && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      console.log('[DownloadVideoDialog] Title fetching completed or timed out');
    }

    // Build child processes array based on selected options
    const childProcesses: any[] = [
      {
        type: 'download',
        displayName: 'Download Video',
        downloadUrl: this.url,
        outputDir: this.data.activeLibrary.clipsFolderPath,
        quality: '1080',
        convertToMp4: true,
        status: 'pending',
        progress: 0
      }
    ];

    // Add transcription if selected
    if (this.transcribeAfterDownload) {
      childProcesses.push({
        type: 'transcribe',
        displayName: 'Transcribe Audio',
        whisperModel: 'base',
        status: 'pending',
        progress: 0
      });
    }

    // Add analysis if selected
    if (this.analyzeAfterDownload && this.transcribeAfterDownload) {
      childProcesses.push({
        type: 'analyze',
        displayName: `AI Analysis (${this.selectedModel})`,
        aiModel: this.selectedModelFull, // Full format: "provider:model"
        aiProvider: this.selectedProvider,
        apiKey: this.selectedProvider === 'claude' && this.claudeApiKey !== '***' ? this.claudeApiKey :
                this.selectedProvider === 'openai' && this.openaiApiKey !== '***' ? this.openaiApiKey :
                undefined,
        status: 'pending',
        progress: 0
      });
    }

    // Create video processing job
    const displayTitle = this.videoTitle || new URL(this.url).hostname;
    const jobId = this.videoProcessingQueueService.addVideoJob({
      videoId: undefined,  // No video ID yet (will be set after download/import)
      videoPath: this.url,  // Use URL as initial path
      displayName: displayTitle,
      processes: childProcesses.map(child => ({
        type: child.type as any,
        config: child
      }))
    });

    console.log('[DownloadVideoDialog] Created processing job with', childProcesses.length, 'child tasks');

    // Start processing the job immediately
    this.videoProcessingQueueService.submitJob(jobId).catch(err => {
      console.error('[DownloadVideoDialog] Failed to start job:', err);
    });

    // Close dialog immediately - download will be tracked in the processing queue
    this.dialogRef.close({
      success: true,
      downloadStarted: true,
      jobId: jobId
    });
  }

  cancel() {
    this.dialogRef.close({ success: false });
  }

  /**
   * Load saved API keys from backend
   */
  private async loadApiKeys(): Promise<void> {
    try {
      const url = await this.backendUrlService.getApiUrl('/config/api-keys');
      const config = await firstValueFrom(
        this.http.get<ApiKeysConfig>(url)
      );

      // Set provider and model from last used
      if (config.lastUsedProvider) {
        this.selectedProvider = config.lastUsedProvider;
      }
      if (config.lastUsedModel) {
        this.selectedModel = config.lastUsedModel;
        // Set full model string
        this.selectedModelFull = `${config.lastUsedProvider}:${config.lastUsedModel}`;
      } else {
        // Set default based on provider
        this.setDefaultModel();
      }

      // Set masked keys to indicate they exist
      if (config.claudeApiKey) {
        this.hasClaudeKey = true;
        this.claudeApiKey = config.claudeApiKey; // Will be '***'
      }
      if (config.openaiApiKey) {
        this.hasOpenAiKey = true;
        this.openaiApiKey = config.openaiApiKey; // Will be '***'
      }
    } catch (error) {
      console.error('Failed to load API keys:', error);
      this.setDefaultModel();
    }
  }

  /**
   * Set default model based on availability
   */
  private setDefaultModel(): void {
    if (this.ollamaModels.length > 0) {
      this.selectedProvider = 'ollama';
      this.selectedModel = this.ollamaModels[0].name;
      this.selectedModelFull = `ollama:${this.ollamaModels[0].name}`;
    } else {
      this.selectedProvider = 'claude';
      this.selectedModel = 'claude-3-5-sonnet-20241022';
      this.selectedModelFull = 'claude:claude-3-5-sonnet-20241022';
    }
  }

  /**
   * Load available Ollama models
   */
  private async loadOllamaModels(): Promise<void> {
    this.loadingModels = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/analysis/models');
      const response = await firstValueFrom(
        this.http.get<{ success: boolean; connected: boolean; models: OllamaModel[] }>(url)
      );

      if (response.success && response.connected && response.models) {
        this.ollamaModels = response.models;
      } else {
        this.ollamaModels = [];
      }
    } catch (error) {
      console.error('Failed to load Ollama models:', error);
      this.ollamaModels = [];
    } finally {
      this.loadingModels = false;
    }
  }

  /**
   * Handle model change from dropdown
   */
  onModelChange(): void {
    if (!this.selectedModelFull) return;

    // Parse provider:model format
    const [provider, ...modelParts] = this.selectedModelFull.split(':');
    const model = modelParts.join(':'); // Handle model names with colons

    this.selectedProvider = provider as 'ollama' | 'claude' | 'openai';
    this.selectedModel = model;
  }

  /**
   * Get display name for selected model (without provider prefix)
   */
  getDisplayName(modelFull: string): string {
    if (!modelFull) return '';

    // Map of model values to their display names
    const displayNames: Record<string, string> = {
      'claude:claude-sonnet-4-20250514': 'Claude Sonnet 4.5 (Newest)',
      'claude:claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet (Recommended)',
      'claude:claude-3-5-haiku-20241022': 'Claude 3.5 Haiku (Faster)',
      'openai:gpt-4o': 'GPT-4o (Best)',
      'openai:gpt-4o-mini': 'GPT-4o Mini (Faster)',
      'openai:gpt-4-turbo': 'GPT-4 Turbo',
      'openai:gpt-3.5-turbo': 'GPT-3.5 Turbo (Faster, Cheaper)'
    };

    // Check if it's a predefined model
    if (displayNames[modelFull]) {
      return displayNames[modelFull];
    }

    // For Ollama models, just return the model name without the "ollama:" prefix
    const [, ...modelParts] = modelFull.split(':');
    return modelParts.join(':'); // Just the model name
  }
}
