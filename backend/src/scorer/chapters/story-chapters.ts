/**
 * Chapters inside stories: the two-level outline (analysis/stories.ts finds
 * the stories; this file makes each story's chapters on the scorer).
 *
 *   level 0   the stories, as given. They tile the video.
 *   level 1   each story's chapters by the snap chapter method (outline ->
 *             assign per time window -> Viterbi -> ad check), run on that
 *             story's own units with the unit before it as `prevBefore`, as
 *             chapter-tree.ts's refinement runs inside a section. There is no
 *             deeper level.
 *
 * A story too short to hold two chapters (under STORY_CHAPTERS_MIN_SECONDS or
 * STORY_CHAPTERS_MIN_UNITS) is one chapter spanning it, titled with the story's
 * title, with no model call. A one-story video is the whole video, chaptered
 * exactly as a flat video always was (the shared chunk plan, the whole-video
 * state), and its chapters title it later (ai-analysis).
 *
 * A story's outline that is unusable (OutlineError) leaves it one chapter and
 * is NAMED in the result's warnings; on a one-story video it fails the stage,
 * as it always did. Every other error propagates.
 */

import type { Logger } from '@nestjs/common';
import { ScorerError } from '../scorer.types';
import type { TimeWindows } from '../windows';
import { ChapterNode, ChapterTreeResult, childrenOf, flattenChapterTree } from './chapter-tree';
import type { Chunk } from './chunks';
import { OutlineError, SnapChapter, formatHms } from './segmenter';
import { BuildChaptersOptions, BuildChaptersResult, ChapterScorer, runSnapChapters } from './snap-chapter.service';
import { START_OF_VIDEO } from './snap-prompts';
import type { SnapUnit } from './units';

/** A story shorter than this (seconds) is one chapter. */
export const STORY_CHAPTERS_MIN_SECONDS = 180;
/** A story with fewer units than this is one chapter (chapter-tree's minUnits: too little text for an outline). */
export const STORY_CHAPTERS_MIN_UNITS = 24;

/** A story as the chapter pass needs it (analysis/stories.ts StorySpan). */
export interface StoryPlan {
  title: string;
  /** Index into assembleSentences(segments) of its first sentence. */
  startSentence: number;
  startSeconds: number;
  endSeconds: number;
}

export interface StoryChaptersProgress {
  /** 1-based story being chaptered, of `stories`. */
  story: number;
  stories: number;
  /** 0..1 over all stories. Monotone. */
  fraction: number;
}

export interface StoryChaptersOptions {
  /** Options for every story's run (switch cost, ads, chunk sizes, outline writer). */
  chapterOptions?: Omit<BuildChaptersOptions, 'signal' | 'onProgress' | 'chunkPlan' | 'totalSeconds' | 'prevBefore' | 'windows'>;
  windows?: TimeWindows | null;
  /** The whole video's chunk plan: used when one story spans the whole video. */
  chunkPlan?: Chunk[];
  totalSeconds: number;
  signal?: AbortSignal;
  onProgress?: (p: StoryChaptersProgress) => void;
}

export interface StoryChaptersResult {
  /** Stories at level 0, each with its chapters at level 1. */
  tree: ChapterTreeResult;
  /** Every leaf chapter in time order, as a flat run's chapters (unit ranges over the whole video). */
  chapters: BuildChaptersResult;
  /** Named outcomes: a story left one chapter because its outline was unusable; a story with no units joined its neighbour. */
  warnings: string[];
  /** Stories the scorer was asked about. */
  scored: number;
}

/**
 * The unit range [start, end) of each story: a story starts at the first unit
 * that reaches its first sentence (units fold short sentences forward, so a
 * unit may begin a sentence or two early). Monotone; a story can come out
 * empty (two story starts inside one unit).
 */
export function storyUnitRanges(units: Array<Pick<SnapUnit, 'sentenceTo'>>, stories: Array<Pick<StoryPlan, 'startSentence'>>): Array<[number, number]> {
  const starts = stories.map((s, k) => {
    if (k === 0) return 0;
    const i = units.findIndex((u) => u.sentenceTo >= s.startSentence);
    return i < 0 ? units.length : i;
  });
  for (let k = 1; k < starts.length; k++) starts[k] = Math.max(starts[k], starts[k - 1]);
  return starts.map((a, k) => [a, k + 1 < starts.length ? starts[k + 1] : units.length]);
}

/** Does this story get a snap run (else it is one chapter)? A one-story video always does. */
export function storyNeedsScorer(units: number, seconds: number, wholeVideo: boolean): boolean {
  return wholeVideo || (units >= STORY_CHAPTERS_MIN_UNITS && seconds >= STORY_CHAPTERS_MIN_SECONDS);
}

function storyNode(story: StoryPlan, range: [number, number]): ChapterNode {
  return {
    startSeconds: story.startSeconds,
    endSeconds: story.endSeconds,
    title: story.title,
    label: story.title,
    level: 0,
    isAd: false,
    sentenceRange: [range[0], range[1]],
    children: [],
  };
}

function spanningChild(node: ChapterNode): ChapterNode {
  return { ...node, level: 1, sentenceRange: [node.sentenceRange[0], node.sentenceRange[1]], children: [] };
}

/** Stories with their units, empty ones joined to the story before (named). */
export function placeStories(
  units: Array<Pick<SnapUnit, 'sentenceTo'>>,
  stories: StoryPlan[],
): { stories: StoryPlan[]; ranges: Array<[number, number]>; warnings: string[] } {
  const ranges = storyUnitRanges(units, stories);
  const keptStories: StoryPlan[] = [];
  const keptRanges: Array<[number, number]> = [];
  const warnings: string[] = [];
  stories.forEach((story, k) => {
    const [a, b] = ranges[k];
    if (b > a || keptStories.length === 0) {
      keptStories.push({ ...story });
      keptRanges.push([a, b]);
      return;
    }
    const prev = keptStories[keptStories.length - 1];
    prev.endSeconds = story.endSeconds;
    warnings.push(`Stories: "${story.title}" (${formatHms(story.startSeconds)}) holds no whole sentence of its own and was joined to "${prev.title}".`);
  });
  if (keptRanges.length) keptRanges[keptRanges.length - 1][1] = units.length;
  return { stories: keptStories, ranges: keptRanges, warnings };
}

/**
 * Make every story's chapters. Throws ScorerError('cancelled') on the signal
 * and any engine error (a park included); an OutlineError on a story of a
 * multi-story video leaves it one chapter, named in the warnings.
 */
export async function runStoryChapters(
  scorer: ChapterScorer,
  units: SnapUnit[],
  storiesIn: StoryPlan[],
  opts: StoryChaptersOptions,
  logger?: Pick<Logger, 'log' | 'warn'>,
): Promise<StoryChaptersResult> {
  const t0 = Date.now();
  const signal = opts.signal;
  const placed = placeStories(units, storiesIn);
  const warnings = [...placed.warnings];
  const total = Math.max(1, units.length);
  const timings = { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 };
  const outline: string[] = [];
  const tree: ChapterNode[] = [];
  let done = 0;
  let scored = 0;

  for (let k = 0; k < placed.stories.length; k++) {
    if (signal?.aborted) throw new ScorerError('cancelled', 'chaptering was cancelled');
    const story = placed.stories[k];
    const [a, b] = placed.ranges[k];
    const node = storyNode(story, [a, b]);
    tree.push(node);
    const size = b - a;
    const report = (within: number) =>
      opts.onProgress?.({ story: k + 1, stories: placed.stories.length, fraction: Math.min(1, (done + within * size) / total) });
    report(0);
    const wholeVideo = placed.stories.length === 1;
    if (!storyNeedsScorer(size, story.endSeconds - story.startSeconds, wholeVideo) || size === 0) {
      node.children = [spanningChild(node)];
      logger?.log(`[story-chapters] story ${k + 1}/${placed.stories.length} "${story.title}": ${size} units, one chapter`);
      done += size;
      continue;
    }
    scored++;
    let run: BuildChaptersResult | null = null;
    try {
      run = await runSnapChapters(
        scorer,
        wholeVideo ? units : units.slice(a, b),
        {
          ...(opts.chapterOptions ?? {}),
          ...(opts.windows ? { windows: opts.windows } : {}),
          ...(wholeVideo && opts.chunkPlan ? { chunkPlan: opts.chunkPlan } : {}),
          prevBefore: a > 0 ? units[a - 1].text : START_OF_VIDEO,
          totalSeconds: wholeVideo ? opts.totalSeconds : story.endSeconds,
          signal,
          onProgress: (p) => report(p.fraction),
        },
        logger,
      );
    } catch (err) {
      if (!(err instanceof OutlineError) || wholeVideo) throw err;
      warnings.push(`Chapters: the outline of story "${story.title}" (${formatHms(story.startSeconds)}) was unusable (${err.message.slice(0, 120)}), so it is one chapter.`);
      logger?.warn(`[story-chapters] story ${k + 1}: outline unusable, one chapter (${err.message.slice(0, 80)})`);
    }
    if (run) {
      timings.outlineMs += run.timings.outlineMs;
      timings.assignMs += run.timings.assignMs;
      timings.adsMs += run.timings.adsMs;
      for (const item of run.outline) if (!outline.some((o) => o.toLowerCase() === item.toLowerCase())) outline.push(item);
      const kids = childrenOf(node, run.chapters, units);
      node.children = kids.length ? kids : [spanningChild(node)];
      logger?.log(`[story-chapters] story ${k + 1}/${placed.stories.length} "${story.title}": ${size} units -> ${node.children.length} chapter(s)`);
    } else {
      node.children = [spanningChild(node)];
    }
    done += size;
  }
  if (signal?.aborted) throw new ScorerError('cancelled', 'chaptering was cancelled');
  const flat = flattenChapterTree(tree);
  const leaves: SnapChapter[] = flat
    .filter((c) => c.isLeaf)
    .map((c) => ({ startSeconds: c.startSeconds, endSeconds: c.endSeconds, title: c.title, label: c.label, sentenceRange: c.sentenceRange, isAd: c.isAd }));
  timings.totalMs = Date.now() - t0;
  opts.onProgress?.({ story: placed.stories.length, stories: placed.stories.length, fraction: 1 });
  return {
    tree: { tree, flat, depth: tree.length ? 2 : 0, refined: scored, timings: { refineMs: timings.totalMs } },
    chapters: { chapters: leaves, outline, chunks: [], seams: [], timings },
    warnings,
    scored,
  };
}

/**
 * The two-level tree from stories and chapters made over the whole video (a
 * scorer stage that returned flat chapters only): each chapter goes under the
 * story its start falls in, cut at story boundaries, so the children tile
 * their story. A story no chapter starts in gets one spanning it.
 */
export function storyTreeFromChapters(stories: StoryPlan[], chapters: Array<Pick<SnapChapter, 'startSeconds' | 'endSeconds' | 'title' | 'label' | 'isAd' | 'sentenceRange'>>): ChapterTreeResult {
  const tree: ChapterNode[] = stories.map((s) => storyNode(s, [0, 0]));
  for (const node of tree) {
    const inside = chapters.filter((c) => c.endSeconds > node.startSeconds && c.startSeconds < node.endSeconds);
    node.children = inside.map((c) => ({
      startSeconds: Math.max(node.startSeconds, c.startSeconds),
      endSeconds: Math.min(node.endSeconds, c.endSeconds),
      title: c.title,
      label: c.label,
      level: 1,
      isAd: c.isAd,
      sentenceRange: [c.sentenceRange[0], c.sentenceRange[1]] as [number, number],
      children: [],
    }));
    node.children = node.children.filter((c) => c.endSeconds > c.startSeconds);
    if (node.children.length === 0) node.children = [spanningChild(node)];
  }
  return { tree, flat: flattenChapterTree(tree), depth: tree.length ? 2 : 0, refined: 0, timings: { refineMs: 0 } };
}
