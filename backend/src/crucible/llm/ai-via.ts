/**
 * WHICH ROAD AN LLM CALL TAKES: through Crucible, or Briefcase's own direct
 * providers (the pre-Crucible code, kept untouched until P7).
 *
 *   env BRIEFCASE_AI_VIA=crucible|direct       wins over everything
 *   app-config.json  "aiVia": "crucible"|"direct"
 *   otherwise        'crucible' when a Crucible server is registered, else 'direct'
 *
 * "Registered" and not "reachable": once the user has connected a Crucible,
 * an unreachable one must say so on the task, never quietly fall back to a
 * different provider (migration plan §0 #13).
 *
 * Synchronous, and cheap: two small JSON reads. It is asked on every call so a
 * setting changed in the pane applies to the next call without a restart.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';
import { REGISTRY_FILE } from '../registry';

export type AiVia = 'crucible' | 'direct';

export const AI_VIA_ENV = 'BRIEFCASE_AI_VIA';
export const AI_VIA_CONFIG_KEY = 'aiVia';

export interface AiViaSetting {
  via: AiVia;
  source: 'env' | 'setting' | 'default';
  /** The stored choice, when there is one (the env may override it). */
  stored: AiVia | null;
  /** How many Crucible servers are registered; what the default was decided on. */
  registeredServers: number;
  /** A value that was present and not understood, reported rather than guessed at. */
  ignored?: string;
}

export interface AiViaDeps {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
}

export function parseAiVia(raw: unknown): AiVia | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value === 'crucible' || value === 'direct' ? value : null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function registeredCount(configDir: string): number {
  const doc = readJson(path.join(configDir, REGISTRY_FILE));
  const servers = doc?.['servers'];
  return Array.isArray(servers) ? servers.length : 0;
}

export function resolveAiVia(deps: AiViaDeps = {}): AiViaSetting {
  const env = deps.env ?? process.env;
  const configDir = deps.configDir ?? getBriefcaseConfigDir();
  const registeredServers = registeredCount(configDir);
  const config = readJson(path.join(configDir, 'app-config.json'));
  const storedRaw = config?.[AI_VIA_CONFIG_KEY];
  const stored = parseAiVia(storedRaw);
  let ignored: string | undefined;
  if (storedRaw !== undefined && stored === null) ignored = `app-config ${AI_VIA_CONFIG_KEY}=${JSON.stringify(storedRaw)}`;

  const fromEnv = env[AI_VIA_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const parsed = parseAiVia(fromEnv);
    if (parsed !== null) return { via: parsed, source: 'env', stored, registeredServers, ...(ignored ? { ignored } : {}) };
    ignored = `${AI_VIA_ENV}=${fromEnv}`;
  }
  if (stored !== null) return { via: stored, source: 'setting', stored, registeredServers, ...(ignored ? { ignored } : {}) };
  return {
    via: registeredServers > 0 ? 'crucible' : 'direct',
    source: 'default',
    stored: null,
    registeredServers,
    ...(ignored ? { ignored } : {}),
  };
}

/** True when LLM calls go through Crucible right now. */
export function aiViaCrucible(deps: AiViaDeps = {}): boolean {
  return resolveAiVia(deps).via === 'crucible';
}

/** Store the choice (null clears it back to the default). Temp-then-rename; other keys are kept. */
export function writeAiVia(value: AiVia | null, deps: AiViaDeps = {}): AiViaSetting {
  const configDir = deps.configDir ?? getBriefcaseConfigDir();
  const file = path.join(configDir, 'app-config.json');
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  }
  if (value === null) delete config[AI_VIA_CONFIG_KEY];
  else config[AI_VIA_CONFIG_KEY] = value;
  config['lastUpdated'] = new Date().toISOString();
  fs.mkdirSync(configDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return resolveAiVia({ ...deps, configDir });
}
