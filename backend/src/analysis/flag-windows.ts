/**
 * TRANSCRIPT SENTENCES: the transcript's segments joined and cut into
 * sentences, each with the times of the segments it spans. What the flag
 * stage (flag-highlights.ts), the Ask chat and the snap engine's units all
 * read. (The flag windows and candidate types that also lived here went with
 * the scorer's flag ranking and the verifier, 2026-10-26.)
 */

/** One transcript sentence with the times of the segments it spans. */
export interface RankedSentence {
  start: number;
  end: number;
  text: string;
}

/**
 * Merge transcript segments into sentences.
 *
 * Whisper segments are breath-length fragments, not sentences: scoring them
 * directly gives a model half a clause and no stance. This concatenates
 * every segment into one character stream, splits it on terminal punctuation,
 * and maps each sentence back to the FIRST and LAST segment it overlaps — so
 * the sentence's timestamps are measured segment times, never interpolated.
 *
 * Ported verbatim in behavior from proto_stage12.py.
 */
export function assembleSentences(
  segments: Array<{ start: number; end: number; text: string }>,
): RankedSentence[] {
  const spans: Array<{ lo: number; hi: number; start: number; end: number }> = [];
  const parts: string[] = [];
  let pos = 0;

  for (const seg of segments) {
    const text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (parts.length > 0) {
      parts.push(' ');
      pos += 1;
    }
    parts.push(text);
    spans.push({ lo: pos, hi: pos + text.length, start: seg.start, end: seg.end });
    pos += text.length;
  }

  const full = parts.join('');
  if (!full) return [];

  // Sentence boundaries: . ! ? possibly followed by a closing quote/bracket,
  // then whitespace or end of stream.
  const bounds: number[] = [];
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full)) !== null) bounds.push(m.index + m[0].length);
  if (bounds.length === 0 || bounds[bounds.length - 1] < full.length) bounds.push(full.length);

  const out: RankedSentence[] = [];
  let cursor = 0;
  for (const bound of bounds) {
    const text = full.slice(cursor, bound).trim();
    if (text) {
      const hits = spans.filter((s) => s.lo < bound && s.hi > cursor);
      if (hits.length > 0) {
        out.push({ start: hits[0].start, end: hits[hits.length - 1].end, text });
      }
    }
    cursor = bound;
  }
  return out;
}
