/**
 * HOW FLAGS ARE FOUND: the model marks the clip-worthy moments (the user,
 * 2026-10-26: "maybe we just flip the 'analyze' step in the analysis pipeline
 * … to this method"). Tuned in the highlights experiment against the user's
 * hand-marked baseline (round 3, prompt c10: about 80-93% of the hand markers
 * found on a dense debate, nothing in an hour of church service before the
 * sermon), and it replaces the scorer's flag ranking, the model reading
 * chunks for passages, and the verifier.
 *
 *   windows     the transcript's sentences in stretches of about 15 minutes
 *               (smaller when a small model's context needs them smaller);
 *               one fresh question per stretch, every one over the same
 *               system prompt and the same tool, byte for byte, so the
 *               engine's prompt cache holds across them;
 *   transcript  in the system prompt once when it fits the model's context
 *               (a local model is loaded big enough for it, up to its
 *               maximum), else each question carries its stretch and a minute
 *               of context on each side;
 *   the tool    add_marker (prompts/flag-highlights-prompts.ts): title, one
 *               category, why, and the moment's first and last words, found
 *               in the stretch (and its context) by passage-anchor.ts;
 *   guards      deterministic, in the tool: words found more than 8 minutes
 *               apart are refused (a cold-open teaser repeats lines from
 *               later); a marker more than half on top of one already placed
 *               is refused as already placed; one outside the stretch is
 *               refused;
 *   padding     after every stretch is done, a marker under 30 seconds grows
 *               by whole sentences, two before for each one after (a clip
 *               needs its lead-in), never into a neighbour;
 *   rows        each marker is one flag (verdict 'flag', ranker
 *               'highlights-v1', no score): its category, its title, and
 *               "title — why" as the reason the lists show.
 *
 * No count cap and no length limit: the count follows the content.
 *
 * Pure except for the model calls, which go through the transport and codec
 * it is handed (tool-harness/): the stage that wires them is in
 * ai-analysis.service.ts.
 */
import { runToolLoop, ToolLoopAborted, type ChatTransport, type Tool, type ToolCallCodec } from '../tool-harness';
import type { AnalysisCategory } from './prompts/analysis-prompts';
import {
  buildHighlightsSystemPrompt,
  buildWindowQuestion,
  HIGHLIGHT_TOOL_DESCRIPTION,
  HIGHLIGHT_TOOL_NAME,
  highlightResults,
  highlightToolParameters,
} from './prompts/flag-highlights-prompts';
import { chunkWords, matchPassage } from './passage-anchor';
import type { RankedSentence } from './flag-windows';
import { formatHms } from './analysis-parts';

/** The `ranker` stored on every flag row this finder makes. There is no score: `nli_score` stays null. */
export const HIGHLIGHTS_RANKER = 'highlights-v1' as const;

/** One question's stretch of the transcript, when the model's context allows it. */
export const HIGHLIGHT_WINDOW_SECONDS = 15 * 60;
/** The smallest stretch a small context is cut down to; under it the transcript is refused as too long. */
export const HIGHLIGHT_MIN_WINDOW_SECONDS = 3 * 60;
/** Context on each side of a stretch: shown with it when the transcript isn't in the system prompt, and where a quote may be found. */
export const HIGHLIGHT_MARGIN_SECONDS = 60;
/** Quoted words found further apart than this are a mismatch, not a moment. */
export const HIGHLIGHT_MAX_SPAN_SECONDS = 8 * 60;
/** A marker shorter than this is padded to it with whole sentences. */
export const HIGHLIGHT_MIN_CLIP_SECONDS = 30;
/** Rounds of tool calls one question may take (the first marks, the others re-quote). */
export const HIGHLIGHT_MAX_ROUNDS = 3;
/** A reply's token ceiling on a local model (round 1 saw a 9B run on past 300 s without one). */
export const HIGHLIGHT_MAX_OUTPUT_TOKENS = 6144;
/** Characters per token when sizing a prompt (the Ask chat's measure, with margin). */
export const HIGHLIGHT_CHARS_PER_TOKEN = 3.5;
/** Room kept in the context for one question's replies and results. */
export const HIGHLIGHT_REPLY_RESERVE_TOKENS = HIGHLIGHT_MAX_OUTPUT_TOKENS + HIGHLIGHT_MAX_ROUNDS * 1024;

/** An inclusive range of sentence indices. */
export interface SentenceRange {
  from: number;
  to: number;
}

/** A placed marker: its sentences, its times (the sentences' segment times), and what the model said about it. */
export interface HighlightMarker {
  from: number;
  to: number;
  start: number;
  end: number;
  title: string;
  category: string;
  why: string;
}

// =============================================================================
// WINDOWS
// =============================================================================

/** The sentences cut into stretches of at most `windowSeconds` (a sentence is never split; one longer than that is a stretch of its own). */
export function highlightWindows(sentences: readonly RankedSentence[], windowSeconds: number = HIGHLIGHT_WINDOW_SECONDS): SentenceRange[] {
  const windows: SentenceRange[] = [];
  for (let i = 0; i < sentences.length;) {
    let j = i;
    while (j + 1 < sentences.length && sentences[j + 1].end - sentences[i].start <= windowSeconds) j++;
    windows.push({ from: i, to: j });
    i = j + 1;
  }
  return windows;
}

/** A stretch with `marginSeconds` of context on each side, in whole sentences. */
export function withMargin(sentences: readonly RankedSentence[], window: SentenceRange, marginSeconds: number = HIGHLIGHT_MARGIN_SECONDS): SentenceRange {
  let from = window.from;
  while (from > 0 && sentences[window.from].start - sentences[from - 1].start <= marginSeconds) from--;
  let to = window.to;
  while (to + 1 < sentences.length && sentences[to + 1].end - sentences[window.to].end <= marginSeconds) to++;
  return { from, to };
}

// =============================================================================
// HOW THE TRANSCRIPT IS SENT
// =============================================================================

export type TranscriptPlan =
  | { mode: 'whole'; windowSeconds: number; neededTokens: number }
  | { mode: 'window'; windowSeconds: number; neededTokens: number };

const tokensOf = (chars: number) => Math.ceil(chars / HIGHLIGHT_CHARS_PER_TOKEN);
const linesChars = (sentences: readonly RankedSentence[], range: SentenceRange) =>
  sentences.slice(range.from, range.to + 1).reduce((sum, s) => sum + s.text.length + 1, 0);

/** The tokens one question needs when the whole transcript is in the system prompt. */
export function wholeTranscriptTokens(systemChars: number, sentences: readonly RankedSentence[]): number {
  const transcript = sentences.reduce((sum, s) => sum + s.text.length + 1, 0);
  // The question names the stretch by two sentences: a few hundred characters.
  return tokensOf(systemChars + transcript + 1500) + HIGHLIGHT_REPLY_RESERVE_TOKENS;
}

/** The tokens the largest question needs when each carries its stretch and margins. */
export function perWindowTokens(systemChars: number, sentences: readonly RankedSentence[], windowSeconds: number): number {
  const windows = highlightWindows(sentences, windowSeconds);
  const largest = windows.reduce((max, w) => Math.max(max, linesChars(sentences, withMargin(sentences, w))), 0);
  return tokensOf(systemChars + largest + 1500) + HIGHLIGHT_REPLY_RESERVE_TOKENS;
}

/**
 * Whether the transcript goes once in the system prompt (it fits
 * `contextTokens`) or with each question; and the stretch size, halved from
 * 15 minutes while the largest question doesn't fit, down to 3. Null when not
 * even a 3-minute stretch fits (the model's context is too small for this).
 */
export function planTranscript(
  sentences: readonly RankedSentence[],
  /** The system prompt's length without the transcript. */
  systemChars: number,
  contextTokens: number,
): TranscriptPlan | null {
  const whole = wholeTranscriptTokens(systemChars, sentences);
  if (whole <= contextTokens) return { mode: 'whole', windowSeconds: HIGHLIGHT_WINDOW_SECONDS, neededTokens: whole };
  for (let seconds = HIGHLIGHT_WINDOW_SECONDS; seconds >= HIGHLIGHT_MIN_WINDOW_SECONDS; seconds = Math.floor(seconds / 2)) {
    const needed = perWindowTokens(systemChars, sentences, seconds);
    if (needed <= contextTokens) return { mode: 'window', windowSeconds: seconds, neededTokens: needed };
  }
  return null;
}

// =============================================================================
// THE TOOL AND ITS GUARDS
// =============================================================================

export interface HighlightToolState {
  sentences: readonly RankedSentence[];
  categoryNames: readonly string[];
  /** Every marker placed so far in the run, across stretches (the overlap guard reads it). */
  placed: HighlightMarker[];
}

/** The tool's definition: the same for every question of a run. */
export function highlightToolDefinition(categoryNames: readonly string[]): Pick<Tool, 'name' | 'description' | 'parameters'> {
  return { name: HIGHLIGHT_TOOL_NAME, description: HIGHLIGHT_TOOL_DESCRIPTION, parameters: highlightToolParameters(categoryNames) };
}

/** True when `a` and `b` overlap by more than half of the shorter. */
function mostlyOverlaps(a: Pick<HighlightMarker, 'start' | 'end'>, b: Pick<HighlightMarker, 'start' | 'end'>): boolean {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  return overlap > 0.5 * Math.min(a.end - a.start, b.end - b.start);
}

/**
 * add_marker for one stretch: quotes are found in the stretch and its margins
 * only; the guards (see the file header) answer the model by name, and a
 * placed marker is added to `state.placed`.
 */
export function highlightTool(state: HighlightToolState, window: SentenceRange, scope: SentenceRange = withMargin(state.sentences, window)): Tool<Record<string, unknown>, HighlightMarker> {
  const words = chunkWords(state.sentences.slice(scope.from, scope.to + 1));
  return {
    ...highlightToolDefinition(state.categoryNames),
    async execute(args) {
      const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
      const missing = ['title', 'category', 'first_words', 'last_words'].filter((key) => !str(key));
      if (missing.length > 0) throw new Error(`the arguments have no ${missing.join(', ')}`);
      const title = str('title');
      const category = state.categoryNames.find((name) => name.toLowerCase() === str('category').toLowerCase());
      if (category === undefined) throw new Error(highlightResults.badCategory(str('category'), state.categoryNames));
      const hit = matchPassage(words, str('first_words'), str('last_words'));
      if (!hit) return { content: highlightResults.notFound(title, str('first_words'), str('last_words')) };
      const from = scope.from + hit.from;
      const to = scope.from + hit.to;
      const start = state.sentences[from].start;
      const end = state.sentences[to].end;
      if (end - start > HIGHLIGHT_MAX_SPAN_SECONDS) {
        return { content: highlightResults.tooFarApart(title, Math.round((end - start) / 60)) };
      }
      if (to < window.from || from > window.to) return { content: highlightResults.outsideStretch(title) };
      const twin = state.placed.find((p) => mostlyOverlaps({ start, end }, p));
      if (twin) return { content: highlightResults.alreadyPlaced(twin.title, formatHms(twin.start), formatHms(twin.end)) };
      const marker: HighlightMarker = { from, to, start, end, title, category, why: str('why') };
      state.placed.push(marker);
      return { content: highlightResults.placed(title, formatHms(start), formatHms(end)), data: marker };
    },
  };
}

// =============================================================================
// PADDING
// =============================================================================

/**
 * Markers under `minSeconds` grown by whole sentences, two before for each one
 * after (a clip needs its lead-in), never into a neighbouring marker and never
 * past the transcript's ends. In time order.
 */
export function padHighlights(
  markers: readonly HighlightMarker[],
  sentences: readonly RankedSentence[],
  minSeconds: number = HIGHLIGHT_MIN_CLIP_SECONDS,
): HighlightMarker[] {
  const sorted = [...markers].sort((a, b) => a.start - b.start);
  const out: HighlightMarker[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const lo = out.length > 0 ? out[out.length - 1].end : -Infinity;
    const hi = i + 1 < sorted.length ? sorted[i + 1].start : Infinity;
    let from = m.from;
    let to = m.to;
    let k = 0;
    while (sentences[to].end - sentences[from].start < minSeconds) {
      const canBefore = from > 0 && sentences[from - 1].start >= lo;
      const canAfter = to + 1 < sentences.length && sentences[to + 1].end <= hi;
      if (!canBefore && !canAfter) break;
      if ((k % 3 !== 2 && canBefore) || !canAfter) from--;
      else to++;
      k++;
    }
    out.push({ ...m, from, to, start: sentences[from].start, end: sentences[to].end });
  }
  return out;
}

// =============================================================================
// THE RUN
// =============================================================================

export interface FindHighlightsInput {
  sentences: readonly RankedSentence[];
  categories: readonly AnalysisCategory[];
  videoTitle: string;
  plan: Pick<TranscriptPlan, 'mode' | 'windowSeconds'>;
}

export interface FindHighlightsDeps {
  transport: ChatTransport;
  codec: ToolCallCodec;
  signal?: AbortSignal;
  /** True for an error that must stop the whole stage (a cancel, a park, a refusal of native tools); others fail one stretch. */
  stops?: (error: unknown) => boolean;
  /** Called as stretch `current` (1-based) of `total` starts. */
  onWindow?: (current: number, total: number) => void;
  log?: (message: string) => void;
}

export interface FindHighlightsResult {
  /** Padded, in time order. */
  markers: HighlightMarker[];
  windows: number;
  /** Stretches whose question failed, each named with its times and why. */
  failed: string[];
  /** Calls the guards refused or the matcher couldn't place (each told to the model, which may have re-quoted). */
  notPlaced: number;
  modelCalls: number;
}

/** The enabled categories, by name (the tool's enum). */
export function enabledCategories(categories: readonly AnalysisCategory[]): AnalysisCategory[] {
  const seen = new Set<string>();
  return categories.filter((c) => {
    const name = c.name?.trim();
    if (!name || c.enabled === false || seen.has(name.toLowerCase())) return false;
    seen.add(name.toLowerCase());
    return true;
  });
}

/** The system prompt a run sends: the transcript in it for the 'whole' plan, none for 'window'. */
export function highlightsSystemPrompt(input: Omit<FindHighlightsInput, 'plan'>, mode: TranscriptPlan['mode']): string {
  return buildHighlightsSystemPrompt({
    videoTitle: input.videoTitle,
    categories: enabledCategories(input.categories),
    transcriptLines: mode === 'whole' ? input.sentences.map((s) => s.text) : null,
  });
}

/**
 * Ask about every stretch in turn and keep what was placed. A stretch whose
 * question fails is named and skipped; every stretch failing throws with the
 * last reason (the stored flags stay). A stop (cancel, park, native tools
 * refused) stops it as it is.
 */
export async function findHighlights(input: FindHighlightsInput, deps: FindHighlightsDeps): Promise<FindHighlightsResult> {
  const categories = enabledCategories(input.categories);
  const names = categories.map((c) => c.name.trim());
  const sentences = input.sentences;
  if (sentences.length === 0 || names.length === 0) {
    return { markers: [], windows: 0, failed: [], notPlaced: 0, modelCalls: 0 };
  }
  const system = highlightsSystemPrompt(input, input.plan.mode);
  const windows = highlightWindows(sentences, input.plan.windowSeconds);
  const state: HighlightToolState = { sentences, categoryNames: names, placed: [] };
  const failed: string[] = [];
  let notPlaced = 0;
  let modelCalls = 0;

  for (let k = 0; k < windows.length; k++) {
    const window = windows[k];
    const scope = withMargin(sentences, window);
    const label = `stretch ${k + 1} (${formatHms(sentences[window.from].start)}-${formatHms(sentences[window.to].end)})`;
    deps.onWindow?.(k + 1, windows.length);
    const question = buildWindowQuestion({
      first: sentences[window.from].text,
      last: sentences[window.to].text,
      minutes: (sentences[window.to].end - sentences[window.from].start) / 60,
      parts: windows.length,
      ...(input.plan.mode === 'window'
        ? {
          text: {
            before: sentences.slice(scope.from, window.from).map((s) => s.text),
            stretch: sentences.slice(window.from, window.to + 1).map((s) => s.text),
            after: sentences.slice(window.to + 1, scope.to + 1).map((s) => s.text),
          },
        }
        : {}),
    });
    try {
      const result = await runToolLoop({
        transport: deps.transport,
        tools: [highlightTool(state, window, scope)],
        system,
        userMessage: question,
        maxRounds: HIGHLIGHT_MAX_ROUNDS,
        codec: deps.codec,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      modelCalls += result.usage.length;
      const placed = result.toolCalls.filter((call) => call.ok && call.data !== undefined).length;
      const refused = result.toolCalls.length - placed;
      notPlaced += refused;
      deps.log?.(`${label}: ${placed} placed${refused > 0 ? `, ${refused} call(s) not placed` : ''}, ${result.usage.length} model call(s)`);
    } catch (error) {
      if (error instanceof ToolLoopAborted || deps.stops?.(error)) throw error;
      failed.push(`${label}: ${(error as Error).message}`);
      deps.log?.(`${label} failed: ${(error as Error).message}`);
    }
  }

  if (failed.length === windows.length) {
    throw new Error(`no stretch of the transcript could be asked about — all ${windows.length} failed. Last failure: ${failed[failed.length - 1]}`);
  }
  return { markers: padHighlights(state.placed, sentences), windows: windows.length, failed, notPlaced, modelCalls };
}

/** A flag row's reason, as the lists show it: the marker's title, then why. */
export function highlightReason(marker: Pick<HighlightMarker, 'title' | 'why'>): string {
  return marker.why ? `${marker.title} — ${marker.why}` : marker.title;
}
