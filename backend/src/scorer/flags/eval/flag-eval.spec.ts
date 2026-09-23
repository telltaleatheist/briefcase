import { describe, expect, it } from '@jest/globals';

import type { SnapFlagWindow } from '../flag-spans';
import { parseSrt, scoreVideo } from './flag-eval';

describe('flag eval harness (pure parts)', () => {
  it('parses SRT like the analysis service does', () => {
    const srt = '1\r\n00:00:01,500 --> 00:00:04,200\r\nHello there.\r\n\r\n2\n01:00:00,000 --> 01:00:02,000\nline one\nline two';
    expect(parseSrt(srt)).toEqual([
      { start: 1.5, end: 4.2, text: 'Hello there.' },
      { start: 3600, end: 3602, text: 'line one line two' },
    ]);
  });

  it('scores recall by time overlap of fired ranges, category-agnostic and matched, in and over budget', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: `s${i}` }));
    const win = (from: number, to: number, cats: string[], spanId: number) =>
      ({
        contextFrom: from,
        contextTo: to,
        firedFrom: from,
        firedTo: to,
        categories: cats.map((category) => ({ category })),
        score: 0.9,
        spanIds: [spanId],
        strength: -2,
        heat: 1,
      }) as unknown as SnapFlagWindow;
    const rows = [
      { video_id: 'v', start_seconds: 10, end_seconds: 20, category: 'hate', verdict: 'flag', nli_score: 0.95 },
      { video_id: 'v', start_seconds: 50, end_seconds: 55, category: 'conspiracy', verdict: 'flag', nli_score: 0.9 },
      { video_id: 'v', start_seconds: 80, end_seconds: 85, category: 'violence', verdict: 'flag', nli_score: null },
      { video_id: 'v', start_seconds: 12, end_seconds: 14, category: 'hate', verdict: 'skip', nli_score: 0.5 },
    ];
    const m = scoreVideo('v', sentences, rows, [win(2, 3, ['hate'], 0), win(10, 10, ['hate'], 1)], [win(16, 16, ['violence'], 2)], {
      pass1Questions: 20,
      pass2Questions: 3,
      wallMs: 1000,
      scorerMs: 900,
    });
    expect(m.flagRows).toBe(3);
    expect(m.recallAnyInBudget).toBeCloseTo(2 / 3);
    expect(m.recallCategoryInBudget).toBeCloseTo(1 / 3);
    expect(m.recallAnyAll).toBeCloseTo(1);
    expect(m.recallCategoryAll).toBeCloseTo(2 / 3);
    expect(m.skipRowsHit).toBe(1);
    expect(m.verifyCalls).toBe(2);
    expect(m.overflowCalls).toBe(1);
    expect(m.nliRows).toBe(3);
    expect(m.picketFence).toBe(0);
    expect(m.missed).toEqual([]);
  });
});
