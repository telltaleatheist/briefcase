import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { AnalysisCancelledError, isCancellation } from '../../analysis/cancellation';
import type { FlagWindow, RankedSentence } from '../../analysis/flag-windows';
import { ChoiceAnswer, ChoiceQuestion, DecideRequest, DecideResponse, ScorerError } from '../scorer.types';
import { SNAP_OPTION_TEXTS } from './flag-options';
import { FlagRankProgress, FlagScorer, SnapFlagRanker } from './snap-flag-ranker.service';

// --------------------------------------------------------------------------- fake scorer

/** Which category a sentence "is", by keyword. Anything else is ordinary talk. */
const KEYWORDS: Array<[RegExp, string]> = [
  [/communist/i, 'political-demonization'],
  [/vermin/i, 'dehumanization'],
  [/deep state/i, 'conspiracy'],
  [/moon/i, 'moon-hoax'],
];

function passageOf(q: ChoiceQuestion): string {
  return /Passage from the transcript above: "(.*)"/.exec(q.instructions)![1];
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
      // A passage that does two things splits the mass between them, as a softmax does.
      const hits = KEYWORDS.filter(([re]) => re.test(passageOf(q))).map(([, cat]) => cat);
      const probs: Record<string, number> = hits.length ? { none: 0.15 } : { none: 0.97 };
      for (const cat of hits) probs[cat] = 0.8 / hits.length;
      answers[q.name] = answer(q, probs);
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
    // "communists" is in two groups: one where it is the only hit, one shared with "vermin".
    const u = map.units.findIndex((x) => x.text.includes('communists'));
    expect(map.p1[u][0]).toBeGreaterThan(0.55);
    expect(map.p1[u][1]).toBeGreaterThan(0.15);
    expect(map.p1[u][4]).toBeCloseTo(0.157, 2);
    // Each unit's vector is the mean of the vectors of the groups that hold it.
    for (let i = 0; i < map.units.length; i++) {
      const mine = map.groups.filter((g) => g.unitFrom <= i && i <= g.unitTo);
      expect(mine.length).toBeGreaterThan(0);
      map.p1[i].forEach((p, j) => expect(p).toBeCloseTo(mine.reduce((sum, g) => sum + g.p[j], 0) / mine.length, 9));
    }
    // JSON-serialisable, for the debug dump / heat map / eval.
    expect(JSON.parse(JSON.stringify(map))).toEqual(map);
  });

  it('keeps the canonical column order when none is asked first (the §6.2 bias probe)', async () => {
    const a = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer: new FakeScorer() });
    const b = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer: new FakeScorer(), nonePosition: 'first' });
    expect(b.ratingMap.nonePosition).toBe('first');
    a.ratingMap.p1.forEach((row, i) => row.forEach((p, j) => expect(b.ratingMap.p1[i][j]).toBeCloseTo(p, 9)));
  });

  it('asks one question per group of 3 units, each group sharing a unit with the next, quoting the passage', async () => {
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer });
    const n = res.ratingMap.units.length;
    expect(SnapFlagRanker.groupsOf(0, n)).toEqual(
      Array.from({ length: Math.ceil((n - 1) / 2) }, (_, k) => [2 * k, Math.min(2 * k + 2, n - 1)]),
    );
    expect(res.ratingMap.groups.map((g) => [g.unitFrom, g.unitTo])).toEqual(SnapFlagRanker.groupsOf(0, n));
    const asked = scorer.requests.flatMap((r) => r.questions) as ChoiceQuestion[];
    expect(asked).toHaveLength(res.ratingMap.groups.length);
    expect(res.stats.groupQuestions).toBe(asked.length);
    // The question quotes the passage it judges, never an index into the transcript.
    const units = res.ratingMap.units;
    expect(passageOf(asked[0])).toBe(`${units[0].text} ${units[1].text} ${units[2].text}`);
    for (const q of asked) expect(q.instructions).not.toMatch(/sentence \d|unit \d|#\d/i);
    // Every batch uses 'floor', so a missing letter never refuses a group.
    for (const r of scorer.requests) expect(r.missingLabels).toBe('floor');
  });

  it('groups never cross a chunk, and the last group ends exactly at the chunk end', () => {
    expect(SnapFlagRanker.groupsOf(0, 1)).toEqual([[0, 0]]);
    expect(SnapFlagRanker.groupsOf(0, 3)).toEqual([[0, 2]]);
    expect(SnapFlagRanker.groupsOf(0, 4)).toEqual([[0, 2], [2, 3]]);
    expect(SnapFlagRanker.groupsOf(10, 15)).toEqual([[10, 12], [12, 14]]);
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
    await new SnapFlagRanker().rank(transcript(), CATEGORIES, { scorer, batchSize: 3 });
    expect(scorer.requests.length).toBeGreaterThan(2);
    const state = scorer.requests[0].state as string;
    expect(state).toContain('Categories (the options in the questions below):');
    expect(state).toContain(SNAP_OPTION_TEXTS['political-demonization']);
    for (const r of scorer.requests) expect(r.state).toBe(state);
    const q = scorer.requests[0].questions[0] as ChoiceQuestion;
    expect(q.options.map((o) => o.description)).not.toContain(SNAP_OPTION_TEXTS['political-demonization']);
    expect(q.instructions).toContain('Passage from the transcript above: "Welcome back to the show everybody.');
  });

  it('produces drop-in FlagWindows: sentence indices, propositions, descending score, one span per moment', async () => {
    const sentences = transcript();
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(sentences, CATEGORIES, { scorer });
    const windows: FlagWindow[] = res.windows;
    for (let i = 1; i < windows.length; i++) expect(windows[i].score).toBeLessThanOrEqual(windows[i - 1].score);
    const at = (re: RegExp) => sentences.findIndex((s) => re.test(s.text));
    const covering = (i: number) => windows.filter((w) => w.firedFrom <= i && i <= w.firedTo);
    // The adjacent demonization + dehumanization lines are ONE passage carrying both.
    const joint = covering(at(/communists/));
    expect(joint).toHaveLength(1);
    expect(joint[0]).toBe(covering(at(/vermin/))[0]);
    expect(joint[0].categories.map((c) => c.category).sort()).toEqual(['dehumanization', 'political-demonization']);
    expect(covering(at(/deep state/))[0].categories.map((c) => c.category)).toContain('conspiracy');
    expect(covering(at(/moon landing/))[0].categories.map((c) => c.category)).toContain('moon-hoax');
    // Ordinary talk far from any hit is in no window.
    expect(covering(at(/Welcome back/))).toHaveLength(0);
    for (const w of windows) {
      expect(w.contextFrom).toBeGreaterThanOrEqual(0);
      expect(w.contextTo).toBeLessThan(sentences.length);
      for (const c of w.categories) {
        expect(c.proposition).toBeTruthy();
        expect(c.sentenceIndices.length).toBeGreaterThan(0);
      }
    }
  });

  it('reports progress per batch, monotonically, in groups and in sentences covered', async () => {
    const events: FlagRankProgress[] = [];
    const res = await new SnapFlagRanker().rank(transcript(), CATEGORIES, {
      scorer: new FakeScorer(),
      batchSize: 3,
      onProgress: (p) => events.push({ ...p }),
    });
    const units = res.ratingMap.units.length;
    expect(events[0]).toEqual({ done: 0, total: res.ratingMap.groups.length, unitsDone: 0, unitsTotal: units });
    expect(events[events.length - 1]).toEqual({ done: res.ratingMap.groups.length, total: res.ratingMap.groups.length, unitsDone: units, unitsTotal: units });
    for (let i = 1; i < events.length; i++) {
      expect(events[i].done).toBeGreaterThan(events[i - 1].done);
      expect(events[i].unitsDone).toBeGreaterThanOrEqual(events[i - 1].unitsDone);
    }
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

  it('chunked transcripts: every unit is in a group of its own chunk, asked against that chunk\'s state', async () => {
    const base = transcript();
    const sentences = Array.from({ length: 6 }, (_, k) => base.map((s) => ({ ...s, start: s.start + k * 100, end: s.end + k * 100 }))).flat();
    const scorer = new FakeScorer();
    const res = await new SnapFlagRanker().rank(sentences, CATEGORIES, {
      scorer,
      chunks: { singleChunkMaxTokens: 300, coreMaxTokens: 250, overlapTokens: 50 },
    });
    const { chunks, groups, units } = res.ratingMap;
    expect(chunks.length).toBeGreaterThan(1);
    const covered = new Set<number>();
    for (const g of groups) {
      const chunk = chunks.find((c) => c.coreFrom <= g.unitFrom && g.unitFrom < c.coreTo)!;
      expect(g.unitTo).toBeLessThan(chunk.coreTo);
      for (let i = g.unitFrom; i <= g.unitTo; i++) covered.add(i);
    }
    expect(covered.size).toBe(units.length);
    // A group of the second chunk is asked with the second chunk's state.
    const second = chunks[1];
    const request = scorer.requests.find((r) =>
      (r.questions as ChoiceQuestion[]).some((q) => passageOf(q).startsWith(units[second.coreFrom].text)),
    )!;
    expect(request.state).toContain(units[second.coreFrom].text);
  });

  it('no categories or no sentences: no scorer calls, empty result', async () => {
    const scorer = new FakeScorer();
    expect((await new SnapFlagRanker().rank([], CATEGORIES, { scorer })).windows).toEqual([]);
    expect((await new SnapFlagRanker().rank(transcript(), [{ name: 'misinformation' }], { scorer })).windows).toEqual([]);
    expect(scorer.requests).toHaveLength(0);
  });
});
