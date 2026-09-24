/**
 * THE SCORER ON CRUCIBLE (migration plan P6): `withScorer(fn)` handing `fn` a
 * {@link ScorerHandle}. Since P7 it is the only scorer (the scorer's own
 * llama-server is gone). Crucible reserves the card and returns data;
 * chapters, flags and every decision about them stay above the seam, in
 * Briefcase.
 *
 *   decide     `POST /v1/decide` (PHASE22), act `decide`, `missing: "report"`,
 *              read back by crucible-decide.ts (Briefcase's floor policy
 *              client-side, the label-mass gate, the renormalised logprobs
 *              Viterbi needs).
 *   generate   the chat door, act `generate`: thinking off, temperature 0.
 *   tokens     the chat door again, one token of answer: prompt_tokens of the
 *              text less the template's own, measured once per model (exact
 *              to within the template seam).
 *   the lease  ONE hold across the whole chapters + flags pass: the run's
 *              `withModel` (P3), loaded at {@link SCORER_LOAD_CONTEXT} (the
 *              largest chunk state plus its questions), heartbeaten, released
 *              when the pass settles. Inside a queue-admitted run (P4 lanes) a
 *              busy card, a silent server or no server at all PARKS the task.
 *
 * WHICH MODEL. The server's `decide` class must be enabled, and the model a
 * model it can read decisions from (a qwen3.5 / qwen3.8 row, installed and
 * served on this backend: PHASE22 §2.9's family rule). Preferred:
 * `qwen3.5-9b`, the model the chapter benchmark was measured on. THE PICKER
 * RULE (§2.9): a base and its `-vl` alias are two engine forms over the same
 * weights and switching is a full reload, so the form is chosen ONCE per
 * server session — the alias only when it is what is already on the card —
 * and kept.
 *
 * NO FALLBACK (the user's rule, 2026-09-23): when Crucible cannot serve the
 * scorer — no decide model, a server older than the door, decide_not_served —
 * the work fails by name, or parks when the server is merely busy or silent.
 * There is nothing else to switch to.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  type CapabilityRow,
  type CrucibleClient,
  type ModelInfo,
} from '@crucible/client';
import { CrucibleServersService } from '../crucible/crucible-servers.service';
import { CrucibleChatService, localTimeoutMs, MAX_QUEUE_FULL_RETRIES } from '../crucible/llm/crucible-chat.service';
import {
  CrucibleBusyError,
  CrucibleChatCancelled,
  CrucibleChatError,
  CrucibleNoVenueError,
  CrucibleParkedError,
  isParked,
} from '../crucible/llm/errors';
import { crucibleTargetOf } from '../crucible/llm/target';
import { compareVersions } from '../crucible/probe';
import { isVisionAlias } from '../crucible/llm/ollama-map';
import { crucibleUnavailableCause } from '../crucible/transport-failure';
import { fromWireResponse, toWireRequest } from './crucible-decide';
import type { ScorerHandle } from './scorer-handle';
import {
  ChatMessage,
  DecideOptions,
  DecideRequest,
  DecideResponse,
  GenerateOptions,
  GenerateResult,
  ScorerError,
} from './scorer.types';

/** The model the chapter benchmark was measured on: preferred wherever the decide class can use it. */
export const SCORER_PREFERRED_MODEL = 'qwen3.5-9b';
/** The first Crucible with the decision door (and `generate`, and load-time context). */
export const DECIDE_MIN_VERSION = '1.0.24';
/**
 * The window the scorer's model is loaded with: a 16K-token chunk state (the
 * chunk planner's single-chunk ceiling, chunks.ts) plus the flag legend, a
 * question and the outline's answer, with room. Within every host's ceiling
 * for the 9B (PC 65,536; Mac 131,072); a larger one is refused
 * `context_over_limit` by name.
 */
export const SCORER_LOAD_CONTEXT = 32768;
/** The capability classes this seam names its work by (X-Crucible-Act). */
export const DECIDE_ACT = 'decide';
export const GENERATE_ACT = 'generate';
/** Families the decide class reads decisions from (PHASE22 §2.9). */
export const DECIDE_FAMILIES: readonly string[] = ['qwen3.5', 'qwen3.8'];
/** A busy card outside a queue run is asked again this often, for this long (as ai-provider's chats are). */
const BUSY_RETRY_MS = 10_000;
const BUSY_WAIT_MS = 30 * 60_000;
const DEFAULT_QUEUE_FULL_WAIT_MS = 2_000;

export interface CruciblePick {
  server: string;
  model: string;
}

/**
 * A model the decide class can read decisions from, installed and served here
 * — on the row's STATED facts: an unstated family, install or backend support
 * (null, 1.0.25+) does not qualify a model by itself (see pickDecideModel for
 * the server's own selection).
 */
export function isDecideModel(model: Pick<ModelInfo, 'family' | 'installed' | 'backendSupported' | 'modalities'>): boolean {
  return model.family !== null && DECIDE_FAMILIES.includes(model.family.toLowerCase())
    && model.installed === true && model.backendSupported === true && model.modalities.includes('text');
}

/**
 * The decide class's own selection, taken on the server's word where the row
 * does not state family/install/support (null, 1.0.25+): the capability row
 * (enabled + selected, load-bearing) says it serves decisions. A row that
 * STATES a family outside {@link DECIDE_FAMILIES}, or that it is not installed
 * or not supported, is still refused here.
 */
function selectionServes(model: Pick<ModelInfo, 'family' | 'installed' | 'backendSupported' | 'modalities'>): boolean {
  return (model.family === null || DECIDE_FAMILIES.includes(model.family.toLowerCase()))
    && model.modalities.includes('text') && model.installed !== false && model.backendSupported !== false;
}

/**
 * The scorer model on one server. PURE. `kept` is this server session's earlier
 * choice (the picker rule: one form per session); `resident` what is on the
 * card now; `selected` the decide class's own pick.
 */
export function pickDecideModel(
  models: readonly ModelInfo[],
  options: { kept?: string | null; resident?: string | null; selected?: string | null; preferred?: string } = {},
): string | null {
  const usable = new Map(models.filter(isDecideModel).map((m) => [m.id, m]));
  if (options.kept && usable.has(options.kept)) return options.kept;
  const preferred = options.preferred ?? SCORER_PREFERRED_MODEL;
  const aliasOfPreferred = [...usable.values()].find((m) => isVisionAlias(m) && m.weightsOf === preferred);
  // Already on the card as the vision form: use it as it is, no reload.
  if (aliasOfPreferred && options.resident === aliasOfPreferred.id) return aliasOfPreferred.id;
  if (usable.has(preferred)) return preferred;
  if (aliasOfPreferred) return aliasOfPreferred.id;
  if (options.selected && usable.has(options.selected)) return options.selected;
  const selected = options.selected ? models.find((m) => m.id === options.selected) : undefined;
  if (selected !== undefined && selectionServes(selected)) return selected.id;
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScorerError('cancelled', 'cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ScorerError('cancelled', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Aborted when either is: a call's own signal and its run's. */
function eitherSignal(own: AbortSignal | undefined, run: AbortSignal | undefined): AbortSignal | undefined {
  if (own === undefined || own === run) return run;
  if (run === undefined) return own;
  return AbortSignal.any([own, run]);
}

function retryAfterMsOf(err: CrucibleServerError): number {
  const details = err.details as { retry_after?: unknown } | null;
  const secs = typeof details?.retry_after === 'number' ? details.retry_after : null;
  return secs !== null && Number.isFinite(secs) ? Math.min(60_000, Math.max(250, secs * 1000)) : DEFAULT_QUEUE_FULL_WAIT_MS;
}

@Injectable()
export class CrucibleScorerService {
  private readonly logger = new Logger('CrucibleScorer');
  /** Per server: the form chosen this session (the picker rule). */
  private readonly sessionForm = new Map<string, string>();
  /** `server\nmodel` → the chat template's own prompt tokens (countTokens' offset). */
  private readonly templateTokens = new Map<string, number>();

  constructor(
    private readonly chat: CrucibleChatService,
    private readonly servers: CrucibleServersService,
  ) {}

  /**
   * The server and model the scorer runs on, or a named failure. Parks (inside
   * a queue run) when no server answers; fails by name when one answers but
   * cannot serve decisions.
   */
  async pick(signal?: AbortSignal): Promise<CruciblePick> {
    if (signal?.aborted) throw new ScorerError('cancelled', 'cancelled before the scorer started');
    let server: string;
    try {
      // Inside a queue run the lane already reserved a card: the scorer uses that
      // server (one run, one card), never a second one found by rank.
      server = this.chat.heldInRun()[0]?.server ?? await this.chat.venueFor(crucibleTargetOf('local', SCORER_PREFERRED_MODEL));
    } catch (err) {
      throw this.mapFailure(err, null);
    }
    // Refused up front only when the server STATES an older version. One that
    // states none (server.version is informational since 1.0.25) is asked: the
    // door itself answers, and a server without it refuses by name.
    const version = await this.chat.serverVersion(server);
    if (version !== null && compareVersions(version, DECIDE_MIN_VERSION) < 0) {
      throw new ScorerError('scorer_unavailable',
        `Crucible "${server}" is ${version}; the analysis engine needs its decision door (${DECIDE_MIN_VERSION} or newer). Update Crucible.`);
    }
    let models: ModelInfo[];
    let decide: Pick<CapabilityRow, 'enabled' | 'selected' | 'reason'> | null = null;
    let resident: string | null = null;
    try {
      models = await this.chat.modelsOn(server, true);
      resident = models.find((m) => m.resident)?.id ?? null;
      const client = await this.servers.clientFor(server);
      const record = await client.capability({ timeoutMs: 5_000 });
      const row = record.classes.find((r) => r.capability === DECIDE_ACT);
      decide = row === undefined ? null : { enabled: row.enabled, selected: row.selected, reason: row.reason };
    } catch (err) {
      throw this.mapFailure(err, server);
    }
    if (decide !== null && !decide.enabled) {
      throw new ScorerError('scorer_unavailable', `Crucible "${server}" does not serve decisions on this machine: ${decide.reason ?? 'it gave no reason'}`);
    }
    const kept = this.sessionForm.get(server) ?? null;
    const model = pickDecideModel(models, { kept, resident, selected: decide?.selected ?? null });
    if (model === null) {
      throw new ScorerError('scorer_unavailable',
        `Crucible "${server}" has no model it can read decisions from installed (${SCORER_PREFERRED_MODEL} is the one the analysis engine was measured on). Download it in Settings › AI.`);
    }
    if (kept !== model) {
      this.sessionForm.set(server, model);
      this.logger.log(`[${server}] the analysis engine reads decisions from ${model}${kept ? ` (was ${kept}, no longer installed)` : ''}`);
    }
    return { server, model };
  }

  /**
   * Hold the scorer model for `fn` (one chapters + flags pass): loaded at
   * {@link SCORER_LOAD_CONTEXT}, leased, released when `fn` settles.
   */
  async withScorer<T>(fn: (scorer: ScorerHandle) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const { server, model } = await this.pick(signal);
    const parks = this.chat.parksOnBusy();
    try {
      return await this.chat.withModel(server, model, async () => fn(this.handle(server, model, signal)), {
        signal,
        loadContext: SCORER_LOAD_CONTEXT,
        ...(parks ? {} : {
          busyWait: {
            everyMs: BUSY_RETRY_MS,
            forMs: BUSY_WAIT_MS,
            onWait: (line: string) => this.logger.log(`[${server}] busy (${line}); waiting to run the analysis engine`),
          },
        }),
      });
    } catch (err) {
      throw this.mapFailure(err, server, signal);
    }
  }

  // ── the handle ─────────────────────────────────────────────────────────

  /**
   * The handle `withScorer`'s `fn` gets. Every call carries the run's signal as
   * well as its own: a caller that passes none (the live tools) is still
   * stopped by an abort of the run, so an interrupted run cannot go on to
   * decide, or reload the model after `model_not_resident`, once its lease is
   * being given back.
   */
  private handle(server: string, model: string, runSignal?: AbortSignal): ScorerHandle {
    return {
      model,
      decide: (req, options) => this.decide(server, model, req, { ...options, signal: eitherSignal(options?.signal, runSignal) }),
      generate: (messages, options) => this.generate(server, model, messages, { ...options, signal: eitherSignal(options.signal, runSignal) }),
      countTokens: (text, signal) => this.countTokens(server, model, text, signal ?? runSignal),
    };
  }

  private async decide(server: string, model: string, req: DecideRequest, options: DecideOptions): Promise<DecideResponse> {
    const signal = options.signal;
    const wire = toWireRequest(model, req);
    const stateChars = typeof req.state === 'string' ? req.state.length : JSON.stringify(req.state).length;
    const timeoutMs = localTimeoutMs(stateChars + req.questions.reduce((n, q) => n + q.instructions.length, 0));
    let reacquired = false;
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new ScorerError('cancelled', 'decide was cancelled');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      let client: CrucibleClient;
      try {
        client = await this.servers.clientFor(server);
        const res = await client.decide(wire, { act: DECIDE_ACT, signal: combined });
        this.chat.noteActivity();
        const out = fromWireResponse(req, res);
        if (out.gated) this.logger.warn(`[${server}] ${out.gated}/${req.questions.length} answer(s) under the label-mass gate were read as no evidence`);
        const { gated: _gated, ...response } = out;
        return response;
      } catch (err) {
        if (signal?.aborted) throw new ScorerError('cancelled', 'decide was cancelled');
        if (err instanceof ScorerError) throw err;
        if (timeout.aborted) {
          throw new ScorerError('engine_timeout', `Crucible "${server}" did not answer a decision within ${Math.round(timeoutMs / 1000)} s`);
        }
        if (err instanceof CrucibleServerError && err.code === 'chat_queue_full' && attempt <= MAX_QUEUE_FULL_RETRIES) {
          const wait = retryAfterMsOf(err);
          this.logger.log(`[${server}] decision door full; retrying in ${Math.round(wait / 100) / 10}s (attempt ${attempt})`);
          await sleep(wait, signal);
          continue;
        }
        if (err instanceof CrucibleRefused && err.code === 'model_not_resident' && !reacquired) {
          // Someone else's load, or Crucible's settlement after a lapsed lease,
          // evicted it: take it back once, at the scorer's window. A card the
          // settlement still holds (engine_in_use) is waited out, bounded
          // (RELOAD_BUSY_WAIT), then parks the task: never a failed analysis.
          reacquired = true;
          this.logger.warn(`[${server}] ${model} is no longer resident (${err.serverMessage}); loading it again`);
          try {
            await this.chat.reacquire(server, model, signal, SCORER_LOAD_CONTEXT);
          } catch (again) {
            throw this.mapFailure(again, server, signal);
          }
          continue;
        }
        throw this.mapFailure(err, server, signal);
      }
    }
  }

  private async generate(server: string, model: string, messages: ChatMessage[] | string, options: GenerateOptions): Promise<GenerateResult> {
    const msgs: ChatMessage[] = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
    try {
      const result = await this.chat.chat({
        server,
        model,
        messages: msgs,
        maxTokens: options.maxTokens,
        temperature: 0,
        thinking: false,
        act: GENERATE_ACT,
        loadContext: SCORER_LOAD_CONTEXT,
        signal: options.signal,
      });
      return {
        text: result.text,
        promptTokens: result.usage?.promptTokens ?? null,
        completionTokens: result.usage?.completionTokens ?? null,
        finishReason: result.finishReason,
        model: result.model,
      };
    } catch (err) {
      throw this.mapFailure(err, server, options.signal);
    }
  }

  /**
   * Tokens `text` is on this model: prompt_tokens of a one-token chat holding
   * it, less the template's own (a chat of nothing, measured once per model).
   */
  private async countTokens(server: string, model: string, text: string, signal?: AbortSignal): Promise<number> {
    const key = `${server}\n${model}`;
    let template = this.templateTokens.get(key);
    if (template === undefined) {
      template = await this.promptTokens(server, model, '', signal);
      this.templateTokens.set(key, template);
    }
    return Math.max(0, (await this.promptTokens(server, model, text, signal)) - template);
  }

  private async promptTokens(server: string, model: string, content: string, signal?: AbortSignal): Promise<number> {
    try {
      const result = await this.chat.chat({
        server,
        model,
        messages: [{ role: 'user', content }],
        maxTokens: 1,
        temperature: 0,
        thinking: false,
        act: GENERATE_ACT,
        loadContext: SCORER_LOAD_CONTEXT,
        signal,
      });
      // Load-bearing here: the count sizes the scorer's chunks. Never a guessed 0.
      if (result.usage === null) throw new ScorerError('engine_error', `Crucible "${server}" answered a chat with no usage to count tokens from`);
      if (result.usage.promptTokens === null) {
        throw new ScorerError('engine_error', `Crucible "${server}" answered a chat whose usage states no prompt_tokens to count tokens from`);
      }
      return result.usage.promptTokens;
    } catch (err) {
      throw this.mapFailure(err, server, signal);
    }
  }

  // ── failures, by name ──────────────────────────────────────────────────

  /**
   * Every failure as a ScorerError (the seam's vocabulary), except a park:
   * inside a queue run a busy card, a silent server or no server at all parks
   * the task (P4) rather than failing it.
   */
  private mapFailure(err: unknown, server: string | null, signal?: AbortSignal): Error {
    if (err instanceof ScorerError || isParked(err)) return err as Error;
    if (signal?.aborted || err instanceof CrucibleChatCancelled) return new ScorerError('cancelled', 'the analysis engine was cancelled');
    const park = (where: string | null, reason: string): Error => {
      if (!this.chat.parksOnBusy()) return new ScorerError('engine_unreachable', reason);
      this.chat.markParked(where, reason);
      this.logger.log(`[Crucible] parking the analysis engine: ${reason}`);
      return new CrucibleParkedError(where, reason);
    };
    if (err instanceof CrucibleBusyError) {
      return this.chat.parksOnBusy() ? park(err.server, err.busyLine)
        : new ScorerError('engine_unreachable', `Crucible "${err.server}" stayed busy (${err.busyLine})`);
    }
    if (err instanceof CrucibleNoVenueError) return park(null, err.message);
    if (err instanceof CrucibleChatError) {
      if (err.code === 'unreachable') return park(err.server ?? server, `Crucible on ${err.server ?? server ?? 'the server'} isn't answering.`);
      if (err.code === 'timeout') return new ScorerError('engine_timeout', err.message);
      if (err.code === 'decide_not_served') return new ScorerError('decide_not_served', err.message);
      return new ScorerError('engine_error', `${err.code}: ${err.message}`);
    }
    if (err instanceof CrucibleServerError) {
      if (err.code === 'decide_not_served') return new ScorerError('decide_not_served', `Crucible "${server}": ${err.serverMessage}`);
      if (err.code === 'label_not_in_probs') return new ScorerError('label_not_in_probs', err.serverMessage);
      return new ScorerError('engine_error', `${err.code}: ${err.serverMessage}`);
    }
    if (err instanceof CrucibleRefused) {
      if (err.code === 'too_many_options') return new ScorerError('too_many_options', err.serverMessage);
      if (err.code === 'too_many_images') return new ScorerError('too_many_images', err.serverMessage);
      if (err.code === 'model_text_only') return new ScorerError('engine_no_vision', err.serverMessage);
      if (err.code === 'invalid_request') return new ScorerError('bad_request', err.serverMessage);
      return new ScorerError('engine_error', `${err.code}: ${err.serverMessage}`);
    }
    if (err instanceof CrucibleUnreachable || crucibleUnavailableCause(err) !== null) {
      return park(server, `Crucible on ${server ?? 'the server'} isn't answering.`);
    }
    return new ScorerError('engine_error', (err as Error)?.message ?? String(err));
  }
}
