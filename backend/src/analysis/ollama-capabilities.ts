/**
 * Ollama model-capability negotiation for the analysis pipeline.
 *
 * Analysis is judgment-heavy with small outputs, so we WANT thinking-capable
 * models (qwen3-class) to think. Ollama's /api/generate accepts a top-level
 * `think` field, but only models whose /api/show capabilities include
 * 'thinking' honor it — so we probe once per (baseUrl, model) and cache.
 *
 * Empirically verified against the live Ollama at localhost:11434 (2026-07-09):
 *  - qwen3:32b reports ['completion','tools','thinking']. Sending `think:true`
 *    makes it reason in the SEPARATE `thinking` response field while `response`
 *    contains ONLY clean JSON (no inline <think>), which parses directly.
 *  - cogito:8b/14b/32b report ['completion','tools'] — NO 'thinking' — so they
 *    get no `think` field at all (sending it to a non-thinking model is
 *    unnecessary and we omit it).
 *
 * This is explicit negotiation (probe + log + cache), not a silent fallback:
 * a failed probe (Ollama unreachable / unknown model) throws so the caller
 * fails loudly rather than silently guessing.
 */

// Cache successful probes; a failed probe is dropped so the next call retries.
const thinkingCapabilityCache = new Map<string, Promise<boolean>>();

async function probeThinkingCapability(baseUrl: string, model: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    throw new Error(`Ollama /api/show for '${model}' returned HTTP ${response.status}`);
  }
  const data = (await response.json()) as { capabilities?: unknown };
  const capabilities = Array.isArray(data.capabilities) ? (data.capabilities as string[]) : [];
  const supportsThinking = capabilities.includes('thinking');
  console.log(
    `[OLLAMA-CAPS] ${model} capabilities: [${capabilities.join(', ')}] — ` +
      (supportsThinking
        ? 'thinking model, enabling think:true (reasoning lands in separate field)'
        : 'no thinking capability, omitting think field'),
  );
  return supportsThinking;
}

/**
 * Whether the model reports the 'thinking' capability. Probes /api/show once
 * per (baseUrl, model) and caches for the process lifetime.
 */
export async function ollamaModelSupportsThinking(baseUrl: string, model: string): Promise<boolean> {
  const key = `${baseUrl}::${model}`;
  let cached = thinkingCapabilityCache.get(key);
  if (!cached) {
    cached = probeThinkingCapability(baseUrl, model);
    cached.catch(() => thinkingCapabilityCache.delete(key));
    thinkingCapabilityCache.set(key, cached);
  }
  return cached;
}

export interface OllamaThinkNegotiation {
  /** Top-level fields to merge into the /api/generate body. */
  fields: { think?: true };
  /** True when the model is thinking-capable (caller sizes num_predict up). */
  thinking: boolean;
}

/**
 * Negotiate the `think` request field. Analysis enables thinking, so
 * thinking-capable models get `{ think: true }` and non-thinking models get
 * `{}`. Also returns the `thinking` flag so the caller can size num_predict and
 * num_ctx to leave room for the chain of thought.
 */
export async function negotiateOllamaThink(
  baseUrl: string,
  model: string,
): Promise<OllamaThinkNegotiation> {
  const thinking = await ollamaModelSupportsThinking(baseUrl, model);
  return { fields: thinking ? { think: true } : {}, thinking };
}
