import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { runSnapChapters } from './chapters/snap-chapter.service';
import { SnapFlagRanker } from './flags/snap-flag-ranker.service';
import { ScorerPromptBuilder, TemplateRenderer } from './scorer-prompt';
import {
  ChatMessage,
  ChoiceAnswer,
  ChoiceQuestion,
  DecideRequest,
  DecideResponse,
  GenerateResult,
  YesNoAnswer,
} from './scorer.types';
import { buildSnapTranscript, chunkTranscript } from './snap-transcript';

/** Records every decide state; answers anything (flags: all "none"; chapters: the first section). */
class RecordingScorer {
  readonly states: Array<{ state: string; pass: 'chapters' | 'flags' }> = [];

  async generate(): Promise<GenerateResult> {
    return { text: 'Cooking\nTravel', promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' };
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    const answers: DecideResponse['answers'] = {};
    let pass: 'chapters' | 'flags' = 'chapters';
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
      if (cq.name.startsWith('p1:') || cq.name.startsWith('p2:')) pass = 'flags';
      const names = cq.options.map((o) => o.name);
      const pick = names.includes('none') ? names.indexOf('none') : 0;
      const probs = names.map((_, k) => (k === pick ? 0.97 : 0.03 / (names.length - 1)));
      const a: ChoiceAnswer = {
        type: 'choice', choice: names[pick], confidence: 0.97, options: names,
        probabilities: Object.fromEntries(names.map((n, k) => [n, probs[k]])),
        logProbs: probs.map(Math.log), rawLogProbs: probs.map(Math.log), labelMass: 0.99,
      };
      answers[q.name] = a;
    }
    this.states.push({ state: req.state as string, pass });
    return { model: 'fake', answers, timingMs: { total: 1, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

/** Qwen3.5's template for system + user, thinking off (content |trim), as the engine renders it. */
const qwenRenderer: TemplateRenderer = {
  async applyTemplate(messages: ChatMessage[], addGen: boolean): Promise<string> {
    let out = '';
    for (const m of messages) out += `<|im_start|>${m.role}\n${m.content.trim()}<|im_end|>\n`;
    if (addGen) out += '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    return out;
  },
};

function segments(n: number) {
  const topics = ['cooking pasta in a big pot', 'travel to the mountains by train', 'a word from our sponsor today'];
  return Array.from({ length: n }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: `Sentence ${i} talks about ${topics[Math.floor((i / n) * topics.length)]} at some length.`,
  }));
}

const CATEGORIES = [{ name: 'hate' }, { name: 'conspiracy' }];

async function bothPasses(nSegments: number, layout: 'prefix' | 'inline', chunking?: { maxSingleTokens: number; maxCoreTokens: number; overlapTokens: number }) {
  const t = await buildSnapTranscript(segments(nSegments), { chunking });
  const scorer = new RecordingScorer();
  await runSnapChapters(scorer, t.units, { chunkPlan: t.chunks, totalSeconds: t.totalSeconds });
  await new SnapFlagRanker().rank(t.sentences, CATEGORIES, {
    scorer,
    layout,
    unitList: t.units,
    chunkPlan: t.flagChunks,
  });
  return { t, scorer };
}

describe('one transcript for both snap passes (plan §3.2)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('flag units index the same sentences the verifier stage uses, with segment times', async () => {
    const t = await buildSnapTranscript(segments(12));
    expect(t.units.length).toBeGreaterThan(0);
    for (const u of t.units) {
      expect(t.sentences[u.sentenceFrom].start).toBe(u.start);
      expect(t.sentences[u.sentenceTo].end).toBe(u.end);
    }
    expect(t.flagChunks).toEqual([{ coreFrom: 0, coreTo: t.units.length, contextFrom: 0, contextTo: t.units.length }]);
  });

  it('prefix layout: every flag state starts with the byte-identical chapter state, then only the legend', async () => {
    const { t, scorer } = await bothPasses(12, 'prefix');
    const chapterStates = new Set(scorer.states.filter((s) => s.pass === 'chapters').map((s) => s.state));
    const flagStates = new Set(scorer.states.filter((s) => s.pass === 'flags').map((s) => s.state));
    expect(chapterStates.size).toBe(1);
    expect(flagStates.size).toBe(1);
    const chapter = [...chapterStates][0];
    const flag = [...flagStates][0];
    expect(chapter).toBe(chunkTranscript(t, 0));
    expect(flag.startsWith(chapter + '\n\n')).toBe(true);
    expect(flag.slice(chapter.length + 2).startsWith('Categories (the options in the questions below):')).toBe(true);

    // What the engine is actually sent to prime: the chapter prime is a byte
    // prefix of the flag prime, so the flag pass restores the checkpoint the
    // chapter pass left at the end of the transcript and prefills the legend only.
    const builder = await ScorerPromptBuilder.create(qwenRenderer, '<__media__>');
    const chapterPrime = builder.sharedPrefix(chapter);
    const flagPrime = builder.sharedPrefix(flag);
    expect(flagPrime.startsWith(chapterPrime)).toBe(true);
    expect(flagPrime.slice(chapterPrime.length).startsWith('\n\nCategories')).toBe(true);
  });

  it('inline layout: the chapter and flag states are identical', async () => {
    const { scorer } = await bothPasses(12, 'inline');
    const states = new Set(scorer.states.map((s) => s.state));
    expect(states.size).toBe(1);
  });

  it('chunked: chunk k has the same transcript text in both passes', async () => {
    const { t, scorer } = await bothPasses(120, 'prefix', { maxSingleTokens: 400, maxCoreTokens: 300, overlapTokens: 60 });
    expect(t.chunks.length).toBeGreaterThan(1);
    const expected = t.chunks.map((_, k) => chunkTranscript(t, k));
    const chapterStates = [...new Set(scorer.states.filter((s) => s.pass === 'chapters').map((s) => s.state))];
    const flagStates = [...new Set(scorer.states.filter((s) => s.pass === 'flags').map((s) => s.state))];
    expect(chapterStates).toEqual(expected);
    expect(flagStates.length).toBe(expected.length);
    flagStates.forEach((s, k) => expect(s.startsWith(expected[k] + '\n\n')).toBe(true));
  });
});
