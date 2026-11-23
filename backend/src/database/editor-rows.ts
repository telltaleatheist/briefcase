import type * as Database from 'better-sqlite3';

/**
 * The rows the video editor creates, edits and deletes: AI sections, custom
 * markers, chapters and mute sections. Its undo/redo works on whole rows.
 * Removing returns exactly what was removed, and restoring puts those rows
 * back as they were (same ids, every column), so a redo after an undo, or an
 * undo after a redo, lands on the same data.
 */
export const EDITOR_TABLES = {
  analysisSections: 'analysis_sections',
  customMarkers: 'custom_markers',
  chapters: 'chapters',
  muteSections: 'mute_sections',
} as const;

export type EditorTable = keyof typeof EDITOR_TABLES;
export type EditorRow = Record<string, unknown> & { id: string };
export type EditorRows = Partial<Record<EditorTable, EditorRow[]>>;
export type EditorRowIds = Partial<Record<EditorTable, string[]>>;

const TABLE_KEYS = Object.keys(EDITOR_TABLES) as EditorTable[];

/**
 * Delete the given rows of one video and return them in full. A chapter takes
 * its sub-chapters with it (the outline never keeps orphans), and they come
 * back in the result so a restore rebuilds the whole subtree. Ids that don't
 * exist, or belong to another video, are skipped.
 */
export function removeEditorRows(db: Database.Database, videoId: string, ids: EditorRowIds): EditorRows {
  const removed: EditorRows = {};
  db.transaction(() => {
    for (const key of TABLE_KEYS) {
      const wanted = [...new Set(ids[key] ?? [])];
      if (!wanted.length) continue;
      const table = EDITOR_TABLES[key];
      const rows: EditorRow[] = [];
      const seen = new Set<string>();
      for (const id of wanted) {
        const found: EditorRow[] =
          key === 'chapters'
            ? (db
                .prepare(
                  `WITH RECURSIVE sub(id) AS (
                     SELECT ? UNION ALL SELECT c.id FROM chapters c JOIN sub ON c.parent_id = sub.id
                   )
                   SELECT * FROM chapters WHERE id IN (SELECT id FROM sub) AND video_id = ?`,
                )
                .all(id, videoId) as EditorRow[])
            : (db.prepare(`SELECT * FROM ${table} WHERE id = ? AND video_id = ?`).all(id, videoId) as EditorRow[]);
        for (const row of found) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
        }
      }
      const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const row of rows) del.run(row.id);
      if (rows.length) removed[key] = rows;
    }
  })();
  return removed;
}

/**
 * Put rows back exactly as `removeEditorRows` returned them. Only the table's
 * real columns are written, and every row is pinned to `videoId`, so a
 * malformed or foreign row can't land on another video. A row whose id
 * already exists is replaced.
 */
export function restoreEditorRows(db: Database.Database, videoId: string, rows: EditorRows): number {
  let restored = 0;
  db.transaction(() => {
    for (const key of TABLE_KEYS) {
      const list = rows[key] ?? [];
      if (!list.length) continue;
      const table = EDITOR_TABLES[key];
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      // Parents before children, so a chapter's parent_id always names a row
      // that's already back.
      const ordered = key === 'chapters' ? parentsFirst(list) : list;
      for (const row of ordered) {
        if (!row || typeof row.id !== 'string' || !row.id) {
          throw new Error(`A ${key} row to restore has no id`);
        }
        const record: Record<string, unknown> = { ...row, video_id: videoId };
        const names = Object.keys(record).filter((name) => columns.has(name));
        db.prepare(
          `INSERT OR REPLACE INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        ).run(...names.map((name) => record[name] ?? null));
        restored++;
      }
    }
  })();
  return restored;
}

function parentsFirst(rows: EditorRow[]): EditorRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const placed = new Set<string>();
  const out: EditorRow[] = [];
  let pending = rows;
  while (pending.length) {
    const next = pending.filter((r) => {
      const parent = r.parent_id as string | null | undefined;
      if (parent && ids.has(parent) && !placed.has(parent)) return true;
      out.push(r);
      placed.add(r.id);
      return false;
    });
    // A cycle can't come out of the outline, but never loop forever on one.
    if (next.length === pending.length) {
      out.push(...next);
      break;
    }
    pending = next;
  }
  return out;
}
