import type * as Database from 'better-sqlite3';

/**
 * Migration 27: chapters.level and chapters.parent_id — the outline (nested
 * chapters) from the snap engine's refinement (scorer/chapters/chapter-tree.ts).
 *
 * Additive and nullable, like migrations 24 and 26. NULL level reads as 0 and
 * NULL parent_id as top level, so every existing row (and every flat analysis,
 * which writes neither) is a top-level chapter exactly as before. A nested
 * analysis writes one row per outline node, parents before children; the
 * top-level rows tile the timeline as flat chapters always have, and each
 * parent's children tile the parent.
 *
 * Both ALTERs run in ONE transaction; `level` is the "already migrated" marker.
 * Returns true when it migrated. Throws on failure (the caller aborts the load).
 */
export function migrateChaptersOutline(db: Database.Database): boolean {
  try {
    db.exec('SELECT level FROM chapters LIMIT 1');
    return false;
  } catch (error: any) {
    const message: string = error?.message || '';
    // A brand-new database: initializeSchema creates the table with both columns.
    if (message.includes('no such table')) return false;
    if (!message.includes('no such column: level')) throw error;
  }
  db.transaction(() => {
    db.exec('ALTER TABLE chapters ADD COLUMN level INTEGER');
    db.exec('ALTER TABLE chapters ADD COLUMN parent_id TEXT');
  })();
  return true;
}

/** Delete a chapter and every chapter nested under it. */
export function deleteChapterSubtree(db: Database.Database, chapterId: string): number {
  return db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? UNION ALL SELECT c.id FROM chapters c JOIN sub ON c.parent_id = sub.id
       )
       DELETE FROM chapters WHERE id IN (SELECT id FROM sub)`,
    )
    .run(chapterId).changes;
}

/** An analysis chapter row as the analysis pipeline returns it (ai-analysis `Chapter`). */
export interface AnalysisChapterLike {
  sequence: number;
  start_time: string;
  end_time?: string;
  title: string;
  summary?: string;
  level?: number;
  /** `sequence` of the parent row in the same list (nested analyses only). */
  parent_sequence?: number;
}

/**
 * Where an analysis chapter sits in the outline, for its insertChapter record.
 * Call in list order, parents-first (preorder), with one `idBySeq` per video:
 * it records this row's id and resolves parent_sequence to the parent's id. A
 * child whose parent is not in the list (filtered out) is stored at top level
 * rather than pointing at nothing. A flat analysis carries neither field and
 * gets `{}`: exactly the record it always wrote.
 */
export function chapterPlace(
  c: Pick<AnalysisChapterLike, 'sequence' | 'level' | 'parent_sequence'>,
  id: string,
  idBySeq: Map<number, string>,
): { level?: number; parentId?: string } {
  idBySeq.set(c.sequence, id);
  if (c.level === undefined) return {};
  const parentId = c.parent_sequence !== undefined ? idBySeq.get(c.parent_sequence) : undefined;
  return parentId ? { level: c.level, parentId } : { level: 0 };
}
