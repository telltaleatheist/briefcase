/**
 * What Settings › AI, the pickers and the setup wizard read about AI through
 * Crucible (P3). Owned by the backend, imported by the renderer as
 * `@crucible-wire/ai-wire`. No key ever crosses: upstreams carry `keyHint`.
 */
import type { ServerReach } from './settings-wire';

export type AiVia = 'crucible' | 'direct';

/** Which road LLM calls take, and why. */
export interface AiViaView {
  via: AiVia;
  source: 'env' | 'setting' | 'default';
  stored: AiVia | null;
  registeredServers: number;
  /** Set when BRIEFCASE_AI_VIA decides it; the pane shows the switch read-only then. */
  envOverride: string | null;
  ignored?: string;
}

/** One pickable model. `value` is Briefcase's stored `provider:model` format. */
export interface AiModelOption {
  value: string;
  label: string;
  provider: 'local' | 'claude' | 'openai' | 'ollama';
  /** Local models only: the weights are on the server. */
  installed?: boolean;
  /** Local models only: why it cannot load right now, in the server's words. */
  note?: string | null;
}

export interface AiUpstreamsView {
  anthropic: { configured: boolean; keyHint: string | null };
  openai: { configured: boolean; keyHint: string | null };
  ollama: { configured: boolean; url: string | null };
}

/** `GET /crucible/ai/models`: the connected server's catalog and upstreams, as picker options. */
export interface AiModelsView {
  via: AiViaView;
  /** The server these came from: the best-ranked running server that answers. */
  server: string | null;
  reach: ServerReach | null;
  /** Why there is no list, as a sentence with the fix. Null when `server` is set. */
  unavailable: string | null;
  upstreams: AiUpstreamsView | null;
  models: AiModelOption[];
  /** The server's own choice for the `analysis` class, as an option value. */
  analysisDefault: string | null;
  /** Per-upstream listing failures (a configured key the provider rejected, say). */
  upstreamErrors: Partial<Record<'anthropic' | 'openai' | 'ollama', string>>;
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
export type AiTaskName = 'boundary' | 'chapter' | 'flags' | 'description' | 'tags' | 'title';
export type AiTaskModels = Partial<Record<AiTaskName, string>>;
