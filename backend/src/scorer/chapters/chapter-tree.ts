/**
 * Hierarchical (outline) chaptering: the snap chapter method, applied again
 * inside every section that is still long.
 *
 *   level 0   runSnapChapters over the whole video (chunked as usual): outline,
 *             assign with the ad/plug item, Viterbi, ad confirmation.
 *   level L+1 for each level-L section that is LONG (and not an ad), the SAME
 *             method on just that section's units: a sub-outline written over
 *             the section text with the verbatim outline prompt, one assign
 *             choice per unit over the sub-items (NO plug item: ads are found
 *             once, at level 0), Viterbi, boundaries. Recurse while children
 *             stay long, up to `maxDepth` levels in all.
 *
 * A section whose sub-outline has fewer than 2 items (OutlineError), or whose
 * sub-path collapses to one run, stays a leaf. Children tile their parent
 * exactly: the first child starts at the parent's start, the last ends at the
 * parent's end, and every inner boundary is a unit start clamped into the
 * parent's span (zero-length children are dropped, which cannot open a gap).
 *
 * THE STATE PER LEVEL. A refinement's decide state is the SECTION's units
 * joined with "\n", not the whole transcript, so every question is about that
 * section and the engine primes each section once and reuses it for all of its
 * questions. The chunk plan is per call: a section that fits the single-chunk
 * limit (16k tokens; every section of a video under ~1 h) is one state, and a
 * bigger one is chunked and stitched by runSnapChapters exactly as a video is.
 * Level 0 is untouched: same chunk plan as the flag pass, same states, and a
 * video with no long section never reaches this file's refinement at all.
 * Flags keep the full-transcript chunk states; SnapAnalysisService runs the
 * refinement AFTER the flag pass so the chapter -> flag prefix reuse (plan §3.2)
 * is unchanged.
 *
 * Every model call goes through the ChapterScorer seam (generate + decide).
 */

import type { Logger } from '@nestjs/common';
import { ScorerError } from '../scorer.types';
import { OutlineError, SnapChapter, formatHms } from './segmenter';
import { BuildChaptersOptions, BuildChaptersResult, ChapterPhase, ChapterScorer, runSnapChapters } from './snap-chapter.service';
import { START_OF_VIDEO } from './snap-prompts';
import { SentenceUnit } from './units';

export interface ChapterNode {
  startSeconds: number;
  endSeconds: number;
  /** Display title (the outline label; "Sponsor / self-promotion" for an ad; "(continued)" on a return within the parent). */
  title: string;
  /** The raw outline item. */
  label: string;
  /** 0 = top level (the whole-video outline). */
  level: number;
  isAd: boolean;
  /** Unit range [start, end) over the video's units. */
  sentenceRange: [number, number];
  children: ChapterNode[];
}

/** A node in preorder, with its place in the tree. */
export interface FlatChapter extends Omit<ChapterNode, 'children'> {
  /** Position in the preorder list. */
  index: number;
  /** Index of the parent in the same list, or null at level 0. */
  parent: number | null;
  isLeaf: boolean;
}

/**
 * When a section is refined. Defaults and why:
 *   longSeconds 900 (15 min) and longUnits 120: the method was benchmarked on
 *     whole YTSeg videos of 60-320 sentences, ~5-20 min. A section past either
 *     mark is itself video-sized, so a fresh outline over it works at the
 *     measured granularity; below it, a sub-outline would be asked to split what
 *     a video's own chapters do not split. 120 units is also two assign batches.
 *   minUnits 24: a section with fewer units is never refined whatever its
 *     duration (music, silence, a game with sparse commentary): too little text
 *     for an outline, and the 900 s rule alone would fire on it.
 *   maxDepth 3: levels 0, 1 and 2. A 4-hour stream -> ~10-20 top sections ->
 *     sub-sections of a few minutes; a third split only where one is still
 *     over 15 min / 120 units.
 */
export const TREE_DEFAULTS = { maxDepth: 3, longSeconds: 900, longUnits: 120, minUnits: 24, switchCost: 20 } as const;

export interface RefineOptions {
  /** Levels in the tree, level 0 included (1 = no refinement). Default 3. */
  maxDepth?: number;
  /** A section longer than this (seconds) is refined. Default 900. */
  longSeconds?: number;
  /** A section with more units than this is refined. Default 120. */
  longUnits?: number;
  /** A section with fewer units is never refined. Default 24. */
  minUnits?: number;
  /**
   * Viterbi switch cost per level (index = level; the last entry repeats).
   * Default 20 at every level: the measured best on whole videos. Unmeasured
   * inside a section, where sub-items are closer and margins smaller.
   */
  switchCost?: number | number[];
  /** Chunk sizes for a section too big for one state (tokens). Defaults as runSnapChapters. */
  chunking?: BuildChaptersOptions['chunking'];
  /** Who writes each sub-outline. Default: the scorer model, as level 0. */
  writeOutline?: BuildChaptersOptions['writeOutline'];
  signal?: AbortSignal;
  onProgress?: (p: RefineProgress) => void;
}

export interface RefineProgress {
  phase: ChapterPhase;
  /** The level being BUILT (1 = sub-chapters of the top level). */
  level: number;
  /** 1-based section being refined at this level, of `sections`. */
  section: number;
  sections: number;
  /** Units of this level's long sections assigned so far, of `unitsTotal`. */
  unitsDone: number;
  unitsTotal: number;
  /** 0..1 over the whole refinement. Monotone. */
  fraction: number;
}

export interface ChapterTreeResult {
  /** Level-0 nodes, each with its children. They tile the video. */
  tree: ChapterNode[];
  /** Every node in preorder. */
  flat: FlatChapter[];
  /** Deepest level + 1. */
  depth: number;
  /** Sections a sub-outline was attempted on. */
  refined: number;
  timings: { refineMs: number };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScorerError('cancelled', 'chaptering was cancelled');
}

function costAt(cost: number | number[] | undefined, level: number): number {
  if (cost === undefined) return TREE_DEFAULTS.switchCost;
  if (typeof cost === 'number') return cost;
  return cost.length ? cost[Math.min(level, cost.length - 1)] : TREE_DEFAULTS.switchCost;
}

/** Is a span of `units` units over `seconds` long enough to refine? */
export function isLongSpan(units: number, seconds: number, opts: RefineOptions = {}): boolean {
  const minUnits = opts.minUnits ?? TREE_DEFAULTS.minUnits;
  const longUnits = opts.longUnits ?? TREE_DEFAULTS.longUnits;
  const longSeconds = opts.longSeconds ?? TREE_DEFAULTS.longSeconds;
  return units >= minUnits && (units > longUnits || seconds > longSeconds);
}

/** Could any section of this video be refined? False => the flat result is the whole answer. */
export function mayRefine(unitCount: number, totalSeconds: number, opts: RefineOptions = {}): boolean {
  return (opts.maxDepth ?? TREE_DEFAULTS.maxDepth) > 1 && isLongSpan(unitCount, totalSeconds, opts);
}

function isLong(node: ChapterNode, opts: RefineOptions): boolean {
  return !node.isAd && isLongSpan(node.sentenceRange[1] - node.sentenceRange[0], node.endSeconds - node.startSeconds, opts);
}

function leafOf(c: SnapChapter, level: number): ChapterNode {
  return {
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
    title: c.title,
    label: c.label,
    level,
    isAd: c.isAd,
    sentenceRange: [c.sentenceRange[0], c.sentenceRange[1]],
    children: [],
  };
}

/**
 * Children of `parent` from a run over its units (sentence ranges relative to
 * the section). Tiles the parent exactly; drops zero-length children.
 */
export function childrenOf(parent: ChapterNode, sub: SnapChapter[], units: SentenceUnit[]): ChapterNode[] {
  const a = parent.sentenceRange[0];
  const clamp = (t: number) => Math.min(parent.endSeconds, Math.max(parent.startSeconds, t));
  const kids = sub.map((c, k) => {
    const node = leafOf(c, parent.level + 1);
    node.sentenceRange = [a + c.sentenceRange[0], a + c.sentenceRange[1]];
    node.startSeconds = k === 0 ? parent.startSeconds : clamp(units[node.sentenceRange[0]].start);
    return node;
  });
  // Enforce monotone starts (unit starts may tie or, with odd timings, step back).
  for (let k = 1; k < kids.length; k++) kids[k].startSeconds = Math.max(kids[k].startSeconds, kids[k - 1].startSeconds);
  for (let k = 0; k < kids.length; k++) kids[k].endSeconds = k + 1 < kids.length ? kids[k + 1].startSeconds : parent.endSeconds;
  // Zero-length children give their units to a neighbour (the times already
  // tile), and two neighbours left with one label become one child.
  const out: ChapterNode[] = [];
  let carry: number | null = null;
  for (const kid of kids) {
    const prev = out[out.length - 1];
    if (kid.endSeconds <= kid.startSeconds) {
      if (prev) prev.sentenceRange[1] = kid.sentenceRange[1];
      else carry ??= kid.sentenceRange[0];
      continue;
    }
    if (carry !== null) {
      kid.sentenceRange[0] = carry;
      carry = null;
    }
    if (prev && !prev.isAd && !kid.isAd && prev.label.toLowerCase() === kid.label.toLowerCase()) {
      prev.sentenceRange[1] = kid.sentenceRange[1];
      prev.endSeconds = kid.endSeconds;
      continue;
    }
    out.push(kid);
  }
  return out;
}

/**
 * Refine a level-0 result into a tree. Pure orchestration over `scorer`.
 * Breadth-first: every level-1 section, then every level-2 section, so progress
 * is banded per level. Throws ScorerError('cancelled') on the signal and any
 * engine error; an OutlineError on a section only makes it a leaf.
 */
export async function refineChapters(
  scorer: ChapterScorer,
  units: SentenceUnit[],
  base: Pick<BuildChaptersResult, 'chapters'>,
  opts: RefineOptions = {},
  logger?: Pick<Logger, 'log' | 'warn'>,
): Promise<ChapterTreeResult> {
  const t0 = Date.now();
  const maxDepth = opts.maxDepth ?? TREE_DEFAULTS.maxDepth;
  const signal = opts.signal;
  const tree = base.chapters.map((c) => leafOf(c, 0));
  let refined = 0;
  let depth = tree.length ? 1 : 0;

  let frontier = tree;
  let doneBase = 0;
  for (let level = 1; level < maxDepth && frontier.length; level++) {
    const todo = frontier.filter((n) => isLong(n, opts));
    if (todo.length === 0) break;
    throwIfAborted(signal);
    // This level takes half of what is left when a deeper level is possible, else all of it.
    const share = (1 - doneBase) * (level + 1 < maxDepth ? 0.5 : 1);
    const unitsTotal = todo.reduce((n, s) => n + (s.sentenceRange[1] - s.sentenceRange[0]), 0);
    let unitsBefore = 0;
    const next: ChapterNode[] = [];
    for (let s = 0; s < todo.length; s++) {
      throwIfAborted(signal);
      const node = todo[s];
      const [a, b] = node.sentenceRange;
      const size = b - a;
      const tick = (phase: ChapterPhase, within: number) =>
        opts.onProgress?.({
          phase,
          level,
          section: s + 1,
          sections: todo.length,
          unitsDone: unitsBefore + Math.round(within * size),
          unitsTotal,
          fraction: Math.min(1, doneBase + share * ((unitsBefore + within * size) / unitsTotal)),
        });
      refined++;
      let sub: BuildChaptersResult | null = null;
      try {
        sub = await runSnapChapters(
          scorer,
          units.slice(a, b),
          {
            switchCost: costAt(opts.switchCost, level),
            detectAds: false,
            signal,
            chunking: opts.chunking,
            writeOutline: opts.writeOutline,
            prevBefore: a > 0 ? units[a - 1].text : START_OF_VIDEO,
            totalSeconds: node.endSeconds,
            onProgress: (p) => tick(p.phase === 'done' ? 'assign' : p.phase, p.fraction),
          },
          logger,
        );
      } catch (err) {
        if (!(err instanceof OutlineError)) throw err;
        logger?.log(`[snap-chapters] level ${level}: "${node.title}" stays a leaf (${err.message.slice(0, 80)})`);
      }
      unitsBefore += size;
      tick('assign', 0);
      const kids = sub ? childrenOf(node, sub.chapters, units) : [];
      if (kids.length >= 2) {
        node.children = kids;
        next.push(...kids);
        depth = Math.max(depth, level + 1);
      }
    }
    doneBase += share;
    frontier = next;
  }
  throwIfAborted(signal);
  const flat = flattenChapterTree(tree);
  opts.onProgress?.({ phase: 'done', level: depth - 1, section: 0, sections: 0, unitsDone: 0, unitsTotal: 0, fraction: 1 });
  return { tree, flat, depth, refined, timings: { refineMs: Date.now() - t0 } };
}

/** Level 0 and the refinement in one call (SnapChapterService, tests). Progress: level 0 first, then the tree. */
export async function runSnapChapterTree(
  scorer: ChapterScorer,
  units: SentenceUnit[],
  opts: BuildChaptersOptions & { refine?: RefineOptions } = {},
  logger?: Pick<Logger, 'log' | 'warn'>,
): Promise<{ base: BuildChaptersResult; tree: ChapterTreeResult }> {
  const { refine = {}, ...level0 } = opts;
  const total = opts.totalSeconds ?? (units.length ? units[units.length - 1].end : 0);
  const refineShare = mayRefine(units.length, total, refine) ? 0.5 : 0;
  const onProgress = level0.onProgress;
  const base = await runSnapChapters(
    scorer,
    units,
    refineShare && onProgress
      ? { ...level0, onProgress: (p) => onProgress({ ...p, fraction: p.fraction * (1 - refineShare) }) }
      : level0,
    logger,
  );
  const tree = refineShare
    ? await refineChapters(scorer, units, base, { signal: opts.signal, ...refine }, logger)
    : flatChapterTree(base.chapters);
  return { base, tree };
}

/** The one-level tree of a flat result (no refinement ran, or it failed). */
export function flatChapterTree(chapters: SnapChapter[]): ChapterTreeResult {
  const tree = chapters.map((c) => leafOf(c, 0));
  return { tree, flat: flattenChapterTree(tree), depth: tree.length ? 1 : 0, refined: 0, timings: { refineMs: 0 } };
}

/** Preorder list of a tree, with parent indices. */
export function flattenChapterTree(tree: ChapterNode[]): FlatChapter[] {
  const out: FlatChapter[] = [];
  const walk = (nodes: ChapterNode[], parent: number | null) => {
    for (const n of nodes) {
      const { children, ...rest } = n;
      const index = out.length;
      out.push({ ...rest, sentenceRange: [rest.sentenceRange[0], rest.sentenceRange[1]], index, parent, isLeaf: children.length === 0 });
      walk(children, index);
    }
  };
  walk(tree, null);
  return out;
}

/** The leaves in time order: they tile the video, and are what the per-chapter LLM step summarizes. */
export function leafChapters(flat: FlatChapter[]): FlatChapter[] {
  return flat.filter((c) => c.isLeaf);
}

/** The analysis `Chapter` row shape plus its place in the outline. */
export interface NestedAnalysisChapter {
  sequence: number;
  start_time: string;
  end_time: string;
  title: string;
  summary?: string;
  failed?: boolean;
  /** 0 = top level. */
  level: number;
  /** `sequence` of the parent row, absent at level 0. */
  parent_sequence?: number;
}

/**
 * Interleave the outline's parent rows with the per-leaf analysis chapters.
 * `leafRows` are the Pass 2 chapters, whose `sequence` is the 1-based leaf
 * index (a leaf Pass 2 skipped, e.g. no speech, is simply absent). Output is
 * preorder, renumbered 1..n; parents get the outline title and no summary.
 */
export function nestAnalysisChapters<C extends { sequence: number; start_time: string; end_time: string; title: string; summary?: string; failed?: boolean }>(
  leafRows: C[],
  flat: FlatChapter[],
): Array<C & NestedAnalysisChapter> {
  const bySeq = new Map(leafRows.map((c) => [c.sequence, c]));
  const seqOf = new Map<number, number>();
  const out: Array<C & NestedAnalysisChapter> = [];
  let leaf = 0;
  for (const node of flat) {
    const parent_sequence = node.parent === null ? undefined : seqOf.get(node.parent);
    const place = { level: node.level, ...(parent_sequence !== undefined ? { parent_sequence } : {}) };
    if (node.isLeaf) {
      const row = bySeq.get(++leaf);
      if (!row) continue;
      out.push({ ...row, sequence: out.length + 1, ...place });
    } else {
      const sequence = out.length + 1;
      seqOf.set(node.index, sequence);
      out.push({
        sequence,
        start_time: formatHms(node.startSeconds),
        end_time: formatHms(node.endSeconds),
        title: node.title,
        summary: '',
        ...place,
      } as C & NestedAnalysisChapter);
    }
  }
  return out;
}
