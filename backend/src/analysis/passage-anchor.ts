/**
 * A PASSAGE QUOTED BY A MODEL, FOUND IN THE TRANSCRIPT: the model never sees or
 * writes a timestamp. It names a passage by its first and last words, copied
 * from the transcript; those are matched (fuzzily) to the transcript's
 * sentences here, and the times are those sentences' segment times.
 *
 * Shared by the flags the model marks (flag-highlights.ts)
 * and the markers the Ask chat places (video-chat/). Pure: no I/O, no Nest.
 */
import type { RankedSentence } from './flag-windows';


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
