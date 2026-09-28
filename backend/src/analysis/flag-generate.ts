/**
 * FLAGS FOUND BY THE MODEL READING THE TRANSCRIPT ("generate"), the default way
 * the Analysis part finds its flag candidates (the user, 2026-09-28: "lets try
 * ditching decide and try generate instead, where we send chunks of text to the
 * 9b and ask it to send back sections that match the categories that apply.
 * thats how we used to do it ... we can link it to a timestamp on the other side
 * when we get the text back").
 *
 *   chunks    the transcript's sentences in chunks of about 8,000 characters,
 *             cut at sentence boundaries, each overlapping the last by two
 *             sentences so a passage cut at a seam is still seen whole;
 *   prompt    one chat call per chunk on the `flags` task's model: the enabled
 *             categories as short act descriptions, and "mark every passage
 *             where one may apply" (generously: the verifier checks each);
 *   anchors   each passage comes back as its first and last words, copied from
 *             the transcript; they are matched (fuzzily) to sentences in that
 *             chunk, and the times are those sentences' segment times. A
 *             passage whose words can't be found is dropped and counted;
 *   windows   the matched passages become the FlagWindows the verifier (Pass 2b)
 *             already reads, merged by the same rules as the snap ranker's.
 *
 * The scorer's `/v1/decide` ranking (scorer/flags/) stays available behind the
 * "How flags are found" setting (`flagFinder` in app-config.json), so the two
 * can be compared. Chapters stay on the scorer either way.
 *
 * Pure: no I/O, no Nest. The stage that calls the model is runGenerateFlagStage
 * in ai-analysis.service.ts.
 */
import { buildWindows, FlagCandidate, FlagWindow, RankedSentence } from './flag-windows';
import type { FlagOptionPlan } from '../scorer/flags/flag-options';
import { extractJsonFromResponse } from './json-utils';
import { stripThinkTags } from './model-utils';

// =============================================================================
// THE SETTING
// =============================================================================

/**
 * How the Analysis part finds its flag candidates (Settings › AI Analysis,
 * "How flags are found"; app-config.json `flagFinder`):
 *
 *   generate  the flags task's model reads the transcript in chunks (this file).
 *   snap      the scorer's decide ranking (scorer/flags/, SnapFlagRanker).
 */
export type FlagFinder = 'generate' | 'snap';

export const FLAG_FINDERS: readonly FlagFinder[] = ['generate', 'snap'];

export const DEFAULT_FLAG_FINDER: FlagFinder = 'generate';

/** The stored setting as sent, or why it can't be stored. */
export function readFlagFinder(raw: unknown): FlagFinder | string {
  const value = (raw ?? {}) as Record<string, unknown>;
  const finder = typeof raw === 'string' ? raw : value['finder'];
  if (typeof finder === 'string' && (FLAG_FINDERS as readonly string[]).includes(finder)) return finder as FlagFinder;
  return `finder must be ${FLAG_FINDERS.map((f) => `"${f}"`).join(' or ')}`;
}

/** What a run uses for a stored value. Absent or unreadable: the default. */
export function flagFinderOf(stored: unknown): FlagFinder {
  if (stored === undefined || stored === null) return DEFAULT_FLAG_FINDER;
  const read = readFlagFinder(stored);
  return (FLAG_FINDERS as readonly string[]).includes(read) ? (read as FlagFinder) : DEFAULT_FLAG_FINDER;
}

/** The `ranker` stored on rows found this way. There is no ranker score: `nli_score` stays null. */
export const GENERATE_RANKER = 'generate-v1' as const;

// =============================================================================
// CHUNKS
// =============================================================================

/**
 * About how much transcript one call reads, in characters (the user: "maybe we
 * should take it in chunks of like 8,000 characters or something"). This is the
 * lever against a mid-size model listing only the first few matches of a long
 * input (docs/chapter-pipeline-handoff.md): smaller chunks, fewer items each.
 * A model whose context is smaller than this reads smaller chunks (the run
 * caps it at the flags model's limit).
 */
export const GENERATE_CHUNK_CHARS = 8000;

/** Sentences each chunk repeats from the end of the one before, so a passage cut at a seam is seen whole. */
export const GENERATE_CHUNK_OVERLAP_SENTENCES = 2;

/**
 * The output ceiling for one chunk's answer (sent as max_tokens to a Crucible
 * catalog model; cloud upstreams are sent none). A passage is about 40-60
 * tokens of JSON (two short anchors and a category or two), so 4,096 holds
 * 60-plus passages from ~2,500 tokens of transcript. A reply that still reaches
 * it is said on the job, by chunk, never silently cut.
 */
export const GENERATE_MAX_OUTPUT_TOKENS = 4096;

/** One chunk: an inclusive range of sentence indices. */
export interface TranscriptChunk {
  from: number;
  to: number;
  /** Characters of transcript it holds (one sentence per line). */
  chars: number;
}

/**
 * Cut the sentences into chunks of at most `maxChars` characters (one sentence
 * per line), at sentence boundaries, each starting `overlap` sentences before
 * the previous one ended. A single sentence longer than `maxChars` is a chunk
 * of its own: sentences are the unit timestamps come from, and are never split.
 */
export function chunkSentences(
  sentences: Array<Pick<RankedSentence, 'text'>>,
  maxChars: number = GENERATE_CHUNK_CHARS,
  overlap: number = GENERATE_CHUNK_OVERLAP_SENTENCES,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let from = 0;
  while (from < sentences.length) {
    let to = from;
    let chars = sentences[from].text.length;
    while (to + 1 < sentences.length && chars + 1 + sentences[to + 1].text.length <= maxChars) {
      to++;
      chars += 1 + sentences[to].text.length;
    }
    chunks.push({ from, to, chars });
    if (to === sentences.length - 1) break;
    // Always forward, even when the overlap would cover the whole chunk.
    from = Math.max(from + 1, to + 1 - Math.max(0, overlap));
  }
  return chunks;
}

// =============================================================================
// THE PROMPT
// =============================================================================

/**
 * The discovery prompt for one chunk.
 *
 * Categories are named with the scorer's short description of the ACT
 * (SNAP_OPTION_TEXTS via buildFlagPlan; a custom category's own description),
 * never with DEFAULT_CATEGORIES' LLM instructions.
 *
 * It asks for EVERY passage where a category may apply, reported and quoted
 * ones included: whether the speaker asserts it (the report-vs-assert judgment)
 * is the verifier's question, asked of each passage afterwards. Per the
 * prompt-hygiene ruling (analysis-prompts.ts): correct forms only, no incorrect
 * examples and no ban lists.
 */
export function buildGenerateFlagsPrompt(plan: Array<Pick<FlagOptionPlan, 'category' | 'optionText'>>, chunkText: string): string {
  const categories = plan.map((p) => `- ${p.category}: ${p.optionText}`).join('\n');
  return `Read this part of a video transcript and mark every passage where any of these categories may apply.

Categories:
${categories}

Mark generously. Include every passage where a category may apply, the ones you are unsure about too, and passages where the speaker quotes, reports or discusses such content. Each passage you mark is checked closely afterwards, one at a time.

A passage is one sentence or a few consecutive sentences about one point. For each passage give:
- first_words: the first 5 to 10 words of the passage, copied exactly from the transcript
- last_words: the last 5 to 10 words of the passage, copied exactly from the transcript
- categories: the name of every category above that may apply to it

Output JSON only, in this shape:
{"passages": [{"first_words": "<exact first words>", "last_words": "<exact last words>", "categories": ["<category name>"]}]}
When no passage in this part matches a category, output {"passages": []}.

TRANSCRIPT:
${chunkText}`;
}

/**
 * The answer's shape, for a Crucible catalog model and ollama/ (a cloud
 * upstream gets no schema: target.ts). Category names are an enum of the
 * enabled categories, so a constrained decode can only name real ones.
 */
export function generateFlagsSchema(categoryNames: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      passages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            first_words: { type: 'string' },
            last_words: { type: 'string' },
            categories: { type: 'array', items: { type: 'string', enum: categoryNames } },
          },
          required: ['first_words', 'last_words', 'categories'],
          additionalProperties: false,
        },
      },
    },
    required: ['passages'],
    additionalProperties: false,
  };
}

// =============================================================================
// READING THE ANSWER
// =============================================================================

/** One passage as the model returned it. */
export interface GeneratedPassage {
  firstWords: string;
  lastWords: string;
  categories: string[];
}

/**
 * The passages in one answer, or null when it holds none that can be read.
 *
 * Tolerant on purpose, as parseVerification is: a cloud upstream gets no
 * schema and may wrap the JSON in prose or a fence, and a reply cut off at the
 * token ceiling still holds the passages written before the cut. Only whole
 * passage objects are read (each parsed as it stands); a fragment is never
 * repaired into one. `whole` is false when the list itself could not be read
 * and its complete items were picked out one by one.
 *
 * An item without both anchors is counted in `invalid`, never guessed at.
 */
export function parseGeneratedPassages(
  text: string,
): { passages: GeneratedPassage[]; invalid: number; whole: boolean } | null {
  if (!text || !text.trim()) return null;
  const cleaned = stripThinkTags(text).trim();

  const read = (items: unknown[], whole: boolean) => {
    const passages: GeneratedPassage[] = [];
    let invalid = 0;
    for (const item of items) {
      const passage = passageOf(item);
      if (passage) passages.push(passage);
      else invalid++;
    }
    return { passages, invalid, whole };
  };

  // The list as a whole: {"passages": [...]}, or a bare array.
  const unfenced = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (unfenced.startsWith('[')) {
    try {
      const parsed = JSON.parse(unfenced);
      if (Array.isArray(parsed)) return read(parsed, true);
    } catch {
      // fall through to the item scan
    }
  }
  const json = extractJsonFromResponse(cleaned);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const list = parsed?.['passages'];
      if (Array.isArray(list)) return read(list, true);
    } catch {
      // fall through to the item scan
    }
  }

  // Whole passage objects, one by one (a truncated reply, or prose around them).
  const items = balancedObjects(cleaned)
    .map((candidate) => {
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o) && ('first_words' in o || 'last_words' in o));
  if (items.length > 0) return read(items, false);
  return null;
}

function passageOf(item: unknown): GeneratedPassage | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const first = typeof o['first_words'] === 'string' ? o['first_words'].trim() : '';
  const last = typeof o['last_words'] === 'string' ? o['last_words'].trim() : '';
  if (!first || !last) return null;
  const raw = Array.isArray(o['categories']) ? o['categories'] : typeof o['categories'] === 'string' ? [o['categories']] : typeof o['category'] === 'string' ? [o['category']] : [];
  const categories = raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map((c) => c.trim());
  return { firstWords: first, lastWords: last, categories };
}

/** Every balanced {...} in the text, string-aware, innermost first. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length > 0) out.push(text.slice(stack.pop()!, i + 1));
  }
  return out;
}

/**
 * The plan's category a returned name means: exact, else the same name up to
 * case, spaces, underscores and hyphens ("Political demonization" is
 * 'political-demonization'). Null for a name that is not an enabled category.
 */
export function resolveCategoryName(name: string, planNames: string[]): string | null {
  if (planNames.includes(name)) return name;
  const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = key(name);
  return planNames.find((p) => key(p) === wanted) ?? null;
}

// =============================================================================
// ANCHORS
// =============================================================================

/**
 * How close a fuzzy anchor must be (character similarity of the normalised
 * words, 0-1) to count as found. Normalising already takes care of case,
 * punctuation and apostrophes; this tolerates a misheard or respelled word or
 * two in a ten-word anchor ("Somalies" / "Somalis"), not a paraphrase.
 */
export const ANCHOR_MIN_SIMILARITY = 0.8;

/** Anchors shorter than this many words must match exactly: two fuzzy words match too much. */
const ANCHOR_FUZZY_MIN_WORDS = 3;

/** Lowercased words with punctuation and apostrophes gone ("Don't," -> "dont"). */
export function anchorWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Levenshtein distance, two rows. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_u, j) => j);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - editDistance(a, b) / longer;
}

/** Where an anchor was found in the chunk's word stream: [first word, last word]. */
interface AnchorHit {
  from: number;
  to: number;
  score: number;
}

/**
 * Find an anchor's words in the chunk's word stream, at or after `notBefore`
 * (a word index). Exact first (the earliest), then fuzzy: every window of the
 * anchor's length, one word shorter and one longer (a dropped or split word),
 * scored by character similarity; the best at or above ANCHOR_MIN_SIMILARITY,
 * the earliest on a tie. A window is only scored when at least half the
 * anchor's words are in it, which keeps a long chunk cheap.
 */
function findAnchor(words: string[], anchor: string[], notBefore: number, mustEndAfter = -1): AnchorHit | null {
  const n = anchor.length;
  if (n === 0) return null;
  for (let p = notBefore; p + n <= words.length; p++) {
    if (p + n - 1 < mustEndAfter) continue;
    let same = true;
    for (let k = 0; k < n && same; k++) same = words[p + k] === anchor[k];
    if (same) return { from: p, to: p + n - 1, score: 1 };
  }
  if (n < ANCHOR_FUZZY_MIN_WORDS) return null;

  const target = anchor.join(' ');
  const anchorSet = new Set(anchor);
  const needed = Math.ceil(n / 2);
  let best: AnchorHit | null = null;
  for (let p = notBefore; p < words.length; p++) {
    for (const len of [n, n - 1, n + 1]) {
      if (len < 1 || p + len > words.length || p + len - 1 < mustEndAfter) continue;
      let shared = 0;
      for (let k = 0; k < len; k++) if (anchorSet.has(words[p + k])) shared++;
      if (shared < needed) continue;
      const score = similarity(words.slice(p, p + len).join(' '), target);
      if (score >= ANCHOR_MIN_SIMILARITY && (!best || score > best.score)) best = { from: p, to: p + len - 1, score };
    }
  }
  return best;
}

/**
 * A chunk's sentences as one word stream, with the sentence each word is in,
 * built once per chunk and matched against every passage it returned.
 */
export interface ChunkWords {
  words: string[];
  /** Sentence index (into the chunk's sentences) of each word. */
  sentenceOf: number[];
}

export function chunkWords(sentences: Array<Pick<RankedSentence, 'text'>>): ChunkWords {
  const words: string[] = [];
  const sentenceOf: number[] = [];
  sentences.forEach((sentence, index) => {
    for (const word of anchorWords(sentence.text)) {
      words.push(word);
      sentenceOf.push(index);
    }
  });
  return { words, sentenceOf };
}

/**
 * The sentences a passage covers, as indices into the chunk's sentences: the
 * sentence its first words start in to the sentence its last words end in,
 * the last words found at or after the first. Null when either anchor can't be
 * found: the passage is dropped and counted, never guessed.
 */
export function matchPassage(chunk: ChunkWords, firstWords: string, lastWords: string): { from: number; to: number } | null {
  const start = findAnchor(chunk.words, anchorWords(firstWords), 0);
  if (!start) return null;
  // The last words may begin inside the first words (a short, one-sentence
  // passage), but must end no earlier than they do.
  const end = findAnchor(chunk.words, anchorWords(lastWords), start.from, start.to);
  if (!end) return null;
  return { from: chunk.sentenceOf[start.from], to: chunk.sentenceOf[end.to] };
}

// =============================================================================
// PASSAGES -> VERIFICATION WINDOWS
// =============================================================================

/** One passage matched to the whole transcript's sentences, with its plan categories. */
export interface AnchoredPassage {
  /** Inclusive sentence indices into the whole (or ranged) transcript. */
  from: number;
  to: number;
  categories: string[];
}

/**
 * The matched passages as the verifier's windows, by the snap path's rules
 * (buildWindows): each passage expanded by its context sentences, and nearby
 * passages merged category-blind up to the merge cap. The same passage
 * returned by two overlapping chunks is one candidate. There is no score:
 * every candidate is 0 and the windows keep transcript order.
 */
export function windowsFromPassages(
  sentences: RankedSentence[],
  passages: AnchoredPassage[],
  plan: Array<Pick<FlagOptionPlan, 'category' | 'proposition'>>,
): FlagWindow[] {
  const propositionOf = new Map(plan.map((p) => [p.category, p.proposition]));
  const seen = new Set<string>();
  const candidates: FlagCandidate[] = [];
  for (const passage of passages) {
    for (const category of passage.categories) {
      const proposition = propositionOf.get(category);
      const key = `${passage.from}:${passage.to}:${category}`;
      if (proposition === undefined || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        sentenceIndex: passage.from,
        spanFrom: passage.from,
        spanTo: passage.to,
        start: sentences[passage.from].start,
        end: sentences[passage.to].end,
        text: sentences.slice(passage.from, passage.to + 1).map((s) => s.text).join(' '),
        category,
        score: 0,
        proposition,
        source: 'generate',
        rescued: false,
      });
    }
  }
  candidates.sort((a, b) => a.spanFrom - b.spanFrom || a.spanTo - b.spanTo);
  return buildWindows(sentences, candidates);
}
