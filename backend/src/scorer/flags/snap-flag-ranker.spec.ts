import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { AnalysisCancelledError, isCancellation } from '../../analysis/cancellation';
import type { FlagWindow, RankedSentence } from '../../analysis/flag-windows';
import { ChoiceAnswer, ChoiceQuestion, DecideRequest, DecideResponse, ScorerError } from '../scorer.types';
import { SNAP_OPTION_TEXTS } from './flag-options';
import { FITS } from './flag-questions';
import { FlagRankProgress, FlagScorer, SnapFlagRanker } from './snap-flag-ranker.service';

// --------------------------------------------------------------------------- fake scorer

/** Which category a sentence "is", by keyword. Anything else is ordinary talk. */
const KEYWORDS: Array<[RegExp, string]> = [
  [/communist/i, 'political-demonization'],
  [/vermin/i, 'dehumanization'],
  [/deep state/i, 'conspiracy'],
  [/moon/i, 'moon-hoax'],
];

function sentenceOf(q: ChoiceQuestion): string {
  return /Sentence from the transcript above: "(.*)"/.exec(q.instructions)![1];
}

function answer(q: ChoiceQuestion, probs: Record<string, number>): ChoiceAnswer {
  const options = q.options.map((o) => o.name);
  const raw = options.map((o) => probs[o] ?? 0.001);
  const z = raw.reduce((a, b) => a + b, 0);
  const p = raw.map((x) => x / z);
  const probabilities = Object.fromEntries(options.map((o, i) => [o, p[i]]));
  let best = 0;
  p.forEach((x, i) => (x > p[best] ? (best = i) : 0));
  return {
    type: 'choice',
    options,
    probabilities,
    logProbs: p.map(Math.log),
    rawLogProbs: p.map((x) => Math.log(x * 0.9)),
    labelMass: 0.9,
    choice: options[best],
    confidence: p[best],
  };
}

class FakeScorer implements FlagScorer {
  readonly requests: DecideRequest[] = [];
  onDecide?: (n: number) => void;

  async decide(req: DecideRequest, options: { signal?: AbortSignal } = {}): Promise<DecideResponse> {
    if (options.signal?.aborted) throw new ScorerError('cancelled', 'POST /completion: cancelled by the caller');
    this.requests.push(req);
    this.onDecide?.(this.requests.length);
    const answers: Record<string, ChoiceAnswer> = {};
    for (const q of req.questions as ChoiceQuestion[]) {
      const s = sentenceOf(q);
      const hit = KEYWORDS.find(([re]) => re.test(s))?.[1];
      if (q.name.startsWith('p1:')) {
        answers[q.name] = answer(q, hit ? { [hit]: 0.8, none: 0.15 } : { none: 0.97 });
      } else {
        const cat = q.name.split(':').slice(2).join(':');
        answers[q.name] = answer(q, cat === hit ? { [FITS]: 0.92, 'Does not fit': 0.08 } : { [FITS]: 0.1, 'Does not fit': 0.9 });
      }
    }
    return {
      model: 'fake-qwen',
      answers,
      timingMs: { total: 5, perQuestion: {} },
      tokens: { perQuestion: {}, images: 0 },
    };
  }
}

// --------------------------------------------------------------------------- fixtures

const CATEGORIES = [
  { name: 'political-demonization' },
  { name: 'dehumanization' },
  { name: 'conspiracy' },
  { name: 'misinformation' },
  { name: 'moon-hoax', description: 'Claims the moon landing was faked. NOTE: do NOT flag debunking.' },
];

function transcript(): RankedSentence[] {
  const lines = [
    'Welcome back to the show everybody.',
    'Today we are talking about the news.',
    'Let me read you this first story.',
    'The mayor said the budget passed on Tuesday.',
    'Those people are communists and enemies of this country.',
    'They are vermin spreading through our cities.',
    'Anyway, let us move on to the weather report.',
    'It will rain tomorrow in most of the state.',
    'Next week we will have a special guest on.',
    'He is an expert on gardening and tomatoes.',
    'Now the deep state rigged all of it behind closed doors.',
    'That is what they will never tell you about.',
    'We will be right back after this short break.',
    'Thanks for watching and see you next time.',
    'And the moon landing was filmed in a studio, folks.',
    'Goodbye to all of you out there tonight.',
  ];
  return lines.map((text, i) => ({ start: i * 6, end: i * 6 + 6, text }));
}

// --------------------------------------------------------------------------- tests

describe('SnapFlagRanker with a fake scorer', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('builds the rating map: a whole probability vector per unit, categories then none, never argmaxed', async () => {
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer });
    const map = res.ratingMap;
    expect(map.categories).toEqual(['political-demonization', 'dehumanization', 'conspiracy', 'moon-hoax']);
    expect(map.model).toBe('fake-qwen');
    expect(map.p1).toHaveLength(map.units.length);
    for (const row of map.p1) {
      expect(row).toHaveLength(5);
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
    const u = map.units.findIndex((x) => x.text.includes('communists'));
    expect(map.p1[u][0]).toBeGreaterThan(0.7);
    expect(map.p1[u][4]).toBeCloseTo(0.15 / (0.8 + 0.15 + 3 * 0.001), 3);
    // JSON-serialisable, for the debug dump / heat map / eval.
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });

  it('keeps the canonical column order when none is asked first (the §6.2 bias probe)', async () => {
    const a = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer: new FakeScorer() });
    const b = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer: new FakeScorer(), nonePosition: 'first' });
    expect(b.ratingMap.nonePosition).toBe('first');
    a.ratingMap.p1.forEach((row, i) => row.forEach((p, j) => expect(b.ratingMap.p1[i][j]).toBeCloseTo(p, 9)));
  });

  it('asks pass 2 only for hot units, one two-option choice per plausible category', async () => {
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer });
    const p2 = scorer.requests.flatMap((r) => r.questions).filter((q) => q.name.startsWith('p2:')) as ChoiceQuestion[];
    expect(res.stats.pass1Questions).toBe(res.ratingMap.units.length);
    expect(res.stats.hotUnits).toBe(4);
    expect(p2).toHaveLength(4); // one plausible category per hot unit in this fixture
    for (const q of p2) {
      expect(q.type).toBe('choice');
      expect(q.options).toHaveLength(2);
      const unit = Number(q.name.split(':')[1]);
      expect(1 - res.ratingMap.p1[unit][4]).toBeGreaterThanOrEqual(0.2);
    }
    const cold = res.ratingMap.p2.filter((r) => Object.keys(r).length === 0).length;
    expect(cold).toBe(res.ratingMap.units.length - 4);
    // Every batch uses 'floor', so a missing letter never refuses a unit.
    for (const r of scorer.requests) expect(r.missingLabels).toBe('floor');
  });

  it('runs a custom category with no hypothesis on its description, and it reaches the windows', async () => {
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer, layout: 'inline' });
    const q1 = scorer.requests[0].questions[0] as ChoiceQuestion;
    expect(q1.options.find((o) => o.name === 'moon-hoax')!.description).toBe('Claims the moon landing was faked.');
    expect(q1.options.find((o) => o.name === 'conspiracy')!.description).toBe(SNAP_OPTION_TEXTS.conspiracy);
    expect(res.plan.find((p) => p.category === 'moon-hoax')!.tuned).toBe(false);
    const cats = res.windows.flatMap((w) => w.categories.map((c) => c.category));
    expect(cats).toContain('moon-hoax');
    expect(cats).not.toContain('misinformation');
  });

  it('prefix layout: the legend is in the state once, and every batch shares that state', async () => {
    const scorer = new FakeScorer();
    await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer, batchSize: 4 });
    expect(scorer.requests.length).toBeGreaterThan(2);
    const state = scorer.requests[0].state as string;
    expect(state).toContain('Categories (the options in the questions below):');
    expect(state).toContain(SNAP_OPTION_TEXTS['political-demonization']);
    for (const r of scorer.requests) expect(r.state).toBe(state);
    const q = scorer.requests[0].questions[0] as ChoiceQuestion;
    expect(q.options.map((o) => o.description)).not.toContain(SNAP_OPTION_TEXTS['political-demonization']);
    expect(q.instructions).toContain('(The sentence just before it: "(start of the video)")');
  });

  it('produces drop-in FlagWindows: sentence indices, propositions, descending score, one span per moment', async () => {
    const sentences = transcript();
    const scorer = new FakeScorer();
    const ranker = new SnapFlagRanker();
    const windows: FlagWindow[] = await ranker.rankWindows(sentences, CATEGORIES, { scorer });
    expect(windows.length).toBe(3); // the adjacent demonization + dehumanization lines are ONE passage
    for (let i = 1; i < windows.length; i++) expect(windows[i].score).toBeLessThanOrEqual(windows[i - 1].score);
    const joint = windows.find((w) => w.categories.length === 2)!;
    expect(joint.categories.map((c) => c.category).sort()).toEqual(['dehumanization', 'political-demonization']);
    expect(windows[0]).toBe(joint); // co-fire boost puts it first
    expect(sentences[joint.firedFrom].text).toContain('communists');
    expect(sentences[joint.firedTo].text).toContain('vermin');
    for (const w of windows) {
      expect(w.contextFrom).toBeGreaterThanOrEqual(0);
      expect(w.contextTo).toBeLessThan(sentences.length);
      for (const c of w.categories) {
        expect(c.proposition).toBeTruthy();
        expect(c.sentenceIndices.length).toBeGreaterThan(0);
      }
    }
  });

  it('reports progress per batch, monotonically, for both passes', async () => {
    const events: FlagRankProgress[] = [];
    await new SnapFlagRanker().rank(transcript(), CATEGORIES, {
      scorer: new FakeScorer(),
      batchSize: 5,
      onProgress: (p) => events.push({ ...p }),
    });
    const p1 = events.filter((e) => e.phase === 'pass1');
    const p2 = events.filter((e) => e.phase === 'pass2');
    expect(p1[0]).toEqual({ phase: 'pass1', done: 0, total: p1[0].total });
    expect(p1[p1.length - 1].done).toBe(p1[0].total);
    expect(p2[p2.length - 1]).toEqual({ phase: 'pass2', done: 4, total: 4 });
    for (let i = 1; i < p1.length; i++) expect(p1[i].done).toBeGreaterThan(p1[i - 1].done);
  });

  it('cancel: stops issuing batches and throws a cancellation, not a failure', async () => {
    const controller = new AbortController();
    const scorer = new FakeScorer();
    scorer.onDecide = (n) => n === 2 && controller.abort();
    const err = await new SnapFlagRanker()
      .rank(transcript(), CATEGORIES, { scorer, batchSize: 3, signal: controller.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnalysisCancelledError);
    expect(isCancellation(err)).toBe(true);
    expect(scorer.requests).toHaveLength(2);
  });

  it("cancel: maps the scorer's own 'cancelled' error (an aborted in-flight request) to a cancellation", async () => {
    const controller = new AbortController();
    const scorer: FlagScorer = {
      decide: async () => {
        controller.abort();
        throw new ScorerError('cancelled', 'POST /completion: cancelled by the caller');
      },
    };
    const err = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer, signal: controller.signal }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
  });

  it('a real scorer failure propagates as-is (the caller falls back to NLI)', async () => {
    const scorer: FlagScorer = {
      decide: async () => {
        throw new ScorerError('engine_unreachable', 'down');
      },
    };
    const err = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer }).catch((e) => e);
    expect(err).toBeInstanceOf(ScorerError);
    expect(isCancellation(err)).toBe(false);
  });

  it('refuses to rank without a scorer (the caller holds the lease)', async () => {
    await expect(new SnapFlagRanker().rank(transcript(), CATEGORIES)).rejects.toThrow(/no scorer/);
  });

  it('chunked transcripts: every unit scored once, against its own chunk, with the real previous unit', async () => {
    const base = transcript();
    const sentences = Array.from({ length: 6 }, (_, k) => base.map((s) => ({ ...s, start: s.start + k * 100, end: s.end + k * 100 }))).flat();
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(sentences, CATEGORIES, {
      scorer,
      chunks: { singleChunkMaxTokens: 300, coreMaxTokens: 250, overlapTokens: 50 },
    });
    expect(res.ratingMap.chunks.length).toBeGreaterThan(1);
    const asked = scorer.requests.flatMap((r) => r.questions).filter((q) => q.name.startsWith('p1:')).map((q) => q.name);
    expect(new Set(asked).size).toBe(res.ratingMap.units.length);
    expect(asked).toHaveLength(res.ratingMap.units.length);
    const second = res.ratingMap.chunks[1];
    const firstOfSecond = scorer.requests
      .flatMap((r) => r.questions)
      .find((q) => q.name === `p1:${second.coreFrom}`)!;
    expect(firstOfSecond.instructions).toContain(`"${res.ratingMap.units[second.coreFrom - 1].text}"`);
  });

  it('no categories or no sentences: no scorer calls, empty result', async () => {
    const scorer = new FakeScorer();
    expect((await new SnapFlagRanker().rank([], CATEGORIES, { scorer })).windows).toEqual([]);
    expect((await new SnapFlagRanker().rank(transcript(), [{ name: 'misinformation' }], { scorer })).windows).toEqual([]);
    expect(scorer.requests).toHaveLength(0);
  });
});
