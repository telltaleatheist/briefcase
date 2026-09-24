/**
 * What Settings › AI, the pickers and the setup wizard read about AI through
 * Crucible (P3). Owned by the backend, imported by the renderer as
 * `@crucible-wire/ai-wire`. No key ever crosses: upstreams carry `keyHint`.
 */
import type { ServerReach } from './settings-wire';

/** One pickable model. `value` is Briefcase's stored `provider:model` format. */
export interface AiModelOption {
  value: string;
  label: string;
  provider: 'local' | 'claude' | 'openai' | 'ollama';
  /** Local models only: the weights are on the server; null when the server did not say. */
  installed?: boolean | null;
  /** Local models only: why it cannot load right now, in the server's words. */
  note?: string | null;
}

/** The connected server's upstream cards; null for one it does not offer. */
export interface AiUpstreamsView {
  anthropic: { configured: boolean; keyHint: string | null } | null;
  openai: { configured: boolean; keyHint: string | null } | null;
  ollama: { configured: boolean; url: string | null } | null;
}

/** `GET /crucible/ai/models`: the connected server's catalog and upstreams, as picker options. */
export interface AiModelsView {
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

/**
 * `GET /crucible/ai/runs-as?models=a,b`: what a stored `ollama:<tag>` choice
 * actually runs as through Crucible (ollama-map.ts). Other values are not listed.
 */
export interface AiRunsAs {
  /** The stored `ollama:<tag>` value. */
  value: string;
  /** The server that answers for it: the one with a model of its own, else the connected one. */
  server: string | null;
  /** The server's own model it runs as, or null: it goes to Ollama through Crucible. */
  runsAs: string | null;
  /** The context it is served at: the model's, or Ollama's default when it goes to Ollama. */
  contextTokens: number | null;
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
