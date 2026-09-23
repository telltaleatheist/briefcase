import { describe, expect, it } from '@jest/globals';

import { ChunkPath, decideSeam, planChunks, stitchChunks } from './chunks';
import { piecesToChapters } from './segmenter';
import { PLUG } from './snap-prompts';

describe('planChunks', () => {
  it('keeps a transcript of <= 16k tokens as one chunk', () => {
    expect(planChunks(Array(40).fill(400))).toEqual([{ start: 0, end: 40, coreStart: 0, coreEnd: 40 }]);
    expect(planChunks([])).toEqual([]);
  });

  it('cuts equal cores of <= 12k tokens with ~2k tokens of overlap each side', () => {
    const chunks = planChunks(Array(100).fill(400)); // 40k tokens -> 4 cores of 10k
    expect(chunks).toEqual([
      { start: 0, end: 30, coreStart: 0, coreEnd: 25 },
      { start: 20, end: 55, coreStart: 25, coreEnd: 50 },
      { start: 45, end: 80, coreStart: 50, coreEnd: 75 },
      { start: 70, end: 100, coreStart: 75, coreEnd: 100 },
    ]);
  });

  it('gives every unit exactly one owning core, with uneven unit sizes', () => {
    const tokens = Array.from({ length: 333 }, (_, i) => 50 + ((i * 37) % 200));
    const chunks = planChunks(tokens);
    expect(chunks.length).toBeGreaterThan(1);
    const owners = Array(tokens.length).fill(0);
    for (const c of chunks) {
      for (let i = c.coreStart; i < c.coreEnd; i++) owners[i]++;
      expect(c.start).toBeLessThanOrEqual(c.coreStart);
      expect(c.end).toBeGreaterThanOrEqual(c.coreEnd);
      const core = tokens.slice(c.coreStart, c.coreEnd).reduce((a, b) => a + b, 0);
      expect(core).toBeLessThanOrEqual(12000 + 250);
    }
    expect(owners.every((n) => n === 1)).toBe(true);
  });
});

/** chunk 0 covers units 0..11 (core 0..7), chunk 1 covers 4..19 (core 8..19): overlap [4, 12), seam 8. */
function pair(left: number[], right: number[], plug = -1): [ChunkPath, ChunkPath] {
  return [
    { chunk: { start: 0, end: 12, coreStart: 0, coreEnd: 8 }, path: left, items: ['A0', 'A1', PLUG], plug },
    { chunk: { start: 4, end: 20, coreStart: 8, coreEnd: 20 }, path: right, items: ['B0', 'B1', PLUG], plug },
  ];
}

describe('stitchChunks', () => {
  it('joins the seam chapters when both cover >= 80% of the overlap, label from the larger run', () => {
    const [l, r] = pair([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(decideSeam(l, r)).toEqual({ cut: 8, merged: true, labelFrom: 'right' });
    const { pieces, seams } = stitchChunks([l, r]);
    expect(seams).toEqual([{ cut: 8, merged: true }]);
    expect(pieces.map((p) => [p.start, p.end, p.label])).toEqual([
      [0, 3, 'A0'],
      [3, 14, 'B0'],
      [14, 20, 'B1'],
    ]);
  });

  it('keeps the left label when its run is the larger one', () => {
    const [l, r] = pair([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const { pieces } = stitchChunks([l, r]);
    expect(pieces.map((p) => [p.start, p.end, p.label])).toEqual([
      [0, 14, 'A1'],
      [14, 20, 'B1'],
    ]);
  });

  it('otherwise cuts at the boundary nearest the seam, from either chunk', () => {
    // left changes at 10 (distance 2), right changes at 7 (distance 1): cut at 7.
    const [l, r] = pair([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1], [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(decideSeam(l, r)).toEqual({ cut: 7, merged: false, labelFrom: 'right' });
    const { pieces } = stitchChunks([l, r]);
    expect(pieces.map((p) => [p.start, p.end, p.label])).toEqual([
      [0, 7, 'A0'],
      [7, 20, 'B1'],
    ]);
  });

  it('prefers the earlier boundary on a distance tie', () => {
    const [l, r] = pair([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(decideSeam(l, r).cut).toBe(7);
  });

  it('pieces tile every unit exactly once across three chunks', () => {
    const chunks = planChunks(Array(90).fill(400), { maxSingleTokens: 16000, maxCoreTokens: 12000, overlapTokens: 2000 });
    const results: ChunkPath[] = chunks.map((c, k) => ({
      chunk: c,
      path: Array.from({ length: c.end - c.start }, (_, i) => ((c.start + i) % 17 < 9 ? 0 : 1)),
      items: [`c${k}-x`, `c${k}-y`],
      plug: -1,
    }));
    const { pieces } = stitchChunks(results);
    expect(pieces[0].start).toBe(0);
    expect(pieces[pieces.length - 1].end).toBe(90);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].start).toBe(pieces[i - 1].end);
  });

  it('merges ad pieces that meet across a seam into one chapter', () => {
    const [l, r] = pair([0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 1, 1], [0, 0, 0, 0, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1], 2);
    const { pieces } = stitchChunks([l, r]);
    const units = Array.from({ length: 20 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: `u${i}` }));
    const ch = piecesToChapters(pieces, units);
    expect(ch.filter((c) => c.isAd)).toHaveLength(1);
    const ad = ch.find((c) => c.isAd)!;
    expect(ad.sentenceRange).toEqual([7, 13]);
    expect(ad.title).toBe('Sponsor / self-promotion');
  });
});
