// backend/src/analysis/ai-provider.service.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  AITaskKind,
  temperatureForTask,
  estimateNumCtx,
  stripThinkTags,
} from './model-utils';
import { AnalysisCancelledError, ensureNotCancelled } from './cancellation';
import { CrucibleChatService, OLLAMA_CONTEXT_VERSION, isAnalysisModel, type CrucibleChatResult } from '../crucible/llm/crucible-chat.service';
import { isVisionAlias, servedContextOf } from '../crucible/llm/ollama-map';
import { CrucibleBusyError, CrucibleChatCancelled, CrucibleChatError, CrucibleNoVenueError, CrucibleParkedError } from '../crucible/llm/errors';
import { crucibleTargetOf, type CrucibleTarget } from '../crucible/llm/target';
import { CRUCIBLE_ANALYSIS_CONTEXT } from '../crucible/llm/ollama-map';

/**
 * A Crucible busy with someone else's work, OUTSIDE a queue-admitted run (the
 * library's insights, a Test button, a standalone analysis): asked again every
 * 10 s for up to 30 min. Inside a run the queue admitted (P4), a busy card is
 * never waited out in the task: the run throws `CrucibleParkedError` and the
 * queue parks the task on the holder's sentence, freeing its lane.
 */
export const CRUCIBLE_BUSY_RETRY_MS = 10_000;
export const CRUCIBLE_BUSY_WAIT_MS = 30 * 60_000;

/**
 * A stored model choice: `local` is a model in the Crucible server's own
 * catalog; `claude`, `openai` and `ollama` are that server's upstreams
 * (crucible/llm/target.ts). There are no keys and no endpoints here: both are
 * the serving Crucible's.
 */
export interface AIProviderConfig {
  provider: 'local' | 'ollama' | 'claude' | 'openai';
  model: string;
}

export interface AIResponse {
  text: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  provider: string;
  model: string;
  /**
   * The chat door's `finish_reason`. 'length' means the generation was CUT OFF
   * at the token ceiling, so the text is a fragment — callers that need a
   * complete answer (a verbatim quote, a JSON object) must treat it as a failed
   * call rather than parse the fragment.
   */
  doneReason?: string;
}

/**
 * Per-call overrides. They exist for stages that make a RUN of near-identical
 * calls and need them to behave identically; target.ts decides which of them
 * cross for a given target (cloud upstreams get none of the sampling ones).
 */
export interface AIGenerateOverrides {
  /**
   * Fixed context window for the whole run, instead of per-call estimation.
   * Sent only to an `ollama/` upstream (as `context_tokens`, Ollama's num_ctx):
   * Ollama fully reloads the model on any num_ctx change, so a stage whose
   * prompts vary slightly in size sizes ONCE from its largest prompt.
   */
  numCtx?: number;
  /**
   * Structured output: `'json'` (json_object) or a JSON Schema object
   * (json_schema), for local models and `ollama/`. The schema form is strictly
   * stronger: besides guaranteeing the parse, it collapses a thinking model's
   * output from thousands of reasoning tokens to the answer itself.
   */
  format?: 'json' | Record<string, unknown>;
  /**
   * Sampling temperature for THIS call, overriding the per-task default.
   *
   * `temperatureForTask` is per TASK, but one task can contain calls that want
   * different settling: the description task makes a hook call that wants a
   * little life (the task default, 0.4) and a body call that wants near-greedy
   * prose (0.2) — see docs/youtube-metadata-spec.md §5. Rather than splitting the
   * task kind in two (which would fragment `taskModels` routing users already
   * configure), the odd call out passes its own value.
   *
   * Applies to local models and `ollama/`. Cloud upstreams are sent NO
   * sampling params at all (newer Claude/OpenAI models 400 on them).
   */
  temperature?: number;
  /**
   * Cancellation for THIS call, owned by the caller (one signal per analysis
   * job — see ai-analysis.service's run registry).
   *
   * Honoured for every target. When it fires, the call rejects with AnalysisCancelledError
   * rather than a provider error, so no catch block upstream mistakes a
   * cancellation for a failure worth retrying, recording, or degrading around.
   */
  signal?: AbortSignal;
}

/**
 * EVERY LLM CALL BRIEFCASE MAKES, through Crucible's chat door (P3, and since
 * P7 the only road: the direct Claude/OpenAI/Ollama providers and the bundled
 * llama runtime are gone). A stored `provider:model` choice is read into a
 * Crucible model string by crucible/llm/target.ts; keys live on the serving
 * Crucible, never here.
 */
@Injectable()
export class AIProviderService {
  private readonly logger = new Logger(AIProviderService.name);

  constructor(private readonly crucibleChat: CrucibleChatService) {}

  /**
   * Run a multi-call job (one analysis) as ONE Crucible run: each local model
   * it uses is loaded once and leased until `fn` settles, then released.
   */
  async withRun<T>(fn: () => Promise<T>): Promise<T> {
    return this.crucibleChat.withRun(fn);
  }

  /**
   * A small model in the connected Crucible's own catalog, installed and
   * loadable, for boundary placement. Returns `local:<id>`, or null when the
   * catalog has none.
   */
  async smallLocalCrucibleModel(maxParamsB = 5): Promise<string | null> {
    try {
      const venue = await this.crucibleChat.venueFor(crucibleTargetOf('local', '_'));
      const [models, pageReaders] = await Promise.all([this.crucibleChat.modelsOn(venue), this.crucibleChat.pageReadersOn(venue)]);
      // By capability class (never a page reader), and the base form over its
      // `-vl` alias: switching a card between the two is a full reload.
      // Only STATED facts qualify: a row whose support, install or size the
      // server did not state (null, 1.0.25+) can't be shown to be a small
      // installed model, so it is not a candidate.
      const usable = models.flatMap((m) =>
        m.backendSupported === true && m.installed === true && m.paramsB !== null && m.paramsB > 0 && m.paramsB <= maxParamsB
          && isAnalysisModel(m, pageReaders) ? [{ model: m, paramsB: m.paramsB }] : []);
      const small = usable
        .filter(({ model: m }) => !isVisionAlias(m) || !usable.some(({ model: b }) => b.id === m.weightsOf))
        .sort((a, b) => a.paramsB - b.paramsB || Number(isVisionAlias(b.model)) - Number(isVisionAlias(a.model)));
      return small.length > 0 ? `local:${small[small.length - 1].model.id}` : null;
    } catch (error) {
      this.logger.debug(`[Placement] Crucible catalog not readable: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * The Crucible model an `ollama:<tag>` choice runs as (ollama-map.ts), or
   * null when it stays on the `ollama/` upstream. The same decision chat()
   * makes at call time, so analysis sizes its chunks for the model that will
   * actually answer.
   */
  async crucibleOllamaStandIn(model: string): Promise<string | null> {
    return (await this.crucibleOllamaStandInChoice(model))?.model ?? null;
  }

  /** {@link crucibleOllamaStandIn}, with the context the stand-in is loaded at when it is loaded larger than its default. */
  async crucibleOllamaStandInChoice(model: string): Promise<{ model: string; loadContext?: number } | null> {
    try {
      const chosen = await this.crucibleChat.effectiveTarget(crucibleTargetOf('ollama', model));
      if (chosen.mappedFrom === null) return null;
      return { model: chosen.target.model, ...(chosen.loadContext === undefined ? {} : { loadContext: chosen.loadContext }) };
    } catch {
      return null;
    }
  }

  /**
   * True when an `ollama:<tag>` choice reaches Ollama through a Crucible that
   * forwards the window (`context_tokens` → options.num_ctx, 1.0.24+). False
   * on an older server, where Ollama runs at its 4096 default
   * (CRUCIBLE_OLLAMA_CONTEXT).
   */
  async crucibleOllamaTakesContext(model: string): Promise<boolean> {
    try {
      const target = crucibleTargetOf('ollama', model);
      const venue = await this.crucibleChat.venueFor(target);
      return await this.crucibleChat.serverAtLeast(venue, OLLAMA_CONTEXT_VERSION);
    } catch {
      return false;
    }
  }

  /** The context window a Crucible local model is served at, or null when it can't be read. */
  async crucibleContextWindow(model: string, loadContext?: number): Promise<number | null> {
    try {
      const target = crucibleTargetOf('local', model);
      const venue = await this.crucibleChat.venueFor(target);
      const info = (await this.crucibleChat.modelsOn(venue)).find((m) => m.id === target.model);
      if (!info) return null;
      // The context this host serves it at, never more than what is in force,
      // and capped at 32K: a larger chunk is slower on a local card for no gain.
      // A model this run loads at a larger context (ollama-map.ts rule 4) is served at that.
      // Null when the server stated neither context (1.0.25+): the caller's
      // documented unread-context sizing applies (ai-analysis
      // CRUCIBLE_LOCAL_CONTEXT_FALLBACK), said here by field name.
      const served = loadContext !== undefined ? loadContext : servedContextOf(info);
      if (served === null) {
        this.logger.warn(`[Model Limits] "${venue}" states neither contextDefault nor maxModelLen for ${target.model}; its context is unknown`);
      }
      return served !== null && Number.isFinite(served) && served > 0 ? Math.min(served, CRUCIBLE_ANALYSIS_CONTEXT) : null;
    } catch {
      return null;
    }
  }

  // Pricing per 1M tokens (as of May 2025)
  private readonly PRICING: Record<'claude' | 'openai', Record<string, { input: number; output: number }>> = {
    claude: {
      'claude-sonnet-4': { input: 3.00, output: 15.00 },
      'claude-haiku-4': { input: 0.80, output: 4.00 },
      'claude-opus-4': { input: 15.00, output: 75.00 },
      'claude-3-7-sonnet': { input: 3.00, output: 15.00 },
      'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
      'claude-3-5-haiku': { input: 0.80, output: 4.00 },
      'claude-3-opus': { input: 15.00, output: 75.00 },
      'claude-3-sonnet': { input: 3.00, output: 15.00 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
    },
    openai: {
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4.1': { input: 2.00, output: 8.00 },
      'gpt-4.1-mini': { input: 0.40, output: 1.60 },
      'gpt-4.1-nano': { input: 0.10, output: 0.40 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
      'o3-mini': { input: 1.10, output: 4.40 },
    },
  };

  /**
   * Calculate estimated cost based on token usage
   * Uses prefix matching so date-suffixed models (e.g. claude-sonnet-4-20250514) still match
   */
  private calculateCost(
    provider: 'claude' | 'openai',
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const providerPricing = this.PRICING[provider];
    if (!providerPricing) return 0;

    // Try exact match first
    let pricing = providerPricing[model];

    // Fallback: find a key that the model starts with (handles date suffixes like -20250514)
    if (!pricing) {
      const matchingKey = Object.keys(providerPricing)
        .sort((a, b) => b.length - a.length) // Longest match first
        .find(key => model.startsWith(key));
      if (matchingKey) {
        pricing = providerPricing[matchingKey];
      }
    }

    // Fallback: find a key that starts with the same base (handles -latest suffix)
    if (!pricing) {
      const modelBase = model.replace(/-latest$/, '').replace(/-\d{8}$/, '');
      const matchingKey = Object.keys(providerPricing)
        .find(key => key === modelBase || modelBase.startsWith(key));
      if (matchingKey) {
        pricing = providerPricing[matchingKey];
      }
    }

    if (!pricing) {
      this.logger.warn(`No pricing data for ${provider}:${model}`);
      return 0;
    }

    // Cost per 1M tokens, so divide by 1,000,000
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Generate text using the specified AI provider
   */
  async generateText(
    prompt: string,
    config: AIProviderConfig,
    task?: AITaskKind,
    overrides?: AIGenerateOverrides,
  ): Promise<AIResponse> {
    // Last gate before a request is ISSUED. Aborting the open call is only half
    // a cancellation; the other half is never starting the next one.
    ensureNotCancelled(overrides?.signal, `a ${task ?? 'generation'} call`);

    // Per-task default, unless this particular call asked for its own.
    const temperature = overrides?.temperature ?? temperatureForTask(task);

    return this.generateViaCrucible(prompt, config, temperature, task, overrides);
  }

  /**
   * THE ROAD (P3). What crosses the wire is decided in crucible/llm/target.ts: cloud upstreams get no sampling
   * parameters at all, ollama/ and local models keep the per-task temperature,
   * 'json' and schemas become response_format where the target takes one.
   * Keys are the serving Crucible's, so `config.apiKey` is not read here.
   */
  private async generateViaCrucible(
    prompt: string,
    config: AIProviderConfig,
    temperature: number,
    task: AITaskKind | undefined,
    overrides: AIGenerateOverrides | undefined,
  ): Promise<AIResponse> {
    const chat = this.crucibleChat;
    const signal = overrides?.signal;
    let target: CrucibleTarget;
    try {
      target = crucibleTargetOf(config.provider, config.model);
    } catch (error) {
      throw new Error(`Crucible: ${(error as Error).message}`);
    }
    this.logger.log(`Generating via Crucible: ${target.model} (from ${config.provider}:${config.model}), task: ${task ?? 'unspecified'}`);

    const parkOnBusy = chat.parksOnBusy();
    // An ollama/ upstream gets a window sent as num_ctx (bucketed by the
    // prompt, capped per model); the chat service sends it
    // only to a server that forwards it (1.0.24+). Other targets ignore it.
    const contextTokens = target.upstream === 'ollama'
      ? overrides?.numCtx ?? estimateNumCtx(prompt.length, target.bareModel, 2048)
      : undefined;
    let result: CrucibleChatResult;
    try {
      result = await chat.chat({
        model: target.model,
        prompt,
        temperature,
        responseFormat: overrides?.format,
        schemaName: task ?? 'answer',
        contextTokens,
        signal,
        busyWait: parkOnBusy ? undefined : {
          everyMs: CRUCIBLE_BUSY_RETRY_MS,
          forMs: CRUCIBLE_BUSY_WAIT_MS,
          onWait: (line, server) => this.logger.log(`[Crucible] ${server} is busy (${line}); waiting to run ${task ?? 'the call'}`),
        },
      });
    } catch (error) {
      if (signal?.aborted || error instanceof CrucibleChatCancelled) {
        throw new AnalysisCancelledError(`Crucible request cancelled: job was cancelled`);
      }
      // P4: inside a queue-admitted run, a card someone else holds, a server
      // that stopped answering, or no server at all PARKS the task (§7.2, §11):
      // never a failure, never a wait inside the task.
      if (parkOnBusy) {
        const parked = error instanceof CrucibleBusyError ? new CrucibleParkedError(error.server, error.busyLine)
          : error instanceof CrucibleNoVenueError ? new CrucibleParkedError(null, error.message)
            : error instanceof CrucibleChatError && error.code === 'unreachable' ? new CrucibleParkedError(error.server, `Crucible on ${error.server ?? 'the server'} isn't answering.`)
              : null;
        if (parked !== null) {
          chat.markParked(parked.server, parked.reason);
          this.logger.log(`[Crucible] parking ${task ?? 'the call'}: ${parked.reason}`);
          throw parked;
        }
      }
      if (error instanceof CrucibleBusyError) {
        throw new Error(`Crucible "${error.server}" stayed busy for ${Math.round(CRUCIBLE_BUSY_WAIT_MS / 60_000)} min (${error.busyLine}).`);
      }
      if (error instanceof CrucibleChatError) {
        this.logger.error(`Crucible chat error (${error.server ?? 'no server'}): ${error.code}: ${error.message}`);
        throw new Error(`Crucible ${error.code}: ${error.message}`);
      }
      if (error instanceof CrucibleNoVenueError) throw new Error(`Crucible: ${error.message}`);
      throw new Error(`Crucible error: ${(error as Error).message}`);
    }

    if (result.sampling) this.logger.debug(`[Crucible] ${result.server} sampling sources: ${JSON.stringify(result.sampling)}`);
    if (result.fromReasoning) this.logger.debug(`[Crucible] structured answer read from the reasoning field (empty content)`);
    if (result.finishReason === 'length') {
      this.logger.warn(`[Crucible] ${target.model} stopped at its token limit on ${task ?? 'a call'} (finish_reason=length)`);
      if (!result.text.trim()) {
        throw new Error('The model spent its whole token budget thinking and returned no answer. Turn thinking off for this model on the Crucible server, or pick another model.');
      }
    }

    const text = stripThinkTags(result.text);
    // Informational (cost and log): a count the server did not state adds
    // nothing to the tally and reads "?" in the log, as it did with no usage.
    const statedIn = result.usage?.promptTokens ?? null;
    const statedOut = result.usage?.completionTokens ?? null;
    const inputTokens = statedIn ?? 0;
    const outputTokens = statedOut ?? 0;
    const pricedAs = target.upstream === 'anthropic' ? 'claude' : target.upstream === 'openai' ? 'openai' : null;
    const estimatedCost = pricedAs === null ? 0 : this.calculateCost(pricedAs, target.bareModel, inputTokens, outputTokens);
    target = result.target ?? target;
    this.logger.log(
      `Crucible (${result.server}) ${target.model}: ${statedIn ?? '?'} input + ${statedOut ?? '?'} output tokens`
        + `${pricedAs ? ` (≈$${estimatedCost.toFixed(4)})` : ''}${result.attempts > 1 ? `, ${result.attempts} attempts` : ''}`,
    );
    return {
      text,
      tokensUsed: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      estimatedCost,
      provider: config.provider,
      model: config.model,
      doneReason: result.finishReason ?? undefined,
    };
  }

  /**
   * Test if an AI provider is accessible and configured correctly
   */
  async testProvider(config: AIProviderConfig): Promise<{ success: boolean; error?: string }> {
    const chat = this.crucibleChat;
    try {
      const chosen = await chat.effectiveTarget(crucibleTargetOf(config.provider, config.model));
      const target = chosen.target;
      const venue = chosen.server ?? await chat.venueFor(target);
      if (target.upstream !== null) {
        const configured = await chat.upstreamsConfigured(venue);
        if (!configured[target.upstream]) return { success: false, error: `"${venue}" has no ${target.upstream} configured. Add it in Settings › AI.` };
        return { success: true };
      }
      const info = (await chat.modelsOn(venue, true)).find((m) => m.id === target.model);
      if (!info) return { success: false, error: `"${target.model}" is not in the catalog of "${venue}".` };
      if (info.installed === false) return { success: false, error: `"${target.model}" is not downloaded on "${venue}".` };
      return info.loadable || info.resident ? { success: true } : { success: false, error: info.reason ?? `"${target.model}" can't load on "${venue}" right now.` };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}
