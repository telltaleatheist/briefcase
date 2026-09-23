/**
 * llama-server HTTP client for the scorer. Port of snap/engine.py, plus the two
 * endpoints the TypeScript port needs that snap does not:
 *   - POST /apply-template: renders the model's own chat template server-side
 *     (see scorer-prompt.ts for why), and
 *   - POST /v1/chat/completions: one plain text generation (generate()).
 *
 * Field names follow snap's docs/CONTRACT.md (verified against llama.cpp
 * b10964 / b11115). No state beyond the base URL: the server process lifecycle
 * lives in ScorerServerService.
 */

import { ChatMessage, GenerateOptions, GenerateResult, ScorerError } from './scorer.types';

export const N_PROBS = 40;

/**
 * Transient faults (connection refused while the server starts, a dropped
 * socket, a 503 "Loading model" / "no slot available") are retried: 3 tries,
 * waiting 0.5 s then 1.5 s between them, then refused by name. A READ TIMEOUT
 * is never retried (see completion()).
 */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/** Default read budget for small requests (props, tokenize, apply-template). */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Completion read budget: 120 s + 5 ms per prompt character (snap engine.py). */
export const BASE_READ_TIMEOUT_MS = 120_000;
export const READ_TIMEOUT_MS_PER_CHAR = 5;
/** generate(): extra budget per requested output token (decode is ~10-40 tok/s for a 9B). */
export const GENERATE_TIMEOUT_MS_PER_TOKEN = 100;

/**
 * The read budget scales with the prompt: prefill time is linear in tokens (worse
 * at long positions), and a fixed 120 s cut off a 96k-token read of a 27B on
 * 2026-09-22. ~4 chars/token and 50 tokens/s is far below any GPU prefill, so the
 * budget is generous without being open-ended: 120 s + 5 ms per character.
 */
export function completionReadTimeoutMs(
  promptChars: number,
  baseMs = BASE_READ_TIMEOUT_MS,
  perCharMs = READ_TIMEOUT_MS_PER_CHAR,
): number {
  return baseMs + perCharMs * promptChars;
}

export interface EngineProps {
  modelPath: string;
  chatTemplate: string;
  bosToken: string;
  eosToken: string;
  /** /props modalities.vision: true only when the server loaded an --mmproj that supports images. */
  vision: boolean;
  /**
   * /props media_marker: the placeholder for one image in a multimodal prompt.
   * NOT mtmd's "<__media__>": llama-server draws a random "<__media_XXXX__>" once
   * per process, so it must be read from the running engine, never assumed.
   */
  mediaMarker: string;
  /** /props build_info, when reported (e.g. "b10964-..."). */
  buildInfo?: string;
}

/** Model basename, for both separators. */
export function modelNameOf(props: Pick<EngineProps, 'modelPath'>): string {
  const parts = props.modelPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

export interface TopProb {
  id: number;
  token: string;
  /** The engine's logprob: ln of the raw softmax over the whole vocabulary. */
  logprob: number;
  prob: number;
}

export interface CompletionResult {
  top: TopProb[];
  timings: { prompt_ms: number; prompt_n: number; cache_n: number; [k: string]: unknown };
  tokensEvaluated: number;
  tokensCached: number;
}

/** The surface the decider and prompt builder need; the real client and test fakes implement it. */
export interface ScorerEngineLike {
  props(signal?: AbortSignal): Promise<EngineProps>;
  tokenize(text: string, signal?: AbortSignal): Promise<number[]>;
  applyTemplate(messages: ChatMessage[], addGenerationPrompt: boolean, signal?: AbortSignal): Promise<string>;
  completion(prompt: string, nProbs?: number, images?: string[], signal?: AbortSignal): Promise<CompletionResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ScorerEngineOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  retryDelaysMs?: readonly number[];
  defaultTimeoutMs?: number;
  baseReadTimeoutMs?: number;
  readTimeoutMsPerChar?: number;
}

type JsonObject = Record<string, unknown>;

function requireField<T>(
  obj: unknown,
  key: string,
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object',
  where: string,
): T {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !(key in (obj as JsonObject))) {
    throw new ScorerError('engine_error', `${where}: response has no '${key}' field`);
  }
  const val = (obj as JsonObject)[key];
  let ok: boolean;
  switch (kind) {
    case 'string':
      ok = typeof val === 'string';
      break;
    case 'number':
      ok = typeof val === 'number' && !Number.isNaN(val);
      break;
    case 'integer':
      ok = typeof val === 'number' && Number.isInteger(val);
      break;
    case 'boolean':
      ok = typeof val === 'boolean';
      break;
    case 'array':
      ok = Array.isArray(val);
      break;
    case 'object':
      ok = !!val && typeof val === 'object' && !Array.isArray(val);
      break;
  }
  if (!ok) {
    const got = Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val;
    throw new ScorerError('engine_error', `${where}: '${key}' is ${got}, expected ${kind}`);
  }
  return val as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fetch rejection that means "nothing answered" (refused / reset / DNS), as opposed to an abort. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  return err instanceof TypeError || /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|socket/i.test(err.message);
}

export class ScorerEngine implements ScorerEngineLike {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly retryDelaysMs: readonly number[];
  private readonly defaultTimeoutMs: number;
  private readonly baseReadTimeoutMs: number;
  private readonly readTimeoutMsPerChar: number;

  constructor(baseUrl: string, options: ScorerEngineOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseReadTimeoutMs = options.baseReadTimeoutMs ?? BASE_READ_TIMEOUT_MS;
    this.readTimeoutMsPerChar = options.readTimeoutMsPerChar ?? READ_TIMEOUT_MS_PER_CHAR;
  }

  /** The completion read budget this client applies to a prompt of `chars` characters. */
  completionTimeoutMs(chars: number): number {
    return completionReadTimeoutMs(chars, this.baseReadTimeoutMs, this.readTimeoutMsPerChar);
  }

  // ------------------------------------------------------------------ transport

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    budgetNote: string,
  ): Promise<any> {
    const attempts = this.retryDelaysMs.length + 1;
    const t0 = Date.now();
    let last = '';
    const url = `${this.baseUrl}${path}`;

    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw new ScorerError('cancelled', `${method} ${path}: cancelled by the caller`);

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      signal?.addEventListener('abort', onCallerAbort, { once: true });

      let resp: Response;
      let text: string;
      try {
        resp = await this.fetchImpl(url, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        text = await resp.text();
      } catch (err) {
        if (timedOut) {
          // A read timeout on a request whose budget was sized to its prompt is not
          // weather: the engine is slower than the budget allows, and re-sending the
          // same prompt would only queue the same work again. Refuse by name.
          throw new ScorerError(
            'engine_timeout',
            `${method} ${url}: no reply within ${(timeoutMs / 1000).toFixed(0)} s (budget ${budgetNote})`,
          );
        }
        if (signal?.aborted) {
          throw new ScorerError('cancelled', `${method} ${path}: cancelled by the caller`);
        }
        if (isNetworkError(err)) {
          const cause = (err as any).cause;
          last = `${(err as Error).name}: ${(err as Error).message}${cause?.code ? ` (${cause.code})` : ''}`;
          if (i < attempts - 1) {
            await sleep(this.retryDelaysMs[i]);
            continue;
          }
          throw new ScorerError(
            'engine_unreachable',
            `${method} ${url} failed ${attempts} times in ${((Date.now() - t0) / 1000).toFixed(1)} s ` +
              `(waits [${this.retryDelaysMs.map((d) => d / 1000).join(', ')}] s between tries); last: ${last}`,
          );
        }
        throw new ScorerError('engine_error', `${method} ${path}: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onCallerAbort);
      }

      if (resp.status === 503 && i < attempts - 1) {
        last = `503 ${errorMessage(text)}`;
        await sleep(this.retryDelaysMs[i]);
        continue;
      }
      if (resp.status !== 200) {
        throw new ScorerError(
          'engine_error',
          `${method} ${path} answered ${resp.status}: ${errorMessage(text)}` +
            (resp.status === 503 ? ` (after ${attempts} tries)` : ''),
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new ScorerError('engine_error', `${method} ${path} returned non-JSON: ${JSON.stringify(text.slice(0, 200))}`);
      }
    }
    throw new Error('unreachable'); // the loop always returns or throws
  }

  // ------------------------------------------------------------------ endpoints

  /** GET /health once, no retry: 200 {"status":"ok"}, 503 while loading. */
  async health(signal?: AbortSignal, timeoutMs = 5000): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/health`, { method: 'GET', signal: controller.signal });
      const text = await resp.text();
      if (resp.status !== 200) {
        throw new ScorerError('engine_error', `GET /health answered ${resp.status}: ${errorMessage(text)}`);
      }
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof ScorerError) throw err;
      throw new ScorerError('engine_unreachable', `GET ${this.baseUrl}/health: ${(err as Error)?.message ?? err}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async props(signal?: AbortSignal): Promise<EngineProps> {
    const data = await this.request('GET', '/props', undefined, this.defaultTimeoutMs, signal, 'the client default');
    const where = 'GET /props';
    const modalities = requireField<JsonObject>(data, 'modalities', 'object', where);
    return {
      modelPath: requireField<string>(data, 'model_path', 'string', where),
      chatTemplate: requireField<string>(data, 'chat_template', 'string', where),
      bosToken: requireField<string>(data, 'bos_token', 'string', where),
      eosToken: requireField<string>(data, 'eos_token', 'string', where),
      vision: requireField<boolean>(modalities, 'vision', 'boolean', `${where} modalities`),
      mediaMarker: requireField<string>(data, 'media_marker', 'string', where),
      buildInfo: typeof data.build_info === 'string' ? data.build_info : undefined,
    };
  }

  async tokenize(text: string, signal?: AbortSignal): Promise<number[]> {
    const data = await this.request(
      'POST',
      '/tokenize',
      { content: text, add_special: false, with_pieces: false },
      this.defaultTimeoutMs,
      signal,
      'the client default',
    );
    const toks = requireField<unknown[]>(data, 'tokens', 'array', 'POST /tokenize');
    if (!toks.every((t) => typeof t === 'number' && Number.isInteger(t))) {
      throw new ScorerError('engine_error', `POST /tokenize: tokens are not all ints: ${JSON.stringify(toks)}`);
    }
    return toks as number[];
  }

  /**
   * POST /apply-template: the server renders `messages` with the model's own chat
   * template (the one /props reports), thinking disabled. Returns the prompt text.
   */
  async applyTemplate(messages: ChatMessage[], addGenerationPrompt: boolean, signal?: AbortSignal): Promise<string> {
    const data = await this.request(
      'POST',
      '/apply-template',
      {
        messages,
        add_generation_prompt: addGenerationPrompt,
        // Must be a JSON boolean: llama-server refuses the string "false".
        chat_template_kwargs: { enable_thinking: false },
      },
      this.defaultTimeoutMs,
      signal,
      'the client default',
    );
    return requireField<string>(data, 'prompt', 'string', 'POST /apply-template');
  }

  /**
   * One forward pass (n_predict 1) returning the RAW softmax (post_sampling_probs
   * false) top-n at the answer position. With images, "prompt" becomes the object
   * {prompt_string, multimodal_data}; a top-level multimodal_data is ignored by
   * the server.
   */
  async completion(prompt: string, nProbs = N_PROBS, images?: string[], signal?: AbortSignal): Promise<CompletionResult> {
    const body = {
      prompt: images && images.length ? { prompt_string: prompt, multimodal_data: [...images] } : prompt,
      n_predict: 1,
      n_probs: nProbs,
      post_sampling_probs: false, // raw softmax of the logits, before any sampler
      temperature: 1.0,
      top_k: 0,
      top_p: 1.0,
      min_p: 0.0,
      samplers: [],
      cache_prompt: true,
      stream: false,
    };
    const data = await this.request(
      'POST',
      '/completion',
      body,
      this.completionTimeoutMs(prompt.length),
      signal,
      'sized to the prompt',
    );
    const where = 'POST /completion';
    const cps = requireField<unknown[]>(data, 'completion_probabilities', 'array', where);
    if (cps.length !== 1) {
      throw new ScorerError(
        'engine_error',
        `${where}: expected 1 completion_probabilities entry for n_predict=1, got ${cps.length}`,
      );
    }
    // post_sampling_probs=false -> the key is "top_logprobs" and each entry carries "logprob"
    const tops = requireField<unknown[]>(cps[0], 'top_logprobs', 'array', `${where} completion_probabilities[0]`);
    const top: TopProb[] = tops.map((t, j) => {
      const w = `${where} top_logprobs[${j}]`;
      const logprob = requireField<number>(t, 'logprob', 'number', w);
      return {
        id: requireField<number>(t, 'id', 'integer', w),
        token: requireField<string>(t, 'token', 'string', w),
        logprob,
        prob: Math.exp(logprob),
      };
    });
    const timings = requireField<CompletionResult['timings']>(data, 'timings', 'object', where);
    for (const k of ['prompt_ms', 'prompt_n', 'cache_n']) {
      requireField<number>(timings, k, 'number', `${where} timings`);
    }
    return {
      top,
      timings,
      tokensEvaluated: requireField<number>(data, 'tokens_evaluated', 'integer', where),
      tokensCached: requireField<number>(data, 'tokens_cached', 'integer', where),
    };
  }

  /**
   * One plain text generation via the OpenAI-compatible endpoint: thinking off,
   * temperature 0 (this is a local llama-server, so sampling params are fine).
   */
  async generate(messages: ChatMessage[], options: GenerateOptions): Promise<GenerateResult> {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new ScorerError('bad_request', `maxTokens must be a positive integer, got ${options.maxTokens}`);
    }
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const timeoutMs = this.completionTimeoutMs(chars) + GENERATE_TIMEOUT_MS_PER_TOKEN * options.maxTokens;
    const data = await this.request(
      'POST',
      '/v1/chat/completions',
      {
        messages,
        max_tokens: options.maxTokens,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        cache_prompt: true,
        stream: false,
      },
      timeoutMs,
      options.signal,
      'sized to the prompt and max_tokens',
    );
    const where = 'POST /v1/chat/completions';
    const choices = requireField<unknown[]>(data, 'choices', 'array', where);
    if (choices.length < 1) throw new ScorerError('engine_error', `${where}: no choices`);
    const message = requireField<JsonObject>(choices[0], 'message', 'object', `${where} choices[0]`);
    const content = message.content;
    if (typeof content !== 'string') {
      throw new ScorerError('engine_error', `${where}: choices[0].message.content is not a string`);
    }
    const usage = (data.usage ?? {}) as JsonObject;
    return {
      text: content,
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      finishReason: String((choices[0] as JsonObject).finish_reason ?? ''),
      model: typeof data.model === 'string' ? data.model : '',
    };
  }
}

/** llama-server errors: {"error": {"code", "message", "type"}}. */
function errorMessage(text: string): string {
  try {
    const msg = JSON.parse(text)?.error?.message;
    if (msg !== undefined) return String(msg);
  } catch {
    // fall through
  }
  return text.slice(0, 300);
}
