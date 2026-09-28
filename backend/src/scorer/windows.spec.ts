import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import type { RankedSentence } from '../analysis/flag-windows';
import { runSnapChapters, type ChapterScorer } from './chapters/snap-chapter.service';
import { SnapFlagRanker, type FlagScorer } from './flags/snap-flag-ranker.service';
import type { ChoiceAnswer, ChoiceQuestion, DecideRequest, DecideResponse, GenerateResult } from './scorer.types';
import { DEFAULT_TIME_WINDOWS, readWindowsSetting, timeWindows, unitMeans, windowsOf } from './windows';

const at = (...starts: number[]) => starts.map((start) => ({ start }));

describe('timeWindows', () => {
  it('90 s windows every 60 s over 10 s units: neighbours share 30 s, every unit in one or two', () => {
    const units = at(...Array.from({ length: 30 }, (_, i) => i * 10)); // 0..290 s
    const w = timeWindows(units, 0, 30, DEFAULT_TIME_WINDOWS);
    expect(w).toEqual([[0, 8], [6, 14], [12, 20], [18, 26], [24, 29]]);
    const seen = new Array(30).fill(0);
    for (const [a, b] of w) for (let i = a; i <= b; i++) seen[i]++;
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(2);
  });

  it('works on a slice of the units (a chunk), with absolute indices', () => {
    const units = at(...Array.from({ length: 30 }, (_, i) => i * 10));
    expect(timeWindows(units, 10, 20, DEFAULT_TIME_WINDOWS)).toEqual([[10, 18], [16, 19]]);
  });

  it('a silence longer than a window is skipped over: the next window opens at the next unit', () => {
    const units = at(0, 10, 20, 500, 510);
    expect(timeWindows(units, 0, 5, DEFAULT_TIME_WINDOWS)).toEqual([[0, 2], [3, 4]]);
  });

  it('a video shorter than one window is one window; no units, none', () => {
    expect(timeWindows(at(0, 5, 12), 0, 3, DEFAULT_TIME_WINDOWS)).toEqual([[0, 2]]);
    expect(timeWindows(at(0, 5), 1, 1, DEFAULT_TIME_WINDOWS)).toEqual([]);
  });

  it('refuses a step longer than the window (units would fall between windows)', () => {
    expect(() => timeWindows(at(0), 0, 1, { windowSeconds: 30, stepSeconds: 60 })).toThrow(/step <= window/);
  });
});

describe('unitMeans', () => {
  it('each unit gets the mean of the windows that hold it', () => {
    const rows = unitMeans(0, 4, [[0, 2], [2, 3]], [[1, 0], [0, 1]]);
    expect(rows).toEqual([[1, 0], [1, 0], [0.5, 0.5], [0, 1]]);
  });
});

describe('the stored setting', () => {
  it('is read as sent, refused with a reason, and absent or unreadable means the default', () => {
    expect(readWindowsSetting({ mode: 'sentence' })).toEqual({ mode: 'sentence' });
    expect(readWindowsSetting({ mode: 'windows', windowSeconds: 90, stepSeconds: 60 })).toEqual({ mode: 'windows', windowSeconds: 90, stepSeconds: 60 });
    expect(readWindowsSetting({ mode: 'windows', windowSeconds: 60, stepSeconds: 90 })).toMatch(/stepSeconds/);
    expect(readWindowsSetting({ mode: 'windows', windowSeconds: 5, stepSeconds: 5 })).toMatch(/windowSeconds/);
    expect(readWindowsSetting({})).toMatch(/mode/);
    expect(windowsOf(undefined)).toEqual(DEFAULT_TIME_WINDOWS);
    expect(windowsOf({ mode: 'sentence' })).toBeNull();
    expect(windowsOf({ mode: 'windows', windowSeconds: 120, stepSeconds: 60 })).toEqual({ windowSeconds: 120, stepSeconds: 60 });
    expect(windowsOf({ mode: 'bogus' })).toEqual(DEFAULT_TIME_WINDOWS);
  });
});

// --------------------------------------------------------------------------- the passes, asked per window

function choice(q: ChoiceQuestion, probs: number[]): ChoiceAnswer {
  const options = q.options.map((o) => o.name);
  const z = probs.reduce((a, b) => a + b, 0);
  const p = probs.map((x) => x / z);
  let best = 0;
  p.forEach((x, i) => (x > p[best] ? (best = i) : 0));
  return {
    type: 'choice', options, probabilities: Object.fromEntries(options.map((o, i) => [o, p[i]])),
    logProbs: p.map(Math.log), rawLogProbs: p.map(Math.log), labelMass: 0.95, choice: options[best], confidence: p[best],
  };
}

function passageOf(q: ChoiceQuestion): string {
  return /Passage from the transcript above: "([\s\S]*)"/.exec(q.instructions)![1].toLowerCase();
}

const respond = (answers: DecideResponse['answers']): DecideResponse =>
  ({ model: 'fake', answers, timingMs: { total: 1, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } });

describe('chapters asked per window', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('ask one question per window, not per sentence, and still find the switch on the 30 s grid', async () => {
    // 5 minutes of cooking then 5 of travel, a 10 s sentence each.
    const units = Array.from({ length: 60 }, (_, i) => ({
      start: i * 10, end: i * 10 + 10, text: i < 30 ? `now the cooking step ${i}` : `on the travel leg ${i}`,
    }));
    const decides: DecideRequest[] = [];
    const scorer: ChapterScorer = {
      async generate(): Promise<GenerateResult> {
        return { text: 'Cooking\nTravel', promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' };
      },
      async decide(req) {
        decides.push(req);
        const answers: DecideResponse['answers'] = {};
        for (const q of req.questions as ChoiceQuestion[]) {
          const text = passageOf(q);
          const cooking = (text.match(/cooking/g) ?? []).length;
          const travel = (text.match(/travel/g) ?? []).length;
          answers[q.name] = choice(q, [cooking + 0.01, travel + 0.01]);
        }
        return respond(answers);
      },
    };
    const result = await runSnapChapters(scorer, units, { detectAds: false, windows: DEFAULT_TIME_WINDOWS });
    const asked = decides.flatMap((d) => d.questions);
    expect(asked).toHaveLength(timeWindows(units, 0, 60, DEFAULT_TIME_WINDOWS).length);
    expect(asked.length).toBeLessThan(12);
    expect(asked.every((q) => q.name.startsWith('w'))).toBe(true);
    expect(result.chapters.map((c) => c.title)).toEqual(['Cooking', 'Travel']);
    expect(Math.abs(result.chapters[1].startSeconds - 300)).toBeLessThanOrEqual(30);
  });
});

describe('flags asked per window', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('ask one group question per window, and a flagged window still becomes a span on the real timeline', async () => {
    // Ten minutes, a 6 s sentence each; the demonizing talk runs 04:00-05:00.
    const sentences: RankedSentence[] = Array.from({ length: 100 }, (_, i) => ({
      start: i * 6,
      end: i * 6 + 6,
      text: i >= 40 && i < 50 ? `Those people are communists and enemies, point ${i}.` : `Here is an ordinary remark about gardening, number ${i}.`,
    }));
    const requests: DecideRequest[] = [];
    const scorer: FlagScorer = {
      async decide(req) {
        requests.push(req);
        const answers: DecideResponse['answers'] = {};
        for (const q of req.questions as ChoiceQuestion[]) {
          const hit = /communists/.test(passageOf(q));
          answers[q.name] = choice(q, q.options.map((o) => (o.name === 'political-demonization' ? (hit ? 0.85 : 0.01) : o.name === 'none' ? (hit ? 0.14 : 0.98) : 0.001)));
        }
        return respond(answers);
      },
    };
    const res = await new SnapFlagRanker().rank(sentences, [{ name: 'political-demonization' }], { scorer, windows: DEFAULT_TIME_WINDOWS });
    const asked = requests.flatMap((r) => r.questions);
    expect(asked.length).toBe(timeWindows(res.ratingMap.units, 0, res.ratingMap.units.length, DEFAULT_TIME_WINDOWS).length);
    expect(asked.length).toBeLessThan(12);
    expect(res.ratingMap).toMatchObject({ windowSeconds: 90, stepSeconds: 60 });
    expect(res.windows.length).toBeGreaterThan(0);
    const flagged = res.windows.flatMap((w) => [sentences[w.contextFrom].start, sentences[w.contextTo].end]);
    // The span sits over the demonizing minute, on the 30 s grid the windows draw.
    expect(Math.min(...flagged)).toBeGreaterThanOrEqual(240 - 60);
    expect(Math.max(...flagged)).toBeLessThanOrEqual(300 + 60);
  });
});
