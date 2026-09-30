/**
 * The two-level outline: stories (analysis/stories.ts, groups of consecutive
 * chapters) at level 0, the chapters inside each at level 1. The chapters are
 * the whole video's, made as a flat video's always were; a story's edges are
 * its first and last chapter's, so the children tile their story exactly.
 */

import { ChapterNode, ChapterTreeResult, flattenChapterTree } from './chapter-tree';
import type { SnapChapter } from './segmenter';

/** A story as the tree needs it: its chapters by index (0-based, inclusive). */
export interface StoryGroupPlan {
  title: string;
  summary: string;
  isAd: boolean;
  firstChapter: number;
  lastChapter: number;
}

type TreeChapter = Pick<SnapChapter, 'startSeconds' | 'endSeconds' | 'title' | 'label' | 'isAd' | 'sentenceRange'>;

/** The stories over the chapters, as a two-level tree (every chapter in exactly one story). */
export function storyTreeFromGroups(stories: StoryGroupPlan[], chapters: TreeChapter[]): ChapterTreeResult {
  const tree: ChapterNode[] = stories.map((s) => {
    const kids = chapters.slice(s.firstChapter, s.lastChapter + 1);
    const first = kids[0];
    const last = kids[kids.length - 1];
    return {
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      title: s.title,
      label: s.title,
      summary: s.summary,
      level: 0,
      isAd: s.isAd,
      sentenceRange: [first.sentenceRange[0], last.sentenceRange[1]] as [number, number],
      children: kids.map((c) => ({
        startSeconds: c.startSeconds,
        endSeconds: c.endSeconds,
        title: c.title,
        label: c.label,
        level: 1,
        isAd: c.isAd,
        sentenceRange: [c.sentenceRange[0], c.sentenceRange[1]] as [number, number],
        children: [],
      })),
    };
  });
  return { tree, flat: flattenChapterTree(tree), depth: tree.length ? 2 : 0, refined: 0, timings: { refineMs: 0 } };
}
