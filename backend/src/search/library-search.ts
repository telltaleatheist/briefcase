/**
 * LIBRARY SEARCH: the one search behind the library's search box (the user,
 * 2026-10-09, replacing the years-old video-level FTS search: "if we need to
 * rip the whole thing out and replace it we can").
 *
 * A query is matched against two things, with the same syntax and the same
 * near spellings (moment-query.ts):
 *   titles       a video whose title holds every part of the query (the old
 *                search's default was filenames only, so this stays first-class)
 *   transcripts  the moments where it is said (transcript-moments.ts)
 * One list comes back: videos whose title matches first, then videos by their
 * best moment, each with its moments. Everything is local SQLite.
 *
 * Titles have their own full-text index over `videos.filename`
 * (external content, so the names are not stored twice), kept current by
 * triggers on `videos`: nothing in the app has to remember to update it.
 */
import type { Database } from 'better-sqlite3';

import { highlightRanges, matchExpression, matcherOf, parseMomentQuery } from './moment-query';
import { findMomentWindows, momentsOf, spellerFor, type Moment, type MomentWindow } from './transcript-moments';

/** A file name as the library shows it: without its extension. */
export function titleOf(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

/**
 * Create the title index and its triggers if they are missing, and rebuild it
 * when it does not match `videos` (new here, or a table rebuild that dropped
 * the triggers). Safe to call on every open; the check reads ~7k names.
 */
export function ensureTitleIndex(db: Database): void {
  const existed = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'video_titles_fts'`).get();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS video_titles_fts USING fts5(
      filename,
      content='videos',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS video_titles_ai AFTER INSERT ON videos BEGIN
      INSERT INTO video_titles_fts (rowid, filename) VALUES (new.rowid, new.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS video_titles_ad AFTER DELETE ON videos BEGIN
      INSERT INTO video_titles_fts (video_titles_fts, rowid, filename) VALUES ('delete', old.rowid, old.filename);
    END;
    CREATE TRIGGER IF NOT EXISTS video_titles_au AFTER UPDATE OF filename ON videos BEGIN
      INSERT INTO video_titles_fts (video_titles_fts, rowid, filename) VALUES ('delete', old.rowid, old.filename);
      INSERT INTO video_titles_fts (rowid, filename) VALUES (new.rowid, new.filename);
    END;
  `);
  let consistent = existed;
  if (existed) {
    try {
      db.prepare(`INSERT INTO video_titles_fts (video_titles_fts, rank) VALUES ('integrity-check', 1)`).run();
    } catch {
      consistent = false;
    }
  }
  if (!consistent) db.prepare(`INSERT INTO video_titles_fts (video_titles_fts) VALUES ('rebuild')`).run();
}

export interface LibraryHit {
  videoId: string;
  /** The title as shown, and the ranges of it that matched; empty when only the transcript did. */
  title: string;
  titleHighlights: Array<[number, number]>;
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
}

export interface LibrarySearchOptions {
  fuzzy?: boolean;
  /** Most videos returned (default 300). */
  maxVideos?: number;
}

export function searchLibrary(db: Database, query: string, options: LibrarySearchOptions = {}): LibrarySearchResult {
  const parsed = parseMomentQuery(query);
  if (parsed.groups.length === 0) return { hits: [], momentCount: 0, capped: false, spellings: {} };
  const maxVideos = options.maxVideos ?? 300;
  const { spell, spellings } = spellerFor(db, options.fuzzy ?? true);
  const matcher = matcherOf(parsed, spell);

  const found = findMomentWindows(db, parsed, spell);
  const windowsOf = new Map(found.ranked.map((r) => [r.videoId, r.windows]));

  // Titles first (most spoken first), then videos where it is only said, by rank.
  const titleRows = db.prepare(`
    SELECT v.id, v.filename FROM video_titles_fts f JOIN videos v ON v.rowid = f.rowid
    WHERE video_titles_fts MATCH ?
  `).all(matchExpression(parsed, spell)) as Array<{ id: string; filename: string }>;
  const titled = titleRows
    .map((v) => ({ videoId: v.id, title: titleOf(v.filename), windows: windowsOf.get(v.id) ?? [] }))
    .sort((a, b) => b.windows.length - a.windows.length || a.title.localeCompare(b.title));
  const titledIds = new Set(titled.map((t) => t.videoId));
  const filenameOf = db.prepare('SELECT filename FROM videos WHERE id = ?');
  const spoken = found.ranked
    .filter((r) => !titledIds.has(r.videoId))
    .slice(0, Math.max(0, maxVideos - titled.length))
    .flatMap((r) => {
      const row = filenameOf.get(r.videoId) as { filename: string } | undefined;
      return row ? [{ videoId: r.videoId, title: titleOf(row.filename), windows: r.windows }] : [];
    });

  const hit = (v: { videoId: string; title: string; windows: MomentWindow[] }, titleMatched: boolean): LibraryHit => ({
    videoId: v.videoId,
    title: v.title,
    titleHighlights: titleMatched ? highlightRanges(v.title, matcher) : [],
    moments: momentsOf(db, v.windows, parsed, spell),
    momentCount: v.windows.length,
  });
  const hits = [...titled.slice(0, maxVideos).map((v) => hit(v, true)), ...spoken.map((v) => hit(v, false))];
  return { hits, momentCount: found.momentCount, capped: found.capped, spellings };
}
