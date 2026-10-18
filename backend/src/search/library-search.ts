/**
 * LIBRARY SEARCH: the one search behind the library's search box (the user,
 * 2026-10-09, replacing the years-old video-level FTS search: "if we need to
 * rip the whole thing out and replace it we can").
 *
 * By default a query is matched against file names only, ignoring word
 * breaks (filename-match.ts; the user, 2026-10-17: "i name files in such a
 * way that i should be able to find them easily by a few keywords"). Deep
 * search adds what is said, with the same syntax:
 *   transcripts  the moments where it is said, with near spellings
 *                (transcript-moments.ts)
 *   meaning      the moments that mean it (meaning-search.ts)
 * One list comes back: videos whose file name matches first, best match first
 * (FilenameRank), then videos by their best moment, each with its moments.
 * Everything is local SQLite.
 */
import type { Database } from 'better-sqlite3';

import { filenameQueryOf, matchFilename, type FilenameRank } from './filename-match';
import { parseMomentQuery } from './moment-query';
import { meaningIndexCounts, searchLibraryMeaning } from './meaning-search';
import { findMomentWindows, momentsOf, spellerFor, type Moment, type MomentWindow } from './transcript-moments';

/** A file name as the library shows it: without its extension. */
export function titleOf(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

export interface LibraryHit {
  videoId: string;
  /** The title as shown, and the ranges of it that matched; empty when only the transcript did. */
  title: string;
  titleHighlights: Array<[number, number]>;
  /** How well the file name matched (filename-match.ts), 0 best; absent when only the transcript did. */
  titleRank?: FilenameRank;
  /** In time order, at most the per-video cap. */
  moments: Moment[];
  /** Moments that matched in all, before the cap. */
  momentCount: number;
}

export interface LibrarySearchResult {
  hits: LibraryHit[];
  /** Moments across all videos, before the per-video cap. */
  momentCount: number;
  /** More transcript windows matched than were read: momentCount is a floor. */
  capped: boolean;
  /** The words each plain query word also matched (near spellings). */
  spellings: Record<string, string[]>;
  /** With Deep search: the transcripts searched by meaning, of those there are (the index fills in the background). */
  meaning?: { indexed: number; total: number };
}

export interface LibrarySearchOptions {
  /** Deep search: also near spellings of the words in the transcripts (default true). */
  fuzzy?: boolean;
  /** Most videos returned (default 300). */
  maxVideos?: number;
  /**
   * Deep search: also the transcripts, where it is said. Off, only file names
   * are matched and the transcripts are not read at all.
   */
  deep?: boolean;
  /**
   * Deep search: the query embedded by the meaning model (unit length).
   * Meaning moments (meaning-search.ts) join the word results: added under a
   * video that matched by name or words where they do not overlap its
   * moments, and videos found only by meaning listed after, best first.
   * Ignored without `deep`.
   */
  meaningQuery?: Float32Array;
}

/** Videos by file name, best match first and then newest download first. */
function matchTitles(db: Database, query: ReturnType<typeof filenameQueryOf>) {
  const rows = db.prepare('SELECT id, filename, download_date FROM videos').all() as Array<{ id: string; filename: string; download_date: string | null }>;
  return rows
    .flatMap((v) => {
      const title = titleOf(v.filename);
      const match = matchFilename(title, query);
      return match ? [{ videoId: v.id, title, downloaded: v.download_date ?? '', match }] : [];
    })
    .sort((a, b) => a.match.rank - b.match.rank || b.downloaded.localeCompare(a.downloaded) || a.title.localeCompare(b.title));
}

export function searchLibrary(db: Database, query: string, options: LibrarySearchOptions = {}): LibrarySearchResult {
  const parsed = parseMomentQuery(query);
  const nameQuery = filenameQueryOf(parsed);
  if (nameQuery.groups.length === 0) return { hits: [], momentCount: 0, capped: false, spellings: {} };
  const maxVideos = options.maxVideos ?? 300;
  const titled = matchTitles(db, nameQuery);

  if (!options.deep) {
    const hits = titled.slice(0, maxVideos).map((v): LibraryHit => ({
      videoId: v.videoId,
      title: v.title,
      titleHighlights: v.match.highlights,
      titleRank: v.match.rank,
      moments: [],
      momentCount: 0,
    }));
    return { hits, momentCount: 0, capped: false, spellings: {} };
  }

  const { spell, spellings } = spellerFor(db, options.fuzzy ?? true);
  const found = findMomentWindows(db, parsed, spell);
  const windowsOf = new Map(found.ranked.map((r) => [r.videoId, r.windows]));

  // File names first (best match, then most spoken), then videos where it is only said, by rank.
  const named = titled
    .map((v) => ({ ...v, windows: windowsOf.get(v.videoId) ?? [] }))
    .sort((a, b) => a.match.rank - b.match.rank || b.windows.length - a.windows.length);
  const namedIds = new Set(named.map((t) => t.videoId));
  const filenameOf = db.prepare('SELECT filename FROM videos WHERE id = ?');
  const spoken = found.ranked
    .filter((r) => !namedIds.has(r.videoId))
    .slice(0, Math.max(0, maxVideos - named.length))
    .flatMap((r) => {
      const row = filenameOf.get(r.videoId) as { filename: string } | undefined;
      return row ? [{ videoId: r.videoId, title: titleOf(row.filename), windows: r.windows }] : [];
    });

  const hit = (v: { videoId: string; title: string; windows: MomentWindow[] }): LibraryHit => ({
    videoId: v.videoId,
    title: v.title,
    titleHighlights: [],
    moments: momentsOf(db, v.windows, parsed, spell),
    momentCount: v.windows.length,
  });
  const hits = [
    ...named.slice(0, maxVideos).map((v) => ({ ...hit(v), titleHighlights: v.match.highlights, titleRank: v.match.rank })),
    ...spoken.map(hit),
  ];
  if (!options.meaningQuery) return { hits, momentCount: found.momentCount, capped: found.capped, spellings };

  const meaning = searchLibraryMeaning(db, options.meaningQuery);
  const byId = new Map(hits.map((h) => [h.videoId, h]));
  let meaningMoments = 0;
  for (const v of meaning.videos) {
    const existing = byId.get(v.videoId);
    if (existing) {
      const fresh = v.moments.filter((m) => existing.moments.every((w) => m.end <= w.start || m.start >= w.end));
      existing.moments = [...existing.moments, ...fresh].sort((a, b) => a.start - b.start);
      existing.momentCount += fresh.length;
      meaningMoments += fresh.length;
      continue;
    }
    if (hits.length >= maxVideos) continue;
    const row = filenameOf.get(v.videoId) as { filename: string } | undefined;
    if (!row) continue;
    const added: LibraryHit = { videoId: v.videoId, title: titleOf(row.filename), titleHighlights: [], moments: v.moments, momentCount: v.moments.length };
    hits.push(added);
    byId.set(v.videoId, added);
    meaningMoments += v.moments.length;
  }
  return {
    hits,
    momentCount: found.momentCount + meaningMoments,
    capped: found.capped,
    spellings,
    meaning: meaningIndexCounts(db),
  };
}
