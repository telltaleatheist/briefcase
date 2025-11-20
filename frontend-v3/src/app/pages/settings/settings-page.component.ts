import { Component, signal, ChangeDetectionStrategy, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { AiSetupWizardComponent } from '../../components/ai-setup-wizard/ai-setup-wizard.component';
import { AiSetupService } from '../../services/ai-setup.service';

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

  // AI Setup Wizard state
  wizardOpen = signal(false);

  // AI status
  aiConfigured = signal(false);
  activeProviders = signal<string[]>([]);

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
}
