/**
 * WHERE TRANSCRIPTION RUNS: the `transcription` key of app-config.json.
 *
 *   { "transcription": { "server": "<registry name>" | null,
 *                        "model": "<crucible asr id>" | null } }
 *
 * Transcription is Crucible's asr job and nothing else (P7 removed the
 * offline whisper-cli transcriber and its `venue` choice). A `venue` a file
 * written before P7 still carries is not read; one naming whisper-cli is
 * reported in `ignored`, so the pane can say the offline transcriber is gone.
 *
 * `server` null means the best-ranked running server that offers asr; `model`
 * null means the most accurate asr model installed on the server that takes
 * the job. A named model that server doesn't have is replaced by that rule
 * too, because a model id is per-engine (mlx-whisper on the Mac,
 * faster-whisper on the PC).
 *
 * Read leniently: a value that is present and not understood is
 * reported in `ignored` and the default applies, so a hand-edited file never
 * stops transcription. Written temp-then-rename, keeping every other key.
 */
import * as fs from 'fs';
import * as path from 'path';

export const TRANSCRIPTION_CONFIG_KEY = 'transcription';

export interface TranscriptionSetting {
  server: string | null;
  model: string | null;
}

export interface TranscriptionSettingRead {
  setting: TranscriptionSetting;
  /** False when no `transcription` key was ever written. */
  explicit: boolean;
  ignored?: string;
}

export const DEFAULT_TRANSCRIPTION_SETTING: TranscriptionSetting = { server: null, model: null };

export class TranscriptionSettingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TranscriptionSettingError';
  }
}

function optName(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readConfig(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function configFileIn(configDir: string): string {
  return path.join(configDir, 'app-config.json');
}

export function readTranscriptionSetting(configDir: string): TranscriptionSettingRead {
  const config = readConfig(configFileIn(configDir));
  const raw = config?.[TRANSCRIPTION_CONFIG_KEY];
  if (raw === undefined) return { setting: { ...DEFAULT_TRANSCRIPTION_SETTING }, explicit: false };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { setting: { ...DEFAULT_TRANSCRIPTION_SETTING }, explicit: false, ignored: `transcription=${JSON.stringify(raw)}` };
  }
  const obj = raw as Record<string, unknown>;
  const server = optName(obj['server']);
  const model = optName(obj['model']);
  const bad: string[] = [];
  if (obj['venue'] === 'whisper-cli') bad.push('venue="whisper-cli" (the offline transcriber was removed; Crucible transcribes)');
  if (server === undefined) bad.push(`server=${JSON.stringify(obj['server'])}`);
  if (model === undefined) bad.push(`model=${JSON.stringify(obj['model'])}`);
  return {
    setting: { server: server ?? null, model: model ?? null },
    explicit: true,
    ...(bad.length > 0 ? { ignored: `transcription ${bad.join(', ')}` } : {}),
  };
}

/** Validate an incoming setting (from the pane) strictly: the pane is ours, so a bad value is a bug to name. */
export function parseTranscriptionSettingInput(raw: unknown): TranscriptionSetting {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TranscriptionSettingError('invalid_setting', 'The transcription setting is {server, model}.');
  }
  const obj = raw as Record<string, unknown>;
  const server = optName(obj['server']);
  if (server === undefined) throw new TranscriptionSettingError('invalid_server', 'server is a registered server name, or null for the best-ranked one.');
  const model = optName(obj['model']);
  if (model === undefined) throw new TranscriptionSettingError('invalid_model', 'model is a Crucible asr model id, or null for the most accurate one.');
  return { server, model };
}

export function writeTranscriptionSetting(configDir: string, setting: TranscriptionSetting): TranscriptionSettingRead {
  const file = configFileIn(configDir);
  let config: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch (err) {
      throw new TranscriptionSettingError('app_config_unreadable',
        `${file} is not valid JSON (${(err as Error).message}); it was not overwritten. Repair it first.`);
    }
  }
  config[TRANSCRIPTION_CONFIG_KEY] = { server: setting.server, model: setting.model };
  config['lastUpdated'] = new Date().toISOString();
  fs.mkdirSync(configDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return readTranscriptionSetting(configDir);
}
