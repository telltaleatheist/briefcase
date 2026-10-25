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
 *   local:max-<N>b        → a SIZE CEILING     the biggest model the serving Crucible
 *                                              fits, up to N billion parameters
 *                                              (Crucible 2.0.1+: verb `generate` +
 *                                              `max_params_b`); which model that is
 *                                              is the server's answer, read per run
 *                                              (CrucibleChatService.effectiveTarget)
 *   local:qwen3.8-27b-…   → local:max-27b      a STORED 27B quantisation (4bit, 8bit,
 *                                              -vl) means "the best 27B this host
 *                                              has" (the user, 2026-10-19). Read so
 *                                              by {@link storedChoice} where a stored
 *                                              choice enters (the analysis, the queue,
 *                                              the pickers); a model id a server
 *                                              names is always that one model
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
 *   - `tools` (OpenAI function definitions) and `tool_choice` cross for every
 *     route alike (Crucible 2.0.30+ writes each model's own format: a local
 *     model's trained one, anthropic/'s tool_use, Ollama's native), as do an
 *     assistant message's `tool_calls` and the `tool` messages answering them.
 *     Never beside a response_format: Crucible refuses the pair
 *     (`tools_with_response_format`), so asking for both is refused here.
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
  /**
   * A size ceiling, in billions of parameters: `model` is not a catalog id but
   * the stored spelling (`max-27b`), and the serving Crucible picks the model
   * (the biggest that fits, up to this). Absent on every other target.
   */
  ceilingB?: number;
}

/** The capability class (verb) a ceiling is asked for: open-ended chat, sized 8192 tokens x 1 in flight. */
export const CEILING_VERB = 'generate';

/** The stored spelling of a size ceiling: `max-27b` (the bare id of `local:max-27b`). */
export function ceilingModelId(ceilingB: number): string {
  return `max-${ceilingB}b`;
}

const CEILING_ID = /^max-(\d+(?:\.\d+)?)b$/;
/**
 * Stored 27B quantisations that read as the 27B ceiling: qwen3.8-27b,
 * qwen3.8-27b-4bit, qwen3.8-27b-8bit and their -vl spellings.
 */
const QWEN_27B = /^qwen3\.8-27b(?:-\d+bit)?(?:-vl)?$/;

/** The ceiling a bare local id spells (`max-27b`), or null when it names one model. */
export function ceilingOf(bareId: string): number | null {
  const own = CEILING_ID.exec(bareId);
  if (!own) return null;
  const value = Number(own[1]);
  return value > 0 ? value : null;
}

/** The ceiling a STORED local id means: its own spelling, or a qwen3.8 27B quantisation (27). */
export function storedCeilingOf(bareId: string): number | null {
  return ceilingOf(bareId) ?? (QWEN_27B.test(bareId) ? 27 : null);
}

/**
 * A stored `(provider, model)` choice as it is run: a local qwen3.8 27B
 * quantisation becomes the 27B ceiling (`local`, `max-27b`); anything else is
 * returned as it is. `model` may carry its own `local:`/`crucible:` prefix.
 */
export function storedChoice<T extends { provider: string; model: string }>(choice: T): T {
  const prov = (choice.provider ?? '').trim().toLowerCase();
  let bare = (choice.model ?? '').trim();
  const prefix = /^(local|crucible):(.+)$/i.exec(bare);
  if (prefix) {
    if (prov !== '' && prov !== 'local' && prov !== 'crucible') return choice;
    bare = prefix[2];
  } else if (prov !== '' && prov !== 'local' && prov !== 'crucible') {
    return choice;
  }
  const ceiling = storedCeilingOf(bare);
  if (ceiling === null) return choice;
  return { ...choice, provider: 'local', model: ceilingModelId(ceiling) };
}

/** The target of a size ceiling. */
export function ceilingTarget(ceilingB: number): CrucibleTarget {
  const id = ceilingModelId(ceilingB);
  return { model: id, route: 'local', upstream: null, bareModel: id, ceilingB };
}

/** How a ceiling is said to a person: "the biggest model up to 27B". */
export function ceilingWords(ceilingB: number): string {
  return `the biggest model up to ${ceilingB}B`;
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
  if (prov === 'local' || prov === 'crucible' || prov === '') {
    const ceiling = ceilingOf(bare);
    if (ceiling !== null) return ceilingTarget(ceiling);
    return { model: bare, route: 'local', upstream: null, bareModel: bare };
  }
  throw new CrucibleTargetError(`"${provider}" is not an AI provider Briefcase knows (claude, openai, ollama, or a Crucible model).`);
}

/** Cloud upstreams: the ones that are never sent a sampling parameter. */
export function isCloudTarget(target: CrucibleTarget): boolean {
  return target.upstream === 'anthropic' || target.upstream === 'openai';
}

/** A native tool call as Briefcase holds it: the OpenAI `tool_calls` entry, flattened. The id is opaque and goes back exactly. */
export interface ChatToolCall {
  id: string;
  name: string;
  /** A JSON string, as the chat format carries it. */
  arguments: string;
}

/** One message of a chat: text, or (native tools) an assistant's calls and a `tool` message answering one. */
export interface ChatBodyMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant only: the calls it made, sent back as `tool_calls`. */
  toolCalls?: ChatToolCall[];
  /** `tool` only: the call it answers, sent as `tool_call_id`. */
  toolCallId?: string;
}

/** What a caller may ask for; `buildChatBody` decides what actually crosses. */
export interface ChatBodyInput {
  messages: ChatBodyMessage[];
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
  /** OpenAI `tools` entries ({type: 'function', function: {name, description, parameters}}), for every route. */
  tools?: Array<Record<string, unknown>>;
  /** OpenAI `tool_choice`; 'auto' when tools are sent and none is said. */
  toolChoice?: string | Record<string, unknown>;
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
    messages: input.messages.map(messageBody),
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
  if (input.tools !== undefined && input.tools.length > 0) {
    if (input.format !== undefined) throw new CrucibleTargetError('A chat cannot ask for tools and a response format together (Crucible refuses tools_with_response_format).');
    body['tools'] = input.tools;
    body['tool_choice'] = input.toolChoice ?? 'auto';
  }
  return body;
}

/** A message as the chat format carries it: an assistant's calls as `tool_calls` (content null when it wrote none), a result with its `tool_call_id`. */
function messageBody(m: ChatBodyMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content === '' ? null : m.content,
      tool_calls: m.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
  return { role: m.role, content: m.content };
}

/** Keys that must never appear in a cloud body. The spec asserts on exactly this list. */
export const CLOUD_FORBIDDEN_KEYS = ['temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'seed', 'chat_template_kwargs'] as const;
