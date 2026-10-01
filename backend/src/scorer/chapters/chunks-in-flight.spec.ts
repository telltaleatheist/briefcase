import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import type { ChoiceAnswer, ChoiceQuestion, DecideResponse, GenerateResult } from '../scorer.types';
import { inFlight, runSnapChapters, type ChapterScorer } from './snap-chapter.service';

describe('inFlight', () => {
  it('runs at most `limit` at once and returns results in task order', async () => {
    let running = 0;
    let most = 0;
    const tasks = [30, 5, 20, 1, 10, 2].map((ms, i) => async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i;
    });
    expect(await inFlight(tasks, 3)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(most).toBe(3);
  });

  it('the first failure rejects, and no task starts after it', async () => {
    const started: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) => async () => {
      started.push(i);
      if (i === 0) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 5));
      return i;
    });
    await expect(inFlight(tasks, 1)).rejects.toThrow('boom');
    expect(started).toEqual([0]);
  });
});

describe('chunks chaptered side by side', () => {
  beforeAll(() => Logger.overrideLogger(false));

  // Three chunks of 20 sentences; each chunk is cooking then travel.
  const units = Array.from({ length: 60 }, (_, i) => ({
    start: i * 10, end: i * 10 + 10, text: i % 20 < 10 ? `now the cooking step ${i}` : `on the travel leg ${i}`,
  }));
  const chunkPlan = [0, 20, 40].map((start) => ({ start, end: start + 20, coreStart: start, coreEnd: start + 20 })) as never;

  function scorer(): { s: ChapterScorer; live: () => number } {
    let live = 0;
    let most = 0;
    const slow = async <T>(v: T): Promise<T> => {
      live++;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return v;
    };
    const s: ChapterScorer = {
      generate: async (): Promise<GenerateResult> => slow({ text: 'Cooking\nTravel', promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' }),
      decide: async (req) => {
        const answers: DecideResponse['answers'] = {};
        for (const q of req.questions as ChoiceQuestion[]) {
          const cooking = /cooking/.test(q.instructions) ? 0.9 : 0.05;
          const probs = q.options.map((o) => (o.name === 'Cooking' ? cooking : o.name === 'Travel' ? 1 - cooking : 0.001));
          const options = q.options.map((o) => o.name);
          answers[q.name] = {
            type: 'choice', options, probabilities: Object.fromEntries(options.map((o, i) => [o, probs[i]])),
            logProbs: probs.map(Math.log), rawLogProbs: probs.map(Math.log), labelMass: 0.95, choice: options[probs.indexOf(Math.max(...probs))], confidence: Math.max(...probs),
          } as ChoiceAnswer;
        }
        return slow({ model: 'fake', answers, timingMs: { total: 1, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } });
      },
    };
    return { s, live: () => most };
  }

  it('the chapters are the same as one chunk after another, and progress never goes back', async () => {
    const one = scorer();
    const serial = await runSnapChapters(one.s, units, { detectAds: false, chunkPlan, chunksInFlight: 1 });
    expect(one.live()).toBe(1);

    const three = scorer();
    const fractions: number[] = [];
    const parallel = await runSnapChapters(three.s, units, { detectAds: false, chunkPlan, onProgress: (p) => fractions.push(p.fraction) });
    expect(three.live()).toBeGreaterThan(1);
    expect(parallel.chapters).toEqual(serial.chapters);
    expect(parallel.chunks.map((c) => c.start)).toEqual([0, 20, 40]);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});
