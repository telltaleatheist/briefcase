import { Component, Output, EventEmitter, signal, ChangeDetectionStrategy, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiSetupService, AIAvailability, LocalModelInfo, SystemInfo } from '../../services/ai-setup.service';
import { ElectronService } from '../../services/electron.service';
import { WebsocketService } from '../../services/websocket.service';
import { TourService } from '../../services/tour.service';

export type WizardStep = 'welcome' | 'local-models' | 'ollama' | 'claude' | 'openai' | 'done';

export interface RecommendedModel {
  name: string;
  size: string;
  ramRequirement: string;
  description: string;
  pullCommand: string;
  recommended?: boolean;
}

@Component({
  selector: 'app-ai-setup-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ai-setup-wizard.component.html',
  styleUrls: ['./ai-setup-wizard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AiSetupWizardComponent implements OnInit, OnDestroy {
  private aiSetupService = inject(AiSetupService);
  private electronService = inject(ElectronService);
  private websocketService = inject(WebsocketService);
  private tourService = inject(TourService);

  @Output() closed = new EventEmitter<void>();
  @Output() completed = new EventEmitter<void>();

  currentStep = signal<WizardStep>('welcome');

  // Form inputs
  claudeApiKey = signal('');
  openaiApiKey = signal('');

  // Loading states
  isCheckingOllama = signal(false);
  isSavingKeys = signal(false);
  pullingModel = signal<string | null>(null);

  // Availability status
  localAvailable = signal(false);
  localReady = signal(false);
  ollamaAvailable = signal(false);
  ollamaModels = signal<string[]>([]);
  claudeKeySet = signal(false);
  openaiKeySet = signal(false);

  // Platform detection
  platform = signal(this.detectPlatform());

  // Local model management
  systemInfo = signal<SystemInfo | null>(null);
  localModels = signal<LocalModelInfo[]>([]);
  downloadingModel = signal<string | null>(null);
  downloadProgress = signal(0);
  downloadSpeed = signal<string | null>(null);
  downloadEta = signal<string | null>(null);
  deletingModel = signal<string | null>(null);

  // WebSocket unsubscribe functions
  private wsUnsubscribers: (() => void)[] = [];

  async ngOnInit() {
    // Check initial AI availability
    await this.refreshAvailability();

    // Subscribe to model download progress events
    this.setupWebSocketListeners();

    // Auto-start tour for AI wizard if user hasn't seen it
    this.tourService.tryAutoStartTour('ai-wizard', 800);
  }

  ngOnDestroy() {
    // Unsubscribe from WebSocket events
    this.wsUnsubscribers.forEach(unsub => unsub());
  }

  private setupWebSocketListeners() {
    // Listen for download progress
    const unsubProgress = this.websocketService.onModelDownloadProgress((event) => {
      this.downloadProgress.set(event.progress);
      this.downloadSpeed.set(event.speed || null);
      this.downloadEta.set(event.eta || null);
    });
    this.wsUnsubscribers.push(unsubProgress);

    // Listen for download complete
    const unsubComplete = this.websocketService.onModelDownloadComplete(async (event) => {
      this.downloadingModel.set(null);
      this.downloadProgress.set(0);
      this.downloadSpeed.set(null);
      this.downloadEta.set(null);
      await this.loadLocalModels();
      await this.refreshAvailability();
    });
    this.wsUnsubscribers.push(unsubComplete);

    // Listen for download error
    const unsubError = this.websocketService.onModelDownloadError((event) => {
      this.downloadingModel.set(null);
      this.downloadProgress.set(0);
      alert(`Download failed: ${event.error}`);
    });
    this.wsUnsubscribers.push(unsubError);

    // Listen for download cancelled
    const unsubCancelled = this.websocketService.onModelDownloadCancelled(() => {
      this.downloadingModel.set(null);
      this.downloadProgress.set(0);
      this.downloadSpeed.set(null);
      this.downloadEta.set(null);
    });
    this.wsUnsubscribers.push(unsubCancelled);
  }

  private async refreshAvailability() {
    const availability = await this.aiSetupService.checkAIAvailability();
    this.localAvailable.set(availability.hasLocal);
    this.localReady.set(availability.localReady);
    this.ollamaAvailable.set(availability.hasOllama);
    this.ollamaModels.set(availability.ollamaModels);
    this.claudeKeySet.set(availability.hasClaudeKey);
    this.openaiKeySet.set(availability.hasOpenAIKey);
  }

  recommendedModels: RecommendedModel[] = [
    {
      name: 'qwen2.5:7b',
      size: '4.7 GB',
      ramRequirement: 'Requires 8GB+ RAM',
      description: 'Best balance of quality and speed. Great for most users.',
      pullCommand: 'ollama pull qwen2.5:7b',
      recommended: true
    },
    {
      name: 'llama3.2:3b',
      size: '2.0 GB',
      ramRequirement: 'Requires 4GB+ RAM',
      description: 'Lightweight and fast. Good for older machines.',
      pullCommand: 'ollama pull llama3.2:3b'
    },
    {
      name: 'qwen2.5:14b',
      size: '9.0 GB',
      ramRequirement: 'Requires 16GB+ RAM',
      description: 'Higher quality results. For powerful machines.',
      pullCommand: 'ollama pull qwen2.5:14b'
    }
  ];

  private detectPlatform(): string {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac')) return 'macOS';
    if (userAgent.includes('win')) return 'Windows';
    return 'Linux';
  }

  getInstallInstructions(): string[] {
    const platform = this.platform();
    if (platform === 'macOS') {
      return [
        'Download Ollama from ollama.com',
        'Open the downloaded .dmg file',
        'Drag Ollama to Applications',
        'Open Ollama from Applications',
        'Click "Allow" if prompted'
      ];
    } else if (platform === 'Windows') {
      return [
        'Download Ollama from ollama.com',
        'Run the installer (.exe)',
        'Follow the installation prompts',
        'Ollama will start automatically'
      ];
    } else {
      return [
        'Open Terminal',
        'Run: curl -fsSL https://ollama.com/install.sh | sh',
        'Start Ollama: ollama serve'
      ];
    }
  }

  selectProvider(provider: 'ollama' | 'claude' | 'openai') {
    this.currentStep.set(provider);
    // Trigger provider-specific tour after DOM updates
    setTimeout(() => {
      this.tourService.tryAutoStartTour(`ai-wizard-${provider}`, 300);
    }, 100);
  }

  async selectLocal() {
    // Go to local models step to download/manage models
    await this.loadSystemInfo();
    await this.loadLocalModels();
    this.currentStep.set('local-models');
    // Trigger local models tour after DOM updates
    setTimeout(() => {
      this.tourService.tryAutoStartTour('ai-wizard-local', 300);
    }, 100);
  }

  goToStep(step: WizardStep) {
    this.currentStep.set(step);
  }

  goBack() {
    this.currentStep.set('welcome');
  }

  // ==================== Local Model Management ====================

  private async loadSystemInfo() {
    const info = await this.aiSetupService.getSystemInfo().toPromise();
    if (info) {
      this.systemInfo.set(info);
    }
  }

  async loadLocalModels() {
    const result = await this.aiSetupService.getLocalModels().toPromise();
    if (result) {
      this.localModels.set(result.models);
    }
  }

  async downloadLocalModel(modelId: string) {
    if (this.downloadingModel()) return;

    const model = this.localModels().find(m => m.id === modelId);
    if (!model) return;

    const confirmed = confirm(
      `Download ${model.name}?\n\n` +
      `Size: ${model.sizeGB} GB\n` +
      `Requires: ${model.minRAM}+ GB RAM\n\n` +
      `This may take several minutes depending on your connection.`
    );

    if (!confirmed) return;

    this.downloadingModel.set(modelId);
    this.downloadProgress.set(0);

    try {
      await this.aiSetupService.downloadLocalModel(modelId).toPromise();
      // Progress will be tracked via WebSocket
    } catch (error: any) {
      this.downloadingModel.set(null);
      this.downloadProgress.set(0);
      alert(`Failed to start download: ${error.message || error}`);
    }
  }

  async cancelDownload() {
    try {
      await this.aiSetupService.cancelModelDownload().toPromise();
    } catch (error) {
      console.error('Error cancelling download:', error);
    }
  }

  async deleteLocalModel(modelId: string) {
    const model = this.localModels().find(m => m.id === modelId);
    if (!model) return;

    const confirmed = confirm(
      `Delete ${model.name}?\n\n` +
      `This will free up ${model.sizeGB} GB of disk space.\n\n` +
      `You can re-download it later if needed.`
    );

    if (!confirmed) return;

    this.deletingModel.set(modelId);

    try {
      await this.aiSetupService.deleteLocalModel(modelId).toPromise();
      await this.loadLocalModels();
      await this.refreshAvailability();
    } catch (error: any) {
      alert(`Failed to delete model: ${error.message || error}`);
    } finally {
      this.deletingModel.set(null);
    }
  }

  async setDefaultModel(modelId: string) {
    try {
      await this.aiSetupService.setDefaultModel(modelId).toPromise();
      await this.loadLocalModels();
    } catch (error: any) {
      alert(`Failed to set default model: ${error.message || error}`);
    }
  }

  hasDownloadedModel(): boolean {
    return this.localModels().some(m => m.downloaded);
  }

  continueFromLocalModels() {
    if (this.hasDownloadedModel()) {
      this.currentStep.set('done');
    }
  }

  async openOllamaWebsite() {
    const url = 'https://ollama.com/download';
    if (this.electronService.isElectron) {
      this.electronService.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  async openClaudeWebsite() {
    const url = 'https://console.anthropic.com';
    if (this.electronService.isElectron) {
      this.electronService.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  async openOpenAIWebsite() {
    const url = 'https://platform.openai.com/api-keys';
    if (this.electronService.isElectron) {
      this.electronService.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  async checkOllama() {
    this.isCheckingOllama.set(true);

    try {
      await this.refreshAvailability();

      // If Ollama is ready with models, go to done
      if (this.ollamaAvailable() && this.ollamaModels().length > 0) {
        this.currentStep.set('done');
      }
    } catch (error) {
      console.error('Error checking Ollama:', error);
    } finally {
      this.isCheckingOllama.set(false);
    }
  }

  async pullModel(modelName: string) {
    if (this.pullingModel()) return;

    const confirmed = confirm(
      `This will download ${modelName}.\n\n` +
      `Make sure Ollama is running before proceeding.\n\n` +
      `Continue?`
    );

    if (!confirmed) return;

    this.pullingModel.set(modelName);

    try {
      const result = await this.aiSetupService.pullModel(modelName).toPromise();

      if (result?.success) {
        alert(`Success! ${modelName} has been downloaded.`);
        await this.checkOllama();
      }
    } catch (error: any) {
      console.error('Failed to pull model:', error);
      let errorMessage = 'Failed to download model.';

      if (error.status === 503) {
        errorMessage = 'Ollama is not running. Please start Ollama and try again.';
      } else if (error.error?.message) {
        errorMessage = error.error.message;
      }

      alert(`Error: ${errorMessage}`);
    } finally {
      this.pullingModel.set(null);
    }
  }

  async saveClaudeKey() {
    if (!this.claudeApiKey()) return;

    this.isSavingKeys.set(true);

    try {
      const result = await this.aiSetupService.saveClaudeKey(this.claudeApiKey()).toPromise();

      if (result?.success) {
        await this.refreshAvailability();
        this.currentStep.set('done');
      }
    } catch (error: any) {
      console.error('Error saving Claude key:', error);
      const errorMessage = error?.error?.message || error?.message || 'Unknown error';
      alert(`Failed to save API key: ${errorMessage}`);
    } finally {
      this.isSavingKeys.set(false);
    }
  }

  async saveOpenAIKey() {
    if (!this.openaiApiKey()) return;

    this.isSavingKeys.set(true);

    try {
      const result = await this.aiSetupService.saveOpenAIKey(this.openaiApiKey()).toPromise();

      if (result?.success) {
        await this.refreshAvailability();
        this.currentStep.set('done');
      }
    } catch (error: any) {
      console.error('Error saving OpenAI key:', error);
      const errorMessage = error?.error?.message || error?.message || 'Unknown error';
      alert(`Failed to save API key: ${errorMessage}`);
    } finally {
      this.isSavingKeys.set(false);
    }
  }

  skipSetup() {
    this.closed.emit();
  }

  complete() {
    this.completed.emit();
  }

  hasAnyProvider(): boolean {
    return this.localAvailable() || this.ollamaAvailable() || this.claudeKeySet() || this.openaiKeySet();
  }
}
