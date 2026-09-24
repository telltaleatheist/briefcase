/**
 * What Settings › AI, the pickers and the setup wizard read about AI through
 * Crucible (P3). Owned by the backend, imported by the renderer as
 * `@crucible-wire/ai-wire`. No key ever crosses: upstreams carry `keyHint`.
 */
import type { ServerReach } from './settings-wire';

/**
 * WHERE AN OPTION COMES FROM, in the order the server presents them: the
 * server's own models (`server`), then each upstream it forwards to.
 */
export type AiOptionGroupKind = 'server' | 'anthropic' | 'openai' | 'ollama';

/**
 * One pickable analysis model. `value` is Briefcase's stored spelling, the one
 * the queue and the analysis read (crucible/llm/target.ts):
 *   local:<id>     a model on the Crucible server itself
 *   claude:<id>    Claude, forwarded by the server
 *   openai:<id>    OpenAI, forwarded by the server
 *   ollama:<tag>   Ollama, forwarded by the server
 */
export interface AiModelOption {
  value: string;
  /** The id as the server names it. */
  label: string;
  group: AiOptionGroupKind;
  /** Parameter count in billions, as the server states it; null = the server did not say (shown as unknown). */
  sizeB: number | null;
  /** On the card right now (server models only; null for an upstream). */
  resident: boolean | null;
  /** The server's own pick for the `analysis` class. */
  serverChoice: boolean;
}

/** One `<optgroup>`: a heading, its options, and why it has none when a listing failed. */
export interface AiOptionGroup {
  kind: AiOptionGroupKind;
  /** "On this Crucible", "Claude via Crucible", … with the server's name when it is not this computer's. */
  label: string;
  options: AiModelOption[];
  /** The upstream's listing failed (a key the provider rejected, say): the server's sentence. */
  error: string | null;
}

/**
 * What a STORED choice (a saved default, a task model, a preset, a queued
 * job's model) is among today's options. Legacy spellings are read through
 * the same rules the analysis uses at call time (target.ts, ollama-map.ts),
 * so the picker shows what would actually run.
 */
export interface AiResolvedValue {
  /** The value as stored. */
  value: string;
  /** The option it is (the Crucible spelling), or null when the server offers nothing it maps to. */
  option: string | null;
  /** When `option` is not `value`: what the stored value was read as, for a line under the picker. */
  note: string | null;
  /** When `option` is null: why, as a sentence with the fix. Never silently another model. */
  unavailable: string | null;
}

/** The connected server's upstream cards; null for one it does not offer. */
export interface AiUpstreamsView {
  anthropic: { configured: boolean; keyHint: string | null } | null;
  openai: { configured: boolean; keyHint: string | null } | null;
  ollama: { configured: boolean; url: string | null } | null;
}

/**
 * `GET /crucible/ai/models[?values=a,b]`: THE one source of analysis-model
 * options, from the selected Crucible server. Every AI model picker in the renderer draws this.
 */
export interface AiModelsView {
  /** The server these came from; null when none answers (see `unavailable`). */
  server: string | null;
  /** The server is the Crucible on this computer. */
  local: boolean;
  reach: ServerReach | null;
  /** Why there is no list, as a sentence with the fix. Null when `server` is set. */
  unavailable: string | null;
  upstreams: AiUpstreamsView | null;
  groups: AiOptionGroup[];
  /** The server's own choice for the `analysis` class, as an option value. */
  analysisDefault: string | null;
  /** The `values` asked about, each resolved against these options. */
  resolved: AiResolvedValue[];
}

/** `GET /crucible/ai/keys/legacy`: what Briefcase's own api-keys.json still holds. */
export interface LegacyKeysView {
  claude: boolean;
  openai: boolean;
  /** The registered server on THIS computer, the only one keys are ever deleted after copying to. */
  localServer: string | null;
}

/** `POST /crucible/ai/keys/copy`. */
export interface KeyCopyOutcome {
  server: string;
  copied: Array<'anthropic' | 'openai'>;
  /** Already there with the same key: nothing to write. */
  alreadyThere: Array<'anthropic' | 'openai'>;
  /** Not written, each with the reason (a different key is already set there, say). */
  skipped: Array<{ upstream: 'anthropic' | 'openai'; reason: string }>;
  /** True when api-keys.json was deleted after the server confirmed every key. */
  deletedLocalFile: boolean;
  /** Why the file was kept, when it was. */
  keptBecause: string | null;
}

/** Per-task model routing (`taskModels` in app-config), `provider:model` values. */
export type AiTaskName = 'chapter' | 'flags' | 'description' | 'tags' | 'title';
export type AiTaskModels = Partial<Record<AiTaskName, string>>;
