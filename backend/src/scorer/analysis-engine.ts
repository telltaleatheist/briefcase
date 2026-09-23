/**
 * Which engine runs AI analysis's chapter and flag stages (plan §8.1).
 *
 *   classic  today's pipeline: embedding chapter boundaries + LLM placement,
 *            NLI flag ranking (then chapter discovery). THE DEFAULT until the
 *            live evaluation (plan §6) passes.
 *   snap     the scorer (snap logit decisions on its own llama-server): outline
 *            + assign + Viterbi chapters, and the snap flag ranker feeding the
 *            same LLM verifier.
 *
 * app-config.json (edited by hand, like taskModels; also POST /config/analysis-engine):
 *   "analysisEngine": "classic" | "snap"
 *   "analysisEngine": { "chapters": "snap" | "classic", "flags": "snap" | "nli" | "classic" }
 * Environment (dev), beats app-config:
 *   BRIEFCASE_ANALYSIS_ENGINE=snap | classic
 *
 * 'snap' is a PREFERENCE, never a requirement: when the scorer is unavailable
 * (no scorer model, no suitable llama-server) or fails mid-run, each stage
 * falls back to its classic path and the job carries a warning (the same
 * channel the NLI-missing fallback uses). Pure, with the environment and file
 * reads injectable, so it is unit tested without touching the real config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../bridges/runtime-paths';

export type AnalysisEngineName = 'classic' | 'snap';
export type AnalysisStageEngine = 'classic' | 'snap';

export const ANALYSIS_ENGINE_ENV = 'BRIEFCASE_ANALYSIS_ENGINE';
export const ANALYSIS_ENGINE_CONFIG_KEY = 'analysisEngine';
export const DEFAULT_ANALYSIS_ENGINE: AnalysisEngineName = 'classic';

export interface AnalysisEngineSetting {
  chapters: AnalysisStageEngine;
  /** 'classic' = NLI ranking, then chapter discovery. */
  flags: AnalysisStageEngine;
  source: 'env' | 'config' | 'default';
  /** A value that was present but not understood (logged; the default applies). */
  ignored?: string;
}

export interface AnalysisEngineDeps {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  readFile?: (p: string) => string | null;
}

function stage(v: unknown): AnalysisStageEngine | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'snap') return 'snap';
  if (s === 'classic' || s === 'nli' || s === 'embedding') return 'classic';
  return null;
}

/** 'snap' | 'classic' | { chapters, flags } -> per-stage engines, or null when not understood. */
export function parseAnalysisEngine(raw: unknown): { chapters: AnalysisStageEngine; flags: AnalysisStageEngine } | null {
  const whole = stage(raw);
  if (whole) return { chapters: whole, flags: whole };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const chapters = o.chapters === undefined ? DEFAULT_ANALYSIS_ENGINE : stage(o.chapters);
    const flags = o.flags === undefined ? DEFAULT_ANALYSIS_ENGINE : stage(o.flags);
    if (chapters && flags) return { chapters, flags };
  }
  return null;
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

export function appConfigFile(configDir: string = getBriefcaseConfigDir()): string {
  return path.join(configDir, 'app-config.json');
}

/** The configured engine: env, then app-config, then the default ('classic'). Never throws. */
export function resolveAnalysisEngine(deps: AnalysisEngineDeps = {}): AnalysisEngineSetting {
  const env = deps.env ?? process.env;
  const fromEnv = env[ANALYSIS_ENGINE_ENV];
  let ignored: string | undefined;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const parsed = parseAnalysisEngine(fromEnv);
    if (parsed) return { ...parsed, source: 'env' };
    ignored = `${ANALYSIS_ENGINE_ENV}=${fromEnv}`;
  }

  const read = deps.readFile ?? defaultReadFile;
  const raw = read(appConfigFile(deps.configDir));
  if (raw) {
    try {
      const value = JSON.parse(raw)?.[ANALYSIS_ENGINE_CONFIG_KEY];
      if (value !== undefined) {
        const parsed = parseAnalysisEngine(value);
        if (parsed) return { ...parsed, source: 'config', ...(ignored ? { ignored } : {}) };
        ignored = ignored ?? `app-config ${ANALYSIS_ENGINE_CONFIG_KEY}=${JSON.stringify(value)}`;
      }
    } catch {
      // unreadable config: the default below
    }
  }
  return {
    chapters: DEFAULT_ANALYSIS_ENGINE,
    flags: DEFAULT_ANALYSIS_ENGINE,
    source: 'default',
    ...(ignored ? { ignored } : {}),
  };
}

/** One word for logs and the config endpoint. */
export function engineLabel(s: Pick<AnalysisEngineSetting, 'chapters' | 'flags'>): 'classic' | 'snap' | 'mixed' {
  if (s.chapters === s.flags) return s.chapters;
  return 'mixed';
}

export function wantsScorer(s: Pick<AnalysisEngineSetting, 'chapters' | 'flags'>): boolean {
  return s.chapters === 'snap' || s.flags === 'snap';
}

/** The job warning when 'snap' was selected but a stage ran on its classic path. */
export function snapFallbackMessage(stages: Array<'chapters' | 'flags'>, reason: string): string {
  const short = reason.length > 160 ? `${reason.slice(0, 157)}...` : reason;
  const what = stages.length === 2 ? 'Chapters and flags were' : stages[0] === 'chapters' ? 'Chapters were' : 'Flags were';
  return (
    `${what} made with the classic analysis engine: the snap engine is selected but could not run ` +
    `(${short}). Check the scorer model and llama-server in Settings -> Components, then re-run the analysis.`
  );
}
