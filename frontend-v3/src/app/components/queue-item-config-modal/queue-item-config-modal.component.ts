import { Component, signal, input, output, inject, OnInit, effect, HostListener, computed, untracked } from '@angular/core';
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
import { AiModelOptionsService } from '../../services/ai-model-options.service';
import { AiModelSelectComponent } from '../ai-model-select/ai-model-select.component';
import { CrucibleReadinessService, taskNeedsCrucible } from '../../services/crucible-readiness.service';
import { firstValueFrom } from 'rxjs';
import { PipelinePresetsService } from '../../core/stores/pipeline-presets.service';

@Component({
  selector: 'app-queue-item-config-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, AiModelSelectComponent],
  templateUrl: './queue-item-config-modal.component.html',
  styleUrls: ['./queue-item-config-modal.component.scss']
})
export class QueueItemConfigModalComponent implements OnInit {
  /** The connected Crucible's analysis-model options (one source for every picker). */
  readonly modelOptions = inject(AiModelOptionsService);
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

  // AI model: the stored choice ("provider:model"); the options are the connected Crucible's.
  defaultAIModel = ''; // No fallback - user must have saved a default or select one
  savedAsDefault = signal(false);

  // Track selected AI model directly (fixes ngModel binding issues)
  selectedAIModel = signal<string>('');

  /** The chosen model can't run on the connected server: why (blocks Apply). */
  readonly selectedModelUnavailable = computed(() => this.modelOptions.unavailable(this.selectedAIModel()));

  // Custom instructions history
  instructionsHistory = signal<{ id: number; instruction_text: string; used_at: string }[]>([]);
  showInstructionsDropdown = signal(false);

  // True once tasks have been initialized for the current open session. Prevents
  // a mid-edit model refresh from re-running initializeTasks and discarding the
  // user's in-progress edits.
  private initializedForOpen = false;

  constructor() {
    // When the modal opens, reload the default AI and then initialize tasks
    // (once per open, so a mid-edit refresh never discards the user's edits).
    effect(() => {
      const isOpen = this.isOpen();
      if (!isOpen) {
        // Closed: arm re-init for the next open.
        this.initializedForOpen = false;
        return;
      }
      if (!this.initializedForOpen) {
        this.initializedForOpen = true;
        untracked(() => void this.reloadDefaultAIModelAndInit());
      }
    }, { allowSignalWrites: true });

    // An AI task with no model of its own is seeded once the options (and what
    // the last-used and default models are among them) have arrived.
    effect(() => {
      if (!this.isOpen()) return;
      const seed = this.preferredSeedModel();
      const task = this.tasks().get('ai-analyze');
      if (!seed || !task || task.config?.['aiModel']) return;
      untracked(() => {
        this.updateTaskConfig('ai-analyze', { aiModel: seed });
        this.selectedAIModel.set(seed);
      });
    }, { allowSignalWrites: true });
  }

  ngOnInit() {
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
    if (level <= -15) return 'Standard - typical for streaming platforms';
    if (level <= -13) return 'Loud - matches YouTube reference level';
    if (level <= -11) return 'Very loud - louder than most YouTube uploads';
    return 'Maximum - heavily limited, reduces dynamic range';
  }

  /**
   * Reload the default AI model from the backend, then initialize tasks, so
   * tasks use the latest saved default. The default and the last-used pick are
   * resolved against the connected Crucible's options like any stored value.
   */
  private async reloadDefaultAIModelAndInit() {
    this.defaultAIModel = '';
    try {
      const savedDefault = await firstValueFrom(this.libraryService.getDefaultAI());
      if (savedDefault.success && savedDefault.defaultAI) {
        this.defaultAIModel = `${savedDefault.defaultAI.provider}:${savedDefault.defaultAI.model}`;
      }
    } catch (error) {
      console.warn('Could not load default AI:', error);
    }
    this.modelOptions.use([this.defaultAIModel, this.presetsService.lastChosenAiModel()]);
    this.initializeTasks();
  }

  async saveAsDefault(modelValue: string) {
    const value = this.modelOptions.canonical(modelValue);
    try {
      // "provider:model" (e.g. "local:qwen3.5-9b" -> provider "local", model "qwen3.5-9b")
      const [provider, ...modelParts] = value.split(':');
      const model = modelParts.join(':');

      const result = await firstValueFrom(
        this.libraryService.saveDefaultAI(provider, model)
      );

      if (result.success) {
        // Update the local default so new tasks use this model
        this.defaultAIModel = value;
        // An explicit default is also a last-used pick — remember it too.
        this.presetsService.rememberAiModel(value);
        this.savedAsDefault.set(true);
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
   * order: the model the user last chose → the configured server-side default
   * → none, each only when it is one of the connected Crucible's options, and
   * in its Crucible spelling. Mirrors the inspector Process picker.
   */
  private preferredSeedModel(): string {
    for (const candidate of [this.presetsService.lastChosenAiModel(), this.defaultAIModel]) {
      const option = this.modelOptions.optionFor(candidate);
      if (option) return option;
    }
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
        return { targetLevel: -14, peakLevel: -1 } as NormalizeAudioConfig;
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
      // Saved in its Crucible spelling: a legacy stored value goes as the option it resolved to.
      const selectedModel = this.modelOptions.canonical(this.selectedAIModel());
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
