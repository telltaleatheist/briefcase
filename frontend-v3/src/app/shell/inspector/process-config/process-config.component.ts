import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { ErrorSurface } from '../../../core/error-surface.service';
import { LibraryService } from '../../../services/library.service';
import { AiModelOptionsService } from '../../../services/ai-model-options.service';
import { AiModelSelectComponent } from '../../../components/ai-model-select/ai-model-select.component';
import { CrucibleReadinessService, taskNeedsCrucible } from '../../../services/crucible-readiness.service';
import {
  PIPELINE_STEPS,
  PipelinePreset,
  PipelinePresetsService,
  PipelineStep,
  PipelineStepType,
  sortPipelineSteps,
  withoutRetiredKeys,
} from '../../../core/stores/pipeline-presets.service';

/** One row from GET /database/custom-instructions-history. */
interface InstructionHistoryItem {
  id: number;
  instruction_text: string;
  used_at: string;
}

/**
 * The Process configuration panel — compose a pipeline of job steps (in run
 * order) for the selected videos, save combinations as named presets, queue
 * with one click. Lives in the right inspector (single- and multi-select
 * alike); it replaced the toolbar's Process popover.
 *
 * Selection counts in via inputs, intents out via outputs. The steps that need
 * Crucible (transcribe, AI analyze) read CrucibleReadinessService: while it is
 * not ready they show disabled and unchecked with the reason and the one door,
 * and are left out of the composed pipeline, so a download or processing job
 * still goes through without them. The user's choice stays sticky, so they
 * come back on when Crucible does. Sticky last-used state restores from
 * PipelinePresetsService.
 */
@Component({
  selector: 'app-process-config',
  standalone: true,
  imports: [FormsModule, AiModelSelectComponent],
  templateUrl: './process-config.component.html',
  styleUrls: ['./process-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessConfigComponent {
  private presetsService = inject(PipelinePresetsService);
  private destroyRef = inject(DestroyRef);
  private library = inject(LibraryService);
  readonly modelOptions = inject(AiModelOptionsService);
  readonly readiness = inject(CrucibleReadinessService);
  private errorSurface = inject(ErrorSurface);

  selectionCount = input(0);
  /** Selected videos lacking a transcript / analysis (from InspectorStore). */
  withoutTranscript = input(0);
  notAnalyzed = input(0);

  /**
   * Per-job mode. When non-null, this panel edits ONE already-staged job's
   * pipeline rather than composing a fresh one: enabled steps + configs are
   * seeded from these steps (merged over defaults), and every global side
   * effect (sticky persistence, enableSteps channel) is suppressed so editing
   * one pending job never mutates shared defaults.
   * Null = the normal compose mode (library selection).
   */
  initialSteps = input<PipelineStep[] | null>(null);
  /**
   * Whether toggles/option changes persist to the sticky last-used state and
   * global defaults. False in per-job mode. Also gates submit's rememberSteps().
   */
  persistSticky = input(true);
  /** Submit button label. "Add to Queue" (compose) vs "Save to N pending". */
  submitLabel = input('Add to Queue');
  /**
   * Chrome toggles for host embedding. The Add popover hides both: it supplies
   * its own "Add media" context (no "Process / N selected" header) and its own
   * full-width Download button (no summary+submit footer), reading the composed
   * steps via composedSteps() at its own submit. Inspector usages leave both on.
   */
  showHeader = input(true);
  showFooter = input(true);
  /**
   * An external reason to block submit (shown in the footer, disables the
   * button). The queue-page trim block sets this when a trim time is invalid.
   */
  submitBlockedReason = input<string | null>(null);

  submitSteps = output<PipelineStep[]>();
  /** A step's Crucible door was pressed (the action it took), so a host overlay can close before navigating. */
  doorOpened = output<string | null>();

  readonly stepDefs = PIPELINE_STEPS;
  presets = this.presetsService.presets;

  /** Enabled state per step type. */
  private enabled = signal<Record<PipelineStepType, boolean>>(this.restoreEnabled());
  /** Per-step config (createQueueTask options). */
  private configs = signal<Record<PipelineStepType, Record<string, unknown>>>(this.restoreConfigs());

  /** Per-step options accordion — each enabled step expands independently. */
  private expandedSteps = signal<Partial<Record<PipelineStepType, boolean>>>({});

  /** Inline save-as-preset mode. */
  savingPreset = signal(false);
  presetName = signal('');

  /** Last enableSteps() token this instance handled (see PipelinePresetsService). */
  private lastSeenEnableToken = this.presetsService.enableStepsRequest().token;

  constructor() {
    // Per-job mode: (re)seed enabled/configs from the selected job's steps
    // whenever the input changes (selection moving to a different job re-seeds
    // in place, no component recreation). Merged over defaults so a job saved
    // before a step gained new option fields never surfaces undefined.
    effect(() => {
      const steps = this.initialSteps();
      if (steps === null) return;
      untracked(() => this.seedFromSteps(steps));
    }, { allowSignalWrites: true });

    // Live-enable steps requested from elsewhere (e.g. the cascade's Run
    // Analysis / View Transcript). A freshly-mounted instance instead picks the
    // steps up from the already-updated sticky lastSteps, so it treats the
    // construction-time token as already seen and only reacts to later bumps.
    // Ignored entirely in per-job mode — enableSteps is a compose-mode concept.
    effect(() => {
      const req = this.presetsService.enableStepsRequest();
      if (req.token === this.lastSeenEnableToken) return;
      this.lastSeenEnableToken = req.token;
      if (this.initialSteps() !== null) return;
      untracked(() => this.applyEnableSteps(req.types));
    }, { allowSignalWrites: true });

    // AI-analyze options (model list, instruction history) load once the step
    // is both enabled and Crucible is ready.
    effect(() => {
      if (this.isEnabled('ai-analyze')) {
        untracked(() => this.ensureAiData());
      }
    }, { allowSignalWrites: true });

    // A preset apply or stale sticky state can leave ai-analyze without a
    // model; once the options are known, seed the empty picker in preference
    // order — last chosen, then the configured default. A non-empty value
    // short-circuits, so the user's own pick / a job's saved model wins.
    effect(() => {
      const seed = this.preferredSeedModel();
      if (!seed || !this.isEnabled('ai-analyze')) return;
      if (String(this.configs()['ai-analyze']['aiModel'] ?? '')) return;
      untracked(() => this.setOption('ai-analyze', 'aiModel', seed));
    }, { allowSignalWrites: true });
  }

  private applyEnableSteps(types: PipelineStepType[]): void {
    if (types.length === 0) return;
    this.enabled.update(state => {
      const next = { ...state };
      for (const type of types) next[type] = true;
      return next;
    });
    this.persistStickyState();
  }

  /**
   * Per-job mode seeding: turn on exactly the steps present in `steps` and merge
   * each one's config over the step defaults (task types outside the four
   * pipeline steps are ignored — they're preserved separately on save). No
   * sticky/global writes: editing one pending job must not mutate defaults.
   */
  private seedFromSteps(steps: PipelineStep[]): void {
    const enabled = { ...this.blankEnabled() };
    const configs = { ...this.defaultConfigs() };
    for (const step of steps.map(withoutRetiredKeys)) {
      if (!(step.type in enabled)) continue;
      enabled[step.type] = true;
      configs[step.type] = { ...configs[step.type], ...step.config };
    }
    this.enabled.set(enabled);
    this.configs.set(configs);
    this.expandedSteps.set({});
  }

  isExpanded(type: PipelineStepType): boolean {
    return this.expandedSteps()[type] === true;
  }

  /**
   * The step needs Crucible and Crucible is not ready: shown disabled and
   * unchecked with the reason. In per-job mode a staged job's own AI steps are
   * kept (checked, locked) instead: editing a job never silently drops them.
   */
  aiLocked(type: PipelineStepType): boolean {
    return taskNeedsCrucible(type) && !this.readiness.ready();
  }

  isEnabled(type: PipelineStepType): boolean {
    if (!this.enabled()[type]) return false;
    return !this.aiLocked(type) || this.initialSteps() !== null;
  }

  /** Only steps with options get the chevron: transcribe has none (its model is Settings › Transcription's). */
  openDoor(): void {
    const action = this.readiness.action();
    void this.readiness.openDoor();
    this.doorOpened.emit(action);
  }

  hasOptions(type: PipelineStepType): boolean {
    return type !== 'transcribe';
  }

  config(type: PipelineStepType): Record<string, unknown> {
    return this.configs()[type];
  }

  /** The composed pipeline, in canonical run order. */
  steps = computed<PipelineStep[]>(() => {
    const configs = this.configs();
    return this.stepDefs
      .filter(def => this.isEnabled(def.type))
      .map(def => {
        const config = { ...configs[def.type] };
        // Queued in its Crucible spelling: a legacy stored value goes as the option it resolved to.
        if (def.type === 'ai-analyze' && typeof config['aiModel'] === 'string') config['aiModel'] = this.modelOptions.canonical(config['aiModel']);
        return { type: def.type, config };
      });
  });

  /**
   * Host-facing read of the composed pipeline, sorted into canonical run order
   * — for embedders (the Add popover) that own their own submit button and read
   * the steps directly via a viewChild reference instead of the submitSteps
   * output. Mirrors what submit() emits.
   */
  composedSteps(): PipelineStep[] {
    return sortPipelineSteps(this.steps());
  }

  /** "3 of 5 already transcribed"-style hint per step, when relevant. */
  doneHint(type: PipelineStepType): string | null {
    const total = this.selectionCount();
    if (total === 0) return null;
    if (type === 'transcribe') {
      const done = total - this.withoutTranscript();
      return done > 0 ? `${done} of ${total} already transcribed` : null;
    }
    if (type === 'ai-analyze') {
      const done = total - this.notAnalyzed();
      return done > 0 ? `${done} of ${total} already analyzed` : null;
    }
    return null;
  }

  // ── AI analyze options: custom instructions, model picker ─────────────────
  // Loaded lazily (once) when the analyze step is enabled and Crucible is ready.

  private aiDataLoaded = false;

  private ensureAiData(): void {
    if (this.aiDataLoaded) return;
    this.aiDataLoaded = true;
    void this.loadDefaultAiModel();
    void this.loadInstructionsHistory();
  }

  // THE DETECTION-SENSITIVITY SLIDER USED TO BE HERE, AND IS GONE ON PURPOSE.
  //
  // It was a 1-5 dial that changed what an analysis DID. Under the operator's
  // 2026-08-25 ruling the analysis always captures everything and stores every
  // verdict, and the dial became a display filter in the video editor's analysis
  // panel. The operator then removed the run-side control outright: "not sure we
  // need the 1-5 run slider anymore after we've turned it into a filter."
  //
  // So this surface no longer sets `analysisGranularity` at all — it is not sent
  // with the job, and the field survives in the request models only as an
  // optional one for API compatibility. The stored `defaultGranularity` in
  // app-config.json is config-file-only. There is no UI in front of it anywhere.

  // Custom instructions + history --------------------------------------------

  instructionsHistory = signal<InstructionHistoryItem[]>([]);
  instructionsHistoryLoading = signal(false);
  instructionsHistoryError = signal(false);
  showInstructionsDropdown = signal(false);

  async loadInstructionsHistory(): Promise<void> {
    this.instructionsHistoryLoading.set(true);
    this.instructionsHistoryError.set(false);
    try {
      const response = await firstValueFrom(this.library.getCustomInstructionsHistory());
      this.instructionsHistory.set(response.success ? response.history : []);
    } catch {
      this.instructionsHistoryError.set(true);
    } finally {
      this.instructionsHistoryLoading.set(false);
    }
  }

  toggleInstructionsDropdown(): void {
    this.showInstructionsDropdown.update(v => !v);
  }

  selectHistoryItem(text: string): void {
    this.setOption('ai-analyze', 'customInstructions', text);
    this.showInstructionsDropdown.set(false);
  }

  truncateInstruction(text: string, maxLength = 60): string {
    return text.length <= maxLength ? text : text.substring(0, maxLength) + '…';
  }

  onTextOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, (event.target as HTMLTextAreaElement).value);
  }

  // AI model picker ----------------------------------------------------------
  // The options are the connected Crucible's (AiModelOptionsService, drawn by
  // <app-ai-model-select>); a stored value is shown as the option it is.

  /** The configured default ("provider:model") as stored, or ''. */
  defaultAiModel = signal('');

  /** The step's chosen model, as stored in its config. */
  readonly aiModelValue = computed(() => String(this.config('ai-analyze')['aiModel'] ?? ''));

  /** The chosen model can't run on the connected server: why (blocks submit while the step is on). */
  readonly aiModelUnavailable = computed(() => this.modelOptions.unavailable(this.aiModelValue()));

  isCurrentModelDefault = computed(() => {
    const current = this.modelOptions.canonical(this.aiModelValue());
    return current.length > 0 && current === this.modelOptions.canonical(this.defaultAiModel());
  });

  /** The configured default drives the "This is your default model" note and seeding. */
  async loadDefaultAiModel(): Promise<void> {
    try {
      const saved = await firstValueFrom(this.library.getDefaultAI());
      const value = saved.success && saved.defaultAI ? `${saved.defaultAI.provider}:${saved.defaultAI.model}` : '';
      this.defaultAiModel.set(value);
      this.modelOptions.use([value, this.presetsService.lastChosenAiModel()]);
    } catch {
      this.defaultAiModel.set('');
      this.modelOptions.use([this.presetsService.lastChosenAiModel()]);
    }
  }

  /** Persist the chosen model, in its Crucible spelling, as the global default (POST). */
  saveAiAsDefault(): void {
    const value = this.modelOptions.canonical(this.aiModelValue());
    const firstColon = value.indexOf(':');
    if (firstColon < 0) return;
    const provider = value.slice(0, firstColon);
    const model = value.slice(firstColon + 1);
    this.library
      .saveDefaultAI(provider, model)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.defaultAiModel.set(value),
        error: error => this.errorSurface.surfaceError("Couldn't save default AI model", error),
      });
  }

  /**
   * The AI model picker's change handler. Applies the pick like any option, and
   * ALSO records it as the user's remembered last model — a personal preference,
   * so it's written in every host including per-job mode (the other per-job
   * suppressions stand; this isn't job config). Seeding never routes through
   * here, so only real user picks are remembered.
   */
  onAiModelValue(value: string): void {
    this.setOption('ai-analyze', 'aiModel', value);
    this.presetsService.rememberAiModel(value);
  }

  /**
   * Preferred value to seed an EMPTY ai-analyze picker, in order: the last model
   * the user chose (when it is one of the server's options) → the configured
   * server-side default → none. Seeded in its Crucible spelling. Reads
   * signals, so effects that call it re-run as options and defaults load.
   */
  private preferredSeedModel(): string {
    for (const candidate of [this.presetsService.lastChosenAiModel(), this.defaultAiModel()]) {
      const option = this.modelOptions.optionFor(candidate);
      if (option) return option;
    }
    return '';
  }

  // Normalize-audio target loudness ------------------------------------------

  audioLevelValue = computed(() => Number(this.config('normalize-audio')['targetLevel'] ?? -14));
  audioLevelDescription = computed(() => this.getAudioLevelDescription(this.audioLevelValue()));

  getAudioLevelDescription(level: number): string {
    if (level <= -22) return 'Very quiet - suitable for background music or ambient content';
    if (level <= -19) return 'Quiet - similar to traditional broadcast standards (EBU R128)';
    if (level <= -17) return 'Moderate - good for podcasts and general web content';
    if (level <= -15) return 'Standard - typical for streaming platforms';
    if (level <= -13) return 'Loud - matches YouTube reference level';
    if (level <= -11) return 'Very loud - louder than most YouTube uploads';
    return 'Maximum - heavily limited, reduces dynamic range';
  }

  summary = computed(() => {
    const stepCount = this.steps().length;
    const videos = this.selectionCount();
    if (stepCount === 0) return 'Pick at least one step';
    const stepsText = `${stepCount} step${stepCount === 1 ? '' : 's'}`;
    const videosText = `${videos} video${videos === 1 ? '' : 's'}`;
    return `${stepsText} → ${videosText}`;
  });

  /** Why Start is disabled, when it is (honest and actionable). */
  blockReason = computed<string | null>(() => {
    const external = this.submitBlockedReason();
    if (external) return external;
    if (this.selectionCount() === 0) return 'Select at least one video';
    if (this.steps().length === 0) return 'Pick at least one step';
    return this.aiModelProblem();
  });

  /**
   * AI Analyze is on and its model is missing or can't run on the connected
   * server: why. Hosts with their own submit (the Add popover) read it too.
   */
  readonly aiModelProblem = computed<string | null>(() => {
    if (!this.isEnabled('ai-analyze') || !this.readiness.ready()) return null;
    // The picker says why a model can't run; this only says what to do.
    if (!this.aiModelValue() || this.aiModelUnavailable()) return 'Pick an AI model for AI Analyze';
    return null;
  });

  canSubmit = computed(() => this.blockReason() === null);

  /** A preset chip highlights when it matches the current composition. */
  isPresetActive(preset: PipelinePreset): boolean {
    const current = this.steps();
    if (current.length !== preset.steps.length) return false;
    return preset.steps.every(ps => {
      const step = current.find(s => s.type === ps.type);
      return !!step && JSON.stringify(step.config) === JSON.stringify(ps.config);
    });
  }

  toggleStep(type: PipelineStepType): void {
    if (this.aiLocked(type)) {
      this.readiness.requireReady();
      return;
    }
    this.enabled.update(state => ({ ...state, [type]: !state[type] }));
    if (!this.enabled()[type]) {
      this.expandedSteps.update(state => ({ ...state, [type]: false }));
    }
    this.persistStickyState();
  }

  toggleExpanded(type: PipelineStepType): void {
    this.expandedSteps.update(state => ({ ...state, [type]: !state[type] }));
  }

  setOption(type: PipelineStepType, key: string, value: unknown): void {
    this.configs.update(state => ({
      ...state,
      [type]: { ...state[type], [key]: value },
    }));
    this.persistStickyState();
  }

  /**
   * Options are sticky: every toggle/option change persists the current
   * composition immediately (not just on submit). Persisted from the raw
   * enabled set: a step waiting on Crucible is remembered, not silently
   * dropped. No-op in per-job mode (persistSticky = false), so
   * editing one staged job never rewrites the shared last-used state.
   */
  private persistStickyState(): void {
    if (!this.persistSticky()) return;
    const enabled = this.enabled();
    const configs = this.configs();
    const raw = this.stepDefs
      .filter(def => enabled[def.type])
      .map(def => ({ type: def.type, config: { ...configs[def.type] } }));
    this.presetsService.rememberSteps(raw);
  }

  onSelectOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, (event.target as HTMLSelectElement).value);
  }

  onNumberOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, Number((event.target as HTMLSelectElement).value));
  }

  onCheckboxOption(type: PipelineStepType, key: string, event: Event): void {
    this.setOption(type, key, (event.target as HTMLInputElement).checked);
  }

  applyPreset(preset: PipelinePreset): void {
    const enabled = { ...this.blankEnabled() };
    const configs = { ...this.defaultConfigs() };
    for (const step of preset.steps) {
      enabled[step.type] = true;
      // Merge over defaults — presets saved before a step gained new option
      // fields would otherwise resurface those fields as undefined.
      configs[step.type] = { ...configs[step.type], ...step.config };
    }
    this.enabled.set(enabled);
    this.configs.set(configs);
    this.expandedSteps.set({});
    this.persistStickyState();
  }

  deletePreset(id: string): void {
    this.presetsService.deletePreset(id);
  }

  startSavePreset(): void {
    this.savingPreset.set(true);
    this.presetName.set('');
  }

  confirmSavePreset(): void {
    const name = this.presetName().trim();
    if (!name || this.steps().length === 0) return;
    this.presetsService.savePreset(name, this.steps());
    this.savingPreset.set(false);
  }

  cancelSavePreset(): void {
    this.savingPreset.set(false);
  }

  onPresetNameInput(event: Event): void {
    this.presetName.set((event.target as HTMLInputElement).value);
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const steps = sortPipelineSteps(this.steps());
    if (steps.length === 0) return;
    if (this.persistSticky()) {
      this.presetsService.rememberSteps(steps);
    }
    this.submitSteps.emit(steps);
  }

  // ── Initial state: restore the last-used combination ──────────────────────

  private blankEnabled(): Record<PipelineStepType, boolean> {
    return {
      'fix-aspect-ratio': false,
      'normalize-audio': false,
      transcribe: false,
      'ai-analyze': false,
    };
  }

  private defaultConfigs(): Record<PipelineStepType, Record<string, unknown>> {
    const configs = {} as Record<PipelineStepType, Record<string, unknown>>;
    for (const def of this.stepDefs) {
      configs[def.type] = { ...def.defaultConfig };
    }
    return configs;
  }

  private restoreEnabled(): Record<PipelineStepType, boolean> {
    const enabled = this.blankEnabled();
    const last = this.presetsService.lastSteps();
    if (last.length === 0) {
      // Sensible first-run default: the user's daily double.
      enabled.transcribe = true;
      enabled['ai-analyze'] = true;
      return enabled;
    }
    for (const step of last) {
      enabled[step.type] = true;
    }
    return enabled;
  }

  private restoreConfigs(): Record<PipelineStepType, Record<string, unknown>> {
    const configs = this.defaultConfigs();
    for (const step of this.presetsService.lastSteps()) {
      configs[step.type] = { ...configs[step.type], ...step.config };
    }
    return configs;
  }
}
