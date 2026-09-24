/**
 * AN OLLAMA CHOICE, RUN ON CRUCIBLE'S OWN MODEL (the user's decision of
 * 2026-09-23: "Crucible ultimately is a replacement for Ollama, but Crucible
 * should be capable of using Ollama if it's necessary").
 *
 * A stored `ollama:<tag>` (a task model, the default
 * AI) is read at call time. When the serving Crucible has the same model in its
 * own catalog, the call runs on that; only when it has none does it go to the
 * `ollama/` upstream (sized by the prompt, with the window sent
 * as `context_tokens`, on Crucible 1.0.24+; at Ollama's 4K default,
 * CRUCIBLE_OLLAMA_CONTEXT, on an older server that forwards no num_ctx).
 * The stored config is never rewritten.
 *
 * THE MATCHING RULE, in order:
 *
 *   1. Same model. The Ollama tag's name is the Crucible family and its size is
 *      the parameter count: `qwen3.8:27b` → family `qwen3.8`, 27B. A tag with
 *      no size (`qwen3.8`, `:latest`) matches nothing: Ollama's `latest` is
 *      whatever the library says today, so guessing a size would be a guess.
 *      Unknown families match nothing.
 *   2. Something that can analyse. A page reader (the model the server's
 *      `pages` capability class selected, e.g. dots-ocr) is never a candidate.
 *      That is a capability-class test, not a modality one: a `-vl` alias is
 *      text+image too and CAN analyse (crucible-maps.md, "Incoming 1.0.24").
 *      Only when the server gives no class record does an image-capable model
 *      that is not an alias of a base count as a page reader.
 *   3. The base form. A `-vl` alias (`weights_of` set, or the `-vl` suffix) is
 *      taken only when no base form matches: switching a card between a base
 *      and its alias is a full engine reload (~20 s on the 9B).
 *   4. The context that fits, then the precision. Among quantisations, those
 *      that can serve the window analysis uses under Crucible (32K,
 *      CRUCIBLE_ANALYSIS_CONTEXT) come first, and of those the highest
 *      precision wins. When none fits, the largest context wins. "Can serve"
 *      is served at >= 32K now, OR (Crucible 1.0.24 load-time context) a host
 *      ceiling >= 32K: the server's own fit number, the `generate` class's
 *      `context_ceilings` (min of the manifest's max_context and what this
 *      host's memory affords). A model that fits only by its ceiling is loaded
 *      with `context: 32768` ({@link OllamaChoice.loadContext}).
 *
 * WHY CONTEXT BEFORE PRECISION. The window decides how much transcript one call
 * sees: a 12K window cuts an hour into roughly three times as many chunks as a
 * 32K one, and every extra chunk boundary is a place a chapter or a flag is
 * split or lost. The step from 8-bit to 4-bit weights on a 27B costs a small,
 * even degradation of every answer. The first loss is structural and the
 * second is marginal, so context is the tiebreak that matters. On the Mac
 * before 1.0.24 this picked qwen3.8-27b-4bit (98K) over qwen3.8-27b-8bit
 * (served at 12K). From 1.0.24 the Mac's own fit data (live, 2026-09-23:
 * `generate` ceilings 131072 for both, the 8-bit's memory context 375,595 at
 * one in flight) says the 8-bit can be loaded at 32K, so the 8-bit wins there,
 * loaded at 32768. Without ceilings (an older server, or none reported) the
 * served-context rule stands and the 4-bit is kept.
 */

import type { ModelInfo } from '@crucible/client';

/**
 * The context an `ollama/` model is chunked for through a Crucible OLDER THAN
 * 1.0.24, which forwards no `num_ctx`, so Ollama serves the call at its own
 * default: 4096 tokens (its documented default, and the server-side
 * OLLAMA_CONTEXT_LENGTH default; older releases used 2048, but a transcript
 * chunk at that size is too small to chapter). Sizing to numCtxMaxForModel
 * instead (12-16K) would hand Ollama a prompt three or four times its
 * window, which it truncates silently.
 */
export const CRUCIBLE_OLLAMA_CONTEXT = 4096;

/** The window an analysis is chunked for through Crucible (ai-provider's cap on a local model's context). */
export const CRUCIBLE_ANALYSIS_CONTEXT = 32768;

/**
 * The facts of one `GET /v1/models` llm row the mapping reads: the SDK's own
 * {@link ModelInfo} fields, so a row read off the server IS one. Since 1.0.25
 * the informational ones (family, paramsB, backendSupported, installed,
 * contextDefault, maxModelLen) are `null` where the server did not state
 * them; the mapping reads each null on purpose: an unstated family, size,
 * support or install never matches (rule 1), and an unstated context never
 * counts as fitting (rule 4). `weightsOf` is optional so a hand-built row may omit it.
 */
export type MappableModel =
  Pick<ModelInfo, 'id' | 'family' | 'paramsB' | 'modalities' | 'backendSupported' | 'installed' | 'contextDefault' | 'maxModelLen'>
  & Partial<Pick<ModelInfo, 'weightsOf'>>
  & {
    /** Capability classes this model serves, when the server reports them per row. */
    readonly classes?: readonly string[] | null;
  };

export interface OllamaMapOptions {
  /** The context a candidate must be served at to "fit". Default CRUCIBLE_ANALYSIS_CONTEXT. */
  minContext?: number;
  /**
   * The page readers, by capability class: the model(s) the server's `pages`
   * class selected. `null`/absent: the server gave no class record.
   */
  pageReaders?: Iterable<string> | null;
  /**
   * Each model's longest servable request on this host (the `generate`
   * class's `context_ceilings`, 1.0.24+). `null`/absent: none reported, and
   * only the served context counts.
   */
  ceilings?: ReadonlyMap<string, number> | null;
}

/** What an Ollama tag runs as: the model, and the context to load it at when its default is too small. */
export interface OllamaChoice {
  id: string;
  /** Set when the model fits the analysis window only by loading it larger than its default. */
  loadContext?: number;
}

/** `qwen3.8:27b` → {family 'qwen3.8', sizeB 27}; null when the tag names no size. */
export function parseOllamaTag(tag: string): { family: string; sizeB: number } | null {
  let name = (tag ?? '').trim().toLowerCase();
  if (name.startsWith('ollama:')) name = name.slice('ollama:'.length);
  if (name.startsWith('ollama/')) name = name.slice('ollama/'.length);
  // A registry path (`library/qwen3.5:9b`, `hf.co/org/model:tag`): the model is the last segment.
  name = name.slice(name.lastIndexOf('/') + 1);
  const colon = name.indexOf(':');
  if (colon <= 0) return null;
  const family = name.slice(0, colon);
  const size = /^(\d+(?:\.\d+)?)b(?![a-z])/.exec(name.slice(colon + 1));
  if (!size) return null;
  const sizeB = parseFloat(size[1]);
  return Number.isFinite(sizeB) && sizeB > 0 ? { family, sizeB } : null;
}

/** The weight precision a Crucible id names (`-4bit`, `-8bit`); unquantised ids count as 16. */
export function precisionBitsOf(id: string): number {
  const bits = /-(\d+)bit(?:-|$)/i.exec(id);
  return bits ? parseInt(bits[1], 10) : 16;
}

/**
 * The context a model is served at here: its manifest's, never more than what
 * is in force. Either figure alone is enough (the one the server stated);
 * null when it stated neither — an unknown context, never a guessed one.
 */
export function servedContextOf(model: Pick<MappableModel, 'contextDefault' | 'maxModelLen'>): number | null {
  const { contextDefault, maxModelLen } = model;
  if (contextDefault === null) return maxModelLen;
  if (maxModelLen === null) return contextDefault;
  return Math.min(contextDefault, maxModelLen);
}

/** A `-vl` alias of a base model (same weights, other engine form). */
export function isVisionAlias(model: Pick<MappableModel, 'id' | 'weightsOf'>): boolean {
  return (typeof model.weightsOf === 'string' && model.weightsOf !== '') || /-vl$/i.test(model.id);
}

/** A page reader, by capability class; by modality only when the server gave no class record. */
export function isPageReader(model: Pick<MappableModel, 'id' | 'modalities' | 'weightsOf' | 'classes'>, pageReaders: ReadonlySet<string> | null): boolean {
  if (Array.isArray(model.classes) && model.classes.length > 0) return model.classes.every((c) => c === 'pages');
  if (pageReaders !== null) return pageReaders.has(model.id);
  return model.modalities.includes('image') && !isVisionAlias(model);
}

/**
 * The Crucible model an Ollama tag runs as on a server with these models, or
 * null when it has none (the call then stays on the `ollama/` upstream).
 * PURE: see the header for the rule.
 */
export function crucibleModelForOllama(tag: string, models: readonly MappableModel[], options: OllamaMapOptions = {}): string | null {
  return crucibleChoiceForOllama(tag, models, options)?.id ?? null;
}

/** {@link crucibleModelForOllama}, with the load context rule 4 may need. PURE. */
export function crucibleChoiceForOllama(tag: string, models: readonly MappableModel[], options: OllamaMapOptions = {}): OllamaChoice | null {
  const wanted = parseOllamaTag(tag);
  if (wanted === null) return null;
  const minContext = options.minContext ?? CRUCIBLE_ANALYSIS_CONTEXT;
  const pageReaders = options.pageReaders === undefined || options.pageReaders === null ? null : new Set(options.pageReaders);

  // Rule 1 on stated facts only: a row whose family, size, backend support or
  // install the server did not state (null, 1.0.25+) is not "the same model"
  // — the call stays on the `ollama/` upstream rather than guess.
  const same = models.filter((m) =>
    m.family !== null && m.family.toLowerCase() === wanted.family
    && m.paramsB !== null && Math.abs(m.paramsB - wanted.sizeB) < 1e-6
    && m.backendSupported === true
    && m.installed === true
    && m.modalities.includes('text')
    && !isPageReader(m, pageReaders));
  const bases = same.filter((m) => !isVisionAlias(m));
  const candidates = bases.length > 0 ? bases : same;
  if (candidates.length === 0) return null;

  const ceilingOf = (m: MappableModel): number => options.ceilings?.get(m.id) ?? 0;
  // What a candidate can serve: its served context, or its host ceiling when
  // that is larger. An unstated served context counts as 0: only a ceiling can make it fit.
  const reach = (m: MappableModel): number => Math.max(servedContextOf(m) ?? 0, ceilingOf(m));
  const ranked = [...candidates].sort((a, b) => {
    const ctxA = reach(a);
    const ctxB = reach(b);
    const fitsA = ctxA >= minContext;
    const fitsB = ctxB >= minContext;
    if (fitsA !== fitsB) return fitsA ? -1 : 1;
    if (fitsA) {
      const bits = precisionBitsOf(b.id) - precisionBitsOf(a.id);
      if (bits !== 0) return bits;
      return ctxB - ctxA;
    }
    if (ctxA !== ctxB) return ctxB - ctxA;
    const bits = precisionBitsOf(b.id) - precisionBitsOf(a.id);
    return bits !== 0 ? bits : a.id.localeCompare(b.id);
  });
  const best = ranked[0];
  if ((servedContextOf(best) ?? 0) < minContext && ceilingOf(best) >= minContext) return { id: best.id, loadContext: minContext };
  return { id: best.id };
}
