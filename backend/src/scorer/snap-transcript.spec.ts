import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { assembleSentences } from '../analysis/flag-windows';
import { runSnapChapters } from './chapters/snap-chapter.service';
import {
  ChoiceAnswer,
  ChoiceQuestion,
  DecideRequest,
  DecideResponse,
  GenerateResult,
  YesNoAnswer,
} from './scorer.types';
import { buildSnapTranscript, chunkTranscript } from './snap-transcript';

/** Records every decide state; answers anything (the first section). */
class RecordingScorer {
  readonly states: string[] = [];

  async generate(): Promise<GenerateResult> {
    return { text: 'Cooking\nTravel', promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' };
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    const answers: DecideResponse['answers'] = {};
    for (const q of req.questions) {
      if (q.type === 'yesno') {
        const a: YesNoAnswer = {
          type: 'yesno', p: 0.9, options: ['Yes', 'No'], probabilities: { Yes: 0.9, No: 0.1 },
          logProbs: [Math.log(0.9), Math.log(0.1)], rawLogProbs: [Math.log(0.9), Math.log(0.1)], labelMass: 1,
        };
        answers[q.name] = a;
        continue;
      }
      const cq = q as ChoiceQuestion;
      const names = cq.options.map((o) => o.name);
      const probs = names.map((_, k) => (k === 0 ? 0.97 : 0.03 / (names.length - 1)));
      const a: ChoiceAnswer = {
        type: 'choice', choice: names[0], confidence: 0.97, options: names,
        probabilities: Object.fromEntries(names.map((n, k) => [n, probs[k]])),
        logProbs: probs.map(Math.log), rawLogProbs: probs.map(Math.log), labelMass: 0.99,
      };
      answers[q.name] = a;
    }
    this.states.push(req.state as string);
    return { model: 'fake', answers, timingMs: { total: 1, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

function segments(n: number) {
  const topics = ['cooking pasta in a big pot', 'travel to the mountains by train', 'a word from our sponsor today'];
  return Array.from({ length: n }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: `Sentence ${i} talks about ${topics[Math.floor((i / n) * topics.length)]} at some length.`,
  }));
}

describe('one transcript for the chapter pass (plan §3.2)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('units index the transcript sentences, with segment times', async () => {
    const segs = segments(12);
    const t = await buildSnapTranscript(segs);
    const sentences = assembleSentences(segs);
    expect(t.units.length).toBeGreaterThan(0);
    for (const u of t.units) {
      expect(sentences[u.sentenceFrom].start).toBe(u.start);
      expect(sentences[u.sentenceTo].end).toBe(u.end);
    }
  });

  it('every chapter question is asked against its chunk\'s transcript text', async () => {
    const t = await buildSnapTranscript(segments(12));
    const scorer = new RecordingScorer();
    await runSnapChapters(scorer, t.units, { chunkPlan: t.chunks, totalSeconds: t.totalSeconds });
    expect(new Set(scorer.states)).toEqual(new Set([chunkTranscript(t, 0)]));
  });

  it('chunked: chunk k\'s questions are asked against chunk k\'s text', async () => {
    const t = await buildSnapTranscript(segments(120), { chunking: { maxSingleTokens: 400, maxCoreTokens: 300, overlapTokens: 60 } });
    expect(t.chunks.length).toBeGreaterThan(1);
    const scorer = new RecordingScorer();
    await runSnapChapters(scorer, t.units, { chunkPlan: t.chunks, totalSeconds: t.totalSeconds });
    const expected = t.chunks.map((_, k) => chunkTranscript(t, k));
    expect([...new Set(scorer.states)]).toEqual(expected);
  });
});
