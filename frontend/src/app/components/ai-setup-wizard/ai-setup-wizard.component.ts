import { Component, OnInit, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { MatCardModule } from '@angular/material/card';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HttpClient } from '@angular/common/http';
import { AiSetupHelperService, AIAvailability } from '../../services/ai-setup-helper.service';
import { BackendUrlService } from '../../services/backend-url.service';

export interface AISetupWizardData {
  forceSetup?: boolean;
  initialTab?: 'welcome' | 'ollama' | 'claude' | 'openai';
}

@Component({
  selector: 'app-ai-setup-wizard',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatTabsModule,
    MatCardModule,
    MatTooltipModule
  ],
  templateUrl: './ai-setup-wizard.component.html',
  styleUrl: './ai-setup-wizard.component.scss'
})
export class AiSetupWizardComponent implements OnInit {
  currentStep: 'welcome' | 'ollama' | 'claude' | 'openai' | 'checking' | 'done' = 'welcome';

  availability: AIAvailability = {
    hasOllama: false,
    hasClaudeKey: false,
    hasOpenAIKey: false,
    ollamaModels: [],
    ollamaEndpoint: 'http://localhost:11434',
    isChecking: false
  };

  claudeApiKey: string = '';
  openaiApiKey: string = '';

  isCheckingOllama: boolean = false;
  isSavingKeys: boolean = false;

  installInstructions: { platform: string; steps: string[] } = { platform: '', steps: [] };
  recommendedModels: any[] = [];

  selectedInstallOption: 'ollama' | 'claude' | 'openai' | null = null;

  constructor(
    private dialogRef: MatDialogRef<AiSetupWizardComponent>,
    @Inject(MAT_DIALOG_DATA) public data: AISetupWizardData,
    private aiSetupHelper: AiSetupHelperService,
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {
    this.installInstructions = this.aiSetupHelper.getOllamaInstallInstructions();
    this.recommendedModels = this.aiSetupHelper.getRecommendedModels();
  }

  async ngOnInit() {
    // Check initial status
    this.availability = await this.aiSetupHelper.checkAIAvailability();

    // Load existing API keys (masked)
    const apiKeysUrl = await this.backendUrlService.getApiUrl('/config/api-keys');
    this.http.get<any>(apiKeysUrl).subscribe(
      response => {
        if (response.claudeApiKey && response.claudeApiKey !== '***') {
          this.availability.hasClaudeKey = true;
        }
        if (response.openaiApiKey && response.openaiApiKey !== '***') {
          this.availability.hasOpenAIKey = true;
        }
      },
      error => console.error('Error loading API keys:', error)
    );

    // If initial tab specified, jump to it
    if (this.data?.initialTab) {
      this.currentStep = this.data.initialTab;
    }
  }

  get hasAnyProvider(): boolean {
    return (this.availability.hasOllama && this.availability.ollamaModels.length > 0) ||
           this.availability.hasClaudeKey ||
           this.availability.hasOpenAIKey;
  }

  goToStep(step: 'welcome' | 'ollama' | 'claude' | 'openai' | 'checking' | 'done') {
    this.currentStep = step;
  }

  selectOption(option: 'ollama' | 'claude' | 'openai') {
    this.selectedInstallOption = option;
    this.currentStep = option; // Go directly to the selected provider's step
  }

  async checkOllamaAgain() {
    this.isCheckingOllama = true;

    try {
      this.availability = await this.aiSetupHelper.checkAIAvailability();

      if (this.availability.hasOllama && this.availability.ollamaModels.length > 0) {
        this.currentStep = 'done';
      }
    } catch (error) {
      console.error('Error checking Ollama:', error);
    } finally {
      this.isCheckingOllama = false;
    }
  }

  async saveClaudeKey() {
    this.isSavingKeys = true;

    try {
      const payload: any = {};

      if (this.claudeApiKey && this.claudeApiKey.trim() !== '') {
        payload.claudeApiKey = this.claudeApiKey.trim();
      }

      console.log('[AI Setup] Saving Claude API key...');

      const apiKeysUrl = await this.backendUrlService.getApiUrl('/config/api-keys');
      console.log('[AI Setup] Using API URL:', apiKeysUrl);

      const response = await this.http.post<any>(apiKeysUrl, payload).toPromise();
      console.log('[AI Setup] Save response:', response);

      if (!response || response.success === false) {
        throw new Error('Backend returned unsuccessful response');
      }

      // Refresh availability
      this.availability = await this.aiSetupHelper.checkAIAvailability();

      this.currentStep = 'done';
    } catch (error: any) {
      console.error('[AI Setup] Error saving API key:', error);
      const errorMessage = error?.error?.message || error?.message || 'Unknown error';
      alert(`Failed to save API key: ${errorMessage}\n\nPlease check the console for more details.`);
    } finally {
      this.isSavingKeys = false;
    }
  }

  async saveOpenAIKey() {
    this.isSavingKeys = true;

    try {
      const payload: any = {};

      if (this.openaiApiKey && this.openaiApiKey.trim() !== '') {
        payload.openaiApiKey = this.openaiApiKey.trim();
      }

      console.log('[AI Setup] Saving OpenAI API key...');

      const apiKeysUrl = await this.backendUrlService.getApiUrl('/config/api-keys');
      console.log('[AI Setup] Using API URL:', apiKeysUrl);

      const response = await this.http.post<any>(apiKeysUrl, payload).toPromise();
      console.log('[AI Setup] Save response:', response);

      if (!response || response.success === false) {
        throw new Error('Backend returned unsuccessful response');
      }

      // Refresh availability
      this.availability = await this.aiSetupHelper.checkAIAvailability();

      this.currentStep = 'done';
    } catch (error: any) {
      console.error('[AI Setup] Error saving API key:', error);
      const errorMessage = error?.error?.message || error?.message || 'Unknown error';
      alert(`Failed to save API key: ${errorMessage}\n\nPlease check the console for more details.`);
    } finally {
      this.isSavingKeys = false;
    }
  }

  skipSetup() {
    this.dialogRef.close({ skipped: true });
  }

  complete() {
    this.dialogRef.close({ completed: true, availability: this.availability });
  }

  openOllamaWebsite() {
    if ((window as any).electron) {
      (window as any).electron.openExternal('https://ollama.com/download');
    } else {
      window.open('https://ollama.com/download', '_blank');
    }
  }

  openClaudeWebsite() {
    if ((window as any).electron) {
      (window as any).electron.openExternal('https://console.anthropic.com/');
    } else {
      window.open('https://console.anthropic.com/', '_blank');
    }
  }

  openOpenAIWebsite() {
    if ((window as any).electron) {
      (window as any).electron.openExternal('https://platform.openai.com/api-keys');
    } else {
      window.open('https://platform.openai.com/api-keys', '_blank');
    }
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      // Could add a toast notification here
      console.log('Copied to clipboard:', text);
    });
  }
}
