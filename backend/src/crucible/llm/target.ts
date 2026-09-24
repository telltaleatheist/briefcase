/**
 * WHAT A BRIEFCASE MODEL CHOICE MEANS TO CRUCIBLE, and what may be sent with it.
 *
 * Briefcase stores a model as `provider:model` (task configs, the default AI,
 * every picker). That format is kept as it is; this is where it is read into a
 * Crucible model string at call time:
 *
 *   claude:<id>           → anthropic/<id>     upstream
 *   openai:<id>           → openai/<id>        upstream
 *   ollama:<id>           → ollama/<id>        upstream
 *   local:<id>            → <id>               a model in the server's own catalog
 *   crucible:<id>         → <id>               (the same, spelled for Crucible)
 *   anthropic/… openai/… ollama/…             already Crucible's, taken as they are
 *
 * THE PARAMETER RULES (migration plan §6.1), in one place so a spec can pin them:
 *
 *   - anthropic/ and openai/ get NO temperature, NO top_p and NO max_tokens,
 *     ever. Newer Claude and OpenAI models refuse sampling parameters with a
 *     400, and o-series/gpt-5 refuse max_tokens. Crucible passes these through
 *     to Anthropic exactly as sent, so the only safe body is one without them.
 *   - ollama/ keeps its pinned per-task temperature.
 *   - a local model gets its per-task temperature, and max_tokens only when the
 *     caller asked for one (the manifest's default applies otherwise).
 *   - `thinking` is sent only when a caller states it for a LOCAL model (the
 *     scorer's outline states `false`, as its own llama-server path did).
 *     Otherwise local models run their manifest's `thinking=false`, and
 *     Crucible drops `chat_template_kwargs` for every upstream anyway
 *     (reporting it as `dropped` in X-Crucible-Sampling).
 *   - Ollama's `num_ctx` is `context_tokens` (Crucible 1.0.24+, PHASE15-HOST
 *     §3.4a: it reaches Ollama as options.num_ctx). Sent for `ollama/` only,
 *     and only when the caller knows the server takes it (the chat service
 *     checks the version): an older server forwarded no num_ctx and every
 *     Ollama tag ran at 4096.
 *   - response_format: 'json' → json_object and a JSON Schema → json_schema,
 *     for local models and ollama/. Cloud gets none: Anthropic would turn json_object into nothing and a schema
 *     into a forced tool, and OpenAI refuses json_object on a prompt without the
 *     word "json" and json_schema on schemas that are not closed. Turning either
 *     on is a follow-up that needs testing per schema, not a side effect.
 */

export type UpstreamName = 'anthropic' | 'openai' | 'ollama';

export interface CrucibleTarget {
  /** The string sent as `model` on the chat door. */
  model: string;
  /** `local` is a model this server loads and leases; `upstream` is forwarded. */
  route: 'local' | 'upstream';
  upstream: UpstreamName | null;
  /** The id without any prefix, for pricing and display. */
  bareModel: string;
}

const PROVIDER_TO_UPSTREAM: Record<string, UpstreamName> = {
  claude: 'anthropic',
  anthropic: 'anthropic',
  openai: 'openai',
  ollama: 'ollama',
};

const UPSTREAM_PREFIX = /^(anthropic|openai|ollama)\/(.+)$/;

export class CrucibleTargetError extends Error {
  readonly code = 'invalid_model';
  constructor(message: string) {
    super(message);
    this.name = 'CrucibleTargetError';
  }
}

/**
 * Read a Briefcase `(provider, model)` pair, or a bare Crucible model string,
 * into a Crucible target. `model` may carry its own `provider:` prefix.
 */
export function crucibleTargetOf(provider: string | undefined, model: string): CrucibleTarget {
  let bare = (model ?? '').trim();
  let prov = (provider ?? '').trim().toLowerCase();

  // A Crucible-spelled upstream id wins over any provider label.
  const already = UPSTREAM_PREFIX.exec(bare);
  if (already) {
    const upstream = already[1] as UpstreamName;
    return { model: bare, route: 'upstream', upstream, bareModel: already[2] };
  }

  // A provider prefix inside the model string ("ollama:qwen3.5:9b").
  const colon = bare.indexOf(':');
  if (colon > 0) {
    const head = bare.slice(0, colon).toLowerCase();
    if (head in PROVIDER_TO_UPSTREAM || head === 'local' || head === 'crucible') {
      if (!prov || prov === head || (prov === 'claude' && head === 'anthropic')) {
        prov = head;
        bare = bare.slice(colon + 1);
      }
    }
  }
  if (!bare) throw new CrucibleTargetError('No model was chosen for this AI task. Pick one in Settings › AI.');

  const upstream = PROVIDER_TO_UPSTREAM[prov];
  if (upstream !== undefined) return { model: `${upstream}/${bare}`, route: 'upstream', upstream, bareModel: bare };
  if (prov === 'local' || prov === 'crucible' || prov === '') return { model: bare, route: 'local', upstream: null, bareModel: bare };
  throw new CrucibleTargetError(`"${provider}" is not an AI provider Briefcase knows (claude, openai, ollama, or a Crucible model).`);
}

/** Cloud upstreams: the ones that are never sent a sampling parameter. */
export function isCloudTarget(target: CrucibleTarget): boolean {
  return target.upstream === 'anthropic' || target.upstream === 'openai';
}

/** What a caller may ask for; `buildChatBody` decides what actually crosses. */
export interface ChatBodyInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** Briefcase's structured-output request: 'json', or a JSON Schema object. */
  format?: 'json' | Record<string, unknown>;
  /** A name for a schema's `json_schema.name`. */
  schemaName?: string;
  /** Local models only: `chat_template_kwargs.enable_thinking`. Absent: nothing is sent. */
  thinking?: boolean;
  /** `ollama/` only: the window, sent as `context_tokens` (Ollama's num_ctx). */
  contextTokens?: number;
}

export type ResponseFormatBody =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown> } };

export function responseFormatFor(target: CrucibleTarget, format: ChatBodyInput['format'], schemaName = 'answer'): ResponseFormatBody | null {
  if (format === undefined || isCloudTarget(target)) return null;
  if (format === 'json') return { type: 'json_object' };
  if (format !== null && typeof format === 'object') return { type: 'json_schema', json_schema: { name: schemaName, schema: format } };
  return null;
}

/** The OpenAI chat body for this target, following the rules in the header. */
export function buildChatBody(target: CrucibleTarget, input: ChatBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: target.model,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  };
  if (!isCloudTarget(target)) {
    if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) body['temperature'] = input.temperature;
    if (target.route === 'local' && typeof input.maxTokens === 'number' && input.maxTokens > 0) body['max_tokens'] = Math.floor(input.maxTokens);
  }
  if (target.route === 'local' && typeof input.thinking === 'boolean') {
    body['chat_template_kwargs'] = { enable_thinking: input.thinking };
  }
  if (target.upstream === 'ollama' && typeof input.contextTokens === 'number' && Number.isInteger(input.contextTokens) && input.contextTokens > 0) {
    body['context_tokens'] = input.contextTokens;
  }
  const format = responseFormatFor(target, input.format, input.schemaName);
  if (format !== null) body['response_format'] = format;
  return body;
}

/** Keys that must never appear in a cloud body. The spec asserts on exactly this list. */
export const CLOUD_FORBIDDEN_KEYS = ['temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'seed', 'chat_template_kwargs'] as const;
