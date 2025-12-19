import { Component, signal, ChangeDetectionStrategy, inject, OnInit, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { AiSetupWizardComponent } from '../../components/ai-setup-wizard/ai-setup-wizard.component';
import { AiSetupService } from '../../services/ai-setup.service';
import { LibraryService } from '../../services/library.service';
import { firstValueFrom } from 'rxjs';

interface AnalysisCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  enabled: boolean;
}

interface AnalysisPrompts {
  description: string;
  title: string;
  tags: string;
  quotes: string;
}

interface PromptsResponse {
  success: boolean;
  prompts: AnalysisPrompts;
  defaults: AnalysisPrompts;
  hasCustom: { description: boolean; title: boolean; tags: boolean; quotes: boolean };
}

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule, FormsModule, AiSetupWizardComponent],
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPageComponent implements OnInit {
  @Input() embedded = false;

  private aiSetupService = inject(AiSetupService);
  private http = inject(HttpClient);
  private libraryService = inject(LibraryService);
  private readonly API_BASE = 'http://localhost:3000/api';

  // AI Setup Wizard state
  wizardOpen = signal(false);

  // AI status
  aiConfigured = signal(false);
  activeProviders = signal<string[]>([]);

  // Default AI Model
  defaultAIModel = signal<string | null>(null);
  availableModels = signal<Array<{ value: string; label: string; provider: string }>>([]);
  loadingDefaultAI = signal(false);
  savingDefaultAI = signal(false);

  // Analysis Categories
  categories = signal<AnalysisCategory[]>([]);
  editingCategory = signal<AnalysisCategory | null>(null);
  isAddingCategory = signal(false);

  // Analysis Prompts
  prompts = signal<AnalysisPrompts | null>(null);
  defaultPrompts = signal<AnalysisPrompts | null>(null);
  hasCustomPrompts = signal<{ description: boolean; title: boolean; tags: boolean; quotes: boolean }>({
    description: false, title: false, tags: false, quotes: false
  });
  loadingPrompts = signal(false);
  savingPrompts = signal(false);
  expandedPrompt = signal<string | null>(null); // Which prompt section is expanded

  // Whisper GPU Mode
  whisperGpuMode = signal<'auto' | 'gpu' | 'cpu'>('auto');
  whisperGpuFailed = signal(false);
  loadingWhisperGpu = signal(false);
  savingWhisperGpu = signal(false);

  // New category form
  newCategory: Partial<AnalysisCategory> = {
    name: '',
    description: '',
    color: '#6b7280',
    enabled: true
  };

  // Default categories for flagging problematic content
  private defaultCategories: AnalysisCategory[] = [
    { id: 'hate', name: 'hate', description: 'Dehumanizing language, slurs, calls for discrimination against groups', color: '#dc2626', enabled: true },
    { id: 'conspiracy', name: 'conspiracy', description: 'Unfounded conspiracy theories presented as fact', color: '#a855f7', enabled: true },
    { id: 'false-prophecy', name: 'false-prophecy', description: 'Specific predictions about future events with dates, apocalyptic prophecies', color: '#8b5cf6', enabled: true },
    { id: 'misinformation', name: 'misinformation', description: 'Demonstrably false claims about science, history, or current events', color: '#eab308', enabled: true },
    { id: 'violence', name: 'violence', description: 'Calls for violence, threatening language, glorification of violence', color: '#ef4444', enabled: true },
    { id: 'christian-nationalism', name: 'christian-nationalism', description: 'Conflation of Christian identity with national/political identity', color: '#ec4899', enabled: true },
    { id: 'extremism', name: 'extremism', description: 'Radical ideological content, calls for extreme action', color: '#f97316', enabled: true },
    { id: 'political-violence', name: 'political-violence', description: 'References to political violence events, defending/downplaying political violence', color: '#b91c1c', enabled: true },
    { id: 'shocking', name: 'shocking', description: 'Particularly shocking or extreme content that stands out', color: '#f59e0b', enabled: true }
  ];

  async ngOnInit() {
    await this.refreshAiStatus();
    await this.loadCategories();
    await this.loadDefaultAI();
    await this.loadAvailableModels();
    await this.loadPrompts();
    await this.loadWhisperGpuMode();
  }

  private async loadCategories() {
    try {
      const response = await fetch('http://localhost:3000/api/config/analysis-categories');
      if (response.ok) {
        const data = await response.json();
        this.categories.set(data.categories || this.defaultCategories);
      } else {
        this.categories.set(this.defaultCategories);
      }
    } catch {
      this.categories.set(this.defaultCategories);
    }
  }

  private async refreshAiStatus() {
    await this.aiSetupService.checkAIAvailability();
    const status = this.aiSetupService.getSetupStatus();

    this.aiConfigured.set(status.isReady);
    this.activeProviders.set(status.availableProviders.map(p => {
      switch (p) {
        case 'local': return 'Local AI';
        case 'ollama': return 'Ollama';
        case 'claude': return 'Claude';
        case 'openai': return 'OpenAI';
        default: return p;
      }
    }));
  }

  openAiWizard() {
    this.wizardOpen.set(true);
  }

  async closeAiWizard() {
    this.wizardOpen.set(false);
    // Always refresh after closing wizard - user may have added keys even if they didn't click "Done"
    await this.refreshAiStatus();
    await this.loadAvailableModels();
  }

  async onWizardCompleted() {
    this.wizardOpen.set(false);
    await this.refreshAiStatus();
    await this.loadAvailableModels();
  }

  // Category Management
  startAddCategory() {
    this.isAddingCategory.set(true);
    this.newCategory = {
      name: '',
      description: '',
      color: '#6b7280',
      enabled: true
    };
  }

  cancelAddCategory() {
    this.isAddingCategory.set(false);
  }

  async addCategory() {
    if (!this.newCategory.name?.trim()) return;

    const category: AnalysisCategory = {
      id: this.newCategory.name.toLowerCase().replace(/\s+/g, '-'),
      name: this.newCategory.name.toLowerCase().replace(/\s+/g, '-'),
      description: this.newCategory.description || '',
      color: this.newCategory.color || '#6b7280',
      enabled: true
    };

    this.categories.update(cats => [...cats, category]);
    this.isAddingCategory.set(false);
    await this.saveCategories();
  }

  startEditCategory(category: AnalysisCategory) {
    this.editingCategory.set({ ...category });
  }

  cancelEditCategory() {
    this.editingCategory.set(null);
  }

  async saveEditCategory() {
    const edited = this.editingCategory();
    if (!edited) return;

    this.categories.update(cats =>
      cats.map(c => c.id === edited.id ? edited : c)
    );
    this.editingCategory.set(null);
    await this.saveCategories();
  }

  async deleteCategory(categoryId: string) {
    if (!confirm('Are you sure you want to delete this category?')) return;

    this.categories.update(cats => cats.filter(c => c.id !== categoryId));
    await this.saveCategories();
  }

  async toggleCategoryEnabled(category: AnalysisCategory) {
    this.categories.update(cats =>
      cats.map(c => c.id === category.id ? { ...c, enabled: !c.enabled } : c)
    );
    await this.saveCategories();
  }

  private async saveCategories() {
    try {
      await fetch('http://localhost:3000/api/config/analysis-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: this.categories() })
      });
    } catch (error) {
      console.error('Failed to save categories:', error);
    }
  }

  async resetToDefaults() {
    if (!confirm('Reset all categories to defaults? This will remove any custom categories.')) return;
    this.categories.set([...this.defaultCategories]);
    await this.saveCategories();
  }

  // Default AI Model Management
  private async loadDefaultAI() {
    this.loadingDefaultAI.set(true);
    try {
      const result = await firstValueFrom(this.libraryService.getDefaultAI());
      if (result.success && result.defaultAI) {
        const fullModelValue = `${result.defaultAI.provider}:${result.defaultAI.model}`;
        this.defaultAIModel.set(fullModelValue);
      } else {
        this.defaultAIModel.set(null);
      }
    } catch (error) {
      console.error('Failed to load default AI:', error);
      this.defaultAIModel.set(null);
    } finally {
      this.loadingDefaultAI.set(false);
    }
  }

  private async loadAvailableModels() {
    try {
      const availability = await this.aiSetupService.checkAIAvailability();
      const models: Array<{ value: string; label: string; provider: string }> = [];

      // Add downloaded Local AI models first (fetched dynamically)
      if (availability.hasLocal) {
        try {
          const localModelsResult = await firstValueFrom(this.aiSetupService.getLocalModels());
          if (localModelsResult?.models) {
            const downloadedModels = localModelsResult.models.filter(m => m.downloaded);
            downloadedModels.forEach(model => {
              models.push({
                value: `local:${model.id}`,
                label: `${model.name} (Local)`,
                provider: 'local'
              });
            });
          }
        } catch (error) {
          console.error('Failed to fetch local models:', error);
        }
      }

      // Add Ollama models (fetched dynamically by aiSetupService)
      if (availability.hasOllama && availability.ollamaModels.length > 0) {
        availability.ollamaModels.forEach(model => {
          models.push({
            value: `ollama:${model}`,
            label: `${model} (Ollama)`,
            provider: 'ollama'
          });
        });
      }

      // Fetch Claude models dynamically from API
      if (availability.hasClaudeKey) {
        try {
          const claudeResponse = await firstValueFrom(
            this.http.get<{ success: boolean; models: any[] }>(`${this.API_BASE}/config/claude-models`)
          );
          if (claudeResponse.success && claudeResponse.models.length > 0) {
            claudeResponse.models.forEach(m => {
              models.push({ value: m.value, label: m.label, provider: 'claude' });
            });
          }
        } catch (error) {
          console.error('Failed to fetch Claude models:', error);
        }
      }

      // Fetch OpenAI models dynamically from API
      if (availability.hasOpenAIKey) {
        try {
          const openaiResponse = await firstValueFrom(
            this.http.get<{ success: boolean; models: any[] }>(`${this.API_BASE}/config/openai-models`)
          );
          if (openaiResponse.success && openaiResponse.models.length > 0) {
            openaiResponse.models.forEach(m => {
              models.push({ value: m.value, label: m.label, provider: 'openai' });
            });
          }
        } catch (error) {
          console.error('Failed to fetch OpenAI models:', error);
        }
      }

      this.availableModels.set(models);
    } catch (error) {
      console.error('Failed to load available models:', error);
    }
  }

  async saveDefaultAI(modelValue: string) {
    this.savingDefaultAI.set(true);
    try {
      const [provider, ...modelParts] = modelValue.split(':');
      const model = modelParts.join(':');

      const result = await firstValueFrom(
        this.libraryService.saveDefaultAI(provider, model)
      );

      if (result.success) {
        console.log(`Saved ${modelValue} as default AI model`);
        this.defaultAIModel.set(modelValue);
        // Show success feedback briefly
        setTimeout(() => {
          this.savingDefaultAI.set(false);
        }, 1000);
      }
    } catch (error) {
      console.error('Failed to save default AI:', error);
      this.savingDefaultAI.set(false);
    }
  }

  // ========================================
  // Prompt Management
  // ========================================

  private async loadPrompts() {
    this.loadingPrompts.set(true);
    try {
      const response = await fetch('http://localhost:3000/api/config/analysis-prompts');
      if (response.ok) {
        const data: PromptsResponse = await response.json();
        this.prompts.set(data.prompts);
        this.defaultPrompts.set(data.defaults);
        this.hasCustomPrompts.set(data.hasCustom);
      }
    } catch (error) {
      console.error('Failed to load prompts:', error);
    } finally {
      this.loadingPrompts.set(false);
    }
  }

  togglePromptExpanded(promptKey: string) {
    if (this.expandedPrompt() === promptKey) {
      this.expandedPrompt.set(null);
    } else {
      this.expandedPrompt.set(promptKey);
    }
  }

  async savePrompt(promptKey: keyof AnalysisPrompts, value: string) {
    this.savingPrompts.set(true);
    try {
      const response = await fetch('http://localhost:3000/api/config/analysis-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts: { [promptKey]: value } })
      });

      if (response.ok) {
        // Update local state
        const currentPrompts = this.prompts();
        if (currentPrompts) {
          this.prompts.set({ ...currentPrompts, [promptKey]: value || this.defaultPrompts()?.[promptKey] || '' });
        }
        // Update hasCustom status
        const hasCustom = this.hasCustomPrompts();
        this.hasCustomPrompts.set({ ...hasCustom, [promptKey]: !!value.trim() });

        // Show success feedback briefly
        setTimeout(() => {
          this.savingPrompts.set(false);
        }, 1000);
      }
    } catch (error) {
      console.error('Failed to save prompt:', error);
      this.savingPrompts.set(false);
    }
  }

  async resetPrompt(promptKey: keyof AnalysisPrompts) {
    const defaults = this.defaultPrompts();
    if (!defaults) return;

    // Save empty string to reset to default
    await this.savePrompt(promptKey, '');

    // Update local state to show default
    const currentPrompts = this.prompts();
    if (currentPrompts) {
      this.prompts.set({ ...currentPrompts, [promptKey]: defaults[promptKey] });
    }
    const hasCustom = this.hasCustomPrompts();
    this.hasCustomPrompts.set({ ...hasCustom, [promptKey]: false });
  }

  async resetAllPrompts() {
    if (!confirm('Reset all prompts to defaults? Your custom prompts will be lost.')) return;

    this.savingPrompts.set(true);
    try {
      const response = await fetch('http://localhost:3000/api/config/analysis-prompts/reset', {
        method: 'POST'
      });

      if (response.ok) {
        const data = await response.json();
        this.prompts.set(data.prompts);
        this.defaultPrompts.set(data.prompts);
        this.hasCustomPrompts.set({ description: false, title: false, tags: false, quotes: false });
      }
    } catch (error) {
      console.error('Failed to reset prompts:', error);
    } finally {
      this.savingPrompts.set(false);
    }
  }

  getPromptLabel(key: string): string {
    const labels: Record<string, string> = {
      description: 'Video Description Prompt',
      title: 'Suggested Title Prompt',
      tags: 'Tag Extraction Prompt',
      quotes: 'Quote Extraction Prompt'
    };
    return labels[key] || key;
  }

  getPromptDescription(key: string): string {
    const descriptions: Record<string, string> = {
      description: 'Generates the 2-3 sentence summary of the video content',
      title: 'Creates suggested filenames based on video analysis',
      tags: 'Extracts people names and topic tags from transcripts',
      quotes: 'Identifies significant quotes from flagged sections'
    };
    return descriptions[key] || '';
  }

  // ========================================
  // Whisper GPU Mode Management
  // ========================================

  private async loadWhisperGpuMode() {
    this.loadingWhisperGpu.set(true);
    try {
      const response = await fetch(`${this.API_BASE}/media/whisper-gpu`);
      if (response.ok) {
        const data = await response.json();
        this.whisperGpuMode.set(data.mode || 'auto');
        this.whisperGpuFailed.set(data.gpuFailed || false);
      }
    } catch (error) {
      console.error('Failed to load Whisper GPU mode:', error);
    } finally {
      this.loadingWhisperGpu.set(false);
    }
  }

  async saveWhisperGpuMode(mode: 'auto' | 'gpu' | 'cpu') {
    this.savingWhisperGpu.set(true);
    try {
      const response = await fetch(`${this.API_BASE}/media/whisper-gpu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });

      if (response.ok) {
        const data = await response.json();
        this.whisperGpuMode.set(data.mode);
        // Reset GPU failed flag when user manually changes mode
        if (mode !== 'auto') {
          this.whisperGpuFailed.set(false);
        }
        // Show success feedback briefly
        setTimeout(() => {
          this.savingWhisperGpu.set(false);
        }, 1000);
      }
    } catch (error) {
      console.error('Failed to save Whisper GPU mode:', error);
      this.savingWhisperGpu.set(false);
    }
  }

  getGpuModeDescription(mode: string): string {
    const descriptions: Record<string, string> = {
      auto: 'Tries GPU first, falls back to CPU if GPU fails',
      gpu: 'Always use GPU (faster, but may fail on some systems)',
      cpu: 'Always use CPU (slower, but more compatible)'
    };
    return descriptions[mode] || '';
  }
}
