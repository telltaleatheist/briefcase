import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, timer } from 'rxjs';
import { LibraryService } from '../../../services/library.service';
import { UiButtonComponent } from '../../../ui';
import { getApiBase } from '../../../core/runtime-url';
import { ErrorSurface } from '../../../core/error-surface.service';
import { PipelinePresetsService } from '../../../core/stores/pipeline-presets.service';
import { Router } from '@angular/router';
import { CrucibleService, type CrucibleRefusal } from '../../../services/crucible.service';
import { AiModelOptionsService } from '../../../services/ai-model-options.service';
import { AiModelSelectComponent } from '../../../components/ai-model-select/ai-model-select.component';
import { CrucibleUpstreamsComponent } from '../../../components/crucible-upstreams/crucible-upstreams.component';
import type { AiTaskModels, AiTaskName, LegacyKeysView } from '@crucible-wire/ai-wire';

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

const PROMPT_KEYS: (keyof AnalysisPrompts)[] = ['description', 'title', 'tags', 'quotes'];

/** The tasks that can each have their own model (app-config `taskModels`). */
const AI_TASKS: { key: AiTaskName; label: string; hint: string }[] = [
  { key: 'chapter', label: 'Chapter titles and summaries', hint: 'Names and summarises the chapters the scorer found.' },
  { key: 'flags', label: 'Flag checks', hint: 'Checks each flag the scorer ranked, and keeps or drops it.' },
  { key: 'description', label: 'Description', hint: '' },
  { key: 'tags', label: 'Tags', hint: '' },
  { key: 'title', label: 'Suggested title', hint: '' },
];

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
 * Settings → AI: the Crucible server AI runs on (its cloud keys and Ollama
 * are that server's upstreams), the default and per-task models, analysis
 * categories and prompts. Every AI call goes through Crucible; there is no
 * other road.
 */
@Component({
  selector: 'app-ai-pane',
  standalone: true,
  imports: [FormsModule, UiButtonComponent, CrucibleUpstreamsComponent, AiModelSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss', './ai-pane.component.scss'],
  templateUrl: './ai-pane.component.html'
})
export class AiPaneComponent {
  private libraryService = inject(LibraryService);
  private destroyRef = inject(DestroyRef);
  private errorSurface = inject(ErrorSurface);
  private presetsService = inject(PipelinePresetsService);
  private crucible = inject(CrucibleService);
  private router = inject(Router);
  private readonly apiBase = getApiBase();

  // ── The connected Crucible (P3) ─────────────────────────────────────────
  /** The analysis-model options every picker shows, from the connected Crucible. */
  readonly modelOptions = inject(AiModelOptionsService);
  readonly crucibleView = this.modelOptions.view;
  /** The server whose upstreams the pane edits: the connected one. */
  readonly connectedServer = computed(() => this.crucibleView()?.server ?? null);
  readonly legacy = signal<LegacyKeysView | null>(null);
  readonly copyingKeys = signal(false);
  readonly copyLine = signal<{ ok: boolean; text: string } | null>(null);
  readonly aiTasks = AI_TASKS;
  readonly taskModels = signal<AiTaskModels>({});

  // Default model
  /** The configured server-side default ("provider:model"), as stored, or ''. */
  readonly configuredDefault = signal('');
  savedFlash = signal(false);

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
    // Stored choices the pickers show are resolved against the server's options.
    effect(() => {
      const values = [this.configuredDefault(), ...Object.values(this.taskModels())];
      untracked(() => this.modelOptions.use(values));
    });
    void this.refreshStatus();
    void this.loadDefaultModel();
    void this.loadCategories();
    void this.loadPrompts();
  }

  promptLabel(key: string): string {
    return PROMPT_LABELS[key] ?? key;
  }

  promptDescription(key: string): string {
    return PROMPT_DESCRIPTIONS[key] ?? '';
  }

  // ── Providers / status ──────────────────────────────────────────────────

  /** The connected server and its models, Briefcase's leftover keys and the per-task models. */
  private async refreshStatus(): Promise<void> {
    await this.modelOptions.refresh();
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

  // ── Default model ───────────────────────────────────────────────────────

  private async loadDefaultModel(): Promise<void> {
    try {
      const result = await firstValueFrom(this.libraryService.getDefaultAI());
      this.configuredDefault.set(
        result.success && result.defaultAI
          ? `${result.defaultAI.provider}:${result.defaultAI.model}`
          : ''
      );
    } catch (error) {
      // A failed lookup is not "no default configured" — surface it.
      this.configuredDefault.set('');
      this.errorSurface.surfaceError("Couldn't load the default AI model setting", error);
    }
  }

  /** Saved in the Crucible spelling the picker emits. */
  async onDefaultModelChange(value: string): Promise<void> {
    if (!value) return;
    const [provider, ...rest] = value.split(':');
    try {
      const result = await firstValueFrom(this.libraryService.saveDefaultAI(provider, rest.join(':')));
      if (result.success) {
        this.configuredDefault.set(value);
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
