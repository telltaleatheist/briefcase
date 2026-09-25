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

/** One unit per sentence; each hot unit's mass goes to `cat` (default hate), or `row` gives the whole vector. */
function mapOf(
  hot: number[],
  opts: { seconds?: number; cat?: (i: number) => number; row?: (i: number) => number[] | null } = {},
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
    const given = opts.row?.(i);
    if (given) return given;
    const row = new Array(CATS.length + 1).fill(0);
    row[opts.cat ? opts.cat(i) : 0] = h;
    row[CATS.length] = 1 - h;
    return row;
  });
  return {
    sentences,
    map: {
      version: 2,
      ranker: 'snap-v1',
      model: 'fake',
      layout: 'prefix',
      nonePosition: 'last',
      categories: CATS,
      units,
      chunks: [{ coreFrom: 0, coreTo: units.length, contextFrom: 0, contextTo: units.length }],
      groupSize: 3,
      groupStride: 2,
      groups: [],
      p1,
      labelMass: hot.map(() => 0.9),
      missingLabels: hot.map(() => 0),
    },
  };
}

describe('hotness and per-unit evidence: the rise above the video\'s own level', () => {
  it('a unit\'s evidence is how far P(c) rises above c\'s median in this video, as a share of the headroom', () => {
    const { map } = mapOf([0.1, 0.5, 0.5, 0.5, 0.9]);
    // Median of hate = 0.5: at or below it is 0; 0.9 is (0.9 - 0.5) / 0.5 = 0.8.
    expect(hotness(map).map((h) => +h.toFixed(6))).toEqual([0, 0, 0, 0, 0.8]);
  });

  it('a category the model leans on all video long reads as zero; only its peaks are hot', () => {
    // Every unit "does" hate a little (0.45): the old 1 - P(none) called all of them hot.
    const hot = Array.from({ length: 40 }, (_, i) => (i >= 20 && i < 24 ? 0.9 : 0.45));
    const { map } = mapOf(hot);
    const h = hotness(map);
    expect(h.filter((x) => x > 0.1).length).toBe(4);
    expect(buildSpans(map).map((sp) => [sp.unitFrom, sp.unitTo])).toEqual([[20, 23]]);
  });

  it('per-unit category evidence is per category: two that both rise both carry it', () => {
    const { map } = mapOf([0.01, 0.01, 0.6, 0.01, 0.01], { row: (i) => (i === 2 ? [0.3, 0.3, 0, 0.4] : null) });
    expect(unitCategoryScore(map, 0, 0)).toBe(0);
    expect(unitCategoryScore(map, 2, 0)).toBeCloseTo((0.3 - 0.01) / 0.99, 6);
    expect(unitCategoryScore(map, 2, 1)).toBeCloseTo(0.3, 6);
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

  it('a stretch where the hot mass is split between two categories keeps both; windows come in descending score', () => {
    // span A (units 2-3): all hate. span B (units 10-11): hate and conspiracy share the mass.
    const hot = [0.01, 0.01, 0.97, 0.97, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.9, 0.9, 0.01, 0.01];
    const { map, sentences } = mapOf(hot, { row: (i) => (i === 10 || i === 11 ? [0.45, 0.45, 0, 0.1] : null) });
    const spans = buildSpans(map);
    const b = spans.find((sp) => sp.unitFrom === 10)!;
    expect(b.categories.map((c) => c.category)).toEqual(['conspiracy', 'hate']);
    expect(spans.find((sp) => sp.unitFrom === 2)!.categories.map((c) => c.category)).toEqual(['hate']);

    const { windows } = rankFromRatingMap(map, sentences, PLAN);
    expect(windows).toHaveLength(2);
    // Descending noisy-OR.
    for (let i = 1; i < windows.length; i++) expect(windows[i].score).toBeLessThanOrEqual(windows[i - 1].score + 1e-12);
  });

  it('keeps categories with at least a third of the top one\'s evidence, and always the top one', () => {
    const { map } = mapOf([0.01, 0.35, 0.01], { row: (i) => (i === 1 ? [0.3, 0.05, 0, 0.65] : null) });
    const spans = buildSpans(map, { ...DEFAULT_SPAN_PARAMS, tau: -3 });
    expect(spans[0].categories.map((c) => c.category)).toEqual(['hate']);
    const both = mapOf([0.01, 0.4, 0.01], { row: (i) => (i === 1 ? [0.3, 0.12, 0, 0.58] : null) }).map;
    expect(buildSpans(both, { ...DEFAULT_SPAN_PARAMS, tau: -3 })[0].categories.map((c) => c.category)).toEqual(['hate', 'conspiracy']);
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

  it('a span up to 90 s is one section', () => {
    const hot = [0.01, ...Array(20).fill(0.9), 0.01]; // 20 hot units x 4 s = 80 s
    const { map, sentences } = mapOf(hot);
    const res = rankFromRatingMap(map, sentences, PLAN);
    expect(res.spans).toHaveLength(1);
    expect(res.passages).toHaveLength(1);
  });

  it('a 5-minute flagged stretch becomes sections of about a minute, cut at its quietest points', () => {
    // 75 hot units x 4 s = 300 s, with dips (still hot, never cold enough to break the span) every ~15 units.
    const hot = [0.01, 0.01, ...Array.from({ length: 75 }, (_, i) => (i % 15 === 14 ? 0.35 : 0.9)), 0.01, 0.01, 0.01, 0.01, 0.01];
    const { map, sentences } = mapOf(hot);
    const res = rankFromRatingMap(map, sentences, PLAN);
    expect(res.spans).toHaveLength(1);
    expect(res.passages.length).toBeGreaterThanOrEqual(4);
    for (const p of res.passages) {
      expect(p.end - p.start).toBeLessThanOrEqual(90);
      expect(p.end - p.start).toBeGreaterThanOrEqual(20);
    }
    // Each cut sits at a dip: the unit just before or after a boundary is one of the quiet ones.
    const sorted = [...res.passages].sort((a, b) => a.unitFrom - b.unitFrom);
    for (let k = 1; k < sorted.length; k++) {
      const cut = sorted[k].unitFrom;
      expect(Math.min(hot[cut - 1], hot[cut])).toBeCloseTo(0.35);
    }
  });

  it('a video that really is hate all the way through is flagged all the way through, as sections of about a minute', () => {
    // 150 units x 4 s = 10 min at 0.9 with small dips: the baseline cap (0.5) keeps it evidence.
    const hot = Array.from({ length: 150 }, (_, i) => (i % 15 === 14 ? 0.6 : 0.9));
    const { map, sentences } = mapOf(hot);
    const res = rankFromRatingMap(map, sentences, PLAN);
    expect(res.passages.length).toBeGreaterThanOrEqual(7);
    for (const p of res.passages) expect(p.end - p.start).toBeLessThanOrEqual(90);
    expect(res.passages.reduce((n, p) => n + (p.end - p.start), 0)).toBeGreaterThan(0.9 * 600);
  });

  it('a real-run shape: one category warm all video long, a few true peaks → a few short sections, not a half-hour block', () => {
    // 360 units x 4 s = 24 min. Every unit leans 0.45 to one category (the run that gave three 8-minute
    // sections had 351 of 360 units over the old 1 - P(none) gate); six real peaks of 8-15 units.
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const peaks: Array<[number, number]> = [[20, 28], [60, 74], [130, 138], [200, 211], [260, 268], [330, 342]];
    const hot = Array.from({ length: 360 }, (_, i) => (peaks.some(([a, b]) => i >= a && i <= b) ? 0.85 + rnd() * 0.1 : 0.4 + rnd() * 0.1));
    const { map, sentences } = mapOf(hot);
    const res = rankFromRatingMap(map, sentences, PLAN);
    expect(res.passages.length).toBeGreaterThanOrEqual(6);
    expect(res.passages.length).toBeLessThanOrEqual(12);
    for (const p of res.passages) expect(p.end - p.start).toBeLessThanOrEqual(90);
    const covered = res.passages.reduce((n, p) => n + (p.end - p.start), 0);
    expect(covered).toBeLessThan(0.4 * 360 * 4);
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
