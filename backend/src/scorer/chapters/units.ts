/**
 * Sentence units for snap chaptering (docs/snap-analysis-plan.md §3.1).
 *
 * Briefcase's `assembleSentences` (the NLI ranker's splitter, left unchanged)
 * does the split and the MEASURED segment timings; on top of it:
 *   1. the fold from ContentStudio's submap.py `sentences(min_words=4)`: a
 *      sentence under 4 words is folded into the sentence that follows (and a
 *      fold that is still short keeps folding forward); a short tail stays a
 *      unit of its own. The merged unit takes the first sentence's start and
 *      the last one's end, so both times are still segment times.
 *   2. a run-on cap (plan §3.1, not in ContentStudio): a unit over 60 words or
 *      30 s — whisper sometimes emits minutes with no punctuation — is split at
 *      segment boundaries into ~30-word pieces, each with its own segments' times.
 *
 * Nothing interpolates: when a sentence starts mid-segment its start is that
 * segment's start (early by up to one segment, the right direction for a marker).
 */

import { assembleSentences } from '../../analysis/nli-ranker.service';

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

interface Span {
  lo: number;
  hi: number;
  start: number;
  end: number;
}

interface Located extends SentenceUnit {
  /** Character range of the unit in the joined stream. */
  lo: number;
  hi: number;
}

/** Python's len(s.split()). */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Whisper segments -> sentence units (fold + run-on cap over assembleSentences). */
export function assembleUnits(segments: TranscriptSegment[], opts: AssembleUnitsOptions = {}): SentenceUnit[] {
  const minWords = opts.minWords ?? 4;
  const maxWords = opts.maxWords ?? 60;
  const maxSeconds = opts.maxSeconds ?? 30;
  const pieceWords = opts.pieceWords ?? 30;

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

  const located: Located[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const lo = full.indexOf(s.text, cursor);
    if (lo < 0) throw new Error(`assembleUnits: sentence not found in the stream: ${s.text.slice(0, 80)}`);
    const hi = lo + s.text.length;
    located.push({ ...s, lo, hi });
    cursor = hi;
  }

  const folded = minWords > 0 ? foldShort(located, minWords) : located;

  const out: SentenceUnit[] = [];
  for (const u of folded) {
    const tooLong = (maxWords > 0 && wordCount(u.text) > maxWords) || (maxSeconds > 0 && u.end - u.start > maxSeconds);
    const pieces = tooLong ? splitRunOn(u, full, spans, pieceWords) : [u];
    for (const p of pieces) out.push({ start: p.start, end: p.end, text: p.text });
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
      s = { start: pend.start, end: s.end, text: pend.text + ' ' + s.text, lo: pend.lo, hi: s.hi };
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

/** Cut a run-on unit at segment boundaries into pieces of about `pieceWords` words. */
function splitRunOn(u: Located, full: string, spans: Span[], pieceWords: number): Located[] {
  const hits = spans.filter((s) => s.lo < u.hi && s.hi > u.lo);
  if (hits.length < 2) return [u];

  const pieces: Located[] = [];
  let group: Span[] = [];
  let words = 0;
  const flush = () => {
    if (group.length === 0) return;
    const lo = Math.max(u.lo, group[0].lo);
    const hi = Math.min(u.hi, group[group.length - 1].hi);
    const text = full.slice(lo, hi).trim();
    if (text) pieces.push({ start: group[0].start, end: group[group.length - 1].end, text, lo, hi });
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
    pieces.push({ start: prev.start, end: group[group.length - 1].end, text: full.slice(prev.lo, hi).trim(), lo: prev.lo, hi });
    group = [];
  }
  flush();
  return pieces.length > 0 ? pieces : [u];
}
