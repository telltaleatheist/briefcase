/**
 * THE CONTEXT A LONG PROMPT GETS: how much of a model's window a call that
 * needs `needed` tokens can count on, and what to send so it holds. Shared by
 * the Ask chat (video-chat/) and the analysis's flag stage (the highlights
 * finder), which both send a whole transcript when it fits.
 *
 *   cloud       a large window (claude/openai upstreams, and claude-cli);
 *   ollama/     the num_ctx cap for the model, sent as `context_tokens` sized
 *               to the prompt; Ollama's 4K default on a Crucible older than
 *               1.0.24, which forwards none;
 *   local       the context the run's session loaded it at (a size ceiling),
 *               or as the server states it (its served context, or the host's
 *               ceiling it is then loaded at), WIDENED when the call needs
 *               more: the context it is resident at now when that holds it,
 *               else loaded at {@link chatLoadContext}, up to the model's
 *               maximum (max_context). Inside the queue's own session the
 *               model is that run's and is never reloaded for this.
 *
 * Never a guess: a server that states no context for a local model is refused
 * by name (CrucibleFieldMissing); a model it does not list, as unknown.
 */
import { CrucibleFieldMissing } from '../errors';
import { CrucibleChatError } from './errors';
import { OLLAMA_CONTEXT_VERSION, type CrucibleChatService } from './crucible-chat.service';
import { CRUCIBLE_OLLAMA_CONTEXT } from './ollama-map';
import { isCloudTarget, type CrucibleTarget } from './target';
import { estimateNumCtx, numCtxMaxForModel } from '../../analysis/model-utils';

/** A cloud model's window, as the app takes it (claude/openai have large windows). */
export const CLOUD_CONTEXT_TOKENS = 128000;

/** The model's window for a call, and what the call is sent so it holds. */
export interface FittedContext {
  tokens: number;
  /** `ollama/` upstream: the num_ctx to send. */
  contextTokens?: number;
  /** A local model: the context to load it at, at least. */
  loadContext?: number;
  /** A local model: the most it can be loaded at (max_context), when the server states it. */
  maxTokens?: number;
  /** What a refusal suggests instead, when not the usual (a cloud model). */
  refusal?: string;
}

/**
 * The context a local model is loaded at for work that needs `needed` tokens:
 * room for follow-ups too (a quarter more, at least 8K), in steps of 4096,
 * never past `max`, so work that grows a little is not a reload each time.
 */
export function chatLoadContext(needed: number, max: number): number {
  const roomy = Math.max(Math.ceil(needed * 1.25), needed + 8192);
  return Math.min(max, Math.ceil(roomy / 4096) * 4096);
}

export interface FitOptions {
  /** The prompt's length in characters (sizes an `ollama/` num_ctx). */
  promptChars: number;
  /** The tokens the call needs: prompt plus the reply's room. */
  needed: number;
  /** Tokens kept for the reply when sizing an `ollama/` num_ctx. */
  reserveTokens: number;
  /** The call runs inside the queue's own session, whose model is never reloaded for it. */
  inQueueSession?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** The context `target` gives a call of this size (see the file header). Call it inside the run the call is made in. */
export async function fitContext(chat: CrucibleChatService, target: CrucibleTarget, options: FitOptions): Promise<FittedContext> {
  if (isCloudTarget(target)) return { tokens: CLOUD_CONTEXT_TOKENS };
  const chosen = await chat.effectiveTarget(target, undefined, options.signal);
  const model = chosen.target;
  if (model.route === 'upstream') {
    if (isCloudTarget(model)) return { tokens: CLOUD_CONTEXT_TOKENS };
    const server = await chat.venueFor(model);
    if (!(await chat.serverAtLeast(server, OLLAMA_CONTEXT_VERSION))) return { tokens: CRUCIBLE_OLLAMA_CONTEXT };
    return { tokens: numCtxMaxForModel(model.bareModel), contextTokens: estimateNumCtx(options.promptChars, model.bareModel, options.reserveTokens) };
  }
  const server = chosen.server ?? await chat.venueFor(model);
  let loaded: FittedContext;
  if (chosen.context !== undefined) loaded = { tokens: chosen.context, loadContext: chosen.context };
  else if (chosen.loadContext !== undefined) loaded = { tokens: chosen.loadContext, loadContext: chosen.loadContext };
  else {
    const stated = await chat.statedLocalContext(server, model.model);
    if (stated === null || !(stated.tokens > 0)) {
      if (!(await chat.modelsOn(server)).some((m) => m.id === model.model)) {
        throw new CrucibleChatError(404, 'unknown_model', `"${model.model}" is not a model Crucible "${server}" knows. Pick one from its catalog.`, server);
      }
      throw new CrucibleFieldMissing(server, `a context for ${model.model} (maxModelLen / contextDefault on GET /v1/models, or its context_ceilings row on GET /v1/capability)`, 'fit the transcript to it');
    }
    loaded = { tokens: stated.tokens, ...(stated.loadAt === undefined ? {} : { loadContext: stated.loadAt }) };
  }
  return options.needed > loaded.tokens ? widened(chat, loaded, server, model.model, options) : loaded;
}

/** A local model whose loaded (or default) context is under what the call needs, sized up to it (see the file header). */
async function widened(chat: CrucibleChatService, loaded: FittedContext, server: string, model: string, options: FitOptions): Promise<FittedContext> {
  const max = await chat.maxLocalContext(server, model);
  if (max === null) return loaded;
  const info = (await chat.modelsOn(server, true)).find((m) => m.id === model);
  const resident = info?.resident === true ? info.maxModelLen ?? 0 : 0;
  if (resident >= options.needed) return { tokens: resident, loadContext: resident, maxTokens: max };
  if (options.inQueueSession) {
    return { ...loaded, refusal: `Briefcase's queue is using ${model} at that context right now; ask with a cloud model, or when that work is done.` };
  }
  if (options.needed > max) return { ...loaded, maxTokens: max };
  const loadContext = chatLoadContext(options.needed, max);
  options.log?.(`[${server}] ${model}: the work needs about ${options.needed} tokens, over the ${loaded.tokens} it loads at; loading it at ${loadContext} (its maximum is ${max})`);
  return { tokens: loadContext, loadContext, maxTokens: max };
}
