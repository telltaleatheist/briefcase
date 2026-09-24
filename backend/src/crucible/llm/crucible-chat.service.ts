/**
 * EVERY LLM CALL BRIEFCASE MAKES THROUGH CRUCIBLE (migration plan §6.1, P3).
 *
 *   chat({server?, model, messages | prompt, responseFormat?, maxTokens?, temperature?, signal})
 *   withModel(server | undefined, model, fn)   hold one model, leased, for a multi-call run
 *   withRun(fn)                                 the same, with the model(s) taken lazily per call
 *
 * VENUE. An explicit `server`, else the server a surrounding run already holds
 * the model on, else the first ENABLED server in rank order that answers and
 * can serve it (a local model it has installed; an upstream it has
 * configured). A paused server is never chosen. When no server qualifies but
 * one answers, that one is asked anyway, so the refusal the user sees is the
 * server's own sentence ("anthropic has no key") rather than a guess.
 *
 * LOCAL MODELS are made resident with a `load-model` job (its events followed
 * to the end) and, inside a run, held with a lease heartbeaten every 40 s
 * against a 120 s TTL. A heartbeat that fails for weather is retried every 5 s
 * while the TTL still covers it; only `unknown_lease`, or the TTL running out
 * unrenewed, loses the lease. A lease given up on that way is released
 * best-effort, and the next local call re-takes one before it is sent (a local
 * call is never sent knowingly unleased). A chat that meets `409 model_not_resident` (someone
 * else's load evicted it) re-ensures once and retries. A load or lease refused
 * `409 server_busy` / `leased` is a typed {@link CrucibleBusyError} carrying
 * the holder's sentence; the caller may ask to wait it out (`busyWait`).
 *
 * `503 chat_queue_full` is retried after the server's `Retry-After`, which is
 * read from the raw response: SDK `chat()` drops it, so the chat door is
 * called through {@link CrucibleClientFactory.engineFetch}, the factory's one
 * raw door, and the token stays in the factory.
 *
 * UPSTREAMS (`anthropic/`, `openai/`, `ollama/`) are forwarded by the server
 * with no load and no lease. The body rules (no sampling to cloud, ever) live
 * in target.ts.
 *
 * AN OLLAMA CHOICE runs on the server's own model when it has one
 * ({@link CrucibleChatService.effectiveTarget}, rule in ollama-map.ts): the
 * first ranked server that answers and has a match serves it as a local model
 * (loaded and leased like any other); only with no match anywhere does it go to
 * the `ollama/` upstream. Decided per call, fixed for the rest of a run, and
 * said in the log once per model.
 *
 * A LOAD'S EVENT STREAM that drops is followed again after the last event seen
 * (`Last-Event-ID`): first after 5 s, the waits doubling to 30 s, for up to
 * 5 minutes from the drop (BookForge's stream-reconnect). Past that, and for
 * any other "not now" from the server on the local path (unreachable, a 5xx,
 * a socket that died), the call fails as `unreachable`, which a queue-admitted
 * run PARKS on rather than failing the analysis (P4).
 *
 * CANCEL. The caller's `signal` aborts the open fetch, cancels an in-flight
 * load job, and ends any busy or queue-full wait at once. A run's lease is
 * released in its `finally`.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CrucibleBusy,
  CrucibleCardHeld,
  CrucibleLeased,
  CrucibleRefused,
  CrucibleUnreachable,
  type CrucibleClient,
  type JobEvent,
  type ModelInfo,
} from '@crucible/client';
import { crucibleUnavailableCause } from '../transport-failure';
import { CrucibleClientFactory } from '../client-factory';
import { CrucibleServersService } from '../crucible-servers.service';
import { CrucibleProbeService, compareVersions } from '../probe';
import type { InFlightLedger } from '../in-flight-ledger';
import { CRUCIBLE_IN_FLIGHT_LEDGER } from '../crucible.constants';
import {
  CrucibleBusyError,
  CrucibleChatCancelled,
  CrucibleChatError,
  CrucibleNoVenueError,
  parseRetryAfter,
} from './errors';
import { buildChatBody, crucibleTargetOf, type ChatBodyInput, type CrucibleTarget, type UpstreamName } from './target';
import { crucibleChoiceForOllama, isPageReader, type MappableModel } from './ollama-map';

/** Capability class sent as `X-Crucible-Act` and as every lease's act. */
export const BRIEFCASE_ACT = 'analysis';
export const LEASE_TTL_SECONDS = 120;
export const HEARTBEAT_MS = 40_000;
/** A heartbeat that failed for weather is tried again this soon, while the TTL still covers it. */
export const HEARTBEAT_RETRY_MS = 5_000;
export const LOAD_STREAM_RETRY: Readonly<{ firstMs: number; maxMs: number; budgetMs: number }> = { firstMs: 5_000, maxMs: 30_000, budgetMs: 5 * 60_000 };
/** Queue-full retries before the call gives up. */
export const MAX_QUEUE_FULL_RETRIES = 30;
const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_RETRY_AFTER_MS = 60_000;
/** 10 minutes for an upstream (a cloud or Ollama model). */
export const UPSTREAM_TIMEOUT_MS = 600_000;
/** A local call: 120 s plus 5 ms per prompt character (the scorer's measured rule). */
export function localTimeoutMs(promptChars: number): number {
  return 120_000 + 5 * promptChars;
}
/**
 * A model Briefcase can give a transcript to. The catalog also serves page
 * readers (dots-ocr) through the same llm door; those are never offered for
 * analysis or picked for placement. BY CAPABILITY CLASS, NOT MODALITY: a page
 * reader is what the server's `pages` class selected (`pageReaders`, from
 * {@link CrucibleChatService.pageReadersOn}). The `-vl` aliases of 1.0.24
 * (`qwen3.5-9b-vl`) are text+image too and CAN analyse, so an image modality
 * alone never excludes a model. Only when the server gave no class record does
 * ollama-map's modality rule (image-capable and not an alias) stand in.
 */
export function isAnalysisModel(
  model: Pick<ModelInfo, 'id' | 'modalities'> & { readonly weightsOf?: string | null },
  pageReaders: Iterable<string> | null,
): boolean {
  if (!model.modalities.includes('text')) return false;
  const readers = pageReaders === null ? null : new Set(pageReaders);
  return !isPageReader(model as MappableModel, readers);
}

/** The first Crucible whose chat door takes `context_tokens` for an `ollama/` model (PHASE15-HOST §3.4a). */
export const OLLAMA_CONTEXT_VERSION = '1.0.24';

const SETTINGS_CACHE_MS = 30_000;
const MODELS_CACHE_MS = 15_000;

export interface CrucibleChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BusyWait {
  /** How often to ask again. */
  everyMs: number;
  /** How long to keep asking before failing with the busy error. */
  forMs: number;
  /** Told the holder's sentence each time it waits. */
  onWait?: (busyLine: string, server: string) => void;
}

export interface CrucibleChatRequest {
  server?: string;
  /** A Crucible model (`qwen3.5-9b`, `anthropic/…`) or a Briefcase `provider:model`. */
  model: string;
  /** Briefcase's provider label for `model`, when it came separately. */
  provider?: string;
  messages?: CrucibleChatMessage[];
  prompt?: string;
  /** 'json', a JSON Schema object, or nothing. Mapped per target (target.ts). */
  responseFormat?: 'json' | Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Overrides the per-route timeout. */
  timeoutMs?: number;
  busyWait?: BusyWait;
  /** `X-Crucible-Act`: the capability class this chat is. Default {@link BRIEFCASE_ACT}. */
  act?: string;
  /** Local models only: state `enable_thinking` (target.ts). Absent: the manifest's default. */
  thinking?: boolean;
  /**
   * `ollama/` only: the window the call needs, sent as `context_tokens` (Ollama's
   * num_ctx) when the server is 1.0.24 or newer; an older server is sent nothing.
   */
  contextTokens?: number;
  /** Local models only: the context the model must be loaded with at least (load-model `params.context`). */
  loadContext?: number;
}

export interface CrucibleChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CrucibleChatResult {
  text: string;
  /** The model string that was sent. */
  model: string;
  target: CrucibleTarget;
  server: string;
  finishReason: string | null;
  usage: CrucibleChatUsage | null;
  /** `X-Crucible-Sampling`, parsed: where each sampling value came from. */
  sampling: Record<string, string> | null;
  /** True when `content` was empty and the structured answer was read from `reasoning`. */
  fromReasoning: boolean;
  /** Chat attempts, including queue-full retries. */
  attempts: number;
  /** `X-Crucible-Context`, parsed: the num_ctx an `ollama/` chat was sent with and where it came from. */
  context: Record<string, unknown> | null;
}

interface Held {
  server: string;
  model: string;
  /** The context it was loaded with when a caller asked for one; null: whatever was resident. */
  context: number | null;
  leaseId: string | null;
  beat: NodeJS.Timeout | null;
  lost: boolean;
  /** Lost by this side giving up (heartbeats unanswered), not by the server saying so: it may still be open there. */
  mayStillHold: boolean;
  /** Released: a heartbeat in flight must not reschedule itself. */
  stopped: boolean;
}

function isUnknownLease(err: unknown): boolean {
  return err instanceof CrucibleRefused && (err.code === 'unknown_lease' || err.status === 404);
}

/** What a Briefcase model choice runs as on Crucible, and where (see effectiveTarget). */
export interface EffectiveTarget {
  target: CrucibleTarget;
  /** The server the mapping was decided on; null when the target was taken as it is. */
  server: string | null;
  /** The `ollama/<tag>` this target stands in for, or null when it was not mapped. */
  mappedFrom: string | null;
  /**
   * The context the mapped model is loaded with, when its default is under the
   * analysis window but this host can serve it there (ollama-map.ts rule 4).
   */
  loadContext?: number;
}

/** How the queue asks for a run (P4). Every field is optional; a bare `withRun(fn)` is P3's run. */
export interface RunOptions {
  /**
   * The queue admitted this run to a lane. A busy card inside it is NOT waited
   * out in the task: the caller throws `CrucibleParkedError` and the queue
   * parks the task, freeing the lane (migration plan §7.2 step 4).
   */
  parkOnBusy?: boolean;
  /** Told whenever the run makes headway (a chat answered, a load moved): the stall watchdog's heartbeat. */
  onActivity?: () => void;
  /** Briefcase's id for the work, written on every ledger row. */
  localId?: string;
}

interface RunScope {
  /** One hold per server: Crucible allows one lease per client per server. */
  held: Map<string, Held>;
  options: RunOptions;
  /** Set when a call inside the run chose to park: the queue reads it after the task returns. */
  parked: { server: string | null; reason: string } | null;
  /** The server each model was placed on in this run, so a run never re-ranks mid-way. */
  placed: Map<string, string>;
  /** What each `ollama/` choice was decided to run as in this run, so it never flips mid-way. */
  mapped: Map<string, EffectiveTarget>;
  /** Serialises acquisitions inside the run. */
  lock: Promise<unknown>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CrucibleChatCancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CrucibleChatCancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The wait that keeps asking longer (a caller's own, or the reload's). */
function longerWait(a: BusyWait | undefined, b: BusyWait): BusyWait {
  return a !== undefined && a.forMs >= b.forMs ? a : b;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CrucibleChatCancelled();
}

/**
 * The refusal codes that mean "the card is briefly someone else's", never "no":
 * a job on the lane, a lease, and `engine_in_use` (the engine is claimed: a
 * streaming session, or Crucible's own settlement clearing the card after a
 * lapsed lease). Each is designed busy-handling: parked in a queue run, waited
 * out (bounded) otherwise. None may fail an analysis.
 */
export const BUSY_REFUSAL_CODES: ReadonlySet<string> = new Set(['server_busy', 'leased', 'engine_in_use']);

function busyLineOfRefusal(err: unknown): string | null {
  if (err instanceof CrucibleBusy) return err.busyLine;
  if (err instanceof CrucibleLeased) return err.leasedLine;
  if (err instanceof CrucibleCardHeld) return `held by ${err.who}: ${err.fact}`;
  if (err instanceof CrucibleRefused && BUSY_REFUSAL_CODES.has(err.code)) return err.serverMessage;
  return null;
}

/**
 * How long a reload after `model_not_resident` waits out a busy card when the
 * caller set no wait of its own: the eviction usually IS a settlement that
 * clears within seconds (`engine_in_use`, "held by the settlement clearing the
 * card"). Past it, the busy error goes up: a queue run parks on it.
 */
export const RELOAD_BUSY_WAIT: Readonly<BusyWait> = { everyMs: 2_000, forMs: 60_000 };

@Injectable()
export class CrucibleChatService {
  private readonly logger = new Logger('CrucibleChat');
  private readonly runs = new AsyncLocalStorage<RunScope>();
  private readonly settingsCache = new Map<string, { at: number; configured: Record<UpstreamName, boolean> }>();
  private readonly modelsCache = new Map<string, { at: number; models: ModelInfo[] }>();
  private readonly pagesCache = new Map<string, { at: number; readers: string[] | null; ceilings: Map<string, number> | null }>();
  /** `server\nollama/<tag>` already said in the log (once per model per process). */
  private readonly mappingNoted = new Set<string>();
  /** `server\nollama/<tag>` whose `X-Crucible-Context` was already logged. */
  private readonly contextNoted = new Set<string>();

  /** The clock and the sleeper, replaceable by a spec. */
  now: () => number = Date.now;
  heartbeatMs = HEARTBEAT_MS;
  /** How soon a heartbeat that failed for weather is tried again. */
  heartbeatRetryMs = HEARTBEAT_RETRY_MS;
  /** How long the server keeps a lease nobody renews: the retry budget. */
  leaseTtlMs = LEASE_TTL_SECONDS * 1000;
  /**
   * Re-following a load's dropped event stream (BookForge's stream-reconnect):
   * the first wait, the cap the waits double up to, and the budget from the
   * drop (reset by any event) after which the server counts as unreachable.
   */
  loadStreamRetry = { ...LOAD_STREAM_RETRY };
  /** The bounded wait of a reload after `model_not_resident` ({@link RELOAD_BUSY_WAIT}). */
  reloadBusyWait: BusyWait = { ...RELOAD_BUSY_WAIT };
  /**
   * Leases this side gave up on but could not hand back, per server. Crucible
   * allows one lease per client per server, so re-leasing is refused `leased`
   * naming this id; it is then ours to take back, not "another app's".
   */
  private readonly staleLeases = new Map<string, string>();

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly factory: CrucibleClientFactory,
    private readonly probes: CrucibleProbeService,
    /** P4: every load job and lease is written here the moment the server admits it. */
    @Optional() @Inject(CRUCIBLE_IN_FLIGHT_LEDGER) private readonly ledger?: InFlightLedger,
  ) {}

  // ── the run scope ──────────────────────────────────────────────────────

  /**
   * Run `fn` as ONE run: every local model a chat inside it needs is loaded
   * once, leased, heartbeaten, and released when `fn` settles (success,
   * failure or cancel). Nested calls join the outer run.
   */
  async withRun<T>(fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    if (this.runs.getStore() !== undefined) return fn();
    const scope: RunScope = { held: new Map(), placed: new Map(), mapped: new Map(), lock: Promise.resolve(), options, parked: null };
    try {
      return await this.runs.run(scope, fn);
    } finally {
      await this.releaseScope(scope);
    }
  }

  /**
   * Hold `model` (leased, if local) for the whole of `fn`. `server` pins the
   * venue; undefined picks one. `fn` is told where it landed.
   */
  async withModel<T>(
    server: string | undefined,
    model: string,
    fn: (held: { server: string; model: string; target: CrucibleTarget }) => Promise<T>,
    options: { signal?: AbortSignal; busyWait?: BusyWait; provider?: string; loadContext?: number } = {},
  ): Promise<T> {
    return this.withRun(async () => {
      const chosen = await this.effectiveTarget(crucibleTargetOf(options.provider, model), server);
      const target = chosen.target;
      const scope = this.runs.getStore()!;
      const venue = server ?? scope.placed.get(target.model) ?? chosen.server ?? await this.venueFor(target);
      scope.placed.set(target.model, venue);
      if (target.route === 'local') await this.ensureLocal(venue, target.model, options.signal, options.busyWait, options.loadContext ?? chosen.loadContext);
      return fn({ server: venue, model: target.model, target });
    });
  }

  /**
   * Inside a run, make `model` held on `server` again after the server said it
   * is not resident (someone else's load evicted it): the hold is forgotten and
   * re-taken, loading at `loadContext` when given. For a door the chat service
   * does not proxy (the scorer's `/v1/decide`).
   */
  async reacquire(server: string, model: string, signal?: AbortSignal, loadContext?: number): Promise<void> {
    this.forgetHold(server, model);
    await this.ensureLocal(server, model, signal, this.reloadBusyWait, loadContext);
  }

  /** The Crucible release a server reports (the probe's, cached 10 s), or null when it can't be read. */
  async serverVersion(server: string): Promise<string | null> {
    try {
      const answer = await this.probes.reach(server);
      return answer.probe.outcome === 'ok' ? answer.probe.facts.version : null;
    } catch {
      return null;
    }
  }

  /** True when `server` is at least `version` (a server whose version can't be read is not). */
  async serverAtLeast(server: string, version: string): Promise<boolean> {
    const running = await this.serverVersion(server);
    return running !== null && compareVersions(running, version) >= 0;
  }

  /** True inside a run the queue admitted: a busy card parks the task instead of being waited out. */
  parksOnBusy(): boolean {
    return this.runs.getStore()?.options.parkOnBusy === true;
  }

  /** Note, on the current run, that a call chose to park it. The queue reads it back with {@link parkedInRun}. */
  markParked(server: string | null, reason: string): void {
    const scope = this.runs.getStore();
    if (scope !== undefined && scope.parked === null) scope.parked = { server, reason };
  }

  parkedInRun(): { server: string | null; reason: string } | null {
    return this.runs.getStore()?.parked ?? null;
  }

  /** A door this service does not proxy made headway (the scorer's decide): the stall watchdog's heartbeat. */
  noteActivity(): void {
    this.touch();
  }

  private touch(): void {
    try {
      this.runs.getStore()?.options.onActivity?.();
    } catch {
      // A heartbeat listener never breaks a call.
    }
  }

  private localId(): string {
    return this.runs.getStore()?.options.localId ?? 'briefcase';
  }

  /** What the current run holds, for a log line or a spec. */
  heldInRun(): Array<{ server: string; model: string; leaseId: string | null }> {
    const scope = this.runs.getStore();
    if (scope === undefined) return [];
    return [...scope.held.values()].map(({ server, model, leaseId }) => ({ server, model, leaseId }));
  }

  // ── chat ───────────────────────────────────────────────────────────────

  async chat(request: CrucibleChatRequest): Promise<CrucibleChatResult> {
    const signal = request.signal;
    throwIfAborted(signal);
    const chosen = await this.effectiveTarget(crucibleTargetOf(request.provider, request.model), request.server);
    const target = chosen.target;
    const messages: CrucibleChatMessage[] = request.messages ?? (request.prompt !== undefined ? [{ role: 'user', content: request.prompt }] : []);
    if (messages.length === 0) throw new CrucibleChatError(400, 'invalid_request', 'A chat needs a prompt or messages.');

    const scope = this.runs.getStore();
    const server = request.server ?? scope?.placed.get(target.model) ?? chosen.server ?? await this.venueFor(target);
    scope?.placed.set(target.model, server);

    // Ollama's num_ctx crosses only to a server that forwards it (1.0.24+); an
    // older one would pass an unknown key to its OpenAI shim for nothing.
    const contextTokens = target.upstream === 'ollama' && request.contextTokens !== undefined
      && await this.serverAtLeast(server, OLLAMA_CONTEXT_VERSION) ? request.contextTokens : undefined;
    const body = buildChatBody(target, {
      messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      format: request.responseFormat,
      schemaName: request.schemaName,
      thinking: request.thinking,
      contextTokens,
    } satisfies ChatBodyInput);
    const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const timeoutMs = request.timeoutMs ?? (target.route === 'local' ? localTimeoutMs(promptChars) : UPSTREAM_TIMEOUT_MS);

    const loadContext = request.loadContext ?? chosen.loadContext;
    if (target.route === 'local') await this.ensureLocal(server, target.model, signal, request.busyWait, loadContext);

    let attempts = 0;
    let reloaded = false;
    for (;;) {
      throwIfAborted(signal);
      attempts += 1;
      const response = await this.post(server, body, timeoutMs, signal, request.act);
      if (response.ok) {
        const result = await this.readReply(response, target, server, request.responseFormat !== undefined);
        if (result.context !== null && !this.contextNoted.has(`${server}\n${target.model}`)) {
          this.contextNoted.add(`${server}\n${target.model}`);
          this.logger.log(`[${server}] ${target.model} runs with ${JSON.stringify(result.context)} (X-Crucible-Context)`);
        }
        this.touch();
        return { ...result, attempts };
      }
      const failure = await this.failureOf(response, server);
      if (failure.code === 'chat_queue_full' && attempts <= MAX_QUEUE_FULL_RETRIES) {
        const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(250, failure.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS));
        this.logger.log(`[${server}] chat queue full; retrying in ${Math.round(wait / 100) / 10}s (attempt ${attempts})`);
        await sleep(wait, signal);
        continue;
      }
      if (failure.code === 'model_not_resident' && target.route === 'local' && !reloaded) {
        reloaded = true;
        this.logger.warn(`[${server}] ${target.model} is no longer resident (${failure.message}); loading it again`);
        this.forgetHold(server, target.model);
        await this.ensureLocal(server, target.model, signal, longerWait(request.busyWait, this.reloadBusyWait), loadContext);
        continue;
      }
      // The chat door refusing because the card is someone else's right now
      // (a claim, a lease): busy, the same as at the load. Never a failure.
      if (failure.status === 409 && BUSY_REFUSAL_CODES.has(failure.code)) throw new CrucibleBusyError(server, failure.message);
      throw failure;
    }
  }

  private async post(server: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, act: string = BRIEFCASE_ACT): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.factory.engineFetch(server, '/v1/openai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
        act,
      });
    } catch (err) {
      if (signal?.aborted) throw new CrucibleChatCancelled();
      if (timeout.aborted) {
        throw new CrucibleChatError(0, 'timeout', `Crucible "${server}" did not finish the answer within ${Math.round(timeoutMs / 1000)} s.`, server);
      }
      throw new CrucibleChatError(0, 'unreachable', `Crucible "${server}" isn't answering (${(err as Error).message}).`, server);
    }
  }

  private async failureOf(response: Response, server: string): Promise<CrucibleChatError> {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now);
    let code = `http_${response.status}`;
    let message = `Crucible "${server}" answered HTTP ${response.status}.`;
    let details: unknown = null;
    const text = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } };
      if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
      if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
      details = parsed?.error?.details ?? null;
    } catch {
      if (text.trim()) message = `${message} ${text.trim().slice(0, 200)}`;
    }
    if (code === 'upstream_unconfigured') {
      message = `${message} Add it on "${server}" in Settings › AI.`;
    }
    if (code === 'upstream_field_unsupported') {
      // 1.0.24's Ollama translation refuses a field it cannot carry to /api/chat by name.
      message = `${message} (Crucible "${server}" cannot carry that field to Ollama.)`;
    }
    return new CrucibleChatError(response.status, code, message, server, retryAfterMs, details);
  }

  private async readReply(response: Response, target: CrucibleTarget, server: string, structured: boolean): Promise<Omit<CrucibleChatResult, 'attempts'>> {
    const raw = await response.text();
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new CrucibleChatError(502, 'protocol_error', `Crucible "${server}" answered a chat with something that is not JSON.`, server);
    }
    const choices = Array.isArray(doc['choices']) ? doc['choices'] as Array<Record<string, unknown>> : [];
    const first = choices[0] ?? {};
    const message = (first['message'] ?? {}) as Record<string, unknown>;
    let text = typeof message['content'] === 'string' ? message['content'] : '';
    let fromReasoning = false;
    // A reasoning model under a grammar can put the whole object in its
    // reasoning channel and leave content empty. Crucible returns `reasoning`
    // untouched on the local door (PHASE2-LLM.md §5), so read it when
    // structured output was asked for, content is empty and reasoning is not.
    if (!text.trim() && structured) {
      const reasoning = typeof message['reasoning'] === 'string' ? message['reasoning']
        : typeof message['reasoning_content'] === 'string' ? message['reasoning_content'] : '';
      if (reasoning.trim()) {
        text = reasoning;
        fromReasoning = true;
      }
    }
    const usageDoc = doc['usage'] as Record<string, unknown> | undefined;
    const usage = usageDoc && typeof usageDoc === 'object'
      ? {
          promptTokens: Number(usageDoc['prompt_tokens'] ?? 0) || 0,
          completionTokens: Number(usageDoc['completion_tokens'] ?? 0) || 0,
          totalTokens: Number(usageDoc['total_tokens'] ?? 0) || 0,
        }
      : null;
    if (usage && usage.totalTokens === 0) usage.totalTokens = usage.promptTokens + usage.completionTokens;
    let sampling: Record<string, string> | null = null;
    const header = response.headers.get('x-crucible-sampling');
    if (header) {
      try { sampling = JSON.parse(header) as Record<string, string>; } catch { sampling = null; }
    }
    let context: Record<string, unknown> | null = null;
    const contextHeader = response.headers.get('x-crucible-context');
    if (contextHeader) {
      try {
        const parsed = JSON.parse(contextHeader) as unknown;
        context = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : { value: parsed };
      } catch {
        context = { value: contextHeader };
      }
    }
    return {
      text,
      model: target.model,
      target,
      server,
      finishReason: typeof first['finish_reason'] === 'string' ? first['finish_reason'] : null,
      usage,
      sampling,
      fromReasoning,
      context,
    };
  }

  // ── an ollama choice, on Crucible's own model ─────────────────────────

  /**
   * What `target` runs as. Anything but `ollama/<tag>` is itself. An Ollama
   * tag is looked up on `server` (when the caller pinned one), else on each
   * enabled server in rank order that answers; the first with a matching local
   * model (ollama-map.ts) serves it as that model. No match anywhere: the
   * `ollama/` upstream, as chosen. Inside a run the answer is kept, so a run
   * never switches models between calls.
   */
  async effectiveTarget(target: CrucibleTarget, server?: string): Promise<EffectiveTarget> {
    if (target.upstream !== 'ollama') return { target, server: null, mappedFrom: null };
    const scope = this.runs.getStore();
    const key = `${server ?? ''}\n${target.model}`;
    const kept = scope?.mapped.get(key);
    if (kept !== undefined) return kept;

    let candidates: string[];
    if (server !== undefined) {
      candidates = [server];
    } else {
      candidates = [];
      try {
        for (const row of this.servers.ranked()) {
          const answer = await this.probes.reach(row.name);
          if (answer.reach === 'ready' || answer.reach === 'busy') candidates.push(row.name);
        }
      } catch {
        candidates = [];
      }
    }
    let chosen: EffectiveTarget = { target, server: null, mappedFrom: null };
    for (const name of candidates) {
      let local: ReturnType<typeof crucibleChoiceForOllama>;
      try {
        const [models, facts] = await Promise.all([this.modelsOn(name), this.classFactsOn(name)]);
        local = crucibleChoiceForOllama(target.bareModel, models, { pageReaders: facts.readers, ceilings: facts.ceilings });
      } catch {
        continue;
      }
      if (local === null) continue;
      chosen = {
        target: { model: local.id, route: 'local', upstream: null, bareModel: local.id },
        server: name,
        mappedFrom: target.model,
        ...(local.loadContext === undefined ? {} : { loadContext: local.loadContext }),
      };
      break;
    }
    const note = `${chosen.server ?? '*'}\n${target.model}`;
    if (!this.mappingNoted.has(note)) {
      this.mappingNoted.add(note);
      if (chosen.mappedFrom !== null) {
        this.logger.log(`[${chosen.server}] ${target.model} runs as ${chosen.target.model}, this server's own copy of that model`
          + (chosen.loadContext === undefined ? '' : `, loaded at ${chosen.loadContext} tokens`));
      }
      else this.logger.log(`${target.model}: no Crucible server has that model of its own, so it goes to Ollama through Crucible`);
    }
    scope?.mapped.set(key, chosen);
    return chosen;
  }

  /**
   * The page readers on a server, by capability class: what its `pages` class
   * selected (cached with the models). Null when the record can't be read, so
   * the mapping falls back to its modality rule.
   */
  async pageReadersOn(server: string): Promise<string[] | null> {
    return (await this.classFactsOn(server)).readers;
  }

  /**
   * One read of a server's capability record (cached with the models): its page
   * readers (the `pages` class's selection) and each model's context ceiling
   * (the `generate` class's `context_ceilings`, 1.0.24+). Nulls when the record
   * can't be read or carries no ceilings.
   */
  async classFactsOn(server: string): Promise<{ readers: string[] | null; ceilings: Map<string, number> | null }> {
    const cached = this.pagesCache.get(server);
    if (cached !== undefined && this.now() - cached.at < MODELS_CACHE_MS) return cached;
    let readers: string[] | null;
    let ceilings: Map<string, number> | null = null;
    try {
      const client = await this.servers.clientFor(server);
      const record = await client.capability({ timeoutMs: 5_000 });
      readers = record.classes.filter((row) => row.capability === 'pages' && row.selected !== '').map((row) => row.selected);
      const generate = record.classes.find((row) => row.capability === 'generate');
      if (generate?.contextCeilings) ceilings = new Map(generate.contextCeilings.map((c) => [c.model, c.tokens]));
    } catch {
      readers = null;
    }
    const entry = { at: this.now(), readers, ceilings };
    this.pagesCache.set(server, entry);
    return entry;
  }

  // ── venue ──────────────────────────────────────────────────────────────

  /**
   * The first enabled, reachable server (rank order) that can serve `target`;
   * failing that, the first reachable one (so its refusal names the fix).
   */
  async venueFor(target: CrucibleTarget): Promise<string> {
    let ranked: string[];
    try {
      ranked = this.servers.ranked().map((row) => row.name);
    } catch (err) {
      throw new CrucibleNoVenueError((err as Error).message);
    }
    const reachable: string[] = [];
    const unreachable: string[] = [];
    for (const name of ranked) {
      const answer = await this.probes.reach(name);
      if (answer.reach !== 'ready' && answer.reach !== 'busy') {
        unreachable.push(`${name} (${answer.reach})`);
        continue;
      }
      reachable.push(name);
      if (await this.canServe(name, target)) return name;
    }
    if (reachable.length > 0) return reachable[0];
    throw new CrucibleNoVenueError(
      `No Crucible server is answering (${unreachable.join(', ')}). Check it is running, or connect another in Settings › Crucible Servers.`,
    );
  }

  async canServe(server: string, target: CrucibleTarget): Promise<boolean> {
    try {
      if (target.route === 'upstream') {
        const configured = await this.upstreamsConfigured(server);
        return configured[target.upstream!] === true;
      }
      const models = await this.modelsOn(server);
      return models.some((m) => m.id === target.model && m.backendSupported && m.installed);
    } catch {
      return false;
    }
  }

  /** Which upstreams a server has configured (cached 30 s). */
  async upstreamsConfigured(server: string): Promise<Record<UpstreamName, boolean>> {
    const cached = this.settingsCache.get(server);
    if (cached !== undefined && this.now() - cached.at < SETTINGS_CACHE_MS) return cached.configured;
    const client = await this.servers.clientFor(server);
    const doc = await client.settings();
    const configured = {
      anthropic: doc.upstreams.anthropic.configured,
      openai: doc.upstreams.openai.configured,
      ollama: doc.upstreams.ollama.configured,
    };
    this.settingsCache.set(server, { at: this.now(), configured });
    return configured;
  }

  /** `GET /v1/models` on a server (cached 15 s; a load or a settings change drops it). */
  async modelsOn(server: string, fresh = false): Promise<ModelInfo[]> {
    const cached = this.modelsCache.get(server);
    if (!fresh && cached !== undefined && this.now() - cached.at < MODELS_CACHE_MS) return cached.models;
    const client = await this.servers.clientFor(server);
    const models = await client.models();
    this.modelsCache.set(server, { at: this.now(), models });
    return models;
  }

  /** Forget cached settings and models (a settings save, a spec). */
  forgetCaches(server?: string): void {
    if (server === undefined) {
      this.settingsCache.clear();
      this.modelsCache.clear();
      this.pagesCache.clear();
      return;
    }
    this.settingsCache.delete(server);
    this.modelsCache.delete(server);
    this.pagesCache.delete(server);
  }

  // ── residency and leases ──────────────────────────────────────────────

  /**
   * Make `model` resident on `server`. Inside a run it is also leased (and the
   * run's previous hold on that server released first, since a lease pins the
   * card to one model). Outside a run it is only loaded.
   */
  private async ensureLocal(server: string, model: string, signal?: AbortSignal, busyWait?: BusyWait, loadContext?: number): Promise<void> {
    const started = this.now();
    for (;;) {
      try {
        await this.ensureLocalOnce(server, model, signal, loadContext);
        return;
      } catch (err) {
        if (!(err instanceof CrucibleBusyError) || busyWait === undefined) throw err;
        if (this.now() - started + busyWait.everyMs > busyWait.forMs) throw err;
        busyWait.onWait?.(err.busyLine, server);
        this.logger.log(`[${server}] busy (${err.busyLine}); asking again in ${Math.round(busyWait.everyMs / 1000)} s`);
        await sleep(busyWait.everyMs, signal);
      }
    }
  }

  private async ensureLocalOnce(server: string, model: string, signal?: AbortSignal, loadContext?: number): Promise<void> {
    const scope = this.runs.getStore();
    if (scope === undefined) {
      await this.makeResident(server, model, signal, false, loadContext).catch((err: unknown) => { throw this.asUnreachable(err, server); });
      return;
    }
    const run = scope.lock.then(async () => {
      const held = scope.held.get(server);
      if (held !== undefined && held.model === model && !held.lost) {
        // Held already; a caller that needs a bigger window than it was taken at gets a reload.
        if (loadContext === undefined || (held.context !== null && held.context >= loadContext)) return;
        if (!(await this.residentTooSmall(server, model, loadContext))) {
          held.context = loadContext;
          return;
        }
      }
      if (held !== undefined) await this.releaseHold(scope, held);
      const leaseId = await this.makeResident(server, model, signal, true, loadContext).catch((err: unknown) => { throw this.asUnreachable(err, server); });
      const hold: Held = { server, model, context: loadContext ?? null, leaseId, beat: null, lost: false, mayStillHold: false, stopped: false };
      if (leaseId !== null) this.startHeartbeat(hold);
      scope.held.set(server, hold);
    });
    scope.lock = run.catch(() => undefined);
    await run;
  }

  /**
   * Resident, by a `load-model` job when it is not. With `lease`, returns the
   * lease id that holds it (taken on the load, or separately when it was
   * already resident), or null when another client's lease already pins it.
   */
  /** True when `model` is resident on `server` at a context under `loadContext` (a reload would be needed). */
  private async residentTooSmall(server: string, model: string, loadContext: number): Promise<boolean> {
    try {
      const info = (await this.modelsOn(server, true)).find((m) => m.id === model);
      return info !== undefined && info.resident && (info.maxModelLen ?? 0) < loadContext;
    } catch {
      return false;
    }
  }

  private async makeResident(server: string, model: string, signal: AbortSignal | undefined, lease: boolean, loadContext?: number): Promise<string | null> {
    throwIfAborted(signal);
    const client = await this.servers.clientFor(server);
    const models = await this.modelsOn(server, true);
    const info = models.find((m) => m.id === model);
    if (info === undefined) {
      throw new CrucibleChatError(404, 'unknown_model',
        `"${model}" is not a model Crucible "${server}" knows. Pick one from its catalog in Settings › AI.`, server);
    }
    // Resident at a smaller context than this run needs: a same-id reload with
    // `context` (1.0.24 load-time context), never a request past its window.
    if (info.resident && loadContext !== undefined && (info.maxModelLen ?? 0) < loadContext) {
      this.logger.log(`[${server}] ${model} is resident at ${info.maxModelLen ?? '?'} tokens; reloading it at ${loadContext}`);
      return this.load(client, server, model, signal, lease, loadContext);
    }
    if (info.resident) {
      if (!lease) return null;
      try {
        const held = await client.lease(model, { act: BRIEFCASE_ACT, ttlSeconds: LEASE_TTL_SECONDS });
        this.recordLease(server, model, held.leaseId);
        this.staleLeases.delete(server);
        this.logger.log(`[${server}] leased resident ${model} (${held.leaseId})`);
        return held.leaseId;
      } catch (err) {
        // Our own lease, given up on earlier but never handed back: it is
        // still open, so it is still ours. Take it back and heartbeat it.
        if (err instanceof CrucibleLeased && this.staleLeases.get(server) === err.leaseId) {
          this.staleLeases.delete(server);
          this.recordLease(server, model, err.leaseId);
          this.logger.log(`[${server}] ${model}: our earlier lease ${err.leaseId} is still open; holding it again`);
          return err.leaseId;
        }
        // Another client already holds a lease on the card. If it holds OUR
        // model, the card is pinned where we need it; chat without our own.
        if (err instanceof CrucibleLeased) {
          this.logger.log(`[${server}] ${model} is resident and leased by ${err.holder ?? 'another app'}; chatting under their lease`);
          return null;
        }
        if (err instanceof CrucibleRefused && err.code === 'not_resident') return this.load(client, server, model, signal, lease, loadContext);
        throw this.mapRefusal(err, server);
      }
    }
    if (!info.backendSupported || !info.installed) {
      throw new CrucibleChatError(409, info.installed ? 'unsupported_model' : 'model_not_installed',
        `"${model}" ${info.installed ? `can't run on "${server}"` : `isn't downloaded on "${server}"`}`
          + `${info.reason ? ` (${info.reason})` : ''}. Pick another model, or download it in Settings › AI.`, server);
    }
    return this.load(client, server, model, signal, lease, loadContext);
  }

  private async load(client: CrucibleClient, server: string, model: string, signal: AbortSignal | undefined, lease: boolean, context?: number): Promise<string | null> {
    let loadId: string;
    try {
      const options = {
        ...(lease ? { lease: { act: BRIEFCASE_ACT, ttlSeconds: LEASE_TTL_SECONDS } } : {}),
        ...(context === undefined ? {} : { context }),
      };
      loadId = await client.loadModel(model, Object.keys(options).length > 0 ? options : undefined);
    } catch (err) {
      throw this.mapRefusal(err, server);
    }
    // The ledger row goes down the moment the server has admitted the job
    // (after, never before: BookForge's rule), so a kill mid-load leaves the
    // startup sweep something to cancel.
    this.ledger?.record({ server, kind: 'job', id: loadId, jobType: 'load-model', model, localId: this.localId() });
    this.logger.log(`[${server}] loading ${model}${context === undefined ? '' : ` at ${context} tokens`} (job ${loadId})`);
    let settled = false;
    const onAbort = (): void => {
      void client.cancel(loadId).then(() => this.ledger?.settle(server, 'job', loadId), () => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let terminal: JobEvent | null = null;
    try {
      terminal = await this.followLoad(client, server, model, loadId, signal);
      settled = true;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (settled) this.ledger?.settle(server, 'job', loadId);
    }
    if (terminal.event === 'failed') {
      throw new CrucibleChatError(500, terminal.data.error.code, `Loading ${model} on "${server}" failed: ${terminal.data.error.message}`, server);
    }
    if (terminal.event === 'cancelled') {
      if (signal?.aborted) throw new CrucibleChatCancelled();
      throw new CrucibleChatError(409, 'load_cancelled', `Loading ${model} on "${server}" was cancelled on the server.`, server);
    }
    this.modelsCache.delete(server);
    if (!lease) {
      throwIfAborted(signal);
      return null;
    }
    // A cancel that lands as the load finishes must still give back the lease
    // the load took: it is in no hold yet, so nothing else would release it
    // and the card stays pinned for another app until its TTL runs out.
    if (signal?.aborted) {
      await this.releaseOrphanLease(client, server, model, loadId);
      throw new CrucibleChatCancelled();
    }
    const status = await client.job(loadId);
    if (status.leaseId === null) {
      this.logger.warn(`[${server}] load of ${model} finished without the lease it was asked for; chatting unprotected`);
    } else {
      this.recordLease(server, model, status.leaseId);
    }
    if (signal?.aborted) {
      if (status.leaseId !== null) await this.releaseLeaseQuietly(client, server, status.leaseId);
      throw new CrucibleChatCancelled();
    }
    return status.leaseId;
  }

  /**
   * A load job's events to its terminal one. A stream that drops for weather
   * is opened again after the last event seen; lost past the budget, the load
   * is cancelled best-effort (the ledger keeps its row for the sweep when the
   * server can't be told) and the call is `unreachable`.
   */
  private async followLoad(client: CrucibleClient, server: string, model: string, loadId: string, signal: AbortSignal | undefined): Promise<JobEvent> {
    const { firstMs, maxMs, budgetMs } = this.loadStreamRetry;
    let lastEventId = 0;
    let droppedAt: number | null = null;
    let wait = firstMs;
    for (;;) {
      try {
        for await (const event of client.events(loadId, lastEventId > 0 ? { lastEventId } : {})) {
          this.touch();
          lastEventId = event.id;
          droppedAt = null;
          wait = firstMs;
          if (event.event === 'failed' || event.event === 'cancelled' || event.event === 'done') return event;
        }
        throw new CrucibleUnreachable('', `the event stream for load ${loadId} ended with no terminal event`);
      } catch (err) {
        if (signal?.aborted) throw new CrucibleChatCancelled();
        const wire = crucibleUnavailableCause(err);
        if (wire === null) throw this.mapRefusal(err, server);
        const now = this.now();
        droppedAt ??= now;
        if (now - droppedAt + wait > budgetMs) {
          void client.cancel(loadId).then(() => this.ledger?.settle(server, 'job', loadId), () => undefined);
          throw new CrucibleChatError(0, 'unreachable',
            `Crucible "${server}" isn't answering (lost the load of ${model} for ${Math.round((now - droppedAt) / 1000)} s: ${wire}).`, server);
        }
        this.logger.warn(`[${server}] the event stream of load ${loadId} dropped (${wire}); following it again after event ${lastEventId} in ${Math.round(wait / 100) / 10} s`);
        await sleep(wait, signal);
        wait = Math.min(wait * 2, maxMs);
      }
    }
  }

  /** A "not now" from the server (unreachable, 5xx, a dead socket) as the chat error a queue run parks on. */
  private asUnreachable(err: unknown, server: string): unknown {
    if (err instanceof CrucibleChatError || err instanceof CrucibleChatCancelled || err instanceof CrucibleBusyError) return err;
    const wire = crucibleUnavailableCause(err);
    if (wire === null) return err;
    return new CrucibleChatError(0, 'unreachable', `Crucible "${server}" isn't answering (${wire}).`, server);
  }

  private async releaseOrphanLease(client: CrucibleClient, server: string, model: string, loadId: string): Promise<void> {
    try {
      const status = await client.job(loadId);
      if (status.leaseId === null) return;
      this.recordLease(server, model, status.leaseId);
      await this.releaseLeaseQuietly(client, server, status.leaseId);
    } catch (err) {
      this.logger.warn(`[${server}] could not look up the lease of cancelled load ${loadId}: ${(err as Error).message} (it expires on its own)`);
    }
  }

  /** Release a lease no hold owns; kept in the ledger for a sweep when the server can't be told. */
  private async releaseLeaseQuietly(client: CrucibleClient, server: string, leaseId: string): Promise<void> {
    try {
      await client.release(leaseId);
      this.ledger?.settle(server, 'lease', leaseId);
    } catch (err) {
      if (err instanceof CrucibleRefused && (err.code === 'unknown_lease' || err.status === 404)) {
        this.ledger?.settle(server, 'lease', leaseId);
        return;
      }
      this.logger.warn(`[${server}] releasing ${leaseId} after a cancel failed: ${(err as Error).message} (it expires on its own)`);
    }
  }

  private recordLease(server: string, model: string, leaseId: string): void {
    this.ledger?.record({ server, kind: 'lease', id: leaseId, jobType: 'lease', model, localId: this.localId() });
  }

  private mapRefusal(err: unknown, server: string): Error {
    const line = busyLineOfRefusal(err);
    if (line !== null) return new CrucibleBusyError(server, line);
    if (err instanceof CrucibleRefused) return new CrucibleChatError(err.status, err.code, err.serverMessage, server, null, err.details);
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Renew `hold`'s lease every {@link heartbeatMs}. A beat that fails for
   * weather is not a lost lease: it is tried again every
   * {@link heartbeatRetryMs} for as long as the last renewal still covers it.
   * `unknown_lease` is the server saying it is gone. Running out of TTL
   * unrenewed is this side giving up: the lease is released best-effort (it may
   * still be open there) and the next call re-takes one.
   */
  private startHeartbeat(hold: Held): void {
    let renewedAt = this.now();
    const schedule = (ms: number): void => {
      if (hold.stopped) return;
      hold.beat = setTimeout(() => void tick(), ms);
      hold.beat.unref?.();
    };
    const tick = async (): Promise<void> => {
      if (hold.stopped) return;
      try {
        const client = await this.servers.clientFor(hold.server);
        await client.heartbeat(hold.leaseId!);
        renewedAt = this.now();
        schedule(this.heartbeatMs);
      } catch (err) {
        if (hold.stopped) return;
        const why = (err as Error).message;
        if (isUnknownLease(err)) {
          hold.lost = true;
          // The server no longer holds it for us: nothing left for a sweep to release.
          this.ledger?.settle(hold.server, 'lease', hold.leaseId!);
          this.logger.warn(`[${hold.server}] lease on ${hold.model} is gone (${why}); the next call re-takes it`);
          return;
        }
        if (this.now() + this.heartbeatRetryMs < renewedAt + this.leaseTtlMs) {
          this.logger.warn(`[${hold.server}] heartbeat of ${hold.leaseId} failed (${why}); trying again in ${Math.round(this.heartbeatRetryMs / 100) / 10} s`);
          schedule(this.heartbeatRetryMs);
          return;
        }
        hold.lost = true;
        hold.mayStillHold = true;
        this.logger.warn(`[${hold.server}] lease on ${hold.model} could not be renewed within its TTL (${why}); releasing it, and the next call re-takes one`);
        await this.releaseGivenUp(hold);
      }
    };
    schedule(this.heartbeatMs);
  }

  /**
   * Best-effort release of a lease this side gave up on. When it can't be
   * told, the ledger keeps the row for the sweep and the id is remembered, so
   * a re-lease refused `leased` naming it is recognised as ours.
   */
  private async releaseGivenUp(hold: Held): Promise<void> {
    if (!hold.mayStillHold || hold.leaseId === null) return;
    try {
      const client = await this.servers.clientFor(hold.server);
      await client.release(hold.leaseId);
      hold.mayStillHold = false;
      this.ledger?.settle(hold.server, 'lease', hold.leaseId);
      this.logger.log(`[${hold.server}] released given-up lease ${hold.leaseId}`);
    } catch (err) {
      if (isUnknownLease(err)) {
        hold.mayStillHold = false;
        this.ledger?.settle(hold.server, 'lease', hold.leaseId);
        return;
      }
      this.staleLeases.set(hold.server, hold.leaseId);
      this.logger.warn(`[${hold.server}] releasing given-up lease ${hold.leaseId} failed: ${(err as Error).message} (kept for the sweep; it expires on its own)`);
    }
  }

  private forgetHold(server: string, model: string): void {
    const scope = this.runs.getStore();
    const held = scope?.held.get(server);
    if (held !== undefined && held.model === model) held.lost = true;
  }

  private async releaseHold(scope: RunScope, hold: Held): Promise<void> {
    hold.stopped = true;
    if (hold.beat !== null) clearTimeout(hold.beat);
    scope.held.delete(hold.server);
    if (hold.lost) {
      // Given up on but maybe still open there: one more try, before it is re-taken.
      await this.releaseGivenUp(hold);
      return;
    }
    if (hold.leaseId === null) return;
    try {
      const client = await this.servers.clientFor(hold.server);
      await client.release(hold.leaseId);
      this.ledger?.settle(hold.server, 'lease', hold.leaseId);
      this.logger.log(`[${hold.server}] released ${hold.model} (${hold.leaseId})`);
    } catch (err) {
      if (err instanceof CrucibleRefused && (err.code === 'unknown_lease' || err.status === 404)) {
        this.ledger?.settle(hold.server, 'lease', hold.leaseId);
        return;
      }
      // Kept in the ledger: the quit or startup sweep releases it (or it expires on its own).
      this.logger.warn(`[${hold.server}] releasing ${hold.leaseId} failed: ${(err as Error).message} (it expires on its own)`);
    }
  }

  private async releaseScope(scope: RunScope): Promise<void> {
    await scope.lock.catch(() => undefined);
    for (const hold of [...scope.held.values()]) await this.releaseHold(scope, hold);
  }
}
