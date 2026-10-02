/**
 * EVERY LLM CALL BRIEFCASE MAKES THROUGH CRUCIBLE (migration plan §6.1, P3).
 *
 *   chat({server?, model, messages | prompt, responseFormat?, maxTokens?, temperature?, signal})
 *   withModel(server | undefined, model, fn)   hold one model, in a session, for a multi-call run
 *   withRun(fn)                                 the same, with the model(s) taken lazily per call
 *
 * VENUE. An explicit `server`, else the server a surrounding run already holds
 * the model on, else the SELECTED server (Settings › Crucible Servers) when it
 * answers. It is asked even when it can't serve the target, so the refusal the
 * user sees is the server's own sentence ("anthropic has no key") rather than
 * a guess. Work never moves to another server on its own.
 *
 * LOCAL MODELS are made resident with a `load-model` job (its events followed
 * to the end). Inside a run, the server is held with a QUEUE SESSION
 * (Crucible 1.0.76, docs/QUEUE.md; leases are gone): one per server per run,
 * opened before the first local call. It waits its turn in Crucible's line
 * (the task told its place), and once open nothing from another app runs on
 * that server until it closes. Every request this client sends is an item of
 * it (Crucible matches on the client name), so loads, chats and decides need
 * no change. It is touched every 30 s, so a run waiting on a cloud model is
 * not closed as idle, and closed when the run settles. A session the server
 * ends (idle, the operator, a restart) is opened again by the next call. A
 * chat that meets `409 model_not_resident` re-ensures once and retries. A
 * load refused busy, or a session taken out of the line, is a typed
 * {@link CrucibleBusyError} carrying the reason; the caller may ask to wait it
 * out (`busyWait`), and a queue run parks on it.
 *
 * `503 chat_queue_full` is retried after the server's `Retry-After`, which is
 * read from the raw response: SDK `chat()` drops it, so the chat door is
 * called through {@link CrucibleClientFactory.engineFetch}, the factory's one
 * raw door, and the token stays in the factory.
 *
 * UPSTREAMS (`anthropic/`, `openai/`, `ollama/`) are forwarded by the server
 * with no load and no session. The body rules (no sampling to cloud, ever) live
 * in target.ts.
 *
 * AN OLLAMA CHOICE runs on the server's own model when it has one
 * ({@link CrucibleChatService.effectiveTarget}, rule in ollama-map.ts): the
 * first ranked server that answers and has a match serves it as a local model
 * (loaded in the run's session like any other); only with no match anywhere does it go to
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
 * load job, takes a waiting session out of the line, and ends any busy or
 * queue-full wait at once. A run's session is closed in its `finally`.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CrucibleBusy,
  CrucibleCardHeld,
  CrucibleRefused,
  CrucibleSessionClosed,
  CrucibleSessionHeld,
  CrucibleUnreachable,
  type CrucibleClient,
  type CrucibleSession,
  type JobEvent,
  type ModelInfo,
} from '@crucible/client';
import { crucibleUnavailableCause } from '../transport-failure';
import { CrucibleClientFactory } from '../client-factory';
import { CrucibleServersService } from '../crucible-servers.service';
import { CrucibleProbeService, compareVersions } from '../probe';
import { QUEUE_HEARTBEAT_MS, cardWaitLine, cardWaitOf } from '../crucible-queue';
import type { InFlightLedger } from '../in-flight-ledger';
import { CRUCIBLE_IN_FLIGHT_LEDGER } from '../crucible.constants';
import {
  CrucibleBusyError,
  CrucibleChatCancelled,
  CrucibleChatError,
  CrucibleNoVenueError,
  BUSY_REFUSAL_CODES,
  parseRetryAfter,
} from './errors';
import { RETIRED_LOCAL_MODELS, buildChatBody, crucibleTargetOf, type ChatBodyInput, type CrucibleTarget, type UpstreamName } from './target';
import { CRUCIBLE_ANALYSIS_CONTEXT, crucibleChoiceForOllama, isPageReader, servedContextOf, type MappableModel } from './ollama-map';

/** Capability class sent as `X-Crucible-Act` and as every session's act. */
export const BRIEFCASE_ACT = 'analysis';
/**
 * How often an open session is touched. Crucible closes a session after its
 * idleS (default 300 s) with nothing in flight; work on this side (a cloud
 * model call, an ffmpeg step) is invisible to it, so the run says it is here.
 */
export const HEARTBEAT_MS = 30_000;
/** How long a local chat may wait in Crucible's line before the server ends it as `removed_from_queue`. */
export const CHAT_QUEUE_WAIT_S = 600;
/** How long a cancelled run waits for the server's answer to its session open, so it can close what it opened. */
export const OPEN_ANSWER_GRACE_MS = 2_000;
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
  model: Pick<MappableModel, 'id' | 'modalities' | 'weightsOf' | 'classes'>,
  pageReaders: Iterable<string> | null,
): boolean {
  if (!model.modalities.includes('text')) return false;
  const readers = pageReaders === null ? null : new Set(pageReaders);
  return !isPageReader(model, readers);
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

/** A chat's `usage`, each count null where the server did not state it (never an invented 0). */
export interface CrucibleChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface CrucibleChatResult {
  text: string;
  /** The model string that was sent. */
  model: string;
  target: CrucibleTarget;
  server: string;
  /** The reply's `finish_reason`, always stated (a reply without one is refused). */
  finishReason: string;
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

/** A model made resident on a server inside a run's session. */
interface Held {
  server: string;
  model: string;
  /** The context it was loaded with when a caller asked for one; null: whatever was resident. */
  context: number | null;
  /** The session it was made resident in: a later session checks it again. */
  sessionId: string;
  /** Said not resident since (someone's load evicted it): made resident again by the next call. */
  lost: boolean;
}

/** A run's queue session on one server. */
interface OpenSession {
  server: string;
  session: CrucibleSession;
  /** The touch timer. */
  beat: NodeJS.Timeout | null;
  /** The server ended it (idle, the operator, a restart): the next call opens another. */
  ended: boolean;
  /** Closed by the run: the touch stops. */
  stopped: boolean;
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
  /** A line for the task while a load waits in Crucible's queue ("Waiting in Crucible's queue on mac (2 of 3)"). */
  onWaiting?: (message: string) => void;
  /** Briefcase's id for the work, written on every ledger row. */
  localId?: string;
}

interface RunScope {
  /** One resident model per server (one card each). */
  held: Map<string, Held>;
  /** The run's queue session on each server it touched. */
  sessions: Map<string, OpenSession>;
  options: RunOptions;
  /** Set when a call inside the run chose to park: the queue reads it after the task returns. */
  parked: { server: string | null; reason: string } | null;
  /** The server each model was placed on in this run, so a run never moves mid-way (not even when the user switches servers). */
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

/** The "card is briefly someone else's" codes live in ./errors (shared with asr); re-exported for this file's callers. */
export { BUSY_REFUSAL_CODES };

function busyLineOfRefusal(err: unknown): string | null {
  if (err instanceof CrucibleBusy) return err.busyLine;
  if (err instanceof CrucibleSessionHeld) return err.serverMessage;
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
  /** How often an open session is touched ({@link HEARTBEAT_MS}). */
  heartbeatMs = HEARTBEAT_MS;
  /**
   * Re-following a load's dropped event stream (BookForge's stream-reconnect):
   * the first wait, the cap the waits double up to, and the budget from the
   * drop (reset by any event) after which the server counts as unreachable.
   */
  loadStreamRetry = { ...LOAD_STREAM_RETRY };
  /** The bounded wait of a reload after `model_not_resident` ({@link RELOAD_BUSY_WAIT}). */
  reloadBusyWait: BusyWait = { ...RELOAD_BUSY_WAIT };

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly factory: CrucibleClientFactory,
    private readonly probes: CrucibleProbeService,
    /** P4: every load job and session is written here the moment the server admits it. */
    @Optional() @Inject(CRUCIBLE_IN_FLIGHT_LEDGER) private readonly ledger?: InFlightLedger,
  ) {}

  // ── the run scope ──────────────────────────────────────────────────────

  /**
   * Run `fn` as ONE run: every server a local call inside it needs is held
   * with one queue session (opened in Crucible's line, touched, closed when
   * `fn` settles: success, failure or cancel), and each local model is loaded
   * once in it. Nested calls join the outer run.
   */
  async withRun<T>(fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    if (this.runs.getStore() !== undefined) return fn();
    const scope: RunScope = { held: new Map(), sessions: new Map(), placed: new Map(), mapped: new Map(), lock: Promise.resolve(), options, parked: null };
    const run = (async () => {
      try {
        return await this.runs.run(scope, fn);
      } finally {
        await this.releaseScope(scope);
      }
    })();
    const settled = run.then(() => undefined, () => undefined);
    this.openRuns.add(settled);
    void settled.then(() => this.openRuns.delete(settled));
    return run;
  }

  /** Every top-level run not yet settled (its release included). */
  private readonly openRuns = new Set<Promise<void>>();

  /**
   * Wait, at most `ms`, for every open run to settle, its own release
   * included. The quit path aborts the runs first and then calls this, so a
   * session the server opens AFTER the quit began (a request already in
   * flight) is closed by its run before the process exits. True when all settled.
   */
  async runsSettled(ms: number): Promise<boolean> {
    if (this.openRuns.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.all([...this.openRuns]).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return settled;
  }

  /**
   * Hold `model` (in the run's session, if local) for the whole of `fn`. `server` pins the
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
  heldInRun(): Array<{ server: string; model: string; sessionId: string | null }> {
    const scope = this.runs.getStore();
    if (scope === undefined) return [];
    return [...scope.held.values()].map(({ server, model }) => ({ server, model, sessionId: scope.sessions.get(server)?.session.id ?? null }));
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
    // A local chat may wait in Crucible's line (the default since 1.0.79):
    // behind another app's session when it is outside ours. Its wait is
    // bounded on the server, so a long one ends as a clean
    // `removed_from_queue` (busy) rather than as our read timeout, which is
    // then sized for the wait AND the answer. Inside our session it waits for
    // nobody, so the bound costs nothing there.
    if (target.route === 'local') body['queue'] = { max_wait_s: CHAT_QUEUE_WAIT_S };
    const timeoutMs = request.timeoutMs
      ?? (target.route === 'local' ? localTimeoutMs(promptChars) + CHAT_QUEUE_WAIT_S * 1000 : UPSTREAM_TIMEOUT_MS);

    // A row that states no served context is loaded at the host's stated
    // ceiling (statedLocalContext), so the window it was sized for is real. A
    // catalog that can't be read here is read again by the load, which
    // reports the failure in its own terms.
    const loadContext = request.loadContext ?? chosen.loadContext
      ?? (target.route === 'local' ? (await this.statedLocalContext(server, target.model).catch(() => null))?.loadAt : undefined);
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
      // Its bounded wait ran out (or the operator took it out of the line):
      // nothing reached the engine. Busy, never a failure.
      if (failure.code === 'removed_from_queue') {
        throw new CrucibleBusyError(server, `the chat waited past ${CHAT_QUEUE_WAIT_S} s in Crucible's line: ${failure.message}`);
      }
      if (failure.code === 'model_not_resident' && target.route === 'local' && !reloaded) {
        reloaded = true;
        this.logger.warn(`[${server}] ${target.model} is no longer resident (${failure.message}); loading it again`);
        this.forgetHold(server, target.model);
        await this.ensureLocal(server, target.model, signal, longerWait(request.busyWait, this.reloadBusyWait), loadContext);
        continue;
      }
      // The chat door refusing because the card is someone else's right now
      // (a claim, another app's session): busy, the same as at the load. Never a failure.
      if (BUSY_REFUSAL_CODES.has(failure.code)) throw new CrucibleBusyError(server, failure.message);
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
    // Load-bearing (the SDK's rule too): the first choice, its message, its
    // content and its finish_reason. Each is refused BY NAME when absent,
    // never defaulted: an empty answer or a 'stop' nobody said would hide a
    // broken reply or a truncated one. `content: null` is the chat format's
    // own "no text" and reads as ''.
    const refuse = (field: string): CrucibleChatError => new CrucibleChatError(502, 'protocol_error',
      `Crucible "${server}" answered a chat without ${field}, which Briefcase needs to read the reply.`, server);
    const choices = doc['choices'];
    if (!Array.isArray(choices) || choices.length === 0) throw refuse('choices[0]');
    const first = choices[0] as unknown;
    if (first === null || typeof first !== 'object') throw refuse('choices[0]');
    const choice = first as Record<string, unknown>;
    const rawMessage = choice['message'];
    if (rawMessage === null || typeof rawMessage !== 'object') throw refuse('choices[0].message');
    const message = rawMessage as Record<string, unknown>;
    const content = message['content'];
    if (content !== null && typeof content !== 'string') throw refuse('choices[0].message.content');
    const finishReason = choice['finish_reason'];
    if (typeof finishReason !== 'string') throw refuse('choices[0].finish_reason');
    let text = content ?? '';
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
    const usageDoc = doc['usage'];
    const count = (key: string): number | null => {
      const value = (usageDoc as Record<string, unknown>)[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    };
    let usage: CrucibleChatUsage | null = null;
    if (usageDoc !== null && typeof usageDoc === 'object') {
      const promptTokens = count('prompt_tokens');
      const completionTokens = count('completion_tokens');
      const stated = count('total_tokens');
      usage = {
        promptTokens,
        completionTokens,
        totalTokens: stated ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
      };
    }
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
      finishReason,
      usage,
      sampling,
      fromReasoning,
      context,
    };
  }

  // ── an ollama choice, on Crucible's own model ─────────────────────────

  /**
   * What `target` runs as. Anything but `ollama/<tag>` is itself. An Ollama
   * tag is looked up on `server` (when the caller pinned one), else on the
   * selected server when it answers; a matching local model there
   * (ollama-map.ts) serves it as that model. No match: the `ollama/` upstream,
   * as chosen. Inside a run the answer is kept, so a run
   * never switches models between calls.
   */
  async effectiveTarget(target: CrucibleTarget, server?: string): Promise<EffectiveTarget> {
    if (target.route === 'local' && RETIRED_LOCAL_MODELS[target.model] !== undefined) return this.replacementTarget(target, server);
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
        const selected = this.servers.selected();
        const answer = await this.probes.reach(selected);
        if (answer.reach === 'ready' || answer.reach === 'busy') candidates.push(selected);
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
      else this.logger.log(`${target.model}: the selected Crucible server has no model of its own for it, so it goes to Ollama through Crucible`);
    }
    scope?.mapped.set(key, chosen);
    return chosen;
  }

  /**
   * A retired Crucible model (RETIRED_LOCAL_MODELS) runs as its replacement on
   * a server that no longer has it installed and does have the replacement.
   * Where the retired model is still installed, or the replacement is not,
   * the target is taken as it is (and the server answers for it as for any
   * model).
   */
  private async replacementTarget(target: CrucibleTarget, server?: string): Promise<EffectiveTarget> {
    const scope = this.runs.getStore();
    const key = `${server ?? ''}\n${target.model}`;
    const kept = scope?.mapped.get(key);
    if (kept !== undefined) return kept;
    const replacement = RETIRED_LOCAL_MODELS[target.model]!;
    let name: string | null = server ?? null;
    if (name === null) {
      try {
        name = this.servers.selected();
      } catch {
        name = null;
      }
    }
    let chosen: EffectiveTarget = { target, server: null, mappedFrom: null };
    if (name !== null) {
      try {
        const models = await this.modelsOn(name);
        const installed = (id: string) => models.some((m) => m.id === id && m.installed === true);
        if (!installed(target.model) && installed(replacement)) {
          chosen = { target: { model: replacement, route: 'local', upstream: null, bareModel: replacement }, server: name, mappedFrom: target.model };
          const note = `${name}\n${target.model}`;
          if (!this.mappingNoted.has(note)) {
            this.mappingNoted.add(note);
            this.logger.log(`[${name}] ${target.model} is no longer on this server; it runs as ${replacement}`);
          }
        }
      } catch {
        // The listing could not be read: the target as it is, and the server answers for it.
      }
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
      if (generate?.contextCeilings) {
        // A row that names no model or states no tokens (both informational
        // since 1.0.25) is no ceiling at all: left out, never guessed.
        ceilings = new Map();
        for (const c of generate.contextCeilings) if (c.model !== null && c.tokens !== null) ceilings.set(c.model, c.tokens);
      }
    } catch {
      readers = null;
    }
    const entry = { at: this.now(), readers, ceilings };
    this.pagesCache.set(server, entry);
    return entry;
  }

  // ── venue ──────────────────────────────────────────────────────────────

  /**
   * The selected server, when it answers. It is returned even when it can't
   * serve `target`, so its own refusal names the fix. Never another server.
   */
  async venueFor(_target: CrucibleTarget): Promise<string> {
    let selected: string;
    try {
      selected = this.servers.selected();
    } catch (err) {
      throw new CrucibleNoVenueError((err as Error).message);
    }
    const answer = await this.probes.reach(selected);
    if (answer.reach === 'ready' || answer.reach === 'busy') return selected;
    throw new CrucibleNoVenueError(
      `Crucible on ${selected} isn't answering (${answer.reach.replace(/_/g, ' ')}). Check it is running, or select another server in Settings › Crucible Servers.`,
    );
  }

  async canServe(server: string, target: CrucibleTarget): Promise<boolean> {
    try {
      if (target.route === 'upstream') {
        const configured = await this.upstreamsConfigured(server);
        return configured[target.upstream!] === true;
      }
      const models = await this.modelsOn(server);
      // Resident is strict and settles it; otherwise only a STATED backend
      // support and install count (null since 1.0.25 = the server did not say).
      return models.some((m) => m.id === target.model && (m.resident || (m.backendSupported === true && m.installed === true)));
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
    // A null card is an upstream this server does not offer (SettingsDocument.upstreams): not configured.
    const configured = {
      anthropic: doc.upstreams.anthropic?.configured === true,
      openai: doc.upstreams.openai?.configured === true,
      ollama: doc.upstreams.ollama?.configured === true,
    };
    this.settingsCache.set(server, { at: this.now(), configured });
    return configured;
  }

  /**
   * The context a local model is served at on `server`, from what the server
   * STATES, never a guess: the row's served context (`maxModelLen` /
   * `contextDefault`); else, when the row states neither, this host's ceiling
   * for it (the `generate` class's `context_ceilings`, the per-host
   * max_context), capped at the analysis window and returned as `loadAt` — the
   * call must then LOAD it at that context (load-model `params.context`), since
   * a model loaded without one serves a default nobody stated. Null when the
   * server states none of them, or does not list the model.
   */
  async statedLocalContext(server: string, model: string): Promise<{ tokens: number; loadAt?: number } | null> {
    const info = (await this.modelsOn(server)).find((m) => m.id === model);
    if (info === undefined) return null;
    const served = servedContextOf(info);
    if (served !== null) return { tokens: served };
    const ceiling = (await this.classFactsOn(server)).ceilings?.get(model);
    if (ceiling === undefined) return null;
    const tokens = Math.min(ceiling, CRUCIBLE_ANALYSIS_CONTEXT);
    return { tokens, loadAt: tokens };
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

  // ── residency and sessions ─────────────────────────────────────────────

  /**
   * Make `model` resident on `server`. Inside a run, in the run's queue
   * session on that server (opened first), so nothing else evicts it until
   * the run ends. Outside a run it is only loaded.
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
      await this.makeResident(server, model, signal, loadContext).catch((err: unknown) => { throw this.asUnreachable(err, server); });
      return;
    }
    const run = scope.lock.then(async () => {
      const open = await this.sessionFor(scope, server, signal);
      const held = scope.held.get(server);
      if (held !== undefined && held.model === model && !held.lost && held.sessionId === open.session.id) {
        // Held already; a caller that needs a bigger window than it was taken at gets a reload.
        if (loadContext === undefined || (held.context !== null && held.context >= loadContext)) return;
        if (!(await this.residentTooSmall(server, model, loadContext))) {
          held.context = loadContext;
          return;
        }
      }
      scope.held.delete(server);
      await this.makeResident(server, model, signal, loadContext).catch((err: unknown) => { throw this.asUnreachable(err, server); });
      scope.held.set(server, { server, model, context: loadContext ?? null, sessionId: open.session.id, lost: false });
      // The session's row names the model it now holds: a sweep after a kill
      // may unload only a model one of our rows names.
      this.ledger?.record({ server, kind: 'session', id: open.session.id, jobType: 'session', model, localId: this.localId() });
    });
    scope.lock = run.catch(() => undefined);
    await run;
  }

  /**
   * The run's open session on `server`, opened (waiting its turn in Crucible's
   * line) when it has none or the server ended it. The open itself answers at
   * once (queued or open), so a quit that lands in it leaves at most a session
   * the server opened after we stopped listening; with nothing in it, the
   * server closes it on its own after its idleS (300 s). While it waits, the task is
   * told its place and the stall watchdog that it is alive. A cancel takes it
   * out of the line. Taken out by anyone else (expired, the operator, a
   * restart), or refused because another app's session holds the server: busy,
   * so a queue run parks.
   */
  private async sessionFor(scope: RunScope, server: string, signal?: AbortSignal): Promise<OpenSession> {
    const existing = scope.sessions.get(server);
    if (existing !== undefined && !existing.ended) return existing;
    if (existing !== undefined) this.stopSession(existing);
    throwIfAborted(signal);
    const client = await this.servers.clientFor(server);
    let waited = false;
    // The open is not aborted mid-request: a session the server opened after we
    // stopped listening could not be closed (its id never reaches us). A cancel
    // before the server has answered lets the answer come (bounded), then the
    // session is closed; one already in the line leaves it at once.
    const wait = new AbortController();
    let cancelledEarly = false;
    const onAbort = (): void => {
      if (waited) {
        wait.abort(signal?.reason);
        return;
      }
      cancelledEarly = true;
      setTimeout(() => wait.abort(signal?.reason), OPEN_ANSWER_GRACE_MS).unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const alive = setInterval(() => this.touch(), QUEUE_HEARTBEAT_MS);
    let session: CrucibleSession;
    try {
      session = await client.session({
        act: BRIEFCASE_ACT,
        // 1.0.83: opening, but the card is held by a process Crucible does not own.
        onWaiting: (wait) => {
          waited = true;
          this.touch();
          this.waiting(cardWaitLine(server, wait.message));
        },
        onQueue: ({ position, of }) => {
          waited = true;
          if (cancelledEarly) {
            wait.abort(signal?.reason);
            return;
          }
          this.touch();
          this.waiting(`Waiting in Crucible's queue on ${server} (${position} of ${of})`);
        },
        signal: wait.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new CrucibleChatCancelled();
      if (err instanceof CrucibleSessionClosed) {
        throw new CrucibleBusyError(server, `Crucible ended the wait for a session (${err.reason}): ${err.serverMessage}`);
      }
      throw this.asUnreachable(this.mapRefusal(err, server), server);
    } finally {
      clearInterval(alive);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) {
      await session.close().catch(() => undefined);
      this.logger.log(`[${server}] session ${session.id} opened as the run was cancelled; closed it`);
      throw new CrucibleChatCancelled();
    }
    this.ledger?.record({ server, kind: 'session', id: session.id, jobType: 'session', model: null, localId: this.localId() });
    if (waited) this.waiting(`Starting on ${server}...`);
    this.logger.log(`[${server}] session ${session.id} open`);
    const open: OpenSession = { server, session, beat: null, ended: false, stopped: false };
    void session.closed.then((end) => {
      open.ended = true;
      if (open.stopped) return;
      this.stopSession(open);
      this.ledger?.settle(server, 'session', session.id);
      this.modelsCache.delete(server);
      this.logger.warn(`[${server}] Crucible ended session ${session.id} (${end.reason}): ${end.message}; the next call opens another`);
    });
    open.beat = setInterval(() => {
      void session.touch().catch((err: unknown) => {
        if (err instanceof CrucibleSessionClosed) open.ended = true;
        else this.logger.warn(`[${server}] touching session ${session.id} failed: ${(err as Error).message}`);
      });
    }, this.heartbeatMs);
    open.beat.unref?.();
    scope.sessions.set(server, open);
    return open;
  }

  private stopSession(open: OpenSession): void {
    open.stopped = true;
    if (open.beat !== null) clearInterval(open.beat);
    open.beat = null;
  }

  /** True when `model` is resident on `server` at a context under `loadContext` (a reload would be needed). */
  private async residentTooSmall(server: string, model: string, loadContext: number): Promise<boolean> {
    try {
      const info = (await this.modelsOn(server, true)).find((m) => m.id === model);
      return info !== undefined && info.resident && (info.maxModelLen ?? 0) < loadContext;
    } catch {
      return false;
    }
  }

  /** Resident, by a `load-model` job when it is not (inside a run's session, nothing else then evicts it). */
  private async makeResident(server: string, model: string, signal: AbortSignal | undefined, loadContext?: number): Promise<void> {
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
      await this.load(client, server, model, signal, loadContext);
      return;
    }
    if (info.resident) return;
    // Refused here only on what the server STATED (false). Unstated (null,
    // 1.0.25+) goes to the load, and the server's own refusal names the cause.
    if (info.backendSupported === false || info.installed === false) {
      const unsupported = info.installed !== false;
      throw new CrucibleChatError(409, unsupported ? 'unsupported_model' : 'model_not_installed',
        `"${model}" ${unsupported ? `can't run on "${server}"` : `isn't downloaded on "${server}"`}`
          + `${info.reason ? ` (${info.reason})` : ''}. Pick another model, or download it in Settings › AI.`, server);
    }
    await this.load(client, server, model, signal, loadContext);
  }

  private async load(client: CrucibleClient, server: string, model: string, signal: AbortSignal | undefined, context?: number): Promise<void> {
    let loadId: string;
    try {
      // The SDK submits a load with `queue`: inside our session it runs ahead
      // of the line; outside one, a busy card puts it in the line (QUEUE.md).
      loadId = await client.loadModel(model, context === undefined ? undefined : { context });
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
      // Failed at the front of the line because the card is busy after all
      // (another process holds its memory): busy, not a failure.
      if (BUSY_REFUSAL_CODES.has(terminal.data.error.code)) throw new CrucibleBusyError(server, terminal.data.error.message);
      throw new CrucibleChatError(500, terminal.data.error.code, `Loading ${model} on "${server}" failed: ${terminal.data.error.message}`, server);
    }
    // Taken out of Crucible's queue before it ran (it waited past its limit,
    // the operator removed it, the server restarted): not run, not failed.
    // Busy, so a queue run parks and asks again later.
    if (terminal.event === 'removed') {
      if (signal?.aborted) throw new CrucibleChatCancelled();
      throw new CrucibleBusyError(server, `the load of ${model} was taken out of Crucible's queue (${terminal.data.reason}): ${terminal.data.message}`);
    }
    if (terminal.event === 'cancelled') {
      if (signal?.aborted) throw new CrucibleChatCancelled();
      throw new CrucibleChatError(409, 'load_cancelled', `Loading ${model} on "${server}" was cancelled on the server.`, server);
    }
    this.modelsCache.delete(server);
    // A cancel that lands as the load finishes leaves the model on the card
    // with nothing using it: Crucible never clears a load's own result, so this
    // side asks for the unload it would otherwise never get.
    if (signal?.aborted) {
      await this.unloadOrphanLoad(client, server, model);
      throw new CrucibleChatCancelled();
    }
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
    // While the load waits in Crucible's queue the stream is quiet between
    // moves. Waiting in line is headway: the stall watchdog is told so.
    let inLine: NodeJS.Timeout | null = null;
    /** The task was told it waits (its place, or the card): the next event says the load goes on. */
    let shownWait = false;
    const leaveLine = (): void => {
      if (inLine !== null) clearInterval(inLine);
      inLine = null;
    };
    try {
      for (;;) {
        try {
          for await (const event of client.events(loadId, lastEventId > 0 ? { lastEventId } : {})) {
            this.touch();
            lastEventId = event.id;
            droppedAt = null;
            wait = firstMs;
            const card = cardWaitOf(event, server);
            // Position 0 is "not waiting" (every job's first frame before 1.0.71).
            if (event.event === 'queued' && event.data.position > 0) {
              const of = event.data.of;
              this.waiting(`Waiting in Crucible's queue on ${server} (${event.data.position}${of !== null ? ` of ${of}` : ''})`);
              inLine ??= setInterval(() => this.touch(), QUEUE_HEARTBEAT_MS);
              shownWait = true;
            } else if (card !== null) {
              // First in line, waiting for a process Crucible does not own to
              // let go of the card; repeated every 60 s (each one touched above).
              this.waiting(card);
              leaveLine();
              shownWait = true;
            } else if (shownWait) {
              leaveLine();
              shownWait = false;
              this.waiting(`Loading ${model} on ${server}...`);
            }
            if (event.event === 'failed' || event.event === 'cancelled' || event.event === 'done' || event.event === 'removed') return event;
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
    } finally {
      leaveLine();
    }
  }

  /** Tell the run's task what it is waiting for. Never breaks a call. */
  private waiting(message: string): void {
    try {
      this.runs.getStore()?.options.onWaiting?.(message);
    } catch {
      // A display line never breaks a load.
    }
  }

  /** A "not now" from the server (unreachable, 5xx, a dead socket) as the chat error a queue run parks on. */
  private asUnreachable(err: unknown, server: string): unknown {
    if (err instanceof CrucibleChatError || err instanceof CrucibleChatCancelled || err instanceof CrucibleBusyError) return err;
    const wire = crucibleUnavailableCause(err);
    if (wire === null) return err;
    return new CrucibleChatError(0, 'unreachable', `Crucible "${server}" isn't answering (${wire}).`, server);
  }

  /** Unload what a cancelled load put on the card. Refused (someone else is using it): theirs now, left alone. */
  private async unloadOrphanLoad(client: CrucibleClient, server: string, model: string): Promise<void> {
    try {
      const jobId = await client.unloadModel(model);
      this.modelsCache.delete(server);
      this.logger.log(`[${server}] the load of ${model} was cancelled as it finished; asked Crucible to unload it (job ${jobId})`);
    } catch (err) {
      this.logger.warn(`[${server}] unloading ${model} after a cancelled load was refused: ${(err as Error).message}`);
    }
  }

  private mapRefusal(err: unknown, server: string): Error {
    const line = busyLineOfRefusal(err);
    if (line !== null) return new CrucibleBusyError(server, line);
    if (err instanceof CrucibleRefused) return new CrucibleChatError(err.status, err.code, err.serverMessage, server, null, err.details);
    return err instanceof Error ? err : new Error(String(err));
  }

  private forgetHold(server: string, model: string): void {
    const scope = this.runs.getStore();
    const held = scope?.held.get(server);
    if (held !== undefined && held.model === model) held.lost = true;
  }

  /** Close every session the run opened (the server forgets a session it already ended). */
  private async releaseScope(scope: RunScope): Promise<void> {
    await scope.lock.catch(() => undefined);
    scope.held.clear();
    for (const open of [...scope.sessions.values()]) {
      this.stopSession(open);
      scope.sessions.delete(open.server);
      try {
        const end = await open.session.close();
        this.ledger?.settle(open.server, 'session', open.session.id);
        this.logger.log(`[${open.server}] closed session ${open.session.id} (${end.reason}, ${end.itemsRun ?? '?'} item(s))`);
      } catch (err) {
        // Kept in the ledger: the quit or startup sweep closes it (or it idles out on its own).
        this.logger.warn(`[${open.server}] closing session ${open.session.id} failed: ${(err as Error).message} (it closes itself when idle)`);
      }
    }
  }

}
