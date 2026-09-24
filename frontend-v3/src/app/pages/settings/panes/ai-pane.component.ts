import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, timer } from 'rxjs';
import { AiSetupService } from '../../../services/ai-setup.service';
import { LibraryService } from '../../../services/library.service';
import { AiSetupWizardComponent } from '../../../components/ai-setup-wizard/ai-setup-wizard.component';
import { UiButtonComponent } from '../../../ui';
import { getApiBase } from '../../../core/runtime-url';
import { ErrorSurface } from '../../../core/error-surface.service';
import { PipelinePresetsService } from '../../../core/stores/pipeline-presets.service';
import { Router } from '@angular/router';
import { CrucibleService, type CrucibleRefusal } from '../../../services/crucible.service';
import { CrucibleUpstreamsComponent } from '../../../components/crucible-upstreams/crucible-upstreams.component';
import type { AiModelsView, AiRunsAs, AiTaskModels, AiTaskName, AiViaView, LegacyKeysView } from '@crucible-wire/ai-wire';

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
  hasCustom: Record<keyof AnalysisPrompts, boolean>;
}

interface ProviderCard {
  key: 'local' | 'ollama' | 'claude' | 'openai';
  name: string;
  description: string;
  ready: boolean;
}

interface ModelOption {
  value: string;
  label: string;
  provider: string;
}

const PROMPT_KEYS: (keyof AnalysisPrompts)[] = ['description', 'title', 'tags', 'quotes'];

/** The tasks that can each have their own model (app-config `taskModels`). */
const AI_TASKS: { key: AiTaskName; label: string; hint: string }[] = [
  { key: 'boundary', label: 'Chapter boundaries', hint: 'Short quote-copying calls; a small model is plenty.' },
  { key: 'chapter', label: 'Chapter titles and summaries', hint: '' },
  { key: 'flags', label: 'Flags', hint: '' },
  { key: 'description', label: 'Description', hint: '' },
  { key: 'tags', label: 'Tags', hint: '' },
  { key: 'title', label: 'Suggested title', hint: '' },
];

type ViaChoice = 'default' | 'crucible' | 'direct';

const PROMPT_LABELS: Record<string, string> = {
  description: 'Video Description Prompt',
  title: 'Suggested Title Prompt',
  tags: 'Tag Extraction Prompt',
  quotes: 'Quote Extraction Prompt',
};

const PROMPT_DESCRIPTIONS: Record<string, string> = {
  description: 'Generates the 2-3 sentence summary of the video content',
  title: 'Creates suggested filenames based on video analysis',
  tags: 'Extracts people names and topic tags from transcripts',
  quotes: 'Identifies significant quotes from flagged sections',
};

const DEFAULT_CATEGORIES: AnalysisCategory[] = [
  { id: 'hate', name: 'hate', description: 'Dehumanizing language, slurs, calls for discrimination against groups', color: '#dc2626', enabled: true },
  { id: 'conspiracy', name: 'conspiracy', description: 'Unfounded conspiracy theories presented as fact', color: '#a855f7', enabled: true },
  { id: 'false-prophecy', name: 'false-prophecy', description: 'Specific predictions about future events with dates, apocalyptic prophecies', color: '#8b5cf6', enabled: true },
  { id: 'misinformation', name: 'misinformation', description: 'Demonstrably false claims about science, history, or current events', color: '#eab308', enabled: true },
  { id: 'violence', name: 'violence', description: 'Calls for violence, threatening language, glorification of violence', color: '#ef4444', enabled: true },
  { id: 'christian-nationalism', name: 'christian-nationalism', description: 'Conflation of Christian identity with national/political identity', color: '#ec4899', enabled: true },
  { id: 'extremism', name: 'extremism', description: 'Radical ideological content, calls for extreme action', color: '#f97316', enabled: true },
  { id: 'political-violence', name: 'political-violence', description: 'References to political violence events, defending/downplaying political violence', color: '#b91c1c', enabled: true },
  { id: 'shocking', name: 'shocking', description: 'Particularly shocking or extreme content that stands out', color: '#f59e0b', enabled: true },
];

/**
 * Settings → AI: provider status, guided setup, default model, analysis
 * categories and prompts. AI is optional throughout — transcription works
 * without any of this. Consolidates the AI sections of the old settings page;
 * the step-by-step wizard stays available as "Guided setup".
 */
@Component({
  selector: 'app-ai-pane',
  standalone: true,
  imports: [FormsModule, AiSetupWizardComponent, UiButtonComponent, CrucibleUpstreamsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss', './ai-pane.component.scss'],
  templateUrl: './ai-pane.component.html'
})
export class AiPaneComponent {
  private aiSetupService = inject(AiSetupService);
  private libraryService = inject(LibraryService);
  private http = inject(HttpClient);
  private destroyRef = inject(DestroyRef);
  private errorSurface = inject(ErrorSurface);
  private presetsService = inject(PipelinePresetsService);
  private crucible = inject(CrucibleService);
  private router = inject(Router);
  private readonly apiBase = getApiBase();

  // ── AI engine: which road, and the connected Crucible (P3) ────────────
  /** 'crucible' | 'direct' as the backend resolves it right now. */
  readonly via = this.aiSetupService.via;
  readonly viaView = signal<AiViaView | null>(null);
  readonly viaChoice = computed<ViaChoice>(() => this.viaView()?.stored ?? 'default');
  readonly crucibleView = signal<AiModelsView | null>(null);
  /** The server whose upstreams the pane edits: the connected one, under Crucible only. */
  readonly connectedServer = computed(() => (this.via() === 'crucible' ? this.crucibleView()?.server ?? null : null));
  readonly legacy = signal<LegacyKeysView | null>(null);
  readonly copyingKeys = signal(false);
  readonly copyLine = signal<{ ok: boolean; text: string } | null>(null);
  readonly aiTasks = AI_TASKS;
  readonly taskModels = signal<AiTaskModels>({});
  /** What each chosen `ollama:<tag>` runs as through Crucible, by stored value. */
  readonly runsAs = signal<Record<string, AiRunsAs>>({});
  /** The chosen Ollama values to ask about (the default and every task), as one key. */
  private readonly ollamaChoices = computed<string>(() => {
    if (this.via() !== 'crucible') return '';
    const values = [this.selectedModel(), ...Object.values(this.taskModels())]
      .filter((v): v is string => typeof v === 'string' && v.startsWith('ollama:'));
    return [...new Set(values)].sort().join(',');
  });

  // Provider status
  providers = signal<ProviderCard[]>([]);
  aiConfigured = signal(false);
  /** The availability check itself failed — provider states are unknown. */
  statusCheckFailed = signal(false);
  wizardOpen = signal(false);

  // Default model
  /** The configured server-side default ("provider:model"), or null. */
  private configuredDefault = signal<string | null>(null);
  /**
   * The model the user explicitly saved this session — wins over any seed so a
   * fresh pick shows immediately, without waiting on a reload.
   */
  private userSelectedModel = signal<string | null>(null);
  availableModels = signal<ModelOption[]>([]);
  savedFlash = signal(false);

  /**
   * The value shown in the picker. An explicit save wins; otherwise it is seeded
   * by preference (see preferredSeedModel): last-used first, then the configured
   * server default, then none.
   */
  readonly selectedModel = computed<string>(
    () => this.userSelectedModel() ?? this.preferredSeedModel() ?? ''
  );

  /** The selected value isn't among the loaded options — render it as "(unavailable)" so the native select still reflects it instead of dropping to the first option. Null while there are genuinely no models (the "No models available" guidance covers that). */
  readonly missingSelectedModel = computed<string | null>(() => {
    const current = this.selectedModel();
    if (!current) return null;
    const models = this.availableModels();
    if (models.length === 0) return null;
    return models.some(m => m.value === current) ? null : current;
  });

  /**
   * Preferred value to seed the picker, in order: the model the user last chose
   * in ANY picker (if it's still an installed option) → the configured
   * server-side default (the legitimate first-run state) → none. Reads signals,
   * so the picker re-seeds as the model list and default load in.
   */
  private preferredSeedModel(): string | null {
    const models = this.availableModels();
    const remembered = this.presetsService.lastChosenAiModel();
    if (remembered && models.some(m => m.value === remembered)) return remembered;
    // Keep the configured server default as-is (membership unchecked, unchanged
    // behavior) — a stale value simply falls through to the placeholder.
    return this.configuredDefault();
  }

  // Categories
  categories = signal<AnalysisCategory[]>([]);
  editingCategoryId = signal<string | null>(null);
  addingCategory = signal(false);
  formName = signal('');
  formColor = signal('#6b7280');
  formDescription = signal('');

  // Prompts
  prompts = signal<AnalysisPrompts | null>(null);
  defaultPrompts = signal<AnalysisPrompts | null>(null);
  hasCustomPrompts = signal<Record<keyof AnalysisPrompts, boolean>>({
    description: false, title: false, tags: false, quotes: false,
  });
  expandedPrompt = signal<keyof AnalysisPrompts | null>(null);

  readonly promptKeys = PROMPT_KEYS;

  constructor() {
    effect(() => {
      const choices = this.ollamaChoices();
      untracked(() => void this.loadRunsAs(choices));
    });
    void this.refreshStatus();
    void this.loadDefaultModel();
    void this.loadCategories();
    void this.loadPrompts();

    // New downloads should appear in the model picker without a restart.
    this.aiSetupService.modelsChanged$
      .pipe(takeUntilDestroyed())
      .subscribe(() => { void this.refreshStatus(); });
  }

  promptLabel(key: string): string {
    return PROMPT_LABELS[key] ?? key;
  }

  promptDescription(key: string): string {
    return PROMPT_DESCRIPTIONS[key] ?? '';
  }

  // ── Providers / status ──────────────────────────────────────────────────

  private async refreshStatus(): Promise<void> {
    await this.refreshEngine();
    const availability = await this.aiSetupService.checkAIAvailability();
    this.statusCheckFailed.set(availability.checkFailed);
    this.aiConfigured.set(
      availability.hasLocal || availability.hasOllama || availability.hasClaudeKey || availability.hasOpenAIKey
    );
    this.providers.set([
      { key: 'local', name: 'Local AI', description: 'Runs on this machine — private, offline, free.', ready: availability.hasLocal },
      { key: 'ollama', name: 'Ollama', description: 'Open models via a separate Ollama install.', ready: availability.hasOllama },
      { key: 'claude', name: 'Claude API', description: 'Anthropic cloud models. Requires an API key.', ready: availability.hasClaudeKey },
      { key: 'openai', name: 'OpenAI API', description: 'OpenAI cloud models. Requires an API key.', ready: availability.hasOpenAIKey },
    ]);
    await this.loadAvailableModels();
  }

  /** The road, the connected server, Briefcase's leftover keys and the per-task models. */
  private async refreshEngine(): Promise<void> {
    try {
      this.viaView.set(await firstValueFrom(this.crucible.aiVia()));
    } catch (error) {
      this.errorSurface.surfaceError("Couldn't read where AI runs", error);
    }
    const via = await this.aiSetupService.refreshVia();
    if (via === 'crucible') {
      try {
        this.crucibleView.set(await this.aiSetupService.loadCrucibleModels());
      } catch (error) {
        this.crucibleView.set(null);
        this.errorSurface.surfaceError("Couldn't list the Crucible server's models", error);
      }
    }
    try {
      this.legacy.set(await firstValueFrom(this.crucible.legacyKeys()));
    } catch {
      this.legacy.set(null);
    }
    try {
      this.taskModels.set(await firstValueFrom(this.crucible.taskModels()));
    } catch {
      this.taskModels.set({});
    }
    void this.loadRunsAs(this.ollamaChoices());
  }

  async onViaChange(choice: ViaChoice): Promise<void> {
    try {
      this.viaView.set(await firstValueFrom(this.crucible.setAiVia(choice === 'default' ? null : choice)));
      this.flashSaved();
      await this.refreshStatus();
    } catch (error) {
      this.errorSurface.surfaceError("Where AI runs didn't save", error);
    }
  }

  openCrucibleServers(): void {
    void this.router.navigate(['/settings/crucible']);
  }

  async onUpstreamsChanged(): Promise<void> {
    await this.refreshStatus();
  }

  /** Which server Briefcase's own keys would be copied to: this computer's Crucible, else the connected one. */
  readonly copyTarget = computed(() => this.legacy()?.localServer ?? this.connectedServer());

  async copyLegacyKeys(): Promise<void> {
    const target = this.copyTarget();
    if (!target) return;
    this.copyingKeys.set(true);
    this.copyLine.set(null);
    try {
      const outcome = await firstValueFrom(this.crucible.copyLegacyKeys(target));
      const parts: string[] = [];
      const names = (list: string[]) => list.map((u) => (u === 'anthropic' ? 'Claude' : 'OpenAI')).join(' and ');
      if (outcome.copied.length) parts.push(`Copied the ${names(outcome.copied)} key to ${target}.`);
      if (outcome.alreadyThere.length) parts.push(`${target} already had the same ${names(outcome.alreadyThere)} key.`);
      for (const skip of outcome.skipped) parts.push(skip.reason);
      parts.push(outcome.deletedLocalFile ? "Briefcase's own copy is deleted; the keys now live on the server." : (outcome.keptBecause ?? ''));
      this.copyLine.set({ ok: outcome.skipped.length === 0, text: parts.filter(Boolean).join(' ') });
      await this.refreshStatus();
    } catch (error) {
      this.copyLine.set({ ok: false, text: (error as CrucibleRefusal).message ?? 'The keys were not copied.' });
    } finally {
      this.copyingKeys.set(false);
    }
  }

  private async loadRunsAs(choices: string): Promise<void> {
    if (!choices) {
      this.runsAs.set({});
      return;
    }
    try {
      const rows = await firstValueFrom(this.crucible.runsAs(choices.split(',')));
      if (choices !== this.ollamaChoices()) return;
      this.runsAs.set(Object.fromEntries(rows.map((row) => [row.value, row])));
    } catch {
      this.runsAs.set({});
    }
  }

  /**
   * The line under a picker holding an Ollama choice, through Crucible: the
   * server's own model it runs as, or Ollama at its default context.
   */
  runsAsLine(value: string): string | null {
    const row = this.runsAs()[value];
    if (!row) return null;
    const tag = value.slice('ollama:'.length);
    const server = row.server ?? 'the Crucible server';
    if (row.runsAs) return `${tag} (Ollama) → runs as ${row.runsAs} on ${server}`;
    const context = row.contextTokens ? `, ${Math.round(row.contextTokens / 1024)}K context` : '';
    return `${tag} (Ollama) → via Ollama on ${server}${context}`;
  }

  taskModelFor(task: AiTaskName): string {
    return this.taskModels()[task] ?? '';
  }

  async onTaskModelChange(task: AiTaskName, value: string): Promise<void> {
    try {
      this.taskModels.set(await firstValueFrom(this.crucible.setTaskModels({ [task]: value || null })));
      this.flashSaved();
    } catch (error) {
      this.errorSurface.surfaceError("That task's model didn't save", error);
    }
  }

  /** A stored per-task model that is not among the options, shown as "(unavailable)" rather than dropped. */
  missingTaskModel(task: AiTaskName): string | null {
    const current = this.taskModelFor(task);
    if (!current) return null;
    const models = this.availableModels();
    return models.length === 0 || models.some((m) => m.value === current) ? null : current;
  }

  retryStatusCheck(): void {
    void this.refreshStatus();
  }

  openWizard(): void {
    this.wizardOpen.set(true);
  }

  async onWizardDone(): Promise<void> {
    this.wizardOpen.set(false);
    await this.refreshStatus();
  }

  // ── Default model ───────────────────────────────────────────────────────

  private async loadDefaultModel(): Promise<void> {
    try {
      const result = await firstValueFrom(this.libraryService.getDefaultAI());
      this.configuredDefault.set(
        result.success && result.defaultAI
          ? `${result.defaultAI.provider}:${result.defaultAI.model}`
          : null
      );
    } catch (error) {
      // A failed lookup is not "no default configured" — surface it.
      this.configuredDefault.set(null);
      this.errorSurface.surfaceError("Couldn't load the default AI model setting", error);
    }
  }

  private async loadAvailableModels(): Promise<void> {
    // Through Crucible: the connected server's catalog and upstreams.
    let viaCrucible: ModelOption[] | null;
    try {
      viaCrucible = await this.aiSetupService.modelOptionsIfCrucible();
    } catch (error) {
      this.errorSurface.surfaceError("Couldn't list the Crucible server's models", error);
      viaCrucible = [];
    }
    if (viaCrucible !== null) {
      this.availableModels.set(viaCrucible.map((m) => ({ value: m.value, label: m.label, provider: m.provider })));
      return;
    }

    const availability = await this.aiSetupService.checkAIAvailability();
    const models: ModelOption[] = [];

    if (availability.hasLocal) {
      try {
        const local = await firstValueFrom(this.aiSetupService.getLocalModels());
        local?.models?.filter(m => m.downloaded).forEach(model => {
          models.push({ value: `local:${model.id}`, label: `${model.name} (Local)`, provider: 'local' });
        });
      } catch (error) {
        // Local AI IS configured, so a listing failure hides real models.
        this.errorSurface.surfaceError("Couldn't list local AI models", error);
      }
    }

    if (availability.hasOllama) {
      availability.ollamaModels.forEach(model => {
        models.push({ value: `ollama:${model}`, label: `${model} (Ollama)`, provider: 'ollama' });
      });
    }

    if (availability.hasClaudeKey) {
      try {
        const response = await firstValueFrom(
          this.http.get<{ success: boolean; models: ModelOption[] }>(`${this.apiBase}/config/claude-models`)
        );
        if (response.success) models.push(...response.models);
      } catch (error) {
        // Key IS configured — a listing failure silently hides usable models.
        this.errorSurface.surfaceError("Couldn't list Claude models", error);
      }
    }

    if (availability.hasOpenAIKey) {
      try {
        const response = await firstValueFrom(
          this.http.get<{ success: boolean; models: ModelOption[] }>(`${this.apiBase}/config/openai-models`)
        );
        if (response.success) models.push(...response.models);
      } catch (error) {
        this.errorSurface.surfaceError("Couldn't list OpenAI models", error);
      }
    }

    this.availableModels.set(models);
  }

  async onDefaultModelChange(value: string): Promise<void> {
    if (!value) return;
    const [provider, ...rest] = value.split(':');
    try {
      const result = await firstValueFrom(this.libraryService.saveDefaultAI(provider, rest.join(':')));
      if (result.success) {
        this.userSelectedModel.set(value);
        // Keep last-used in sync with the explicit default so every other picker
        // (inspector Process, Add popover) seeds to the same model next time.
        this.presetsService.rememberAiModel(value);
        this.flashSaved();
      } else {
        this.errorSurface.surfaceError("Default AI model didn't save", result);
      }
    } catch (error) {
      this.errorSurface.surfaceError("Default AI model didn't save", error);
    }
  }

  // ── Categories ──────────────────────────────────────────────────────────

  /**
   * True when categories FAILED to load. Editing is blocked in that state:
   * saving defaults over the user's (existing but unloadable) custom
   * categories would be silent data loss (fallback-audit).
   */
  categoriesLoadFailed = signal(false);

  private async loadCategories(): Promise<void> {
    this.categoriesLoadFailed.set(false);
    try {
      const response = await fetch(`${this.apiBase}/config/analysis-categories`);
      if (!response.ok) {
        throw new Error(`Analysis categories request failed (${response.status})`);
      }
      const data = await response.json();
      this.categories.set(data.categories || DEFAULT_CATEGORIES);
    } catch (error) {
      // Show defaults read-only rather than pretending they ARE the config.
      this.categories.set([...DEFAULT_CATEGORIES]);
      this.categoriesLoadFailed.set(true);
      this.errorSurface.surfaceError("Couldn't load analysis categories", error);
    }
  }

  private async saveCategories(): Promise<void> {
    if (this.categoriesLoadFailed()) {
      this.errorSurface.surfaceError(
        "Categories weren't saved",
        new Error('Refusing to overwrite unloadable existing categories — reload the pane first')
      );
      return;
    }
    try {
      const response = await fetch(`${this.apiBase}/config/analysis-categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories: this.categories() }),
      });
      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }
    } catch (error) {
      this.errorSurface.surfaceError("Analysis categories didn't save", error);
    }
  }

  startAddCategory(): void {
    this.addingCategory.set(true);
    this.editingCategoryId.set(null);
    this.formName.set('');
    this.formColor.set('#6b7280');
    this.formDescription.set('');
  }

  startEditCategory(category: AnalysisCategory): void {
    this.editingCategoryId.set(category.id);
    this.addingCategory.set(false);
    this.formName.set(category.name);
    this.formColor.set(category.color);
    this.formDescription.set(category.description);
  }

  cancelCategoryForm(): void {
    this.addingCategory.set(false);
    this.editingCategoryId.set(null);
  }

  async submitCategoryForm(): Promise<void> {
    const name = this.formName().trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;

    if (this.addingCategory()) {
      this.categories.update(cats => [...cats, {
        id: name,
        name,
        description: this.formDescription(),
        color: this.formColor(),
        enabled: true,
      }]);
    } else {
      const id = this.editingCategoryId();
      this.categories.update(cats => cats.map(c => c.id === id
        ? { ...c, name, description: this.formDescription(), color: this.formColor() }
        : c));
    }
    this.cancelCategoryForm();
    await this.saveCategories();
  }

  async toggleCategory(category: AnalysisCategory): Promise<void> {
    this.categories.update(cats =>
      cats.map(c => c.id === category.id ? { ...c, enabled: !c.enabled } : c));
    await this.saveCategories();
  }

  async deleteCategory(category: AnalysisCategory): Promise<void> {
    if (!confirm(`Delete the “${category.name}” category?`)) return;
    this.categories.update(cats => cats.filter(c => c.id !== category.id));
    await this.saveCategories();
  }

  async resetCategories(): Promise<void> {
    if (!confirm('Reset all categories to defaults? This will remove any custom categories.')) return;
    this.categories.set([...DEFAULT_CATEGORIES]);
    await this.saveCategories();
  }

  // ── Prompts ─────────────────────────────────────────────────────────────

  private async loadPrompts(): Promise<void> {
    try {
      const response = await fetch(`${this.apiBase}/config/analysis-prompts`);
      if (response.ok) {
        const data: PromptsResponse = await response.json();
        this.prompts.set(data.prompts);
        this.defaultPrompts.set(data.defaults);
        this.hasCustomPrompts.set(data.hasCustom);
      }
    } catch (error) {
      this.errorSurface.surfaceError("Couldn't load analysis prompts", error);
    }
  }

  togglePrompt(key: keyof AnalysisPrompts): void {
    this.expandedPrompt.update(current => current === key ? null : key);
  }

  async savePrompt(key: keyof AnalysisPrompts, value: string): Promise<void> {
    try {
      const response = await fetch(`${this.apiBase}/config/analysis-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts: { [key]: value } }),
      });
      if (response.ok) {
        const current = this.prompts();
        if (current) {
          this.prompts.set({ ...current, [key]: value || this.defaultPrompts()?.[key] || '' });
        }
        this.hasCustomPrompts.update(flags => ({ ...flags, [key]: !!value.trim() }));
        this.flashSaved();
      }
    } catch (error) {
      this.errorSurface.surfaceError("Prompt didn't save", error);
    }
  }

  async resetPrompt(key: keyof AnalysisPrompts): Promise<void> {
    const defaults = this.defaultPrompts();
    if (!defaults) return;
    await this.savePrompt(key, '');
    const current = this.prompts();
    if (current) this.prompts.set({ ...current, [key]: defaults[key] });
    this.hasCustomPrompts.update(flags => ({ ...flags, [key]: false }));
  }

  async resetAllPrompts(): Promise<void> {
    if (!confirm('Reset all prompts to defaults? Your custom prompts will be lost.')) return;
    try {
      const response = await fetch(`${this.apiBase}/config/analysis-prompts/reset`, { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        this.prompts.set(data.prompts);
        this.defaultPrompts.set(data.prompts);
        this.hasCustomPrompts.set({ description: false, title: false, tags: false, quotes: false });
      }
    } catch (error) {
      this.errorSurface.surfaceError("Prompts didn't reset", error);
    }
  }

  private flashSaved(): void {
    this.savedFlash.set(true);
    timer(1200).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.savedFlash.set(false));
  }
}
