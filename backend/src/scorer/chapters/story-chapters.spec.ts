import { describe, expect, it } from '@jest/globals';
import { nestAnalysisChapters } from './chapter-tree';
import { storyTreeFromGroups } from './story-chapters';

const ch = (startSeconds: number, endSeconds: number, title: string, from: number, to: number, isAd = false) =>
  ({ startSeconds, endSeconds, title, label: title, sentenceRange: [from, to] as [number, number], isAd });

const CHAPTERS = [ch(0, 300, 'A1', 0, 10), ch(300, 600, 'A2', 10, 20), ch(600, 660, 'Sponsor', 20, 22, true), ch(660, 1200, 'B1', 22, 40)];
const STORIES = [
  { title: 'Story A', summary: 'About A.', isAd: false, firstChapter: 0, lastChapter: 1 },
  { title: 'Sponsor', summary: 'A read.', isAd: true, firstChapter: 2, lastChapter: 2 },
  { title: 'Story B', summary: 'About B.', isAd: false, firstChapter: 3, lastChapter: 3 },
];

describe('storyTreeFromGroups', () => {
  it('stories at level 0 span their chapters exactly; every chapter sits under its story at level 1', () => {
    const tree = storyTreeFromGroups(STORIES, CHAPTERS);
    expect(tree.depth).toBe(2);
    expect(tree.tree.map((s) => [s.title, s.startSeconds, s.endSeconds, s.sentenceRange, s.summary, s.isAd, s.children.map((c) => c.title)])).toEqual([
      ['Story A', 0, 600, [0, 20], 'About A.', false, ['A1', 'A2']],
      ['Sponsor', 600, 660, [20, 22], 'A read.', true, ['Sponsor']],
      ['Story B', 660, 1200, [22, 40], 'About B.', false, ['B1']],
    ]);
    expect(tree.flat.filter((c) => c.isLeaf).map((c) => [c.title, c.level])).toEqual([['A1', 1], ['A2', 1], ['Sponsor', 1], ['B1', 1]]);
  });

  it('the stored rows carry each story\'s summary; the chapters keep Pass 2\'s', () => {
    const rows = CHAPTERS.map((c, i) => ({ sequence: i + 1, start_time: '', end_time: '', title: c.title, summary: `Pass 2 on ${c.title}.` }));
    const nested = nestAnalysisChapters(rows, storyTreeFromGroups(STORIES, CHAPTERS).flat);
    expect(nested.map((r) => [r.title, r.summary, r.level, r.parent_sequence])).toEqual([
      ['Story A', 'About A.', 0, undefined],
      ['A1', 'Pass 2 on A1.', 1, 1],
      ['A2', 'Pass 2 on A2.', 1, 1],
      ['Sponsor', 'A read.', 0, undefined],
      ['Sponsor', 'Pass 2 on Sponsor.', 1, 4],
      ['Story B', 'About B.', 0, undefined],
      ['B1', 'Pass 2 on B1.', 1, 6],
    ]);
  });
});
