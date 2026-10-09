/**
 * ORPHAN SWEEP: rows that belong to a video that is no longer in the library.
 *
 * Every table that hangs off `videos` declares ON DELETE CASCADE (or SET
 * NULL), so a delete made by the app cleans up after itself. Rows were still
 * left behind, by deletes the cascade never saw: the clips library held 42
 * transcripts with their analyses, sections and tags from Nov 11-14 2025, when
 * the library ran on sql.js (foreign keys not enforced), and 2 chapters from
 * Dec 2025. The sqlite3 shell and Python's sqlite3 also start with foreign
 * keys off, so any delete made with them leaves the same debris. The user,
 * 2026-10-09: "lets remove them if their videos are gone. and lets fix that so
 * that doesnt happen again".
 *
 * So every library open sweeps them: each foreign key into `videos` is read
 * from the schema itself (a table added later is covered without a change
 * here), CASCADE children whose video is gone are deleted, SET NULL ones are
 * unlinked, and the hand-kept full-text mirrors are cleared of the same ids.
 */
import type { Database } from 'better-sqlite3';

/** Full-text mirrors keyed by video_id that no foreign key covers. */
const VIDEO_MIRRORS = ['videos_fts', 'transcripts_fts', 'transcripts_soundex_fts', 'analyses_fts', 'tags_fts'];

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Rows removed (or unlinked) per table; empty when nothing was orphaned. */
export function sweepOrphans(db: Database): Record<string, number> {
  const removed: Record<string, number> = {};
  const count = (table: string, n: number) => {
    if (n > 0) removed[table] = (removed[table] ?? 0) + n;
  };
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'videos' AND sql NOT LIKE 'CREATE VIRTUAL%'`).all() as Array<{ name: string }>;
  db.transaction(() => {
    for (const { name } of tables) {
      const keys = db.prepare(`SELECT "from" AS col, on_delete AS onDelete FROM pragma_foreign_key_list(?) WHERE "table" = 'videos'`).all(name) as Array<{ col: string; onDelete: string }>;
      for (const key of keys) {
        const orphaned = `${ident(key.col)} IS NOT NULL AND ${ident(key.col)} NOT IN (SELECT id FROM videos)`;
        if (key.onDelete === 'SET NULL') {
          count(name, db.prepare(`UPDATE ${ident(name)} SET ${ident(key.col)} = NULL WHERE ${orphaned}`).run().changes);
        } else {
          count(name, db.prepare(`DELETE FROM ${ident(name)} WHERE ${orphaned}`).run().changes);
        }
      }
    }
    const present = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name));
    for (const mirror of VIDEO_MIRRORS) {
      if (!present.has(mirror)) continue;
      count(mirror, db.prepare(`DELETE FROM ${ident(mirror)} WHERE video_id NOT IN (SELECT id FROM videos)`).run().changes);
    }
  })();
  return removed;
}
