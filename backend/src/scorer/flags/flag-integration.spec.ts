import { describe, expect, it } from '@jest/globals';

import type { WindowCategory } from '../../analysis/nli-ranker.service';
import { mergeSpanSubPassages, promoteCachedOverflow } from './flag-integration';
import type { SnapFlagWindow } from './flag-spans';

function cat(category: string, score: number, sentences: number[]): WindowCategory {
  return {
    category,
    proposition: `${category} proposition`,
    score,
    sentenceIndex: sentences[0],
    text: '',
    start: 0,
    end: 0,
    sentenceIndices: sentences,
    rescued: false,
  };
}

function win(from: number, to: number, spanIds: number[], cats: WindowCategory[]): SnapFlagWindow {
  return {
    contextFrom: Math.max(0, from - 1),
    contextTo: to + 1,
    firedFrom: from,
    firedTo: to,
    categories: cats,
    score: Math.max(...cats.map((c) => c.score)),
    spanIds,
    strength: 0,
    heat: 0,
  };
}

describe('mergeSpanSubPassages', () => {
  it('two accepted sub-passages of one span become ONE entry covering both, categories unioned', () => {
    const a = win(10, 14, [3], [cat('hate', 0.9, [10, 12])]);
    const b = win(15, 19, [3], [cat('hate', 0.95, [16]), cat('violence', 0.7, [18])]);
    const out = mergeSpanSubPassages([a, b], new Map([[a, a.categories], [b, b.categories]]));
    expect(out).toHaveLength(1);
    expect(out[0].window.firedFrom).toBe(10);
    expect(out[0].window.firedTo).toBe(19);
    expect(out[0].categories.map((c) => [c.category, c.score, c.sentenceIndices])).toEqual([
      ['hate', 0.95, [10, 12, 16]],
      ['violence', 0.7, [18]],
    ]);
  });

  it('a rejected middle sub-passage keeps its neighbours apart', () => {
    const a = win(0, 4, [1], [cat('hate', 0.9, [1])]);
    const b = win(5, 9, [1], [cat('hate', 0.9, [6])]);
    const c = win(10, 14, [1], [cat('hate', 0.9, [11])]);
    const out = mergeSpanSubPassages([c, a, b], new Map([[a, a.categories], [c, c.categories]]));
    expect(out.map((v) => v.window.firedFrom)).toEqual([0, 10]);
  });

  it('adjacent windows from DIFFERENT spans are not merged, and output is in transcript order', () => {
    const a = win(20, 22, [2], [cat('conspiracy', 0.8, [21])]);
    const b = win(5, 7, [1], [cat('hate', 0.9, [6])]);
    const c = win(8, 9, [4], [cat('hate', 0.9, [8])]);
    const out = mergeSpanSubPassages([a, b, c], new Map([[a, a.categories], [b, b.categories], [c, c.categories]]));
    expect(out.map((v) => v.window.firedFrom)).toEqual([5, 8, 20]);
  });

  it('NLI windows (no span ids) pass through unmerged', () => {
    const a = { ...win(0, 1, [], [cat('hate', 0.9, [0])]) } as any;
    delete a.spanIds;
    const b = { ...win(2, 3, [], [cat('hate', 0.9, [2])]) } as any;
    delete b.spanIds;
    expect(mergeSpanSubPassages([a, b], new Map([[a, a.categories], [b, b.categories]]))).toHaveLength(2);
  });
});

describe('promoteCachedOverflow', () => {
  it('verifies an over-budget window only when every one of its questions is cached', () => {
    const full = win(0, 1, [1], [cat('hate', 0.5, [0]), cat('violence', 0.4, [1])]);
    const half = win(5, 6, [2], [cat('hate', 0.5, [5]), cat('violence', 0.4, [6])]);
    const cached = new Set(['0:hate', '0:violence', '5:hate']);
    const { promoted, candidates } = promoteCachedOverflow([full, half], (w, c) => cached.has(`${w.firedFrom}:${c.category}`));
    expect(promoted).toEqual([full]);
    expect(candidates).toEqual([half]);
  });
});
