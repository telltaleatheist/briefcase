import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { BackendUrlService } from '../../services/backend-url.service';

export interface AnalyzeDialogData {
  selectedCount: number;
  videosWithExistingAnalysis?: number; // Number of selected videos that already have analysis
}

export type AnalysisOption = 'transcribe-only' | 'transcribe-analyze' | 'fix-aspect-ratio' | 'skip';
export type AIProvider = 'ollama' | 'claude' | 'openai';

interface ApiKeysConfig {
  claudeApiKey?: string;
  openaiApiKey?: string;
  lastUsedProvider?: AIProvider;
  lastUsedModel?: string;
}

interface OllamaModel {
  name: string;
  size: number;
}

@Component({
  selector: 'app-analyze-selected-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatExpansionModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>analytics</mat-icon>
      Analyze {{ data.selectedCount }} Video{{ data.selectedCount > 1 ? 's' : '' }}
    </h2>

    <mat-dialog-content>
      <p>Choose how you want to process the selected videos:</p>

      <div *ngIf="data.videosWithExistingAnalysis && data.videosWithExistingAnalysis > 0" class="warning-message">
        <mat-icon>warning</mat-icon>
        <span>
          {{ data.videosWithExistingAnalysis }} of {{ data.selectedCount }} video{{data.videosWithExistingAnalysis !== 1 ? 's' : ''}}
          already {{data.videosWithExistingAnalysis === 1 ? 'has' : 'have'}} an AI analysis.
          These will be skipped unless you check "Force Re-analyze" below.
        </span>
      </div>

      <mat-radio-group [(ngModel)]="selectedOption" class="analysis-options">
        <mat-radio-button value="transcribe-only">
          <div class="option-content">
            <strong>Transcribe Only</strong>
            <span class="option-description">Generate transcript using Whisper (faster)</span>
          </div>
        </mat-radio-button>

        <mat-radio-button value="transcribe-analyze">
          <div class="option-content">
            <strong>Transcribe + AI Analysis</strong>
            <span class="option-description">Generate transcript and perform AI analysis (recommended)</span>
          </div>
        </mat-radio-button>

        <mat-radio-button value="fix-aspect-ratio">
          <div class="option-content">
            <strong>Fix Aspect Ratio</strong>
            <span class="option-description">Process vertical/non-16:9 videos with blurred background</span>
          </div>
        </mat-radio-button>

        <mat-radio-button value="skip">
          <div class="option-content">
            <strong>Skip Analysis</strong>
            <span class="option-description">Import without processing (metadata only)</span>
          </div>
        </mat-radio-button>
      </mat-radio-group>

      <!-- AI Model Selection (only show if transcribe-analyze is selected) -->
      <div *ngIf="selectedOption === 'transcribe-analyze'" class="ai-provider-section">
        <h3 class="section-title">
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

      <div *ngIf="selectedOption === 'transcribe-analyze' && data.videosWithExistingAnalysis && data.videosWithExistingAnalysis > 0" class="force-reanalyze-option">
        <mat-checkbox [(ngModel)]="forceReanalyze">
          Force re-analyze videos that already have analysis
        </mat-checkbox>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-raised-button color="primary" (click)="onConfirm()" [disabled]="!canConfirm()">
        <mat-icon>play_arrow</mat-icon>
        Start Processing
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    h2 {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0;
      padding-top: 8px;
      font-size: 18px;

      mat-icon {
        color: var(--primary-color, #1976d2);
        font-size: 20px;
        width: 20px;
        height: 20px;
      }
    }

    mat-dialog-content {
      min-width: 700px;
      max-width: 800px;
      padding: 20px 24px;
      font-size: 13px;

      p {
        margin-top: 0;
        margin-bottom: 20px;
        color: var(--text-secondary);
        font-size: 13px;
      }
    }

    ::ng-deep .mat-mdc-dialog-container .mat-mdc-dialog-surface {
      max-height: 90vh !important;
    }

    ::ng-deep .mat-mdc-dialog-content {
      max-height: 70vh !important;
      overflow-y: auto !important;
    }

    .analysis-options {
      display: flex;
      flex-direction: column;
      gap: 16px;

      mat-radio-button {
        margin-bottom: 8px;

        .option-content {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding-left: 8px;

          strong {
            font-size: 13px;
            color: var(--text-primary);
          }

          .option-description {
            font-size: 12px;
            color: var(--text-secondary);
          }
        }
      }
    }

    .ai-provider-section {
      margin-top: 24px;
      padding: 20px;
      background-color: var(--surface-elevated, rgba(0, 0, 0, 0.02));
      border-radius: 8px;
      border: 1px solid var(--border-color, rgba(0, 0, 0, 0.12));

      .section-title {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 16px 0;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);

        mat-icon {
          color: var(--primary-color, #1976d2);
          font-size: 18px;
          width: 18px;
          height: 18px;
        }
      }

      .full-width {
        width: 100%;
        margin-bottom: 12px;

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
      }

      .provider-option {
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

    ::ng-deep .mat-mdc-form-field {
      font-size: 13px;
    }

    ::ng-deep .mat-mdc-text-field-wrapper {
      font-size: 13px;
    }

    ::ng-deep .mat-mdc-select {
      font-size: 13px;
    }

    ::ng-deep .mat-mdc-form-field-hint {
      font-size: 11px;
    }

    mat-dialog-actions {
      padding: 16px 24px;

      button {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
      }
    }

    // Dark mode support
    @media (prefers-color-scheme: dark) {
      mat-dialog-actions {
        button.mat-mdc-button {
          color: #e2e8f0 !important;
        }

        button.mat-mdc-raised-button {
          color: white !important;
        }
      }
    }

    .warning-message {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      margin-bottom: 20px;
      background-color: var(--warning-background, rgba(255, 152, 0, 0.1));
      border: 1px solid var(--warning-border, #ffc107);
      border-radius: 4px;

      mat-icon {
        color: var(--warning-icon, #ff9800);
        font-size: 20px;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        margin-top: 2px;
      }

      span {
        font-size: 12px;
        color: var(--text-primary);
        line-height: 1.5;
      }
    }

    .force-reanalyze-option {
      margin-top: 20px;
      padding: 12px 16px;
      background-color: var(--surface-elevated, rgba(255, 255, 255, 0.05));
      border-radius: 4px;
      border-left: 3px solid var(--primary-color, #1976d2);

      mat-checkbox {
        ::ng-deep .mat-checkbox-label {
          font-size: 12px;
          font-weight: 500;
        }
      }
    }
  `]
})
export class AnalyzeSelectedDialogComponent implements OnInit {
  selectedOption: AnalysisOption = 'transcribe-analyze';
  forceReanalyze = false;

  // AI Provider settings
  selectedProvider: AIProvider = 'ollama';
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
    public dialogRef: MatDialogRef<AnalyzeSelectedDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: AnalyzeDialogData,
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {}

  async ngOnInit(): Promise<void> {
    // Load Ollama models first (always, not just for Ollama provider)
    await this.loadOllamaModels();
    // Then load API keys which may set the provider and model
    await this.loadApiKeys();
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
      console.log('[Analyze Dialog] Fetching Ollama models from:', url);

      const response = await firstValueFrom(
        this.http.get<{ success: boolean; connected: boolean; models: OllamaModel[] }>(url)
      );

      console.log('[Analyze Dialog] Ollama models response:', response);

      if (response.success && response.connected && response.models) {
        this.ollamaModels = response.models;
        console.log(`[Analyze Dialog] Loaded ${this.ollamaModels.length} Ollama models:`, this.ollamaModels.map(m => m.name));
      } else {
        console.warn('[Analyze Dialog] Ollama not connected or no models available');
        console.warn('[Analyze Dialog] Response details:', {
          success: response.success,
          connected: response.connected,
          hasModels: !!response.models,
          modelsLength: response.models?.length
        });
        this.ollamaModels = [];
      }
    } catch (error) {
      console.error('[Analyze Dialog] Failed to load Ollama models:', error);
      if (error instanceof Error) {
        console.error('[Analyze Dialog] Error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack
        });
      }
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

    this.selectedProvider = provider as AIProvider;
    this.selectedModel = model;

    console.log('[Analyze Dialog] Model changed:', {
      full: this.selectedModelFull,
      provider: this.selectedProvider,
      model: this.selectedModel
    });
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

  /**
   * Check if the user can confirm
   */
  canConfirm(): boolean {
    if (!this.selectedOption) return false;
    if (this.selectedOption === 'skip' || this.selectedOption === 'transcribe-only' || this.selectedOption === 'fix-aspect-ratio') {
      return true;
    }

    // For transcribe-analyze, need provider and model
    if (!this.selectedProvider || !this.selectedModel) {
      return false;
    }

    // Check API keys for cloud providers
    if (this.selectedProvider === 'claude') {
      return !!this.claudeApiKey && this.claudeApiKey.trim().length > 0;
    }
    if (this.selectedProvider === 'openai') {
      return !!this.openaiApiKey && this.openaiApiKey.trim().length > 0;
    }

    return true;
  }

  onCancel(): void {
    this.dialogRef.close(null);
  }

  async onConfirm(): Promise<void> {
    // Save API keys if they were updated
    if (this.selectedOption === 'transcribe-analyze') {
      await this.saveApiKeys();
    }

    this.dialogRef.close({
      option: this.selectedOption,
      forceReanalyze: this.forceReanalyze,
      aiProvider: this.selectedProvider,
      aiModel: this.selectedModel,
      claudeApiKey: this.claudeApiKey !== '***' ? this.claudeApiKey : undefined,
      openaiApiKey: this.openaiApiKey !== '***' ? this.openaiApiKey : undefined
    });
  }

  /**
   * Save API keys to backend
   */
  private async saveApiKeys(): Promise<void> {
    try {
      const updates: Partial<ApiKeysConfig> = {
        lastUsedProvider: this.selectedProvider,
        lastUsedModel: this.selectedModel
      };

      // Only include keys if they were changed (not masked)
      if (this.claudeApiKey && this.claudeApiKey !== '***') {
        updates.claudeApiKey = this.claudeApiKey;
      }
      if (this.openaiApiKey && this.openaiApiKey !== '***') {
        updates.openaiApiKey = this.openaiApiKey;
      }

      const url = await this.backendUrlService.getApiUrl('/config/api-keys');
      await firstValueFrom(
        this.http.post(url, updates)
      );
    } catch (error) {
      console.error('Failed to save API keys:', error);
    }
  }
}
