import { describe, expect, it } from '@jest/globals';

import { ChoiceAnswer, ChoiceQuestion, DecideRequest, DecideResponse, GenerateResult, YesNoAnswer } from '../scorer.types';
import {
  ChapterNode,
  RefineProgress,
  childrenOf,
  flattenChapterTree,
  leafChapters,
  mayRefine,
  nestAnalysisChapters,
  refineChapters,
  runSnapChapterTree,
} from './chapter-tree';
import { ChapterProgress, ChapterScorer, runSnapChapters } from './snap-chapter.service';
import { PLUG } from './snap-prompts';
import { SnapChapter } from './segmenter';
import { SentenceUnit } from './units';

/**
 * Units carry up to three topic words, one per level ("cooking pasta boil").
 * Each assign answer puts 0.999 on the option whose label's first word the
 * sentence contains ("sponsor" picks the plug). The outline is chosen from the
 * prompt by `outline`; the yes/no says 0.9.
 */
class FakeScorer implements ChapterScorer {
  readonly decides: DecideRequest[] = [];
  readonly prompts: string[] = [];
  onGenerate?: (n: number) => void;
  constructor(private readonly outline: (prompt: string) => string) {}

  async generate(prompt: string): Promise<GenerateResult> {
    this.prompts.push(prompt);
    this.onGenerate?.(this.prompts.length);
    return { text: this.outline(prompt), promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' };
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    this.decides.push(req);
    const answers: DecideResponse['answers'] = {};
    for (const q of req.questions) {
      if (q.type === 'yesno') {
        answers[q.name] = {
          type: 'yesno', p: 0.9, options: ['Yes', 'No'], probabilities: { Yes: 0.9, No: 0.1 },
          logProbs: [Math.log(0.9), Math.log(0.1)], rawLogProbs: [Math.log(0.9), Math.log(0.1)], labelMass: 1,
        } as YesNoAnswer;
        continue;
      }
      const cq = q as ChoiceQuestion;
      const sentence = /^Sentence from the transcript above: "(.*)"\n/.exec(cq.instructions)![1].toLowerCase();
      const topic = cq.options.findIndex((o) => o.description !== PLUG && sentence.includes(o.description.split(' ')[0].toLowerCase()));
      const plug = cq.options.findIndex((o) => o.description === PLUG);
      const pick = plug >= 0 && sentence.includes('sponsor') ? plug : topic;
      const m = cq.options.length;
      const probs = cq.options.map((_, k) => (pick < 0 ? 1 / m : k === pick ? 0.999 : 0.001 / (m - 1)));
      answers[q.name] = {
        type: 'choice', choice: cq.options[Math.max(0, pick)].name, confidence: Math.max(...probs),
        options: cq.options.map((o) => o.name),
        probabilities: Object.fromEntries(cq.options.map((o, k) => [o.name, probs[k]])),
        logProbs: probs.map(Math.log), rawLogProbs: probs.map(Math.log), labelMass: 0.99,
      } as ChoiceAnswer;
    }
    return { model: 'fake', answers, timingMs: { total: 0, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

/** Units from [words, count] runs; 10 s each. */
function unitsOf(runs: Array<[string, number]>): SentenceUnit[] {
  const out: SentenceUnit[] = [];
  for (const [words, n] of runs) {
    for (let k = 0; k < n; k++) {
      const i = out.length;
      out.push({ start: i * 10 + 1, end: i * 10 + 9, text: `Some ${words} talk, line ${i}.` });
    }
  }
  return out;
}

/** Outline by what the prompt's transcript contains. */
function outlineFor(prompt: string): string {
  const has = (w: string) => prompt.includes(` ${w} `);
  if (has('travel') && has('cooking')) return 'Cooking\nTravel';
  if (has('pasta') && has('sauce')) return 'Pasta\nSauce';
  if (has('train') && has('hotel')) return 'Train\nHotel';
  if (has('boil') && has('drain')) return 'Boil water\nDrain it';
  return 'Everything'; // one item: OutlineError
}

// Cooking 60 (pasta 30 = boil 15 + drain 15, sauce 30), sponsor 8, travel 60 (train 30, hotel 30): 128 units.
const VIDEO: Array<[string, number]> = [
  ['cooking pasta boil', 15],
  ['cooking pasta drain', 15],
  ['cooking sauce', 30],
  ['sponsor read', 8],
  ['travel train', 30],
  ['travel hotel', 30],
];

/** Children tile the parent exactly, in seconds and in units, recursively. */
function expectTiles(nodes: ChapterNode[], parent: { startSeconds: number; endSeconds: number; sentenceRange: [number, number] }) {
  expect(nodes[0].startSeconds).toBe(parent.startSeconds);
  expect(nodes[nodes.length - 1].endSeconds).toBe(parent.endSeconds);
  expect(nodes[0].sentenceRange[0]).toBe(parent.sentenceRange[0]);
  expect(nodes[nodes.length - 1].sentenceRange[1]).toBe(parent.sentenceRange[1]);
  for (let i = 1; i < nodes.length; i++) {
    expect(nodes[i].startSeconds).toBe(nodes[i - 1].endSeconds);
    expect(nodes[i].sentenceRange[0]).toBe(nodes[i - 1].sentenceRange[1]);
    expect(nodes[i].endSeconds).toBeGreaterThan(nodes[i].startSeconds);
  }
  for (const n of nodes) if (n.children.length) expectTiles(n.children, n);
}

const LONG = { longUnits: 20, longSeconds: 1e9, minUnits: 4 };

describe('refineChapters / runSnapChapterTree (fake scorer)', () => {
  it('a video below the default thresholds is byte-identical to runSnapChapters: same requests, same progress, a flat tree', async () => {
    // 88 units over 880 s: under 120 units and 15 minutes.
    const units = unitsOf([['cooking', 40], ['sponsor read', 8], ['travel', 40]]);
    const flat = new FakeScorer(outlineFor);
    const seenFlat: ChapterProgress[] = [];
    const want = await runSnapChapters(flat, units, { onProgress: (p) => seenFlat.push({ ...p }) });

    const tree = new FakeScorer(outlineFor);
    const seenTree: ChapterProgress[] = [];
    const got = await runSnapChapterTree(tree, units, { onProgress: (p) => seenTree.push({ ...p }) });
    expect(mayRefine(units.length, units[87].end)).toBe(false);
    expect(want.chapters).toHaveLength(3);
    expect(JSON.stringify(tree.decides)).toBe(JSON.stringify(flat.decides));
    expect(tree.prompts).toEqual(flat.prompts);
    expect(seenTree).toEqual(seenFlat);
    expect(got.base.chapters).toEqual(want.chapters);
    expect(got.tree.depth).toBe(1);
    expect(got.tree.refined).toBe(0);
    expect(got.tree.flat.map((c) => [c.title, c.level, c.parent, c.isLeaf])).toEqual(
      want.chapters.map((c) => [c.title, 0, null, true]),
    );
  });

  it('refines long sections with the section as the state, no ad option below level 0, and children tile their parent', async () => {
    const units = unitsOf(VIDEO);
    const fake = new FakeScorer(outlineFor);
    const { base, tree } = await runSnapChapterTree(fake, units, { refine: { ...LONG, maxDepth: 2 } });

    expect(base.chapters.map((c) => [c.title, c.sentenceRange])).toEqual([
      ['Cooking', [0, 60]],
      ['Sponsor / self-promotion', [60, 68]],
      ['Travel', [68, 128]],
    ]);
    expect(tree.depth).toBe(2);
    expect(tree.refined).toBe(2); // Cooking and Travel; the ad is never refined
    expect(tree.tree.map((n) => [n.title, n.children.map((c) => [c.title, c.level, c.sentenceRange])])).toEqual([
      ['Cooking', [['Pasta', 1, [0, 30]], ['Sauce', 1, [30, 60]]]],
      ['Sponsor / self-promotion', []],
      ['Travel', [['Train', 1, [68, 98]], ['Hotel', 1, [98, 128]]]],
    ]);
    expectTiles(tree.tree, { startSeconds: 0, endSeconds: units[127].end, sentenceRange: [0, 128] });

    // The Cooking refinement: its own outline prompt and its own state, no plug, no yes/no.
    const section = units.slice(0, 60).map((u) => u.text).join('\n');
    expect(fake.prompts[1]).toContain(section);
    expect(fake.prompts[1]).not.toContain(units[60].text);
    const cooking = fake.decides.filter((d) => d.state === section);
    expect(cooking.length).toBe(1);
    expect((cooking[0].questions[0] as ChoiceQuestion).options.map((o) => o.description)).toEqual(['Pasta', 'Sauce']);
    // Travel's first question quotes the real unit before the section.
    const travel = fake.decides.find((d) => d.state === units.slice(68).map((u) => u.text).join('\n'))!;
    expect(travel.questions[0].instructions).toContain(`(The sentence just before it: "${units[67].text}")`);
    // Only level 0 asked about ads.
    const yesnos = fake.decides.filter((d) => d.questions[0].type === 'yesno');
    expect(yesnos).toHaveLength(1);
    expect(yesnos[0].state).toBe(units.map((u) => u.text).join('\n'));
    const sub = fake.decides.filter((d) => d.state !== yesnos[0].state);
    for (const d of sub) for (const q of d.questions) expect((q as ChoiceQuestion).options.some((o) => o.description === PLUG)).toBe(false);
  });

  it('recurses while sections stay long, up to maxDepth', async () => {
    const units = unitsOf(VIDEO);
    const three = new FakeScorer(outlineFor);
    const { tree } = await runSnapChapterTree(three, units, { refine: { ...LONG, maxDepth: 3 } });
    expect(tree.depth).toBe(3);
    const pasta = tree.tree[0].children[0];
    expect(pasta.children.map((c) => [c.title, c.level, c.sentenceRange])).toEqual([
      ['Boil water', 2, [0, 15]],
      ['Drain it', 2, [15, 30]],
    ]);
    // Sauce, Train and Hotel got a one-item sub-outline: leaves.
    expect(tree.tree[0].children[1].children).toEqual([]);
    expect(tree.tree[2].children.every((c) => c.children.length === 0)).toBe(true);
    // 1 level-0 outline + 2 at level 1 + 4 at level 2.
    expect(three.prompts).toHaveLength(7);
    expectTiles(tree.tree, { startSeconds: 0, endSeconds: units[127].end, sentenceRange: [0, 128] });

    // maxDepth 1: never refines.
    const one = new FakeScorer(outlineFor);
    const r1 = await runSnapChapterTree(one, units, { refine: { ...LONG, maxDepth: 1 } });
    expect(r1.tree.depth).toBe(1);
    expect(one.prompts).toHaveLength(1);
  });

  it('stops at the size thresholds: a section at or under them stays a leaf', async () => {
    const units = unitsOf(VIDEO);
    // 60-unit sections, threshold 60: not long (strictly more is needed). Seconds threshold off.
    const fake = new FakeScorer(outlineFor);
    const { tree } = await runSnapChapterTree(fake, units, { refine: { longUnits: 60, longSeconds: 1e9, minUnits: 4 } });
    expect(tree.depth).toBe(1);
    expect(tree.refined).toBe(0);
    expect(fake.prompts).toHaveLength(1);
    // The seconds rule alone: 600 s sections over a 500 s threshold are refined...
    const bySeconds = await runSnapChapterTree(new FakeScorer(outlineFor), units, {
      refine: { longUnits: 1000, longSeconds: 500, minUnits: 4, maxDepth: 2 },
    });
    expect(bySeconds.tree.refined).toBe(2);
    // ...but never under minUnits.
    const sparse = await runSnapChapterTree(new FakeScorer(outlineFor), units, {
      refine: { longUnits: 1000, longSeconds: 500, minUnits: 61 },
    });
    expect(sparse.tree.refined).toBe(0);
  });

  it('a one-item sub-outline, or a sub-path of one run, leaves the section a leaf', async () => {
    const units = unitsOf(VIDEO);
    const oneItem = await runSnapChapterTree(
      new FakeScorer((p) => (p.includes(' travel ') && p.includes(' cooking ') ? 'Cooking\nTravel' : 'Only one')),
      units,
      { refine: LONG },
    );
    expect(oneItem.tree.refined).toBe(2);
    expect(oneItem.tree.depth).toBe(1);
    expect(oneItem.tree.flat.every((c) => c.isLeaf)).toBe(true);

    // Two sub-items, but every sentence picks the first: one run, no children.
    const oneRun = await runSnapChapterTree(
      new FakeScorer((p) => (p.includes(' travel ') && p.includes(' cooking ') ? 'Cooking\nTravel' : 'Some\nNothing')),
      units,
      { refine: LONG },
    );
    expect(oneRun.tree.depth).toBe(1);
  });

  it('reports monotone progress across levels, ending at 1', async () => {
    const units = unitsOf(VIDEO);
    const events: RefineProgress[] = [];
    const level0: ChapterProgress[] = [];
    await runSnapChapterTree(new FakeScorer(outlineFor), units, {
      onProgress: (p) => level0.push({ ...p }),
      refine: { ...LONG, maxDepth: 3, onProgress: (p) => events.push({ ...p }) },
    });
    // Level 0 is scaled into the first half.
    expect(Math.max(...level0.map((p) => p.fraction))).toBeLessThanOrEqual(0.5);
    for (let i = 1; i < events.length; i++) expect(events[i].fraction).toBeGreaterThanOrEqual(events[i - 1].fraction);
    expect(events.some((e) => e.level === 1)).toBe(true);
    expect(events.some((e) => e.level === 2)).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', fraction: 1 });
    const l1 = events.filter((e) => e.level === 1 && e.phase !== 'done');
    expect(l1[l1.length - 1].fraction).toBeCloseTo(0.5); // level 1 of 3 takes half the refinement band
    expect(l1[0].sections).toBe(2);
    expect(l1[l1.length - 1].unitsDone).toBe(120);
  });

  it('stops mid-recursion when the signal fires, and throws cancelled', async () => {
    const units = unitsOf(VIDEO);
    const fake = new FakeScorer(outlineFor);
    const ac = new AbortController();
    const run = runSnapChapterTree(fake, units, {
      signal: ac.signal,
      refine: {
        ...LONG,
        maxDepth: 3,
        onProgress: (p) => {
          if (p.level === 1 && p.section === 2 && p.phase === 'assign') ac.abort();
        },
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    // Level 0 + Cooking + Travel's outline, and nothing at level 2.
    expect(fake.prompts).toHaveLength(3);
  });

  it('an engine error in a refinement propagates (the caller keeps the flat chapters)', async () => {
    const units = unitsOf(VIDEO);
    const fake = new FakeScorer(outlineFor);
    const base = await runSnapChapters(fake, units);
    fake.decide = async () => {
      throw new Error('engine gone');
    };
    await expect(refineChapters(fake, units, base, LONG)).rejects.toThrow('engine gone');
  });
});

describe('childrenOf', () => {
  const units = unitsOf([['a', 10]]);
  const parent: ChapterNode = {
    startSeconds: 0, endSeconds: 100, title: 'P', label: 'P', level: 0, isAd: false, sentenceRange: [0, 10], children: [],
  };
  const ch = (label: string, a: number, b: number): SnapChapter => ({
    startSeconds: 0, endSeconds: 0, title: label, label, sentenceRange: [a, b], isAd: false,
  });

  it('tiles the parent and drops zero-length children into a neighbour', () => {
    const tied = units.map((u, i) => (i === 5 || i === 6 ? { ...u, start: 51 } : u));
    const kids = childrenOf(parent, [ch('A', 0, 5), ch('B', 5, 6), ch('C', 6, 10)], tied);
    expect(kids.map((k) => [k.label, k.startSeconds, k.endSeconds, k.sentenceRange])).toEqual([
      ['A', 0, 51, [0, 6]],
      ['C', 51, 100, [6, 10]],
    ]);
  });

  it('joins neighbours left with the same label', () => {
    const tied = units.map((u, i) => (i === 3 ? { ...u, start: 41 } : u));
    const kids = childrenOf(parent, [ch('A', 0, 3), ch('B', 3, 4), ch('A', 4, 10)], tied);
    expect(kids.map((k) => [k.label, k.startSeconds, k.endSeconds, k.sentenceRange])).toEqual([['A', 0, 100, [0, 10]]]);
  });
});

describe('flattening', () => {
  const node = (title: string, s: number, e: number, level: number, children: ChapterNode[] = []): ChapterNode => ({
    startSeconds: s, endSeconds: e, title, label: title, level, isAd: false, sentenceRange: [s, e], children,
  });
  const tree = [
    node('A', 0, 60, 0, [node('A1', 0, 30, 1, [node('A1a', 0, 10, 2), node('A1b', 10, 30, 2)]), node('A2', 30, 60, 1)]),
    node('B', 60, 90, 0),
  ];

  it('is preorder, with parent indices and leaves that tile the video', () => {
    const flat = flattenChapterTree(tree);
    expect(flat.map((c) => [c.index, c.title, c.level, c.parent, c.isLeaf])).toEqual([
      [0, 'A', 0, null, false],
      [1, 'A1', 1, 0, false],
      [2, 'A1a', 2, 1, true],
      [3, 'A1b', 2, 1, true],
      [4, 'A2', 1, 0, true],
      [5, 'B', 0, null, true],
    ]);
    const leaves = leafChapters(flat);
    expect(leaves.map((c) => [c.startSeconds, c.endSeconds])).toEqual([[0, 10], [10, 30], [30, 60], [60, 90]]);
  });

  it('nests the per-leaf analysis rows under outline parents, renumbered in preorder', () => {
    const flat = flattenChapterTree(tree);
    const rows = [
      { sequence: 1, start_time: '00:00:00', end_time: '00:00:10', title: 'A1a', summary: 's1' },
      { sequence: 2, start_time: '00:00:10', end_time: '00:00:30', title: '', summary: '', failed: true },
      // leaf 3 (A2) was skipped by Pass 2
      { sequence: 4, start_time: '00:01:00', end_time: '00:01:30', title: 'B', summary: 's4' },
    ];
    expect(nestAnalysisChapters(rows, flat)).toEqual([
      { sequence: 1, start_time: '00:00:00', end_time: '00:01:00', title: 'A', summary: '', level: 0 },
      { sequence: 2, start_time: '00:00:00', end_time: '00:00:30', title: 'A1', summary: '', level: 1, parent_sequence: 1 },
      { sequence: 3, start_time: '00:00:00', end_time: '00:00:10', title: 'A1a', summary: 's1', level: 2, parent_sequence: 2 },
      { sequence: 4, start_time: '00:00:10', end_time: '00:00:30', title: '', summary: '', failed: true, level: 2, parent_sequence: 2 },
      { sequence: 5, start_time: '00:01:00', end_time: '00:01:30', title: 'B', summary: 's4', level: 0 },
    ]);
  });
});
