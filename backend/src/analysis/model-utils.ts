/**
 * Shared model/provider utilities for the AI analysis pipeline.
 *
 * Consolidates logic that was previously duplicated across ai-analysis.service,
 * analysis.service, media-operations.service and simple-analyze.controller:
 *  - provider-prefix parsing ("ollama:cogito:14b" -> provider 'ollama', model 'cogito:14b')
 *  - per-task sampling temperature
 *  - Ollama num_ctx sizing (bucketed + model-size-aware cap, ported from BookForge)
 *  - inline <think> stripping (belt-and-braces for thinking models)
 */

export type AIProvider = 'local' | 'ollama' | 'claude' | 'openai';

const KNOWN_PROVIDERS: AIProvider[] = ['local', 'ollama', 'claude', 'openai'];

export interface ParsedProviderModel {
  provider: AIProvider | undefined;
  model: string;
}

/**
 * Split a possibly provider-prefixed model string into its provider and bare
 * model name. Mirrors the historical behavior at all four call sites:
 *  - "ollama:cogito:14b"  -> { provider: 'ollama', model: 'cogito:14b' }
 *  - "local:cogito-8b"    -> { provider: 'local',  model: 'cogito-8b' }
 *  - "cogito:14b"         -> { provider: explicitProvider, model: 'cogito:14b' }
 *    (bare tag whose first segment is NOT a known provider is left untouched)
 *
 * The prefix is only stripped when there is no explicit provider or the prefix
 * matches it — a mismatched prefix (explicit 'claude' + "ollama:x") is left
 * intact so the explicit provider still wins, matching prior behavior.
 */
export function parseProviderModel(
  model: string,
  explicitProvider?: AIProvider | string,
): ParsedProviderModel {
  let provider = (explicitProvider as AIProvider | undefined) || undefined;

  if (typeof model === 'string') {
    const colonIndex = model.indexOf(':');
    if (colonIndex > 0) {
      const firstSegment = model.substring(0, colonIndex);
      if (KNOWN_PROVIDERS.includes(firstSegment as AIProvider)) {
        if (!provider || provider === firstSegment) {
          provider = firstSegment as AIProvider;
          return { provider, model: model.substring(colonIndex + 1) };
        }
      }
    }
  }

  return { provider, model };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-task sampling temperature
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five analysis generation tasks. JSON-extraction tasks want near-greedy
 * decoding (low temperature) so the output parses; free-text tasks tolerate a
 * little variety.
 */
export type AITaskKind = 'boundary' | 'chapter' | 'tags' | 'description' | 'title';

/**
 * Sampling temperature per task.
 *  - boundary / chapter / tags produce STRICT JSON — 0.15 keeps decoding
 *    near-deterministic so the object parses cleanly (the old local path used
 *    0.7, which is far too hot for JSON extraction).
 *  - description / title are free text — 0.4 allows a little natural variation
 *    without drifting into meta-commentary.
 */
export function temperatureForTask(kind?: AITaskKind): number {
  switch (kind) {
    case 'boundary':
    case 'chapter':
    case 'tags':
      return 0.15;
    case 'description':
    case 'title':
      return 0.4;
    default:
      // Connection tests / unspecified — a neutral, low-variance default.
      return 0.2;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama num_ctx sizing (ported from BookForge electron/ai-bridge.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the num_ctx ceiling from the model's parameter count, sniffed from the
 * tag (e.g. 'cogito:14b', 'qwen3:32b', 'llama3.1:8b-instruct-q4_K_M'; MoE tags
 * like 'mixtral:8x7b' count experts × size).
 *
 * The ceiling keeps weights + KV cache on the GPU (spilling a layer to CPU
 * bottlenecks every token):
 *  - ≤15B: 16384 tokens.
 *  - Larger (32B-class) OR unrecognized size: 12288 (conservative — guessing
 *    low costs a rare clamp, guessing high cripples the whole job).
 *
 * The absurd 131072 cap the old code used would allocate a full 128K KV cache
 * and spill any real model to CPU.
 */
export function numCtxMaxForModel(model: string): number {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(model);
  const dense = /(\d+(?:\.\d+)?)b/i.exec(model);
  const sizeB = moe
    ? parseInt(moe[1], 10) * parseFloat(moe[2])
    : dense
      ? parseFloat(dense[1])
      : null;
  if (sizeB !== null && sizeB <= 15) return 16384;
  return 12288;
}

/**
 * Estimate the num_ctx for an Ollama request.
 *
 * Two constraints, both from BookForge's hard-won experience:
 *  - Bucket to 4096: Ollama fully reloads the model on ANY num_ctx change, so
 *    per-request estimates that each land on a slightly different value cause
 *    relentless reload churn. Rounding up to coarse buckets makes similar-sized
 *    prompts reuse the already-loaded runner.
 *  - Cap at numCtxMaxForModel(model): keep KV cache on the GPU.
 *
 * `outputBudgetTokens` must cover the generation that has to fit ALONGSIDE the
 * prompt in the context window — for thinking models that includes the chain of
 * thought, so callers pass a larger budget when thinking is active.
 */
export function estimateNumCtx(
  promptChars: number,
  model: string,
  outputBudgetTokens: number,
): number {
  const CHARS_PER_TOKEN = 3;
  const NUM_CTX_BUCKET = 4096;
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const raw = Math.ceil((inputTokens + outputBudgetTokens + 512) * 1.2);
  const bucketed = Math.max(NUM_CTX_BUCKET, Math.ceil(raw / NUM_CTX_BUCKET) * NUM_CTX_BUCKET);
  return Math.min(numCtxMaxForModel(model), bucketed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Thinking-model output hygiene
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip inline <think>...</think> (and stray closing/opening tags) from a
 * response. Well-behaved Ollama thinking models put the chain of thought in the
 * separate `thinking` response field, but some model templates inline it into
 * the answer — this removes it before JSON extraction / free-text use so the
 * reasoning never leaks into a title or corrupts a JSON parse. It is a no-op for
 * clean responses.
 */
export function stripThinkTags(text: string): string {
  if (!text) return text;
  let out = text;
  // Complete <think>...</think> blocks (dotall).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // An unterminated opening <think> (reasoning that ran into the token budget
  // with no closing tag and thus no answer after it) — drop it to end.
  out = out.replace(/<think>[\s\S]*$/i, '');
  // Any stray lone tags left over (e.g. a leading </think> with no opener).
  out = out.replace(/<\/?think>/gi, '');
  return out.trim();
}
