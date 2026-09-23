/**
 * Scorer configuration: which model, which llama-server binary, which launch
 * flags. Pure functions (filesystem and environment injected) so they are unit
 * tested without spawning anything.
 *
 * app-config.json keys (all optional, edited by hand like taskModels):
 *   scorerModel        GGUF filename in <configDir>/models, or an absolute path.
 *                      Default: Qwen3.5-9B-BF16.gguf. Deliberately NOT
 *                      defaultLocalModel — that one is the chat model.
 *   scorerMmproj       Vision projector (filename in the models dir, or absolute).
 *                      Absent = no image input (engine_no_vision on images).
 *   scorerLlamaServer  Absolute path to a llama-server binary (dev override).
 *   scorerContextSize  -c for the scorer server. Default 65536.
 *   scorerIdleMinutes  Idle shutdown. Default 5.
 * Environment:
 *   BRIEFCASE_SCORER_LLAMA_SERVER  Absolute path to llama-server; beats app-config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir, getLlamaLibraryPath, getRuntimePaths } from '../bridges/runtime-paths';
import { DEFAULT_SCORER_MODEL_FILE } from '../config/model-catalog';

export const SCORER_BINARY_ENV = 'BRIEFCASE_SCORER_LLAMA_SERVER';
export const DEFAULT_SCORER_CONTEXT = 65536;
export const DEFAULT_SCORER_IDLE_MINUTES = 5;
/** First llama.cpp build that loads Qwen3.5's hybrid (DeltaNet) architecture. */
export const MIN_SCORER_LLAMA_BUILD = 10964;

/**
 * Homebrew's llama.cpp (build 10964 on the dev Mac).
 *
 * TODO(binaries-v1): the bundled/downloaded llama-server is pinned to b7482
 * (scripts/download-llama-cpp.js and the binaries-v1 manifest's `llama`
 * component), which cannot load Qwen3.5. The manifest needs a llama bump to
 * >= b10964 before the scorer works on a machine without Homebrew llama.cpp or
 * the env/app-config override. The chat path (LlamaBridge, port 8081) must be
 * re-tested against the new build when that happens.
 */
export const HOMEBREW_LLAMA_SERVER_PATHS = ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'];

export interface ScorerConfig {
  configDir: string;
  modelsDir: string;
  /** Absolute path of the scorer GGUF. */
  modelPath: string;
  /** Absolute path of the vision projector, when configured. */
  mmprojPath?: string;
  contextSize: number;
  idleTimeoutMs: number;
  /** app-config scorerLlamaServer, when set. */
  llamaServerOverride?: string;
}

export interface ScorerConfigDeps {
  configDir?: string;
  readFile?: (p: string) => string | null;
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Read the scorer keys from app-config.json. Unreadable config falls back to the defaults. */
export function loadScorerConfig(deps: ScorerConfigDeps = {}): ScorerConfig {
  const configDir = deps.configDir ?? getBriefcaseConfigDir();
  // Same flat dir as ComponentManagerService.llamaModelsDir / LlamaManager / runtime-paths llamaModelsDir.
  const modelsDir = path.join(configDir, 'models');
  const read = deps.readFile ?? defaultReadFile;

  let cfg: Record<string, unknown> = {};
  const raw = read(path.join(configDir, 'app-config.json'));
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') cfg = parsed;
    } catch {
      // ignore: defaults below
    }
  }

  const inModels = (p: string) => (path.isAbsolute(p) ? p : path.join(modelsDir, p));
  const model = nonEmpty(cfg.scorerModel) ?? DEFAULT_SCORER_MODEL_FILE;
  const mmproj = nonEmpty(cfg.scorerMmproj);
  const idleMinutes = typeof cfg.scorerIdleMinutes === 'number' && cfg.scorerIdleMinutes > 0
    ? cfg.scorerIdleMinutes
    : DEFAULT_SCORER_IDLE_MINUTES;

  return {
    configDir,
    modelsDir,
    modelPath: inModels(model),
    mmprojPath: mmproj ? inModels(mmproj) : undefined,
    contextSize: positiveInt(cfg.scorerContextSize) ?? DEFAULT_SCORER_CONTEXT,
    idleTimeoutMs: Math.round(idleMinutes * 60_000),
    llamaServerOverride: nonEmpty(cfg.scorerLlamaServer),
  };
}

export type ScorerBinarySource = 'env' | 'config' | 'homebrew' | 'bundled';

export interface ScorerBinary {
  path: string;
  source: ScorerBinarySource;
  /** DYLD_LIBRARY_PATH to set (bundled/downloaded builds only; never for Homebrew/overrides). */
  libraryPath?: string;
}

export interface ScorerBinaryDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  /** The app's own llama-server (bundled or downloaded component). */
  bundled?: () => { path: string; libraryPath?: string };
}

/**
 * Which llama-server runs the scorer, in order:
 *   1. BRIEFCASE_SCORER_LLAMA_SERVER (must exist, else an error — an explicit override never silently falls through)
 *   2. app-config scorerLlamaServer (same rule)
 *   3. Homebrew llama.cpp (macOS)
 *   4. the app's own llama-server — currently b7482, too old for Qwen3.5 (see TODO above)
 */
export function resolveScorerBinary(configOverride: string | undefined, deps: ScorerBinaryDeps = {}): ScorerBinary {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const platform = deps.platform ?? process.platform;

  const fromEnv = nonEmpty(env[SCORER_BINARY_ENV]);
  if (fromEnv) {
    if (!exists(fromEnv)) throw new Error(`${SCORER_BINARY_ENV} points at a missing file: ${fromEnv}`);
    return { path: fromEnv, source: 'env' };
  }
  if (configOverride) {
    if (!exists(configOverride)) {
      throw new Error(`app-config scorerLlamaServer points at a missing file: ${configOverride}`);
    }
    return { path: configOverride, source: 'config' };
  }
  if (platform === 'darwin') {
    const brew = HOMEBREW_LLAMA_SERVER_PATHS.find((p) => exists(p));
    if (brew) return { path: brew, source: 'homebrew' };
  }
  const bundled = (deps.bundled ?? (() => ({ path: getRuntimePaths().llama, libraryPath: getLlamaLibraryPath() })))();
  if (exists(bundled.path)) {
    return { path: bundled.path, source: 'bundled', libraryPath: bundled.libraryPath };
  }
  throw new Error(
    `No llama-server for the scorer: set ${SCORER_BINARY_ENV} or app-config scorerLlamaServer, ` +
      `or install llama.cpp (brew install llama.cpp). Needs build >= b${MIN_SCORER_LLAMA_BUILD}.`,
  );
}

export interface ScorerLaunch {
  modelPath: string;
  port: number;
  contextSize: number;
  mmprojPath?: string;
}

/**
 * snap's serve command line (-ngl 99 -c <ctx> -fa on --host 127.0.0.1 --port
 * <port> --parallel 1 --ctx-checkpoints 32 [--mmproj] --no-webui), plus:
 *   --alias scorer  a stable model name in responses, and
 *   --jinja         the scorer renders prompts with POST /apply-template and
 *                   passes chat_template_kwargs.enable_thinking=false, which
 *                   only the Jinja template path honours (default-on in recent
 *                   builds; explicit so an older default cannot silently
 *                   ignore it — the prompt builder would then refuse by name).
 * --ctx-checkpoints 32: Qwen3.5 is hybrid, so a shared prefix is reused only
 * from a context checkpoint; with 0, every question after the first re-reads
 * the whole state (snap README, "Sharing a state").
 */
export function buildScorerArgs(launch: ScorerLaunch): string[] {
  const args = [
    '-m', launch.modelPath,
    '--alias', 'scorer',
    '-ngl', '99',
    '-c', String(launch.contextSize),
    '-fa', 'on',
    '--host', '127.0.0.1',
    '--port', String(launch.port),
    '--parallel', '1',
    '--ctx-checkpoints', '32',
    '--jinja',
    '--no-webui',
  ];
  if (launch.mmprojPath) args.push('--mmproj', launch.mmprojPath);
  return args;
}

/** The build number in /props build_info ("b10964-abc123", "10964 (abc123)"), or null. */
export function parseLlamaBuild(buildInfo: string | undefined): number | null {
  if (!buildInfo) return null;
  const m = /b?(\d{4,})/.exec(buildInfo);
  return m ? Number(m[1]) : null;
}
