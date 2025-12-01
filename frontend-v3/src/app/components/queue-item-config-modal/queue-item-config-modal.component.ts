import { Component, signal, input, output, inject, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import {
  AVAILABLE_TASKS,
  Task,
  TaskType,
  DownloadImportConfig,
  TranscribeConfig,
  AIAnalyzeConfig,
  FixAspectRatioConfig,
  NormalizeAudioConfig
} from '../../models/task.model';
import { QueueItemTask } from '../../models/queue.model';
import { AiSetupService, AIAvailability } from '../../services/ai-setup.service';
import { LibraryService } from '../../services/library.service';
import { firstValueFrom } from 'rxjs';

interface AIModelOption {
  value: string;
  label: string;
  provider: 'ollama' | 'claude' | 'openai';
}

@Component({
  selector: 'app-queue-item-config-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './queue-item-config-modal.component.html',
  styleUrls: ['./queue-item-config-modal.component.scss']
})
export class QueueItemConfigModalComponent implements OnInit {
  private aiSetupService = inject(AiSetupService);
  private libraryService = inject(LibraryService);
  private http = inject(HttpClient);
  private readonly API_BASE = 'http://localhost:3000/api';

  // Inputs
  isOpen = input<boolean>(false);
  itemSource = input<'url' | 'library'>('url');
  existingTasks = input<QueueItemTask[]>([]);
  bulkMode = input<boolean>(false);
  itemCount = input<number>(0);

  // Outputs
  close = output<void>();
  save = output<QueueItemTask[]>();
  bulkSave = output<QueueItemTask[]>();

  // State
  tasks = signal<Map<TaskType, QueueItemTask>>(new Map());
  expandedTask = signal<TaskType | null>(null);

  // AI Models
  aiModels = signal<AIModelOption[]>([]);
  loadingModels = signal(false);
  defaultAIModel = ''; // No fallback - user must have saved a default or select one
  savedAsDefault = signal(false);

  constructor() {
    // When modal opens, reload default AI and then initialize tasks
    effect(() => {
      const isOpen = this.isOpen();
      const loading = this.loadingModels();

      // Only initialize when modal is open AND models are loaded
      if (isOpen && !loading) {
        // Reload default AI first, then initialize tasks
        this.reloadDefaultAIModelAndInit();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit() {
    this.loadAIModels();
  }

  /**
   * Reload the default AI model from the backend, then initialize tasks
   * This ensures tasks use the latest saved default
   */
  private async reloadDefaultAIModelAndInit() {
    try {
      const savedDefault = await firstValueFrom(this.libraryService.getDefaultAI());
      if (savedDefault.success && savedDefault.defaultAI) {
        const fullModelValue = `${savedDefault.defaultAI.provider}:${savedDefault.defaultAI.model}`;
        // Check if the saved model is still available in our loaded models
        const models = this.aiModels();
        if (models.length === 0 || models.some(m => m.value === fullModelValue)) {
          this.defaultAIModel = fullModelValue;
          console.log(`Loaded saved default AI model: ${fullModelValue}`);
        }
      }
    } catch (error) {
      console.warn('Could not load default AI:', error);
    }

    // Now initialize tasks with the updated default
    this.initializeTasks();
  }

  private async loadAIModels() {
    this.loadingModels.set(true);

    try {
      const availability = await this.aiSetupService.checkAIAvailability();
      const models: AIModelOption[] = [];

      // Add Ollama models (fetched dynamically by aiSetupService)
      if (availability.hasOllama && availability.ollamaModels.length > 0) {
        availability.ollamaModels.forEach(model => {
          models.push({
            value: `ollama:${model}`,
            label: model,
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

      this.aiModels.set(models);
      console.log('=== QUEUE MODAL: Loading AI models ===');
      console.log('Available models:', models.map(m => m.value));

      // Load saved default from backend - NO FALLBACK
      try {
        const savedDefault = await firstValueFrom(this.libraryService.getDefaultAI());
        console.log('Saved default response:', JSON.stringify(savedDefault));
        if (savedDefault.success && savedDefault.defaultAI) {
          const fullModelValue = `${savedDefault.defaultAI.provider}:${savedDefault.defaultAI.model}`;
          console.log('Constructed default model value:', fullModelValue);
          // Check if the saved model is still available
          const modelExists = models.some(m => m.value === fullModelValue);
          console.log('Model exists in list?', modelExists);
          if (modelExists) {
            this.defaultAIModel = fullModelValue;
            console.log(`✓ Using saved default AI model: ${fullModelValue}`);
          } else {
            // Saved default not available - leave blank, user must select
            this.defaultAIModel = '';
            console.warn(`⚠ Saved default model not available: ${fullModelValue}`);
          }
        } else {
          // No saved default - leave blank, user must select
          this.defaultAIModel = '';
          console.log('No saved default AI, user must select one');
        }
      } catch (error) {
        console.warn('Could not load saved default AI:', error);
        this.defaultAIModel = '';
      }
      console.log('=== FINAL defaultAIModel:', this.defaultAIModel, '===');
    } catch (error) {
      console.error('Failed to load AI models:', error);
    } finally {
      this.loadingModels.set(false);
    }
  }

  getModelsByProvider(provider: 'ollama' | 'claude' | 'openai'): AIModelOption[] {
    return this.aiModels().filter(m => m.provider === provider);
  }

  private extractModelSize(modelName: string): number {
    // Extract size from model names like "qwen2.5:70b", "llama3:8b", etc.
    const match = modelName.match(/(\d+)b/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  }

  hasModelsForProvider(provider: 'ollama' | 'claude' | 'openai'): boolean {
    return this.aiModels().some(m => m.provider === provider);
  }

  async saveAsDefault(modelValue: string) {
    try {
      // Split the model value (e.g., "ollama:qwen2.5:7b" -> provider: "ollama", model: "qwen2.5:7b")
      const [provider, ...modelParts] = modelValue.split(':');
      const model = modelParts.join(':');

      const result = await firstValueFrom(
        this.libraryService.saveDefaultAI(provider, model)
      );

      if (result.success) {
        console.log(`Saved ${modelValue} as default AI model`);
        // Update the local default so new tasks use this model
        this.defaultAIModel = modelValue;
        // Show success feedback
        this.savedAsDefault.set(true);
        // Reset after 1 second
        setTimeout(() => {
          this.savedAsDefault.set(false);
        }, 1000);
      }
    } catch (error) {
      console.error('Failed to save default AI:', error);
    }
  }

  initializeTasks() {
    const taskMap = new Map<TaskType, QueueItemTask>();

    // Initialize from existing tasks or defaults
    const existing = this.existingTasks();
    console.log('initializeTasks - existing tasks:', existing);
    if (existing && existing.length > 0) {
      existing.forEach(task => {
        console.log('Adding task to map:', task.type, 'config:', task.config);
        const taskCopy = { ...task };

        // Ensure ai-analyze task has the default AI model if not specified
        if (task.type === 'ai-analyze') {
          if (!task.config || !task.config['aiModel']) {
            taskCopy.config = {
              ...task.config,
              aiModel: this.defaultAIModel
            };
            console.log('Set default AI model for ai-analyze task:', this.defaultAIModel);
          }
        }

        taskMap.set(task.type, taskCopy);
      });
    }

    this.tasks.set(taskMap);
    console.log('Tasks map after init:', Array.from(taskMap.entries()));
  }

  getAvailableTasks(): Task[] {
    const source = this.itemSource();
    return AVAILABLE_TASKS.filter(task => {
      // Exclude download-import - it's automatically added based on source type
      if (task.type === 'download-import') {
        return false;
      }
      if (source === 'url') {
        return task.requiresUrl || task.requiresFile;
      } else {
        return task.requiresFile;
      }
    });
  }

  isTaskSelected(taskType: TaskType): boolean {
    return this.tasks().has(taskType);
  }

  toggleTask(task: Task) {
    const currentTasks = new Map(this.tasks());

    if (currentTasks.has(task.type)) {
      currentTasks.delete(task.type);
      // If removing transcribe, also remove ai-analyze since it depends on transcribe
      if (task.type === 'transcribe' && currentTasks.has('ai-analyze')) {
        currentTasks.delete('ai-analyze');
      }
    } else {
      currentTasks.set(task.type, {
        type: task.type,
        status: 'pending',
        progress: 0,
        config: this.getDefaultConfig(task.type)
      });
      // If adding ai-analyze, also add transcribe if not already selected
      if (task.type === 'ai-analyze' && !currentTasks.has('transcribe')) {
        currentTasks.set('transcribe', {
          type: 'transcribe',
          status: 'pending',
          progress: 0,
          config: this.getDefaultConfig('transcribe')
        });
      }
    }

    this.tasks.set(currentTasks);
  }

  toggleExpanded(taskType: TaskType) {
    if (this.expandedTask() === taskType) {
      this.expandedTask.set(null);
    } else {
      this.expandedTask.set(taskType);
    }
  }

  getDefaultConfig(taskType: TaskType): any {
    switch (taskType) {
      case 'download-import':
        return { quality: 'best', format: 'mp4' } as DownloadImportConfig;
      case 'transcribe':
        return { model: 'tiny', translate: false } as TranscribeConfig;
      case 'ai-analyze':
        return {
          aiModel: this.defaultAIModel
        } as AIAnalyzeConfig;
      case 'fix-aspect-ratio':
        return { targetRatio: '16:9', cropMode: 'smart' } as FixAspectRatioConfig;
      case 'normalize-audio':
        return { targetLevel: -16, peakLevel: -1 } as NormalizeAudioConfig;
      default:
        return {};
    }
  }

  updateTaskConfig(taskType: TaskType, config: any) {
    const currentTasks = new Map(this.tasks());
    const task = currentTasks.get(taskType);
    if (task) {
      task.config = { ...task.config, ...config };
      currentTasks.set(taskType, task);
      this.tasks.set(currentTasks);
    }
  }

  getTaskConfig(taskType: TaskType): any {
    const task = this.tasks().get(taskType);
    const config = task?.config;
    // Only fall back to default if config is undefined/null or empty object
    if (!config || Object.keys(config).length === 0) {
      return this.getDefaultConfig(taskType);
    }
    return config;
  }

  onSave() {
    const tasksArray = Array.from(this.tasks().values());
    if (this.bulkMode()) {
      this.bulkSave.emit(tasksArray);
    } else {
      this.save.emit(tasksArray);
    }
  }

  onClose() {
    this.close.emit();
  }

  onBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.onClose();
    }
  }
}
