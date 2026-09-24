import type { TimelineChapter } from '../../../models/video-editor.model';

/**
 * Nested chapters (the snap engine's outline): rows carry `parentId`, stored
 * parents-first in sequence order. The timeline shows only the top level
 * (which tiles the video, as flat chapters do); the chapter list shows the
 * nesting, collapsed until the user opens a row with its chevron.
 *
 * A flat list (every row top level) comes out exactly as before: every row,
 * in order, numbered by its sequence.
 */

export interface ChapterRow {
  chapter: TimelineChapter;
  /** 0 = top level. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** What the number badge shows: the sequence on a flat list, else "2", "2.1", "2.1.3". */
  number: string;
}

/** Rows without a parent (or whose parent is not in the list) are top level. */
function parentOf(c: TimelineChapter, ids: ReadonlySet<string>): string | null {
  return c.parentId && ids.has(c.parentId) ? c.parentId : null;
}

export function topLevelChapters(chapters: TimelineChapter[]): TimelineChapter[] {
  const ids = new Set(chapters.map((c) => c.id));
  return chapters.filter((c) => parentOf(c, ids) === null);
}

export function isNested(chapters: TimelineChapter[]): boolean {
  const ids = new Set(chapters.map((c) => c.id));
  return chapters.some((c) => parentOf(c, ids) !== null);
}

/** The visible rows: children only under an expanded parent (whose ancestors are expanded too). */
export function chapterRows(chapters: TimelineChapter[], expanded: ReadonlySet<string>): ChapterRow[] {
  const ids = new Set(chapters.map((c) => c.id));
  const nested = isNested(chapters);
  const kids = new Map<string | null, TimelineChapter[]>();
  for (const c of chapters) {
    const p = parentOf(c, ids);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(c);
  }
  const rows: ChapterRow[] = [];
  const walk = (parent: string | null, depth: number, prefix: string) => {
    (kids.get(parent) ?? []).forEach((chapter, i) => {
      const hasChildren = (kids.get(chapter.id)?.length ?? 0) > 0;
      const open = hasChildren && expanded.has(chapter.id);
      const number = nested ? `${prefix}${i + 1}` : String(chapter.sequence);
      rows.push({ chapter, depth, hasChildren, expanded: open, number });
      if (open) walk(chapter.id, depth + 1, `${number}.`);
    });
  };
  walk(null, 0, '');
  return rows;
}

/** The id and every descendant id (what deleting a chapter removes). */
export function chapterSubtreeIds(chapters: TimelineChapter[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of chapters) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}
