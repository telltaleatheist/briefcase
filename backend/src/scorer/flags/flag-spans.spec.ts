import { describe, expect, it } from '@jest/globals';

import type { RankedSentence } from '../../analysis/flag-windows';
import { buildFlagPlan } from './flag-options';
import {
  DEFAULT_SPAN_PARAMS,
  FlagRatingMap,
  applyVerifyBudget,
  buildSpans,
  coFireStrength,
  hotness,
  mergedRuns,
  noisyOr,
  onOffPath,
  picketFenceCount,
  rankFromRatingMap,
  selectPass2Categories,
  unitCategoryScore,
  verifyBudget,
} from './flag-spans';
import { FlagUnit, buildFlagUnits, planFlagChunks } from './flag-units';

const CATS = ['hate', 'conspiracy', 'violence'];
const { plan: PLAN } = buildFlagPlan(CATS.map((name) => ({ name })));

function sentencesOf(n: number, seconds = 4): RankedSentence[] {
  return Array.from({ length: n }, (_, i) => ({
    start: i * seconds,
    end: (i + 1) * seconds,
    text: `Sentence number ${i} has words.`,
  }));
}

/** One unit per sentence; each hot unit's mass goes to `cat` (default hate). */
function mapOf(
  hot: number[],
  opts: { seconds?: number; cat?: (i: number) => number; p2?: Array<Record<string, number>> } = {},
): { map: FlagRatingMap; sentences: RankedSentence[] } {
  const sentences = sentencesOf(hot.length, opts.seconds);
  const units: FlagUnit[] = sentences.map((s, i) => ({
    index: i,
    text: s.text,
    sentenceFrom: i,
    sentenceTo: i,
    start: s.start,
    end: s.end,
  }));
  const p1 = hot.map((h, i) => {
    const row = new Array(CATS.length + 1).fill(0);
    row[opts.cat ? opts.cat(i) : 0] = h;
    row[CATS.length] = 1 - h;
    return row;
  });
  return {
    sentences,
    map: {
      version: 1,
      ranker: 'snap-v1',
      model: 'fake',
      layout: 'prefix',
      nonePosition: 'last',
      categories: CATS,
      units,
      chunks: [{ coreFrom: 0, coreTo: units.length, contextFrom: 0, contextTo: units.length }],
      p1,
      labelMass: hot.map(() => 0.9),
      missingLabels: hot.map(() => 0),
      p2: opts.p2 ?? hot.map(() => ({})),
    },
  };
}

describe('hotness and pass-2 gating', () => {
  it('hot = 1 - P(none)', () => {
    const { map } = mapOf([0.1, 0.5, 0.97]);
    expect(hotness(map).map((h) => +h.toFixed(6))).toEqual([0.1, 0.5, 0.97]);
  });

  it('asks nothing below the gate; above it, categories with P >= 0.05, strongest first, at most 3', () => {
    const p = DEFAULT_SPAN_PARAMS;
    expect(selectPass2Categories([0.1, 0.05, 0.0, 0.85], CATS, p)).toEqual([]); // hot 0.15
    expect(selectPass2Categories([0.1, 0.3, 0.04, 0.56], CATS, p)).toEqual(['conspiracy', 'hate']);
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(selectPass2Categories([0.2, 0.3, 0.1, 0.15, 0.2, 0.05], five, p)).toEqual(['b', 'a', 'e']);
  });

  it('per-unit category evidence: pass 2 wins; else share of hot mass above the gate; else raw P', () => {
    const { map } = mapOf([0.1, 0.6, 0.6], { p2: [{}, { hate: 0.2 }, {}] });
    const hot = hotness(map);
    // cold unit: raw P (0.1), never P/hot (which would be 1.0)
    expect(unitCategoryScore(map, hot, 0, 0, DEFAULT_SPAN_PARAMS)).toBeCloseTo(0.1);
    // pass 2 answered
    expect(unitCategoryScore(map, hot, 1, 0, DEFAULT_SPAN_PARAMS)).toBeCloseTo(0.2);
    // hot, not asked: P/hot
    expect(unitCategoryScore(map, hot, 2, 0, DEFAULT_SPAN_PARAMS)).toBeCloseTo(1);
  });
});

describe('Viterbi spans', () => {
  it('opens a span on one isolated unit at hot 0.6 but not at 0.2 (default λ, τ)', () => {
    expect(onOffPath([0.02, 0.02, 0.6, 0.02, 0.02], DEFAULT_SPAN_PARAMS)).toEqual([0, 0, 1, 0, 0]);
    expect(onOffPath([0.02, 0.02, 0.2, 0.02, 0.02], DEFAULT_SPAN_PARAMS)).toEqual([0, 0, 0, 0, 0]);
  });

  it("documents why the plan's λ=3, τ=0 was not kept: an isolated 0.95 cannot open a span", () => {
    expect(onOffPath([0.02, 0.02, 0.95, 0.02, 0.02], { switchCost: 3, tau: 0 })).toEqual([0, 0, 0, 0, 0]);
  });

  it('turns an alternating hot/cold stretch into ONE span: no picket fence', () => {
    const hot = [0.01, 0.01, 0.9, 0.05, 0.9, 0.05, 0.9, 0.05, 0.9, 0.01, 0.01, 0.01, 0.01, 0.01];
    const { map, sentences } = mapOf(hot);
    const spans = buildSpans(map);
    expect(spans).toHaveLength(1);
    expect([spans[0].unitFrom, spans[0].unitTo]).toEqual([2, 8]);
    const { windows } = rankFromRatingMap(map, sentences, PLAN);
    expect(windows).toHaveLength(1);
    expect(picketFenceCount(windows.map((w) => ({ start: sentences[w.contextFrom].start, end: sentences[w.contextTo].end })))).toBe(0);
  });

  it('merges category-blind: a hate unit next to a conspiracy unit is one span with both categories', () => {
    const { map } = mapOf([0.01, 0.9, 0.9, 0.01, 0.01, 0.01], { cat: (i) => (i === 2 ? 1 : 0) });
    const spans = buildSpans(map);
    expect(spans).toHaveLength(1);
    expect(spans[0].categories.map((c) => c.category).sort()).toEqual(['conspiracy', 'hate']);
  });

  it('post-merge joins runs separated by one unit or <= 5 s, and keeps distant runs apart', () => {
    const units = sentencesOf(12).map((s, i) => ({ index: i, text: s.text, sentenceFrom: i, sentenceTo: i, start: s.start, end: s.end }));
    const path = [0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0];
    expect(mergedRuns(path, units, DEFAULT_SPAN_PARAMS)).toEqual([
      [1, 3],
      [8, 9],
    ]);
  });

  it('no picket fence across a random long transcript at default params', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const hot = Array.from({ length: 800 }, () => {
      const r = rnd();
      return r < 0.8 ? r * 0.05 : r < 0.9 ? 0.2 + rnd() * 0.3 : 0.6 + rnd() * 0.4;
    });
    const { map, sentences } = mapOf(hot);
    const { windows, overflow } = rankFromRatingMap(map, sentences, PLAN, { ...DEFAULT_SPAN_PARAMS, minVerifyCalls: 10_000 });
    expect(overflow).toHaveLength(0);
    // What gets STORED is a window's fired range (buildWindowSections). Sections
    // from different spans never sit < 5 s apart; sub-passages of one long span
    // share an id and are stored as one section (plan §5.5).
    const bySpan = new Map<number, { start: number; end: number }>();
    for (const w of windows) {
      const id = w.spanIds[0];
      const r = { start: sentences[w.firedFrom].start, end: sentences[w.firedTo].end };
      const prev = bySpan.get(id);
      bySpan.set(id, prev ? { start: Math.min(prev.start, r.start), end: Math.max(prev.end, r.end) } : r);
    }
    expect(picketFenceCount([...bySpan.values()])).toBe(0);
  });
});

describe('ranking and the co-fire boost', () => {
  it('two categories at 0.9 outrank one at 0.97 (noisy-OR in log space)', () => {
    expect(coFireStrength([0.9, 0.9])).toBeLessThan(coFireStrength([0.97]));
    expect(noisyOr([0.9, 0.9])).toBeGreaterThan(noisyOr([0.97]));
  });

  it('a co-firing span ranks above a stronger single-category span, end to end', () => {
    // span A (units 2-3): hate 0.97 only. span B (units 10-11): hate 0.9 + conspiracy 0.9 via pass 2.
    const hot = [0.01, 0.01, 0.97, 0.97, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.9, 0.9, 0.01, 0.01];
    const p2: Array<Record<string, number>> = hot.map(() => ({}));
    p2[2] = { hate: 0.97 };
    p2[3] = { hate: 0.97 };
    p2[10] = { hate: 0.9, conspiracy: 0.9 };
    p2[11] = { hate: 0.9 };
    const { map, sentences } = mapOf(hot, { p2 });
    const spans = buildSpans(map);
    expect(spans.map((s) => s.unitFrom)).toEqual([10, 2]);
    expect(spans[0].categories.map((c) => c.category)).toEqual(['conspiracy', 'hate']);

    const { windows } = rankFromRatingMap(map, sentences, PLAN);
    expect(windows[0].categories.map((c) => c.category).sort()).toEqual(['conspiracy', 'hate']);
    // Descending noisy-OR, which runRankedFlagStage asserts.
    for (let i = 1; i < windows.length; i++) expect(windows[i].score).toBeLessThanOrEqual(windows[i - 1].score + 1e-12);
  });

  it('keeps categories with s_c >= 0.5 and always the top one', () => {
    const { map } = mapOf([0.01, 0.3, 0.01], { p2: [{}, { hate: 0.3, conspiracy: 0.2 }, {}] });
    const spans = buildSpans(map, { ...DEFAULT_SPAN_PARAMS, tau: -3 });
    expect(spans[0].categories.map((c) => c.category)).toEqual(['hate']);
  });
});

describe('windows, long spans and the verify budget', () => {
  it('maps spans to FlagWindows over sentence indices with propositions and valid ranges', () => {
    const { map, sentences } = mapOf([0.01, 0.01, 0.01, 0.95, 0.01, 0.01, 0.01, 0.01]);
    const { windows } = rankFromRatingMap(map, sentences, PLAN);
    expect(windows).toHaveLength(1);
    const w = windows[0];
    expect([w.firedFrom, w.firedTo]).toEqual([3, 3]);
    expect([w.contextFrom, w.contextTo]).toEqual([1, 5]); // ±2 context, NLI's buildWindows
    expect(w.categories[0]).toMatchObject({ category: 'hate', proposition: PLAN[0].proposition, sentenceIndices: [3], sentenceIndex: 3 });
    expect(w.categories[0].text).toBe(sentences[3].text);
  });

  it('splits a span over 40 s into sub-passages that share the span id', () => {
    const hot = [0.01, ...Array(20).fill(0.9), 0.01]; // 20 hot units x 4 s = 80 s
    const { map, sentences } = mapOf(hot);
    const res = rankFromRatingMap(map, sentences, PLAN);
    expect(res.spans).toHaveLength(1);
    expect(res.passages.length).toBeGreaterThanOrEqual(2);
    for (const p of res.passages) expect(p.end - p.start).toBeLessThanOrEqual(40);
    expect(new Set(res.passages.map((p) => p.id)).size).toBe(1);
  });

  it('budget: max(20, 60/h); whole windows in strength order, the rest is overflow', () => {
    expect(verifyBudget(600, DEFAULT_SPAN_PARAMS)).toBe(20);
    expect(verifyBudget(2 * 3600, DEFAULT_SPAN_PARAMS)).toBe(120);
    const w = (n: number) => ({ categories: Array(n).fill({}) }) as any;
    const { verify, overflow } = applyVerifyBudget([w(2), w(2), w(3), w(1)], 5);
    expect(verify).toHaveLength(2);
    expect(overflow).toHaveLength(2);
    expect(applyVerifyBudget([w(9)], 5).verify).toHaveLength(1);
  });
});

describe('units and chunks', () => {
  it('folds sentences under 4 words forward and keeps segment times', () => {
    const sentences: RankedSentence[] = [
      { start: 0, end: 1, text: 'Yeah.' },
      { start: 1, end: 5, text: 'This is the actual point here.' },
      { start: 5, end: 9, text: 'Another full sentence right here.' },
      { start: 9, end: 10, text: 'Right.' },
    ];
    const units = buildFlagUnits(sentences);
    expect(units.map((u) => [u.sentenceFrom, u.sentenceTo, u.start, u.end])).toEqual([
      [0, 1, 0, 5],
      [2, 2, 5, 9],
      [3, 3, 9, 10], // a short tail stays a unit of its own (submap.py; the builder chapters share)
    ]);
    expect(units[0].text).toBe('Yeah. This is the actual point here.');
  });

  it('splits a run-on into ~30-word pieces that keep their sentence times', () => {
    const text = Array.from({ length: 90 }, (_, i) => `w${i}`).join(' ');
    const units = buildFlagUnits([{ start: 10, end: 70, text }]);
    expect(units).toHaveLength(3);
    for (const u of units) expect([u.sentenceFrom, u.sentenceTo, u.start, u.end]).toEqual([0, 0, 10, 70]);
  });

  it('chunks: one chunk when small; otherwise every unit owned exactly once, with overlap context', () => {
    const units = buildFlagUnits(sentencesOf(1000));
    expect(planFlagChunks(units)).toHaveLength(1);
    const chunks = planFlagChunks(units, { singleChunkMaxTokens: 1000, coreMaxTokens: 800, overlapTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    const owner = new Array(units.length).fill(0);
    for (const c of chunks) {
      for (let i = c.coreFrom; i < c.coreTo; i++) owner[i]++;
      expect(c.contextFrom).toBeLessThanOrEqual(c.coreFrom);
      expect(c.contextTo).toBeGreaterThanOrEqual(c.coreTo);
    }
    expect(owner.every((n) => n === 1)).toBe(true);
    expect(chunks[1].contextFrom).toBeLessThan(chunks[1].coreFrom);
  });
});
