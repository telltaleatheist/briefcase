import { VideoItem } from './video.model';

/**
 * The library search (GET /api/database/search; backend
 * search/library-search.ts): videos whose file name matches, best match
 * first, then with Deep search the closest matches, videos whose name holds
 * some of it and the transcript says the rest, videos where the transcript says it, and partial
 * matches (most of the words), each with the moments where it is said.
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
  /** Says only some of the words searched for (a partial match). */
  partial?: boolean;
}

export interface SearchHit {
  video: VideoItem;
  /** The title as shown (file name without its extension). */
  title: string;
  /** Ranges of `title` that matched; empty when only the transcript did. */
  titleHighlights: Array<[number, number]>;
  /**
   * How closely the file name holds the whole query (backend
   * filename-match.ts), 0 best; absent unless it holds it all. Results list
   * by it first until a column header is clicked.
   */
  titleRank?: 0 | 1 | 2 | 3;
  /**
   * Deep search, 3 or more words: the name and one stretch of speech hold
   * only `found` of the `of` telling words (those not said nearly
   * everywhere). Listed after every full match.
   */
  partial?: { found: number; of: number };
  /**
   * Deep search, 3 or more words: one of the few closest matches, its place
   * among them from 0 (words said side by side as typed and rare words count
   * most). Listed right after the names that hold the whole query.
   */
  closest?: number;
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
 * Search hits in the order they open in: names holding the whole query, by
 * how closely (titleRank, best first); the closest matches, closest first;
 * names holding some of it where the transcript says the rest; videos that
 * say it (or mean it); each but the closest by `compare` (newest upload
 * first) within. Then partial matches, in the search's own order (most of the
 * words first). A clicked column header sorts them all by that column instead.
 */
export function orderSearchHits(hits: ReadonlyArray<SearchHit>, compare: (a: VideoItem, b: VideoItem) => number): SearchHit[] {
  const tier = (h: SearchHit) => h.titleRank ?? (h.closest !== undefined ? 4 : h.partial ? 7 : h.titleHighlights.length ? 5 : 6);
  const within = (a: SearchHit, b: SearchHit) => {
    if (a.closest !== undefined && b.closest !== undefined) return a.closest - b.closest;
    return a.partial ? 0 : compare(a.video, b.video);
  };
  return [...hits].sort((a, b) => tier(a) - tier(b) || within(a, b));
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
