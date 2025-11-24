import { Component, EventEmitter, Input, Output, OnInit, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { VideoJobSettings } from '../../models/video-processing.model';
import { AiSetupService } from '../../services/ai-setup.service';

interface AIModelOption {
  value: string;
  label: string;
  provider: 'ollama' | 'claude' | 'openai';
}

@Component({
  selector: 'app-video-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './video-config-dialog.component.html',
  styleUrls: ['./video-config-dialog.component.scss']
})
export class VideoConfigDialogComponent implements OnInit, OnChanges {
  private aiSetupService = inject(AiSetupService);
  private http = inject(HttpClient);
  private readonly API_BASE = 'http://localhost:3000/api';

  @Input() isOpen = false;
  @Output() closeDialog = new EventEmitter<void>();
  @Output() submitConfig = new EventEmitter<{ url: string; name: string; settings: VideoJobSettings }[]>();

  urlText = '';
  loadingModels = false;
  aiModels: AIModelOption[] = [];

  settings: VideoJobSettings = {
    fixAspectRatio: false,
    normalizeAudio: false,
    transcribe: false,
    whisperModel: 'tiny',
    aiAnalysis: false,
    aiModel: '',
    customInstructions: '',
    outputFormat: 'mp4',
    outputQuality: 'high'
  };

  ngOnInit() {
    this.loadAIModels();
  }

  ngOnChanges(changes: SimpleChanges) {
    // Reload models every time the modal opens to get the latest library default
    if (changes['isOpen'] && changes['isOpen'].currentValue === true) {
      console.log('Modal opened, reloading AI models and library default...');
      this.loadAIModels();
    }
  }

  private async loadAIModels() {
    this.loadingModels = true;

    try {
      const availability = await this.aiSetupService.checkAIAvailability();
      const models: AIModelOption[] = [];

      // Add Ollama models
      if (availability.hasOllama && availability.ollamaModels.length > 0) {
        availability.ollamaModels.forEach(model => {
          models.push({
            value: `ollama:${model}`,
            label: model,
            provider: 'ollama'
          });
        });
      }

      // Add Claude models if API key exists
      if (availability.hasClaudeKey) {
        const claudeModels = [
          { value: 'claude:claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
          { value: 'claude:claude-3-opus-20240229', label: 'Claude 3 Opus' },
          { value: 'claude:claude-3-haiku-20240307', label: 'Claude 3 Haiku' }
        ];
        claudeModels.forEach(m => {
          models.push({ ...m, provider: 'claude' });
        });
      }

      // Add OpenAI models if API key exists
      if (availability.hasOpenAIKey) {
        const openaiModels = [
          { value: 'openai:gpt-4o', label: 'GPT-4o' },
          { value: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' },
          { value: 'openai:gpt-4-turbo', label: 'GPT-4 Turbo' }
        ];
        openaiModels.forEach(m => {
          models.push({ ...m, provider: 'openai' });
        });
      }

      this.aiModels = models;

      // Try to get library's default AI model first
      let defaultModel: string | null = null;
      try {
        const response = await this.http.get<{ success: boolean; aiModel: string | null }>(
          `${this.API_BASE}/database/libraries/default-ai-model`
        ).toPromise();
        defaultModel = response?.aiModel || null;
        console.log('Fetched library default AI model:', defaultModel);
      } catch (error) {
        console.error('Failed to fetch library default AI model:', error);
      }

      // If no library-specific default, try global config default
      if (!defaultModel) {
        console.log('No library-specific default found, checking global config...');
        try {
          const configResponse = await this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
            `${this.API_BASE}/config/default-ai`
          ).toPromise();
          if (configResponse?.defaultAI) {
            defaultModel = `${configResponse.defaultAI.provider}:${configResponse.defaultAI.model}`;
            console.log('Using global config default AI model:', defaultModel);
          }
        } catch (error) {
          console.error('Failed to fetch global default AI model:', error);
        }
      }

      console.log('Available models:', models.map(m => m.value));
      console.log('Final default model to use:', defaultModel);

      // Set default model
      if (models.length > 0) {
        // If we have a default (library or global) and it's available, use it
        if (defaultModel && models.some(m => m.value === defaultModel)) {
          this.settings.aiModel = defaultModel;
          console.log('✓ Successfully set AI model to library/global default:', defaultModel);
        } else {
          if (defaultModel) {
            console.warn('⚠ Default model not available in current models list:', defaultModel);
          }
          // Otherwise, use fallback priority: largest local > claude > openai
          const ollamaModels = models.filter(m => m.provider === 'ollama');
          if (ollamaModels.length > 0) {
            const sorted = [...ollamaModels].sort((a, b) => {
              const sizeA = this.extractModelSize(a.label);
              const sizeB = this.extractModelSize(b.label);
              return sizeB - sizeA;
            });
            this.settings.aiModel = sorted[0].value;
          } else {
            const claudeModels = models.filter(m => m.provider === 'claude');
            if (claudeModels.length > 0) {
              this.settings.aiModel = claudeModels[0].value;
            } else {
              const openaiModels = models.filter(m => m.provider === 'openai');
              if (openaiModels.length > 0) {
                this.settings.aiModel = openaiModels[0].value;
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to load AI models:', error);
    } finally {
      this.loadingModels = false;
    }
  }

  private extractModelSize(modelName: string): number {
    const match = modelName.match(/(\d+)b/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  }

  getModelsByProvider(provider: 'ollama' | 'claude' | 'openai'): AIModelOption[] {
    return this.aiModels.filter(m => m.provider === provider);
  }

  hasModelsForProvider(provider: 'ollama' | 'claude' | 'openai'): boolean {
    return this.aiModels.some(m => m.provider === provider);
  }

  /**
   * Save the selected AI model as both library-specific and global default
   * This ensures consistency across all dialogs and modals
   */
  async onAiModelChange() {
    if (!this.settings.aiModel) {
      return;
    }

    try {
      // Save to library-specific storage
      await this.http.post(
        `${this.API_BASE}/database/libraries/default-ai-model`,
        { aiModel: this.settings.aiModel }
      ).toPromise();
      console.log('Saved default AI model for library:', this.settings.aiModel);

      // Also save to global config storage for consistency
      const [provider, ...modelParts] = this.settings.aiModel.split(':');
      const model = modelParts.join(':');
      await this.http.post(
        `${this.API_BASE}/config/default-ai`,
        { provider, model }
      ).toPromise();
      console.log('Saved default AI model to global config:', this.settings.aiModel);
    } catch (error) {
      console.error('Failed to save default AI model:', error);
    }
  }

  getUrlCount(): number {
    return this.getUrls().length;
  }

  private getUrls(): string[] {
    return this.urlText
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0 && (url.startsWith('http://') || url.startsWith('https://')));
  }

  onSubmit(): void {
    const urls = this.getUrls();
    if (urls.length === 0) return;

    const configs = urls.map(url => ({
      url,
      name: this.extractNameFromUrl(url),
      settings: { ...this.settings }
    }));

    this.submitConfig.emit(configs);
    this.close();
  }

  close(): void {
    this.closeDialog.emit();
    this.resetForm();
  }

  private resetForm(): void {
    this.urlText = '';
    this.settings = {
      fixAspectRatio: false,
      normalizeAudio: false,
      transcribe: false,
      whisperModel: 'tiny',
      aiAnalysis: false,
      aiModel: this.aiModels.length > 0 ? this.aiModels[0].value : '',
      customInstructions: '',
      outputFormat: 'mp4',
      outputQuality: 'high'
    };
  }

  private extractNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Try to get video ID or title from common platforms
      if (urlObj.hostname.includes('youtube') || urlObj.hostname.includes('youtu.be')) {
        const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
        return `YouTube Video ${videoId}`;
      }
      if (urlObj.hostname.includes('vimeo')) {
        return `Vimeo Video ${urlObj.pathname.split('/').pop()}`;
      }
      const path = urlObj.pathname;
      const filename = path.split('/').pop() || 'Video';
      return filename.replace(/\.[^/.]+$/, '');
    } catch {
      return 'Video';
    }
  }
}
