import type { TimelineChapter } from '../../../models/video-editor.model';

/**
 * Nested chapters (the analysis outline): rows carry `parentId`, stored
 * parents-first in sequence order. Since 2026-09-30 the outline is STORIES
 * (the top level, which tiles the video) with their CHAPTERS inside. The
 * timeline shows the chapters (the leaves, which tile the video too) and marks
 * where each story starts; the chapter list shows the stories as an accordion,
 * collapsed until the user opens a row with its chevron (never by itself).
 *
 * A flat list (every row top level) comes out exactly as before: every row,
 * in order, numbered by its sequence. So does an outline that is ONE story
 * (the user: "hide it when theres only one"): its chapters, numbered 1..n,
 * with no story row and no story mark on the timeline.
 */

export interface ChapterRow {
  chapter: TimelineChapter;
  /** 0 = top level. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** What the number badge shows: the sequence on a flat list, else "2", "2.1", "2.1.3". */
  number: string;
  /** Rows directly inside this one (a story's chapters). */
  childCount: number;
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

/** An outline that is one story holding every other row (shown as its chapters alone). */
export function isLoneStory(chapters: TimelineChapter[]): boolean {
  const top = topLevelChapters(chapters);
  return top.length === 1 && top.length < chapters.length;
}

/** The visible rows: children only under an expanded parent (whose ancestors are expanded too). */
export function chapterRows(chapters: TimelineChapter[], expanded: ReadonlySet<string>): ChapterRow[] {
  if (isLoneStory(chapters)) {
    return leafChapters(chapters).map((chapter, i) => ({
      chapter, depth: 0, hasChildren: false, expanded: false, number: String(i + 1), childCount: 0,
    }));
  }
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
      rows.push({ chapter, depth, hasChildren, expanded: open, number, childCount: kids.get(chapter.id)?.length ?? 0 });
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

/** The leaves: rows no row in the list names as its parent (on a flat list, every row), in time order. */
export function leafChapters(chapters: TimelineChapter[]): TimelineChapter[] {
  const ids = new Set(chapters.map((c) => c.id));
  const parents = new Set(chapters.map((c) => parentOf(c, ids)).filter((p): p is string => p !== null));
  return chapters.filter((c) => !parents.has(c.id)).sort((a, b) => a.startTime - b.startTime);
}

/**
 * Where each story starts, for the timeline: the first leaf inside each
 * top-level row that has children, mapped to that story's title. Empty on a
 * flat list and on one story.
 */
export function storyStarts(chapters: TimelineChapter[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!isNested(chapters) || isLoneStory(chapters)) return out;
  const ids = new Set(chapters.map((c) => c.id));
  const leaves = leafChapters(chapters);
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const storyOf = (c: TimelineChapter): TimelineChapter => {
    let at = c;
    for (let p = parentOf(at, ids); p !== null; p = parentOf(at, ids)) at = byId.get(p)!;
    return at;
  };
  const seen = new Set<string>();
  for (const leaf of leaves) {
    const story = storyOf(leaf);
    if (story.id === leaf.id || seen.has(story.id)) continue;
    seen.add(story.id);
    out.set(leaf.id, story.title);
  }
  return out;
}
