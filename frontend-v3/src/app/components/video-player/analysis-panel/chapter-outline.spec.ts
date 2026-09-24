import type { TimelineChapter } from '../../../models/video-editor.model';
import { chapterRows, chapterSubtreeIds, isNested, topLevelChapters } from './chapter-outline';

// Plain describe/it/expect only, so this runs under Karma/Jasmine (ng test) and Jest alike.
const ch = (id: string, sequence: number, start: number, end: number, parentId?: string): TimelineChapter => ({
  id, videoId: 'v', sequence, startTime: start, endTime: end, title: id, source: 'ai', parentId: parentId ?? null,
});

const nested = [
  ch('A', 1, 0, 60),
  ch('A1', 2, 0, 30, 'A'),
  ch('A1a', 3, 0, 10, 'A1'),
  ch('A1b', 4, 10, 30, 'A1'),
  ch('A2', 5, 30, 60, 'A'),
  ch('B', 6, 60, 90),
];

describe('chapter outline', () => {
  it('the timeline gets the top level only', () => {
    expect(topLevelChapters(nested).map((c) => c.id)).toEqual(['A', 'B']);
    expect(isNested(nested)).toBe(true);
  });

  it('collapsed by default: only top-level rows, with a chevron where there are children', () => {
    const rows = chapterRows(nested, new Set());
    expect(rows.map((r) => [r.chapter.id, r.depth, r.hasChildren, r.expanded, r.number])).toEqual([
      ['A', 0, true, false, '1'],
      ['B', 0, false, false, '2'],
    ]);
  });

  it('expanding a row shows its children indented and outline-numbered; grandchildren stay closed', () => {
    const rows = chapterRows(nested, new Set(['A']));
    expect(rows.map((r) => [r.chapter.id, r.depth, r.number])).toEqual([
      ['A', 0, '1'],
      ['A1', 1, '1.1'],
      ['A2', 1, '1.2'],
      ['B', 0, '2'],
    ]);
    const deep = chapterRows(nested, new Set(['A', 'A1']));
    expect(deep.map((r) => r.number)).toEqual(['1', '1.1', '1.1.1', '1.1.2', '1.2', '2']);
    // An expanded child under a collapsed parent stays hidden.
    expect(chapterRows(nested, new Set(['A1'])).map((r) => r.chapter.id)).toEqual(['A', 'B']);
  });

  it('a flat list is every row, in order, numbered by sequence', () => {
    const flat = [ch('x', 1, 0, 10), ch('y', 3, 10, 20)];
    expect(isNested(flat)).toBe(false);
    expect(topLevelChapters(flat)).toEqual(flat);
    expect(chapterRows(flat, new Set()).map((r) => [r.chapter.id, r.depth, r.hasChildren, r.number])).toEqual([
      ['x', 0, false, '1'],
      ['y', 0, false, '3'],
    ]);
  });

  it('a row whose parent is gone is top level', () => {
    const orphan = [ch('A1', 2, 0, 30, 'A'), ch('B', 6, 60, 90)];
    expect(topLevelChapters(orphan).map((c) => c.id)).toEqual(['A1', 'B']);
  });

  it('deleting a chapter removes its subtree', () => {
    expect([...chapterSubtreeIds(nested, 'A')].sort()).toEqual(['A', 'A1', 'A1a', 'A1b', 'A2']);
    expect([...chapterSubtreeIds(nested, 'B')]).toEqual(['B']);
  });
});
