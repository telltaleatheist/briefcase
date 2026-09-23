import { describe, expect, it } from '@jest/globals';

import { f1, goldOf, pk, scoreMatrix } from './snap-smoke';

// Reference values computed with ContentStudio's bench.py f1/pk (Python 3).
describe('snap-smoke scoring (port of bench.py)', () => {
  it('f1 matches bench.py', () => {
    expect(f1([10, 31, 50], [10, 30, 70], 1)).toEqual([2 / 3, 2 / 3, 2 / 3]);
    expect(f1([], [10], 1)).toEqual([0, 0, 0]);
  });

  it("pk matches bench.py, including Python's half-to-even round for k", () => {
    expect(pk([10, 31, 50], [10, 30, 70], 100)).toBeCloseTo(0.29545454545454547, 12);
    expect(pk([12], [10, 30, 70], 100)).toBeCloseTo(0.29545454545454547, 12);
    expect(pk([5], [10], 30)).toBeCloseTo(0.3181818181818182, 12); // k = round(7.5) = 8
  });

  it('gold skips a label at sentence 0, and a clean two-block matrix scores perfectly', () => {
    const v = { id: 'x', sents: Array.from({ length: 20 }, (_, i) => `s${i}`), labels: [1, ...Array(9).fill(0), 1, ...Array(9).fill(0)] };
    expect(goldOf(v)).toEqual([10]);
    const L = v.sents.map((_, i) => (i < 10 ? [Math.log(0.99), Math.log(0.01)] : [Math.log(0.01), Math.log(0.99)]));
    expect(scoreMatrix(v, L, [20])[20]).toEqual({ f1_1: 1, f1_3: 1, pk: 0, count: 1 });
  });
});
