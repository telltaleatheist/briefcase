/**
 * Sentence units for the snap scorer (docs/snap-analysis-plan.md §3.1): ONE
 * builder for chapters AND flags, so both ask their questions against the same
 * unit list and the same state text, and share one primed checkpoint (§3.2).
 *
 * Briefcase's `assembleSentences` (the NLI ranker's splitter, left unchanged)
 * does the split and the MEASURED segment timings; on top of it:
 *   1. the fold from ContentStudio's submap.py `sentences(min_words=4)`: a
 *      sentence under 4 words is folded into the sentence that follows (and a
 *      fold that is still short keeps folding forward); a short tail stays a
 *      unit of its own. The merged unit takes the first sentence's start and
 *      the last one's end, so both times are still segment times.
 *   2. a run-on cap (plan §3.1, not in ContentStudio): a unit over 60 words or
 *      30 s — whisper sometimes emits minutes with no punctuation — is split
 *      into ~30-word pieces. With the whisper segments at hand (assembleUnits)
 *      the cut is at segment boundaries and each piece has its own segments'
 *      times; from sentences alone (unitsFromSentences, the flag ranker's
 *      standalone entry) it is cut by word count and each piece keeps the times
 *      of the sentence(s) it lies in.
 *
 * Every unit records the inclusive range of `assembleSentences` sentences it
 * overlaps (`sentenceFrom..sentenceTo`). The flag pipeline indexes windows,
 * verifier passages and stored sections by SENTENCE, so a flag span over units
 * maps back to whole sentences through it. Chapters only use the unit times.
 *
 * Nothing interpolates: when a sentence starts mid-segment its start is that
 * segment's start (early by up to one segment, the right direction for a marker).
 */

import { RankedSentence, assembleSentences } from '../../analysis/flag-windows';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface SentenceUnit {
  /** Seconds: the start of the first segment the unit overlaps. */
  start: number;
  /** Seconds: the end of the last segment the unit overlaps. */
  end: number;
  text: string;
}

/** A unit as both passes use it: its position and the sentences it came from. */
export interface SnapUnit extends SentenceUnit {
  index: number;
  /** Inclusive `assembleSentences` index range this unit overlaps. */
  sentenceFrom: number;
  sentenceTo: number;
}

export interface AssembleUnitsOptions {
  /** submap.py min_words: sentences with fewer words are folded forward. Default 4; 0 disables. */
  minWords?: number;
  /** Run-on cap: units over this many words are split. Default 60; 0 disables the cap. */
  maxWords?: number;
  /** Run-on cap: units longer than this many seconds are split. Default 30; 0 disables. */
  maxSeconds?: number;
  /** Target words per piece when a run-on is split. Default 30. */
  pieceWords?: number;
}

export const DEFAULT_UNIT_OPTIONS: Required<AssembleUnitsOptions> = {
  minWords: 4,
  maxWords: 60,
  maxSeconds: 30,
  pieceWords: 30,
};

interface Span {
  lo: number;
  hi: number;
  start: number;
  end: number;
}

/** A unit under construction: times, text, sentence range, and (with segments) its character range. */
interface Located extends SentenceUnit {
  sFrom: number;
  sTo: number;
  lo: number;
  hi: number;
}

/** The joined character stream of the segments, exactly as assembleSentences builds it. */
interface Stream {
  full: string;
  spans: Span[];
  /** Character range of each sentence in `full`. */
  sentLo: number[];
  sentHi: number[];
}

/** Python's len(s.split()). */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Whisper segments -> units (assembleSentences + fold + run-on cap cut at
 * segment boundaries). THE unit list of a snap analysis: build it once per
 * video and hand it to both the chapter and the flag pass.
 */
export function assembleUnits(segments: TranscriptSegment[], opts: AssembleUnitsOptions = {}): SnapUnit[] {
  const sentences = assembleSentences(segments);
  if (sentences.length === 0) return [];

  // Rebuild the character stream exactly as assembleSentences does, so every
  // sentence (a trimmed slice of it) can be located and later cut at segment
  // boundaries.
  const spans: Span[] = [];
  let full = '';
  for (const seg of segments) {
    const text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (full) full += ' ';
    spans.push({ lo: full.length, hi: full.length + text.length, start: seg.start, end: seg.end });
    full += text;
  }

  const sentLo: number[] = [];
  const sentHi: number[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const lo = full.indexOf(s.text, cursor);
    if (lo < 0) throw new Error(`assembleUnits: sentence not found in the stream: ${s.text.slice(0, 80)}`);
    sentLo.push(lo);
    sentHi.push(lo + s.text.length);
    cursor = lo + s.text.length;
  }
  return buildUnits(sentences, opts, { full, spans, sentLo, sentHi });
}

/**
 * Sentences -> units, without the segments: the run-on cap cuts by word count.
 * For callers that only hold the sentence list (the flag ranker's standalone
 * entry and the offline eval). The analysis pipeline uses assembleUnits.
 */
export function unitsFromSentences(sentences: RankedSentence[], opts: AssembleUnitsOptions = {}): SnapUnit[] {
  return buildUnits(sentences, opts, null);
}

function buildUnits(sentences: RankedSentence[], opts: AssembleUnitsOptions, stream: Stream | null): SnapUnit[] {
  const o = { ...DEFAULT_UNIT_OPTIONS, ...opts };
  const located: Located[] = sentences.map((s, i) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    sFrom: i,
    sTo: i,
    lo: stream ? stream.sentLo[i] : 0,
    hi: stream ? stream.sentHi[i] : 0,
  }));

  const folded = o.minWords > 0 ? foldShort(located, o.minWords) : located;

  const out: SnapUnit[] = [];
  for (const u of folded) {
    const tooLong =
      (o.maxWords > 0 && wordCount(u.text) > o.maxWords) || (o.maxSeconds > 0 && u.end - u.start > o.maxSeconds);
    const pieces = !tooLong
      ? [u]
      : stream
        ? splitAtSegments(u, stream, o.pieceWords)
        : splitByWords(u, sentences, o.pieceWords);
    for (const p of pieces) {
      out.push({ index: out.length, start: p.start, end: p.end, text: p.text, sentenceFrom: p.sFrom, sentenceTo: p.sTo });
    }
  }
  return out;
}

/** submap.py's fold: a sentence under `minWords` words joins the one after it. */
function foldShort(sents: Located[], minWords: number): Located[] {
  const merged: Located[] = [];
  let pend: Located | null = null;
  for (const s0 of sents) {
    let s = s0;
    if (pend) {
      s = { start: pend.start, end: s.end, text: pend.text + ' ' + s.text, sFrom: pend.sFrom, sTo: s.sTo, lo: pend.lo, hi: s.hi };
      pend = null;
    }
    if (wordCount(s.text) < minWords) {
      pend = s;
      continue;
    }
    merged.push(s);
  }
  if (pend) merged.push(pend);
  return merged;
}

/** The sentences of `u` whose character range meets [lo, hi). */
function sentenceRangeOf(u: Located, stream: Stream, lo: number, hi: number): [number, number] {
  let a = u.sFrom;
  while (a < u.sTo && stream.sentHi[a] <= lo) a++;
  let b = u.sTo;
  while (b > a && stream.sentLo[b] >= hi) b--;
  return [a, b];
}

/** Cut a run-on unit at segment boundaries into pieces of about `pieceWords` words. */
function splitAtSegments(u: Located, stream: Stream, pieceWords: number): Located[] {
  const { full, spans } = stream;
  const hits = spans.filter((s) => s.lo < u.hi && s.hi > u.lo);
  if (hits.length < 2) return [u];

  const piece = (lo: number, hi: number, start: number, end: number): Located => {
    const [sFrom, sTo] = sentenceRangeOf(u, stream, lo, hi);
    return { start, end, text: full.slice(lo, hi).trim(), lo, hi, sFrom, sTo };
  };
  const pieces: Located[] = [];
  let group: Span[] = [];
  let words = 0;
  const flush = () => {
    if (group.length === 0) return;
    const lo = Math.max(u.lo, group[0].lo);
    const hi = Math.min(u.hi, group[group.length - 1].hi);
    if (full.slice(lo, hi).trim()) pieces.push(piece(lo, hi, group[0].start, group[group.length - 1].end));
    group = [];
    words = 0;
  };
  for (const s of hits) {
    group.push(s);
    words += wordCount(full.slice(Math.max(u.lo, s.lo), Math.min(u.hi, s.hi)));
    if (words >= pieceWords) flush();
  }
  // A short remainder joins the previous piece rather than standing alone.
  if (group.length > 0 && pieces.length > 0 && words < pieceWords / 2) {
    const prev = pieces.pop()!;
    const hi = Math.min(u.hi, group[group.length - 1].hi);
    pieces.push(piece(prev.lo, hi, prev.start, group[group.length - 1].end));
    group = [];
  }
  flush();
  return pieces.length > 0 ? pieces : [u];
}

/**
 * Without segments: cut into ceil(words / pieceWords) near-equal pieces by word
 * count. Each piece keeps the times of the sentence(s) its words lie in (never
 * an interpolated time), so the pieces of one long sentence share its times.
 */
function splitByWords(u: Located, sentences: RankedSentence[], pieceWords: number): Located[] {
  const words: Array<{ w: string; s: number }> = [];
  for (let s = u.sFrom; s <= u.sTo; s++) {
    for (const w of sentences[s].text.split(/\s+/).filter(Boolean)) words.push({ w, s });
  }
  if (words.length <= pieceWords) return [u];
  const n = Math.ceil(words.length / pieceWords);
  const size = Math.ceil(words.length / n);
  const out: Located[] = [];
  for (let k = 0; k < words.length; k += size) {
    const slice = words.slice(k, k + size);
    const sFrom = slice[0].s;
    const sTo = slice[slice.length - 1].s;
    out.push({
      start: sentences[sFrom].start,
      end: sentences[sTo].end,
      text: slice.map((x) => x.w).join(' '),
      sFrom,
      sTo,
      lo: 0,
      hi: 0,
    });
  }
  return out;
}
