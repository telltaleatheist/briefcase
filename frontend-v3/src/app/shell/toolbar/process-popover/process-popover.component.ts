import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import {
  PIPELINE_STEPS,
  PipelinePreset,
  PipelinePresetsService,
  PipelineStep,
  PipelineStepType,
  sortPipelineSteps,
} from '../../../core/stores/pipeline-presets.service';

/**
 * The Process popover: compose a pipeline of job steps (in run order) for the
 * selected videos, save combinations as named presets, queue with one click.
 *
 * Anchored to the toolbar's Process button; also opened from the inspector.
 * State restores from the last-used combination via PipelinePresetsService.
 */
@Component({
  selector: 'app-process-popover',
  standalone: true,
  templateUrl: './process-popover.component.html',
  styleUrls: ['./process-popover.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProcessPopoverComponent {
  private presetsService = inject(PipelinePresetsService);

  selectionCount = input(0);
  /** Selected videos lacking a transcript / analysis (from InspectorStore). */
  withoutTranscript = input(0);
  notAnalyzed = input(0);
  aiReady = input(false);
  /** AI readiness unknown — the availability probe failed (retry, don't lie). */
  aiCheckFailed = input(false);

  submitSteps = output<PipelineStep[]>();
  setupAi = output<void>();
  retryAi = output<void>();
  dismissed = output<void>();

  readonly stepDefs = PIPELINE_STEPS;
  presets = this.presetsService.presets;

  /** Enabled state per step type. */
  private enabled = signal<Record<PipelineStepType, boolean>>(this.restoreEnabled());
  /** Per-step config (createQueueTask options). */
  private configs = signal<Record<PipelineStepType, Record<string, unknown>>>(this.restoreConfigs());

  /** Per-step options accordion — each enabled step expands independently. */
  private expandedSteps = signal<Partial<Record<PipelineStepType, boolean>>>({});

  isExpanded(type: PipelineStepType): boolean {
    return this.expandedSteps()[type] === true;
  }

  /** Inline save-as-preset mode. */
  savingPreset = signal(false);
  presetName = signal('');

  isEnabled(type: PipelineStepType): boolean {
    return this.enabled()[type] && (type !== 'ai-analyze' || this.aiReady());
  }

  config(type: PipelineStepType): Record<string, unknown> {
    return this.configs()[type];
  }

  /** The composed pipeline, in canonical run order. */
  steps = computed<PipelineStep[]>(() => {
    const enabled = this.enabled();
    const configs = this.configs();
    return this.stepDefs
      .filter(def => enabled[def.type] && (def.type !== 'ai-analyze' || this.aiReady()))
      .map(def => ({ type: def.type, config: { ...configs[def.type] } }));
  });

  /** 1-based run-order number for an enabled step (0 = disabled). */
  orderOf(type: PipelineStepType): number {
    return this.steps().findIndex(s => s.type === type) + 1;
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

  summary = computed(() => {
    const stepCount = this.steps().length;
    const videos = this.selectionCount();
    if (stepCount === 0) return 'Pick at least one step';
    const stepsText = `${stepCount} step${stepCount === 1 ? '' : 's'}`;
    const videosText = `${videos} video${videos === 1 ? '' : 's'}`;
    return `${stepsText} → ${videosText}`;
  });

  canSubmit = computed(() => this.steps().length > 0 && this.selectionCount() > 0);

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
    this.enabled.update(state => ({ ...state, [type]: !state[type] }));
    if (!this.enabled()[type]) {
      this.expandedSteps.update(state => ({ ...state, [type]: false }));
    }
    this.persistSticky();
  }

  toggleExpanded(type: PipelineStepType): void {
    this.expandedSteps.update(state => ({ ...state, [type]: !state[type] }));
  }

  setOption(type: PipelineStepType, key: string, value: unknown): void {
    this.configs.update(state => ({
      ...state,
      [type]: { ...state[type], [key]: value },
    }));
    this.persistSticky();
  }

  /**
   * Options are sticky: every toggle/option change persists the current
   * composition immediately (not just on submit). Persisted from the raw
   * enabled set — a temporarily AI-unready analyze step is remembered, not
   * silently dropped.
   */
  private persistSticky(): void {
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
      configs[step.type] = { ...step.config };
    }
    this.enabled.set(enabled);
    this.configs.set(configs);
    this.expandedSteps.set({});
    this.persistSticky();
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
    const steps = sortPipelineSteps(this.steps());
    if (steps.length === 0) return;
    this.presetsService.rememberSteps(steps);
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
