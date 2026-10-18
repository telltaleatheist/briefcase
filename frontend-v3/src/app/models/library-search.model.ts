import { VideoItem } from './video.model';

/**
 * The library search (GET /api/database/search; backend
 * search/library-search.ts): videos whose file name matches, best match
 * first, then with Deep search videos where the transcript says it, each with
 * the moments where it is said.
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
  /** Found by meaning (Deep search), not by its words: nothing is highlighted. */
  meaning?: boolean;
}

export interface SearchHit {
  video: VideoItem;
  /** The title as shown (file name without its extension). */
  title: string;
  /** Ranges of `title` that matched; empty when only the transcript did. */
  titleHighlights: Array<[number, number]>;
  /**
   * How closely the file name holds the query (backend filename-match.ts), 0
   * best; absent when only the transcript matched. Results list by it first,
   * whatever they are sorted by.
   */
  titleRank?: 0 | 1 | 2 | 3;
  /** In time order, at most 25. */
  moments: TranscriptMoment[];
  /** Moments that matched in all, before the cap. */
  momentCount: number;
}

export interface LibrarySearchResponse {
  query: string;
  /** Whether this was a Deep search (transcripts too). */
  deep: boolean;
  hits: SearchHit[];
  /** Moments across all videos, before the per-video cap. */
  momentCount: number;
  /** More transcript matches than were read: momentCount is a floor. */
  capped: boolean;
  /** The words each plain query word also matched (near spellings). */
  spellings: Record<string, string[]>;
  /** With Deep search: transcripts the meaning index covers so far, of all (it fills in the background). */
  meaning?: { indexed: number; total: number };
  /** With Deep search, while the transcript index fills after a library opens: what is left (those are not searched yet). */
  indexing: { pending: number; total: number; error?: string } | null;
}

/**
 * Search hits in the order the library lists them: by how closely the file
 * name matched (titleRank, best first; transcript-only hits after), then by
 * `compare` (the filters' Sort By and Order) within each.
 */
export function orderSearchHits(hits: ReadonlyArray<SearchHit>, compare: (a: VideoItem, b: VideoItem) => number): SearchHit[] {
  const tier = (h: SearchHit) => h.titleRank ?? 4;
  return [...hits].sort((a, b) => tier(a) - tier(b) || compare(a.video, b.video));
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
