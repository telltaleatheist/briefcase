/**
 * TRANSCRIPT MOMENTS: search that finds WHERE something is said, not only
 * which video says it (the user, 2026-10-09: "rework the search ... to search
 * for scenes, words, phrases", transcripts only for now).
 *
 * Each transcript's SRT segments are kept with their times, and grouped into
 * WINDOWS of about 30 s that start every 15 s, so every segment sits in one or
 * two windows and words a few sentences apart still count as together. The
 * windows are what SQLite's full-text index holds (contentless: the words
 * live once, in the segments table). A search ranks windows by bm25, keeps the
 * best window of each overlapping run, and hands back MOMENTS: the segments
 * that matched, their time, and the ranges to highlight, grouped by video.
 *
 * Plain words also match near spellings found in the index's own vocabulary
 * (moment-query.ts), which is what catches transcription slips; the old
 * soundex index is not used here.
 *
 * Everything is local SQLite in the library's database (no models, no
 * Crucible). New transcripts are indexed as they are stored; a library
 * opened with transcripts the index has not seen is filled in the background
 * by `indexPendingTranscripts`, in small batches.
 */
import type { Database } from 'better-sqlite3';

import {
  buildVocabulary,
  highlightRanges,
  matchExpression,
  matcherOf,
  nearSpellings,
  type ParsedMomentQuery,
  type Vocabulary,
} from './moment-query';

/** Bump to rebuild every video's windows (a change in how they are cut). */
export const MOMENT_INDEX_VERSION = 1;

/** About 30 s of speech per window, a new one every 15 s. */
export const MOMENT_WINDOWS = { windowSeconds: 30, stepSeconds: 15 } as const;

/**
 * Windows over the segments, as inclusive [first, last] indices in order: a
 * window starting at time t holds the segments starting in [t, t + window);
 * starts step by `step`, and a gap no window reaches opens the next window at
 * the next segment, so every segment is in at least one window. (The same cut
 * as the scorer's timeWindows; kept here so search, which is not AI, does not
 * import the analysis pipeline.)
 */
export function momentWindows(
  segments: ReadonlyArray<{ start: number }>,
  windows: { windowSeconds: number; stepSeconds: number } = MOMENT_WINDOWS,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (segments.length === 0) return out;
  let t = segments[0].start;
  let first = 0;
  while (first < segments.length) {
    while (first < segments.length && segments[first].start < t) first++;
    if (first >= segments.length) break;
    if (segments[first].start >= t + windows.windowSeconds) t = segments[first].start;
    let last = first;
    while (last + 1 < segments.length && segments[last + 1].start < t + windows.windowSeconds) last++;
    out.push([first, last]);
    if (last === segments.length - 1) break;
    t += windows.stepSeconds;
  }
  return out;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** The segments of an SRT document, in order; blocks without a time line are skipped. */
export function parseSrtSegments(srt: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const blocks = srt.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const t = (h: string, m: string, s: string, ms: string) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(lines[at]);
    if (!m) continue;
    const text = lines.slice(at + 1).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ start: t(m[1], m[2], m[3], m[4].padEnd(3, '0')), end: t(m[5], m[6], m[7], m[8].padEnd(3, '0')), text });
  }
  return out;
}

// =============================================================================
// SCHEMA
// =============================================================================

/** Create the moment index's tables if they are missing. Safe to call on every open. */
export function ensureMomentSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_segments (
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      start_s REAL NOT NULL,
      end_s REAL NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (video_id, idx)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS transcript_windows (
      id INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      first_idx INTEGER NOT NULL,
      last_idx INTEGER NOT NULL,
      start_s REAL NOT NULL,
      end_s REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_windows_video ON transcript_windows(video_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_windows_fts USING fts5(
      text,
      content='',
      contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_windows_vocab USING fts5vocab('transcript_windows_fts', 'row');

    CREATE TRIGGER IF NOT EXISTS transcript_windows_ad AFTER DELETE ON transcript_windows BEGIN
      DELETE FROM transcript_windows_fts WHERE rowid = old.id;
    END;

    CREATE TABLE IF NOT EXISTS transcript_index_state (
      video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      transcribed_at TEXT,
      version INTEGER NOT NULL
    );
  `);
}

// =============================================================================
// WRITING
// =============================================================================

/** Index generation per database handle: any write makes the cached vocabulary stale. */
const generations = new WeakMap<Database, number>();
const bump = (db: Database) => generations.set(db, (generations.get(db) ?? 0) + 1);

/** Drop a video's moments (its windows, their index rows, its segments and state). */
export function removeVideoMoments(db: Database, videoId: string): void {
  db.prepare('DELETE FROM transcript_windows WHERE video_id = ?').run(videoId);
  db.prepare('DELETE FROM transcript_segments WHERE video_id = ?').run(videoId);
  db.prepare('DELETE FROM transcript_index_state WHERE video_id = ?').run(videoId);
  bump(db);
}

/**
 * (Re)index one video's transcript. Call inside the transaction that stores
 * the transcript, or on its own (it opens one when none is open).
 */
export function indexVideoMoments(db: Database, videoId: string, srt: string, transcribedAt: string | null): number {
  const run = () => {
    removeVideoMoments(db, videoId);
    const segments = parseSrtSegments(srt || '');
    const insertSegment = db.prepare('INSERT INTO transcript_segments (video_id, idx, start_s, end_s, text) VALUES (?, ?, ?, ?, ?)');
    segments.forEach((s, i) => insertSegment.run(videoId, i, s.start, s.end, s.text));
    const insertWindow = db.prepare('INSERT INTO transcript_windows (video_id, first_idx, last_idx, start_s, end_s) VALUES (?, ?, ?, ?, ?)');
    const insertText = db.prepare('INSERT INTO transcript_windows_fts (rowid, text) VALUES (?, ?)');
    const windows = momentWindows(segments);
    for (const [a, b] of windows) {
      const id = insertWindow.run(videoId, a, b, segments[a].start, segments[b].end).lastInsertRowid;
      insertText.run(id, segments.slice(a, b + 1).map((s) => s.text).join(' '));
    }
    db.prepare('INSERT OR REPLACE INTO transcript_index_state (video_id, transcribed_at, version) VALUES (?, ?, ?)')
      .run(videoId, transcribedAt, MOMENT_INDEX_VERSION);
    return windows.length;
  };
  return db.inTransaction ? run() : db.transaction(run)();
}

/**
 * Transcripts the index has not seen, or saw in an older version or an older
 * transcription. A transcript whose video row is gone (a real library holds a
 * few) is not counted and never indexed.
 */
export function pendingTranscriptCount(db: Database): { pending: number; total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM transcripts t JOIN videos v ON v.id = t.video_id').get() as { n: number }).n;
  const pending = (db.prepare(`
    SELECT COUNT(*) AS n FROM transcripts t
    JOIN videos v ON v.id = t.video_id
    LEFT JOIN transcript_index_state s ON s.video_id = t.video_id
    WHERE s.video_id IS NULL OR s.version != ? OR s.transcribed_at IS NOT t.transcribed_at
  `).get(MOMENT_INDEX_VERSION) as { n: number }).n;
  return { pending, total };
}

/** Index up to `batch` pending transcripts; returns how many were indexed (0: none left). */
export function indexPendingTranscripts(db: Database, batch: number): number {
  const rows = db.prepare(`
    SELECT t.video_id, t.srt_format, t.transcribed_at FROM transcripts t
    JOIN videos v ON v.id = t.video_id
    LEFT JOIN transcript_index_state s ON s.video_id = t.video_id
    WHERE s.video_id IS NULL OR s.version != ? OR s.transcribed_at IS NOT t.transcribed_at
    LIMIT ?
  `).all(MOMENT_INDEX_VERSION, batch) as Array<{ video_id: string; srt_format: string | null; transcribed_at: string | null }>;
  if (rows.length === 0) return 0;
  db.transaction(() => {
    for (const row of rows) indexVideoMoments(db, row.video_id, row.srt_format ?? '', row.transcribed_at);
  })();
  return rows.length;
}

// =============================================================================
// SEARCHING
// =============================================================================

const vocabularies = new WeakMap<Database, { generation: number; vocab: Vocabulary }>();

function vocabularyOf(db: Database): Vocabulary {
  const generation = generations.get(db) ?? 0;
  const cached = vocabularies.get(db);
  if (cached && cached.generation === generation) return cached.vocab;
  const vocab = buildVocabulary(db.prepare('SELECT term, doc AS docs FROM transcript_windows_vocab').all() as Array<{ term: string; docs: number }>);
  vocabularies.set(db, { generation, vocab });
  return vocab;
}

export interface Moment {
  /** Where to play from: the first matching segment's start. */
  start: number;
  end: number;
  /** The matching segments' words. */
  text: string;
  /** [start, end) character ranges of `text` that matched. */
  highlights: Array<[number, number]>;
  score: number;
}

export interface VideoMoments {
  videoId: string;
  /** The best moment's score. */
  score: number;
  /** Moments in time order, at most `maxMomentsPerVideo`. */
  moments: Moment[];
  /** How many moments matched in all, before the cap. */
  momentCount: number;
}

/** A matching window, as read from the index. */
export interface MomentWindow {
  videoId: string;
  firstIdx: number;
  lastIdx: number;
  start: number;
  end: number;
  score: number;
}

/** The windows a query matched, per video: the best of each overlapping run, best first. */
export interface MomentWindows {
  /** Videos ranked by their best window (then by how many they have). */
  ranked: Array<{ videoId: string; windows: MomentWindow[] }>;
  /** Windows kept across all videos (one per moment). */
  momentCount: number;
  /** The index held more matching windows than were read: counts are a floor. */
  capped: boolean;
}

export interface MomentSearchResult {
  videos: VideoMoments[];
  /** Moments across all videos, before the per-video cap. */
  momentCount: number;
  /** The index held more matching windows than were read: counts are a floor. */
  capped: boolean;
}

/** Most windows read from the index for one query. */
export const MAX_WINDOWS = 4000;
/** Most moments shown per video. */
export const MAX_MOMENTS_PER_VIDEO = 25;

/** How a query's plain words are spelled for matching, and what each was widened to. */
export interface Speller {
  spell: (term: string) => string[];
  /** Each widened word's spellings, filled as `spell` is called. */
  spellings: Record<string, string[]>;
}

/** Near spellings from the transcript index's vocabulary, or exact words when `fuzzy` is false. */
export function spellerFor(db: Database, fuzzy: boolean): Speller {
  const spellings: Record<string, string[]> = {};
  const vocab = fuzzy ? vocabularyOf(db) : null;
  return {
    spellings,
    spell: (term) => (vocab ? (spellings[term] ??= nearSpellings(term, vocab)) : [term]),
  };
}

/** The longest stretch a moment shows, in seconds (segments run from ~1 s to ~10 s). */
const SNIPPET_SECONDS = 25;
/** Without a hit, a moment shows the window's first few segments. */
const SNIPPET_FALLBACK_SEGMENTS = 3;

/**
 * The segments a moment shows: the shortest run (in time) that holds every
 * part of the query, each group matched somewhere in it, within
 * SNIPPET_SECONDS. So "kenneth copeland jet" shows the names and the jet, not
 * only the first hit. When the parts never all fit (a phrase across a
 * segment break, or hits too far apart), it shows the hits within
 * SNIPPET_SECONDS of the first one. Null: no segment matched.
 */
export function snippetRange(groupHits: boolean[][], segments: ReadonlyArray<{ start: number; end: number }>): [number, number] | null {
  const n = groupHits.length;
  const groups = groupHits[0]?.length ?? 0;
  const anyHit = groupHits.findIndex((g) => g.some(Boolean));
  if (anyHit < 0) return null;
  const within = (a: number, b: number) => segments[b].end - segments[a].start <= SNIPPET_SECONDS;
  let best: [number, number] | null = null;
  for (let a = 0; a < n; a++) {
    if (!groupHits[a].some(Boolean)) continue;
    const seen = new Array<boolean>(groups).fill(false);
    for (let b = a; b < n && (b === a || within(a, b)); b++) {
      groupHits[b].forEach((hit, g) => (seen[g] ||= hit));
      if (seen.every(Boolean)) {
        const span = segments[b].end - segments[a].start;
        if (!best || span < segments[best[1]].end - segments[best[0]].start) best = [a, b];
        break;
      }
    }
  }
  if (best) return best;
  let last = anyHit;
  for (let b = anyHit + 1; b < n && within(anyHit, b); b++) if (groupHits[b].some(Boolean)) last = b;
  return [anyHit, last];
}

/** Step 1, cheap: the windows a query matches, grouped and ranked by video (no text read). */
export function findMomentWindows(db: Database, parsed: ParsedMomentQuery, spell: (term: string) => string[]): MomentWindows {
  if (parsed.groups.length === 0) return { ranked: [], momentCount: 0, capped: false };
  const hits = db.prepare(`
    SELECT w.video_id AS videoId, w.first_idx AS firstIdx, w.last_idx AS lastIdx, w.start_s AS start, w.end_s AS end, -f.rank AS score
    FROM transcript_windows_fts f JOIN transcript_windows w ON w.id = f.rowid
    WHERE transcript_windows_fts MATCH ?
    ORDER BY f.rank
    LIMIT ?
  `).all(matchExpression(parsed, spell), MAX_WINDOWS) as MomentWindow[];

  const byVideo = new Map<string, MomentWindow[]>();
  for (const hit of hits) {
    let kept = byVideo.get(hit.videoId);
    if (!kept) byVideo.set(hit.videoId, (kept = []));
    if (kept.some((k) => hit.start < k.end && k.start < hit.end)) continue;
    kept.push(hit);
  }
  let momentCount = 0;
  for (const windows of byVideo.values()) momentCount += windows.length;
  const ranked = [...byVideo.entries()]
    .map(([videoId, windows]) => ({ videoId, windows }))
    .sort((a, b) => b.windows[0].score - a.windows[0].score || b.windows.length - a.windows.length);
  return { ranked, momentCount, capped: hits.length === MAX_WINDOWS };
}

/** Step 2, for the videos shown: each window's matching sentences, in time order. */
export function momentsOf(db: Database, windows: MomentWindow[], parsed: ParsedMomentQuery, spell: (term: string) => string[]): Moment[] {
  const matcher = matcherOf(parsed, spell);
  const groupMatchers = parsed.groups.map((group) => matcherOf({ groups: [group], excluded: [] }, spell));
  const segmentsOf = db.prepare('SELECT idx, start_s AS start, end_s AS end, text FROM transcript_segments WHERE video_id = ? AND idx BETWEEN ? AND ? ORDER BY idx');
  return windows
    .slice(0, MAX_MOMENTS_PER_VIDEO)
    .map((w): Moment => {
      const segments = segmentsOf.all(w.videoId, w.firstIdx, w.lastIdx) as Array<{ idx: number; start: number; end: number; text: string }>;
      const segmentHits = segments.map((seg) => groupMatchers.map((m) => highlightRanges(seg.text, m).length > 0));
      const range = snippetRange(segmentHits, segments);
      const shown = range ? segments.slice(range[0], range[1] + 1) : segments.slice(0, SNIPPET_FALLBACK_SEGMENTS);
      const text = shown.map((seg) => seg.text).join(' ');
      return {
        start: shown[0]?.start ?? w.start,
        end: shown[shown.length - 1]?.end ?? w.end,
        text,
        highlights: highlightRanges(text, matcher),
        score: w.score,
      };
    })
    .sort((a, b) => a.start - b.start);
}

/** Both steps, for the best `maxVideos` videos. */
export function searchMoments(db: Database, parsed: ParsedMomentQuery, spell: (term: string) => string[], maxVideos = 200): MomentSearchResult {
  const found = findMomentWindows(db, parsed, spell);
  return {
    videos: found.ranked.slice(0, maxVideos).map(({ videoId, windows }) => ({
      videoId,
      score: windows[0].score,
      moments: momentsOf(db, windows, parsed, spell),
      momentCount: windows.length,
    })),
    momentCount: found.momentCount,
    capped: found.capped,
  };
}
