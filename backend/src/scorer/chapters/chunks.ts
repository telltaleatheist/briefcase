/**
 * Long-video chunking and seam stitching (docs/snap-analysis-plan.md §3.3).
 *
 * Planning:
 *   - a transcript of <= 16k tokens is one chunk and runs exactly as measured;
 *   - a longer one is cut into equal cores of <= 12k tokens (at unit
 *     boundaries), and each core carries ~2k tokens of overlap context on each
 *     side. A chunk's state (outline, assign, Viterbi) is overlap + core +
 *     overlap. Every unit is OWNED by exactly one core (what flags use).
 *
 * Stitch rule (chapters), for each seam between chunk k and chunk k+1:
 *   - O = the units both chunks cover (k's right overlap ∪ k+1's left overlap);
 *     the seam s is the middle unit of O.
 *   - A = the run of chunk k's path that contains s; B = chunk k+1's run that
 *     contains s. If A and B EACH cover >= 80% of O, they are the same chapter:
 *     the cut is at s and the two halves are joined into one chapter, labelled
 *     from whichever chunk's run holds more units (ties: the earlier chunk).
 *   - Otherwise the cut goes at the chapter boundary (from either chunk's path)
 *     inside O nearest to s (ties: the earlier unit); with none, at s.
 *   - Units before the cut take chunk k's labels, units from the cut on take
 *     chunk k+1's. Adjacent ad pieces are merged later (piecesToChapters).
 */

import { Piece, boundaries, pathPieces } from './segmenter';

export interface Chunk {
  /** Global unit range of the whole chunk [start, end): overlap + core + overlap. */
  start: number;
  end: number;
  /** The core this chunk owns [coreStart, coreEnd). */
  coreStart: number;
  coreEnd: number;
}

export interface ChunkPlanOptions {
  /** A transcript up to this many tokens is one chunk. Default 16000. */
  maxSingleTokens?: number;
  /** Largest core. Default 12000. */
  maxCoreTokens?: number;
  /** Overlap context on each side of a core. Default 2000. */
  overlapTokens?: number;
}

export const CHUNK_DEFAULTS = { maxSingleTokens: 16000, maxCoreTokens: 12000, overlapTokens: 2000 } as const;

/** Plan chunks from per-unit token counts. */
export function planChunks(tokens: number[], opts: ChunkPlanOptions = {}): Chunk[] {
  const maxSingle = opts.maxSingleTokens ?? CHUNK_DEFAULTS.maxSingleTokens;
  const maxCore = opts.maxCoreTokens ?? CHUNK_DEFAULTS.maxCoreTokens;
  const overlap = opts.overlapTokens ?? CHUNK_DEFAULTS.overlapTokens;
  const n = tokens.length;
  if (n === 0) return [];
  const cum = [0];
  for (const t of tokens) cum.push(cum[cum.length - 1] + t);
  const total = cum[n];
  if (total <= maxSingle) return [{ start: 0, end: n, coreStart: 0, coreEnd: n }];

  const cores = Math.min(n, Math.ceil(total / maxCore));
  const target = total / cores;
  // Core boundaries: the unit boundary whose cumulative count is nearest each multiple of target.
  const cuts = [0];
  for (let c = 1; c < cores; c++) {
    const want = target * c;
    let best = cuts[cuts.length - 1] + 1;
    for (let i = best; i <= n - (cores - c); i++) {
      if (Math.abs(cum[i] - want) < Math.abs(cum[best] - want)) best = i;
      if (cum[i] > want) break;
    }
    cuts.push(best);
  }
  cuts.push(n);

  const out: Chunk[] = [];
  for (let c = 0; c < cores; c++) {
    const coreStart = cuts[c];
    const coreEnd = cuts[c + 1];
    let start = coreStart;
    for (let acc = 0; start > 0 && acc < overlap; ) acc += tokens[--start];
    let end = coreEnd;
    for (let acc = 0; end < n && acc < overlap; ) acc += tokens[end++];
    out.push({ start, end, coreStart, coreEnd });
  }
  return out;
}

/** One chunk's chaptering result, as stitchChunks needs it. */
export interface ChunkPath {
  chunk: Chunk;
  /** Item per unit of the chunk (length chunk.end - chunk.start). */
  path: number[];
  /** Outline items, the plug last when ads are on. */
  items: string[];
  /** Index of the plug item in `items`, or -1. */
  plug: number;
}

export interface Seam {
  /** Global unit index where ownership passes to the next chunk. */
  cut: number;
  /** True when the chapters either side of the cut were joined into one. */
  merged: boolean;
}

/** Cover >= this share of the overlap on both sides and two seam chapters are one. */
export const SEAM_SAME_CHAPTER = 0.8;

/** Where the run of `path` (global offset) containing global unit `g` starts and ends. */
function runAt(path: number[], offset: number, g: number): [number, number] {
  const i = g - offset;
  let a = i;
  let b = i + 1;
  while (a > 0 && path[a - 1] === path[i]) a--;
  while (b < path.length && path[b] === path[i]) b++;
  return [offset + a, offset + b];
}

function overlapLen(a: [number, number], lo: number, hi: number): number {
  return Math.max(0, Math.min(a[1], hi) - Math.max(a[0], lo));
}

/** Decide the seam between two neighbouring chunks (see the header for the rule). */
export function decideSeam(left: ChunkPath, right: ChunkPath): Seam & { labelFrom: 'left' | 'right' } {
  const lo = right.chunk.start;
  const hi = left.chunk.end;
  if (hi <= lo) return { cut: right.chunk.coreStart, merged: false, labelFrom: 'right' };
  const s = Math.floor((lo + hi) / 2);
  const size = hi - lo;
  const A = runAt(left.path, left.chunk.start, s);
  const B = runAt(right.path, right.chunk.start, s);
  if (overlapLen(A, lo, hi) >= SEAM_SAME_CHAPTER * size && overlapLen(B, lo, hi) >= SEAM_SAME_CHAPTER * size) {
    return { cut: s, merged: true, labelFrom: B[1] - B[0] > A[1] - A[0] ? 'right' : 'left' };
  }
  const candidates = [
    ...boundaries(left.path).map((b) => b + left.chunk.start),
    ...boundaries(right.path).map((b) => b + right.chunk.start),
  ].filter((b) => b > lo && b < hi);
  let cut = s;
  let best = Infinity;
  for (const b of candidates) {
    const d = Math.abs(b - s);
    if (d < best || (d === best && b < cut)) {
      best = d;
      cut = b;
    }
  }
  return { cut, merged: false, labelFrom: 'right' };
}

/** Stitch per-chunk paths into one contiguous list of pieces covering every unit. */
export function stitchChunks(results: ChunkPath[]): { pieces: Piece[]; seams: Seam[] } {
  if (results.length === 0) return { pieces: [], seams: [] };
  const seams: Array<Seam & { labelFrom: 'left' | 'right' }> = [];
  let prevCut = results[0].chunk.start;
  for (let k = 0; k + 1 < results.length; k++) {
    const seam = decideSeam(results[k], results[k + 1]);
    // Keep ownership monotone and inside both chunks, whatever the sizes.
    seam.cut = Math.min(Math.max(seam.cut, prevCut, results[k + 1].chunk.start), results[k].chunk.end);
    seams.push(seam);
    prevCut = seam.cut;
  }

  const pieces: Piece[] = [];
  for (let k = 0; k < results.length; k++) {
    const r = results[k];
    const from = k === 0 ? r.chunk.start : seams[k - 1].cut;
    const to = k === results.length - 1 ? r.chunk.end : seams[k].cut;
    if (to <= from) continue;
    const own = pathPieces(r.path, r.items, r.plug, r.chunk.start, k, from - r.chunk.start, to - r.chunk.start);
    const seam = k > 0 ? seams[k - 1] : null;
    const last = pieces[pieces.length - 1];
    if (seam?.merged && last && last.end === own[0].start) {
      const first = own.shift()!;
      const keep = seam.labelFrom === 'right' ? first : last;
      pieces[pieces.length - 1] = { ...keep, start: last.start, end: first.end };
    }
    pieces.push(...own);
  }
  return { pieces, seams: seams.map(({ cut, merged }) => ({ cut, merged })) };
}
