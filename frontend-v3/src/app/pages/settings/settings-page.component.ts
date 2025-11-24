import { Component, signal, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
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

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule, FormsModule, AiSetupWizardComponent],
  templateUrl: './settings-page.component.html',
  styleUrls: ['./settings-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPageComponent implements OnInit {
  private aiSetupService = inject(AiSetupService);
  private http = inject(HttpClient);
  private libraryService = inject(LibraryService);

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

  // New category form
  newCategory: Partial<AnalysisCategory> = {
    name: '',
    description: '',
    color: '#6b7280',
    enabled: true
  };

  // Default categories
  private defaultCategories: AnalysisCategory[] = [
    { id: 'routine', name: 'routine', description: 'Normal content analysis - use for any content that doesn\'t match specific categories', color: '#3b82f6', enabled: true },
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

  closeAiWizard() {
    this.wizardOpen.set(false);
  }

  async onWizardCompleted() {
    this.wizardOpen.set(false);
    await this.refreshAiStatus();
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

      // Add Ollama models
      if (availability.hasOllama && availability.ollamaModels.length > 0) {
        availability.ollamaModels.forEach(model => {
          models.push({
            value: `ollama:${model}`,
            label: `${model} (Ollama)`,
            provider: 'ollama'
          });
        });
      }

      // Add Claude models
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

      // Add OpenAI models
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
}
