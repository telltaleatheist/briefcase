import { Component, signal, input, output, inject, OnInit, effect, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AVAILABLE_TASKS,
  Task,
  TaskType,
  DownloadImportConfig,
  AIAnalyzeConfig,
  FixAspectRatioConfig,
  NormalizeAudioConfig,
} from '../../models/task.model';
import { QueueItemTask } from '../../models/queue.model';
import { LibraryService } from '../../services/library.service';
import { CrucibleService } from '../../services/crucible.service';
import { CrucibleReadinessService, taskNeedsCrucible } from '../../services/crucible-readiness.service';
import { firstValueFrom } from 'rxjs';
import { PipelinePresetsService } from '../../core/stores/pipeline-presets.service';

interface AIModelOption {
  value: string;
  label: string;
  provider: 'local' | 'ollama' | 'claude' | 'openai';
}

@Component({
  selector: 'app-queue-item-config-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './queue-item-config-modal.component.html',
  styleUrls: ['./queue-item-config-modal.component.scss']
})
export class QueueItemConfigModalComponent implements OnInit {
  private crucible = inject(CrucibleService);
  /** Transcribe and AI analyze need Crucible: while it is not ready they can't be turned on. */
  readonly readiness = inject(CrucibleReadinessService);
  private libraryService = inject(LibraryService);
  private presetsService = inject(PipelinePresetsService);

  // Inputs
  isOpen = input<boolean>(false);
  itemSource = input<'url' | 'library'>('url');
  existingTasks = input<QueueItemTask[]>([]);
  bulkMode = input<boolean>(false);
  itemCount = input<number>(0);
  hasTranscript = input<boolean>(false); // Whether video already has a transcript

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

  // Track selected AI model directly (fixes ngModel binding issues)
  selectedAIModel = signal<string>('');

  // Custom instructions history
  instructionsHistory = signal<{ id: number; instruction_text: string; used_at: string }[]>([]);
  showInstructionsDropdown = signal(false);

  // True once tasks have been initialized for the current open session. Prevents
  // a mid-edit model refresh from re-running initializeTasks and discarding the
  // user's in-progress edits.
  private initializedForOpen = false;

  constructor() {
    // When modal opens, reload default AI and then initialize tasks
    effect(() => {
      const isOpen = this.isOpen();
      const loading = this.loadingModels();

      if (!isOpen) {
        // Closed: arm re-init for the next open.
        this.initializedForOpen = false;
        return;
      }

      // Only initialize once per open, after models have loaded.
      if (!loading && !this.initializedForOpen) {
        this.initializedForOpen = true;
        // Reload default AI first, then initialize tasks
        this.reloadDefaultAIModelAndInit();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit() {
    this.loadAIModels();
    this.loadInstructionsHistory();
  }

  private async loadInstructionsHistory() {
    try {
      const response = await firstValueFrom(this.libraryService.getCustomInstructionsHistory());
      if (response.success && response.history) {
        this.instructionsHistory.set(response.history);
      }
    } catch (error) {
      console.warn('Failed to load instructions history:', error);
    }
  }

  toggleInstructionsDropdown() {
    this.showInstructionsDropdown.update(v => !v);
  }

  selectHistoryItem(item: { instruction_text: string }) {
    this.updateTaskConfig('ai-analyze', { customInstructions: item.instruction_text });
    this.showInstructionsDropdown.set(false);
  }

  truncateInstruction(text: string, maxLength: number = 60): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  // THE DETECTION-SENSITIVITY SLIDER USED TO BE HERE, AND IS GONE ON PURPOSE.
  // See process-config.component.ts for the full note: the analysis now captures
  // everything and stores every verdict, the dial became a display filter in the
  // video editor, and the operator removed the run-side control outright. This
  // modal no longer sets `analysisGranularity`.

  getAudioLevelDescription(level: number): string {
    if (level <= -22) return 'Very quiet - suitable for background music or ambient content';
    if (level <= -19) return 'Quiet - similar to traditional broadcast standards (EBU R128)';
    if (level <= -17) return 'Moderate - good for podcasts and general web content';
    if (level <= -15) return 'Standard - typical for YouTube and streaming platforms';
    return 'Loud - maximizes perceived volume, may reduce dynamic range';
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
      // The connected Crucible server's catalog and its configured upstreams.
      let models: AIModelOption[] = [];
      try {
        models = (await firstValueFrom(this.crucible.modelOptions()))
          .map(m => ({ value: m.value, label: m.label, provider: m.provider }));
      } catch (error) {
        console.error("Failed to list the Crucible server's models:", error);
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

  getModelsByProvider(provider: 'local' | 'ollama' | 'claude' | 'openai'): AIModelOption[] {
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

  hasModelsForProvider(provider: 'local' | 'ollama' | 'claude' | 'openai'): boolean {
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
        // An explicit default is also a last-used pick — remember it too.
        this.presetsService.rememberAiModel(modelValue);
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

  /**
   * Preferred value to seed a task's model when it has none of its own, in
   * order: the model the user last chose (if still installed) → the configured
   * server-side default (if installed) → none. Mirrors the inspector Process
   * picker so last-used is honored here too, not only there. Both candidates are
   * checked against the loaded model list so a stale/uninstalled value is never
   * selected; values are "provider:model", matching every option value.
   */
  private preferredSeedModel(): string {
    const models = this.aiModels();
    const remembered = this.presetsService.lastChosenAiModel();
    if (remembered && models.some(m => m.value === remembered)) return remembered;
    if (this.defaultAIModel && models.some(m => m.value === this.defaultAIModel)) return this.defaultAIModel;
    return '';
  }

  initializeTasks() {
    const taskMap = new Map<TaskType, QueueItemTask>();

    // Reset the dropdown-bound model so a previous item's pick can't leak into
    // this item's save; it's re-seeded below from the item's own ai-analyze task.
    this.selectedAIModel.set('');

    // Initialize from existing tasks or defaults
    const existing = this.existingTasks();
    console.log('[initializeTasks] defaultAIModel:', this.defaultAIModel);
    console.log('[initializeTasks] existing tasks:', existing);
    if (existing && existing.length > 0) {
      existing.forEach(task => {
        console.log('[initializeTasks] Processing task:', task.type, 'config:', task.config);
        const taskCopy = { ...task, config: { ...task.config } };

        // Ensure ai-analyze task has a seeded model when not specified: the
        // task's own saved model wins, then last-used, then the server default.
        if (task.type === 'ai-analyze') {
          const aiModel = task.config?.['aiModel'] || this.preferredSeedModel();
          taskCopy.config = {
            ...task.config,
            aiModel,
          };
          // Also set the direct signal for proper ngModel binding
          this.selectedAIModel.set(aiModel);
          console.log(`[initializeTasks] ai-analyze: model=${aiModel}, set selectedAIModel signal`);
        }

        taskMap.set(task.type, taskCopy);
      });
    }

    this.tasks.set(taskMap);
    console.log('[initializeTasks] Final tasks map:', Array.from(taskMap.entries()));
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

  /** A task that needs Crucible can't be turned on while it is not ready (one already on can be turned off). */
  isTaskLocked(taskType: TaskType): boolean {
    return taskNeedsCrucible(taskType) && !this.readiness.ready() && !this.tasks().has(taskType);
  }

  toggleTask(task: Task) {
    const currentTasks = new Map(this.tasks());

    if (this.isTaskLocked(task.type)) {
      this.readiness.requireReady();
      return;
    }

    if (currentTasks.has(task.type)) {
      currentTasks.delete(task.type);
      // No dependency enforcement - allow independent selection
    } else {
      const config = this.getDefaultConfig(task.type);
      currentTasks.set(task.type, {
        type: task.type,
        status: 'pending',
        progress: 0,
        config
      });
      // Seed the dropdown-bound signal too, so the AI Model select reflects the
      // freshly-seeded model and onSave doesn't submit an empty aiModel (FC-8).
      if (task.type === 'ai-analyze') {
        this.selectedAIModel.set(config?.aiModel || '');
      }
      // No dependency enforcement - allow independent selection
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

  /**
   * Handle AI model change
   */
  onAIModelChange(modelValue: string) {
    console.log('[onAIModelChange] User selected model:', modelValue);
    // Update the direct signal (for ngModel binding)
    this.selectedAIModel.set(modelValue);
    // Also update the task config
    this.updateTaskConfig('ai-analyze', { aiModel: modelValue });
    // Record as the user's last-used model so every picker seeds it next time.
    this.presetsService.rememberAiModel(modelValue);
  }

  getDefaultConfig(taskType: TaskType): any {
    switch (taskType) {
      case 'download-import':
        return { quality: 'best', format: 'mp4' } as DownloadImportConfig;
      case 'transcribe':
        // No options: the asr model is Settings › Transcription's (P7).
        return {};
      case 'ai-analyze':
        // No analysisGranularity: nothing in the UI sets it any more.
        return {
          aiModel: this.preferredSeedModel(),
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
    const currentTasks = new Map(this.tasks());

    // Ensure the ai-analyze task has the currently selected model from the signal
    // This is critical - we use the signal as the source of truth for the selected model
    if (currentTasks.has('ai-analyze')) {
      const aiTask = currentTasks.get('ai-analyze')!;
      const selectedModel = this.selectedAIModel();
      console.log('[onSave] Ensuring ai-analyze task uses selected model:', selectedModel);
      // Only overwrite when the signal actually holds a model — an empty signal
      // must never clobber a model the task already carries (FC-8).
      if (selectedModel) {
        aiTask.config = {
          ...aiTask.config,
          aiModel: selectedModel
        };
        currentTasks.set('ai-analyze', aiTask);
      }
    }

    // If AI analysis is selected but there's no transcript and transcribe wasn't selected,
    // automatically add transcribe task
    if (currentTasks.has('ai-analyze') && !currentTasks.has('transcribe') && !this.hasTranscript() && this.readiness.ready()) {
      currentTasks.set('transcribe', {
        type: 'transcribe',
        status: 'pending',
        progress: 0,
        config: this.getDefaultConfig('transcribe')
      });
      console.log('[onSave] Auto-added transcribe task for AI analysis (no existing transcript)');
    }

    const tasksArray = Array.from(currentTasks.values());
    console.log('[onSave] Emitting tasks:', JSON.stringify(tasksArray, null, 2));
    if (this.bulkMode()) {
      this.bulkSave.emit(tasksArray);
    } else {
      this.save.emit(tasksArray);
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey() {
    if (this.isOpen()) {
      this.onClose();
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
