import { Injectable, signal } from '@angular/core';
import { TaskType } from '../../models/task.model';

/**
 * Job steps the Process pipeline can queue for library videos.
 * Subset of TaskType: every entry here is verified end-to-end in the backend
 * queue-manager (fix-aspect-ratio / normalize-audio / transcribe / analyze).
 * Run order is fixed by QueueService.convertTasksToBackendFormat:
 * video processing first (aspect + audio combine into one process-video
 * pass), then transcribe, then AI analysis.
 */
export type PipelineStepType = Extract<
  TaskType,
  'fix-aspect-ratio' | 'normalize-audio' | 'transcribe' | 'ai-analyze'
>;

/** One enabled step with its task config (createQueueTask options shape). */
export interface PipelineStep {
  type: PipelineStepType;
  config: Record<string, unknown>;
}

/** A named, reusable step combination. */
export interface PipelinePreset {
  id: string;
  name: string;
  steps: PipelineStep[];
}

/** Display/default metadata per step, in pipeline run order. */
export const PIPELINE_STEPS: {
  type: PipelineStepType;
  label: string;
  icon: string;
  description: string;
  defaultConfig: Record<string, unknown>;
}[] = [
  {
    type: 'fix-aspect-ratio',
    label: 'Fix Aspect Ratio',
    icon: '📐',
    description: 'Crop or letterbox to a target ratio',
    defaultConfig: { targetRatio: '16:9', stripBlackBars: false },
  },
  {
    type: 'normalize-audio',
    label: 'Normalize Loudness',
    icon: '🔊',
    description: 'Even out audio levels',
    defaultConfig: { targetLevel: -16 },
  },
  {
    type: 'transcribe',
    label: 'Transcribe',
    icon: '≋',
    description: 'Whisper transcript — no AI setup needed',
    defaultConfig: { model: 'base', language: 'en' },
  },
  {
    type: 'ai-analyze',
    label: 'AI Analyze',
    icon: '✦',
    description: 'Sections & flags via your default AI model',
    defaultConfig: { analysisQuality: 'fast' },
  },
];

const STORAGE_KEY = 'briefcase-pipeline-presets';

interface StoredState {
  presets: PipelinePreset[];
  /** Last-used combination, restored when the popover opens. */
  lastSteps: PipelineStep[];
}

const STARTER_PRESETS: PipelinePreset[] = [
  {
    id: 'starter-transcribe-analyze',
    name: 'Transcribe + Analyze',
    steps: [
      { type: 'transcribe', config: { model: 'base', language: 'en' } },
      { type: 'ai-analyze', config: { analysisQuality: 'fast' } },
    ],
  },
  {
    id: 'starter-fix-normalize',
    name: 'Fix + Normalize',
    steps: [
      { type: 'fix-aspect-ratio', config: { targetRatio: '16:9', stripBlackBars: false } },
      { type: 'normalize-audio', config: { targetLevel: -16 } },
    ],
  },
];

const STEP_ORDER: PipelineStepType[] = PIPELINE_STEPS.map(s => s.type);

/** Sort steps into canonical pipeline run order. */
export function sortPipelineSteps(steps: PipelineStep[]): PipelineStep[] {
  return [...steps].sort((a, b) => STEP_ORDER.indexOf(a.type) - STEP_ORDER.indexOf(b.type));
}

/**
 * Named pipeline presets + last-used steps for the Process popover.
 * Follows the AddDefaultsService pattern: signal state, localStorage
 * persistence, resilient restore. Starter presets seed first run only.
 */
@Injectable({ providedIn: 'root' })
export class PipelinePresetsService {
  readonly presets = signal<PipelinePreset[]>([]);
  readonly lastSteps = signal<PipelineStep[]>([]);

  constructor() {
    const restored = this.restore();
    this.presets.set(restored.presets);
    this.lastSteps.set(restored.lastSteps);
  }

  savePreset(name: string, steps: PipelineStep[]): PipelinePreset {
    const preset: PipelinePreset = {
      id: crypto.randomUUID(),
      name: name.trim(),
      steps: sortPipelineSteps(steps),
    };
    this.presets.update(list => [...list, preset]);
    this.persist();
    return preset;
  }

  deletePreset(id: string): void {
    this.presets.update(list => list.filter(p => p.id !== id));
    this.persist();
  }

  rememberSteps(steps: PipelineStep[]): void {
    this.lastSteps.set(sortPipelineSteps(steps));
    this.persist();
  }

  private persist(): void {
    try {
      const state: StoredState = { presets: this.presets(), lastSteps: this.lastSteps() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('[PipelinePresets] Failed to persist', error);
    }
  }

  private restore(): StoredState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { presets: [...STARTER_PRESETS], lastSteps: [] };
      }
      const saved = JSON.parse(raw) as Partial<StoredState>;
      return {
        presets: Array.isArray(saved.presets) ? saved.presets.filter(isValidPreset) : [],
        lastSteps: Array.isArray(saved.lastSteps) ? saved.lastSteps.filter(isValidStep) : [],
      };
    } catch (error) {
      console.warn('[PipelinePresets] Failed to restore', error);
      return { presets: [...STARTER_PRESETS], lastSteps: [] };
    }
  }
}

function isValidStep(step: unknown): step is PipelineStep {
  return (
    !!step &&
    typeof step === 'object' &&
    STEP_ORDER.includes((step as PipelineStep).type) &&
    typeof (step as PipelineStep).config === 'object'
  );
}

function isValidPreset(preset: unknown): preset is PipelinePreset {
  const p = preset as PipelinePreset;
  return (
    !!p &&
    typeof p === 'object' &&
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    Array.isArray(p.steps) &&
    p.steps.every(isValidStep)
  );
}
