import { describe, expect, it } from '@jest/globals';
import { decideTimingLine } from './crucible-scorer.service';

describe('decideTimingLine', () => {
  it('says where one decide spent its time: here, on Crucible, the prime, and the mean question', () => {
    const line = decideTimingLine({
      timingMs: {
        total: 4200,
        prime: { promptMs: 900, promptTokens: 6000, cachedTokens: 5800 },
        perQuestion: {
          w0: { promptMs: 1900, promptTokens: 6500, cachedTokens: 6000 },
          w1: { promptMs: 2100, promptTokens: 6600, cachedTokens: 6000 },
        },
      },
      tokens: { perQuestion: {}, images: 0 },
    }, 4350);
    expect(line).toBe('decide: 2 question(s), 4350 ms here, 4200 ms on Crucible; prime 900 ms (6000 tokens, 5800 cached); per question 2000 ms, 550 fresh tokens');
  });

  it('what the server did not state reads as ?', () => {
    expect(decideTimingLine({ timingMs: { total: null, perQuestion: { q: { promptMs: null, promptTokens: null, cachedTokens: null } } }, tokens: { perQuestion: {}, images: null } }, 120))
      .toBe('decide: 1 question(s), 120 ms here, ? on Crucible; per question ?, ? fresh tokens');
  });
});
