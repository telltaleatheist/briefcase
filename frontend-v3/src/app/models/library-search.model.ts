import { VideoItem } from './video.model';

/**
 * The library search (GET /api/database/search; backend
 * search/library-search.ts): videos whose title matches, then videos where
 * the transcript says it, each with the moments where it is said.
 */
export interface TranscriptMoment {
  /** Where to play from, in seconds. */
  start: number;
  end: number;
  /** The sentences that matched. */
  text: string;
  /** [start, end) character ranges of `text` that matched. */
  highlights: Array<[number, number]>;
  score: number;
}

export interface SearchHit {
  video: VideoItem;
  /** The title as shown (file name without its extension). */
  title: string;
  /** Ranges of `title` that matched; empty when only the transcript did. */
  titleHighlights: Array<[number, number]>;
  /** In time order, at most 25. */
  moments: TranscriptMoment[];
  /** Moments that matched in all, before the cap. */
  momentCount: number;
}

export interface LibrarySearchResponse {
  query: string;
  hits: SearchHit[];
  /** Moments across all videos, before the per-video cap. */
  momentCount: number;
  /** More transcript matches than were read: momentCount is a floor. */
  capped: boolean;
  /** The words each plain query word also matched (near spellings). */
  spellings: Record<string, string[]>;
  /** While the transcript index fills after a library opens: what is left (those are not searched yet). */
  indexing: { pending: number; total: number; error?: string } | null;
}

/** Text cut into plain and matched pieces, in order. */
export function highlightPieces(text: string, highlights: ReadonlyArray<[number, number]>): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of highlights) {
    if (start < at || end <= start || end > text.length) continue;
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
