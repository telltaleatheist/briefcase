import { Component, signal, input, output, inject, OnInit, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
  defaultAIModel = 'ollama:qwen2.5:7b';

  constructor() {
    // Re-initialize tasks when modal opens
    effect(() => {
      if (this.isOpen()) {
        this.initializeTasks();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit() {
    this.loadAIModels();
  }

  private async loadAIModels() {
    this.loadingModels.set(true);

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

      this.aiModels.set(models);

      // Set default model priority: largest local > claude > openai
      if (models.length > 0) {
        // Try to get largest Ollama model first (prefer models with larger numbers)
        const ollamaModels = models.filter(m => m.provider === 'ollama');
        if (ollamaModels.length > 0) {
          // Sort by model size hints in name (e.g., 70b > 7b > 3b)
          const sorted = [...ollamaModels].sort((a, b) => {
            const sizeA = this.extractModelSize(a.label);
            const sizeB = this.extractModelSize(b.label);
            return sizeB - sizeA;
          });
          this.defaultAIModel = sorted[0].value;
        } else {
          // Fall back to Claude, then OpenAI
          const claudeModels = models.filter(m => m.provider === 'claude');
          if (claudeModels.length > 0) {
            this.defaultAIModel = claudeModels[0].value;
          } else {
            const openaiModels = models.filter(m => m.provider === 'openai');
            if (openaiModels.length > 0) {
              this.defaultAIModel = openaiModels[0].value;
            }
          }
        }
      }
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

  initializeTasks() {
    const taskMap = new Map<TaskType, QueueItemTask>();

    // Initialize from existing tasks or defaults
    const existing = this.existingTasks();
    console.log('initializeTasks - existing tasks:', existing);
    if (existing && existing.length > 0) {
      existing.forEach(task => {
        console.log('Adding task to map:', task.type, 'config:', task.config);
        taskMap.set(task.type, { ...task });
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
        return { model: 'base', translate: false } as TranscribeConfig;
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
      console.log(`getTaskConfig(${taskType}): no config, using default`);
      return this.getDefaultConfig(taskType);
    }
    console.log(`getTaskConfig(${taskType}):`, config);
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
