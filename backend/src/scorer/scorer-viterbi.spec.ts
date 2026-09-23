import { describe, expect, it } from '@jest/globals';

import { runsOf, segments, viterbi } from './scorer-viterbi';

const L = (p: number) => Math.log(p);

/** Rows from a per-unit preferred state: `strong` on the preferred state, the rest share what is left. */
function rows(prefs: number[], m: number, strong = 0.9): number[][] {
  return prefs.map((j) => Array.from({ length: m }, (_, k) => (k === j ? L(strong) : L((1 - strong) / (m - 1)))));
}

describe('viterbi (segment.py port)', () => {
  it('returns [] for no units and the argmax for one', () => {
    expect(viterbi([], 20)).toEqual([]);
    expect(viterbi([[L(0.2), L(0.7), L(0.1)]], 20)).toEqual([1]);
  });

  it('with no switch cost, follows the per-unit argmax', () => {
    expect(viterbi(rows([0, 1, 0, 2, 2], 3), 0)).toEqual([0, 1, 0, 2, 2]);
  });

  it('switch cost trades a brief excursion against two switches', () => {
    // Unit 2 prefers state 1 by exactly 5 nats; leaving and coming back costs 2 x cost.
    const M = [
      [0, -10],
      [0, -10],
      [-5, 0],
      [0, -10],
      [0, -10],
    ];
    expect(viterbi(M, 2)).toEqual([0, 0, 1, 0, 0]); // 4 < 5: take the excursion
    expect(viterbi(M, 3)).toEqual([0, 0, 0, 0, 0]); // 6 > 5: stay
    expect(viterbi(M, 20)).toEqual([0, 0, 0, 0, 0]);
  });

  it('a sustained change is worth one switch even at cost 20', () => {
    const prefs = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const path = viterbi(rows(prefs, 4, 0.97), 20);
    expect(path).toEqual(prefs);
  });

  it('lets a theme recur after an aside (any state may follow any other)', () => {
    const prefs = [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0];
    const path = viterbi(rows(prefs, 3, 0.999), 20);
    expect(path).toEqual(prefs);
    expect(runsOf(path, 0)).toEqual([
      [0, 8],
      [16, 24],
    ]);
    expect(segments(path).map((s) => s.state)).toEqual([0, 2, 0]);
    // The same 8-unit aside (~61 nats of evidence) is absorbed when two switches cost 80.
    expect(viterbi(rows(prefs, 3, 0.999), 40).every((j) => j === 0)).toBe(true);
  });

  it('breaks ties toward the lower state index, as Python max() does', () => {
    expect(viterbi([[0, 0], [0, 0]], 1)).toEqual([0, 0]);
  });

  it('rejects ragged rows', () => {
    expect(() => viterbi([[0, 0], [0]], 1)).toThrow(/row 1/);
  });
});
