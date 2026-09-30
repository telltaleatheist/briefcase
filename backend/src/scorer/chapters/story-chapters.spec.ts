import { describe, expect, it } from '@jest/globals';

import { ChoiceAnswer, ChoiceQuestion, DecideRequest, DecideResponse, GenerateResult, YesNoAnswer } from '../scorer.types';
import { ChapterNode, leafChapters, nestAnalysisChapters } from './chapter-tree';
import { ChapterScorer } from './snap-chapter.service';
import { PLUG } from './snap-prompts';
import {
  StoryPlan,
  placeStories,
  runStoryChapters,
  storyNeedsScorer,
  storyTreeFromChapters,
  storyUnitRanges,
} from './story-chapters';
import { SnapUnit } from './units';

/**
 * Units say their topic words ("cooking pasta"); an assign answer puts 0.95 on
 * the option whose label's first word the sentence (or passage) contains. The
 * outline comes from the prompt; yes/no (ad checks) says no.
 */
class FakeScorer implements ChapterScorer {
  readonly decides: DecideRequest[] = [];
  readonly prompts: string[] = [];
  constructor(private readonly outline: (prompt: string) => string) {}

  async generate(prompt: string): Promise<GenerateResult> {
    this.prompts.push(prompt);
    return { text: this.outline(prompt), promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' };
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    this.decides.push(req);
    const answers: DecideResponse['answers'] = {};
    for (const q of req.questions) {
      if (q.type === 'yesno') {
        answers[q.name] = {
          type: 'yesno', p: 0.1, options: ['Yes', 'No'], probabilities: { Yes: 0.1, No: 0.9 },
          logProbs: [Math.log(0.1), Math.log(0.9)], rawLogProbs: [Math.log(0.1), Math.log(0.9)], labelMass: 1,
        } as YesNoAnswer;
        continue;
      }
      const cq = q as ChoiceQuestion;
      const text = /(?:Sentence|Passage) from the transcript above: "(.*)"/.exec(cq.instructions)![1].toLowerCase();
      const pick = Math.max(0, cq.options.findIndex((o) => o.description !== PLUG && text.includes(o.description.split(' ')[0].toLowerCase())));
      const m = cq.options.length;
      const probs = cq.options.map((_, k) => (k === pick ? 0.95 : 0.05 / (m - 1)));
      answers[q.name] = {
        type: 'choice', choice: cq.options[pick].name, confidence: 0.95, options: cq.options.map((o) => o.name),
        probabilities: Object.fromEntries(cq.options.map((o, k) => [o.name, probs[k]])),
        logProbs: probs.map(Math.log), rawLogProbs: probs.map(Math.log), labelMass: 0.99,
      } as ChoiceAnswer;
    }
    return { model: 'fake', answers, timingMs: { total: 0, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

/** Units from [words, count] runs, 10 s each, one sentence each. */
function unitsOf(runs: Array<[string, number]>): SnapUnit[] {
  const out: SnapUnit[] = [];
  for (const [words, n] of runs) {
    for (let k = 0; k < n; k++) {
      const i = out.length;
      out.push({ index: i, start: i * 10, end: i * 10 + 10, text: `Some ${words} talk, line ${i}.`, sentenceFrom: i, sentenceTo: i });
    }
  }
  return out;
}

function outlineFor(prompt: string): string {
  const has = (w: string) => prompt.includes(` ${w} `);
  if (has('pasta') && has('sauce')) return 'Pasta\nSauce';
  if (has('train') && has('hotel')) return 'Train\nHotel';
  return '';
}

// Cooking 60 units (pasta 30, sauce 30), a plug 8, travel 60 (train 30, hotel 30).
const UNITS = unitsOf([
  ['cooking pasta', 30],
  ['cooking sauce', 30],
  ['patreon plug', 8],
  ['travel train', 30],
  ['travel hotel', 30],
]);
const STORIES: StoryPlan[] = [
  { title: 'Cooking', startSentence: 0, startSeconds: 0, endSeconds: 600 },
  { title: 'A plug', startSentence: 60, startSeconds: 600, endSeconds: 680 },
  { title: 'Travel', startSentence: 68, startSeconds: 680, endSeconds: 1280 },
];

function expectTiles(nodes: ChapterNode[], parent: { startSeconds: number; endSeconds: number }) {
  expect(nodes[0].startSeconds).toBe(parent.startSeconds);
  expect(nodes[nodes.length - 1].endSeconds).toBe(parent.endSeconds);
  for (let i = 1; i < nodes.length; i++) expect(nodes[i].startSeconds).toBe(nodes[i - 1].endSeconds);
}

describe('chapters inside stories', () => {
  it('each story gets its own snap chapters; a short story is one chapter with no model call; two levels only', async () => {
    const scorer = new FakeScorer(outlineFor);
    const seen: string[] = [];
    const res = await runStoryChapters(scorer, UNITS, STORIES, {
      totalSeconds: 1280,
      onProgress: (p) => seen.push(`${p.story}/${p.stories}`),
    });
    const { tree, flat } = res.tree;
    expect(res.tree.depth).toBe(2);
    expect(tree.map((s) => [s.title, s.level, s.startSeconds, s.endSeconds, s.sentenceRange])).toEqual([
      ['Cooking', 0, 0, 600, [0, 60]],
      ['A plug', 0, 600, 680, [60, 68]],
      ['Travel', 0, 680, 1280, [68, 128]],
    ]);
    expect(tree.map((s) => s.children.map((c) => [c.title, c.level, c.startSeconds, c.endSeconds]))).toEqual([
      [['Pasta', 1, 0, 300], ['Sauce', 1, 300, 600]],
      [['A plug', 1, 600, 680]],
      [['Train', 1, 680, 980], ['Hotel', 1, 980, 1280]],
    ]);
    expectTiles(tree, { startSeconds: 0, endSeconds: 1280 });
    for (const s of tree) expectTiles(s.children, s);
    expect(flat.every((n) => n.level === 0 ? n.parent === null : flat[n.parent!].level === 0)).toBe(true);
    expect(flat.some((n) => n.level > 1)).toBe(false);
    // Two outlines (the plug story asked nothing), each over its own story's text only.
    expect(scorer.prompts).toHaveLength(2);
    expect(scorer.prompts[1]).not.toContain('pasta');
    // The travel story's first question quotes the unit before it (the plug), not "(start of the video)".
    const travelFirst = scorer.decides.find((d) => String(d.state).includes('travel train'))!.questions[0] as ChoiceQuestion;
    expect(travelFirst.instructions).toContain('line 67');
    expect(res.scored).toBe(2);
    expect(res.warnings).toEqual([]);
    expect(seen[0]).toBe('1/3');
    expect(seen[seen.length - 1]).toBe('3/3');
    expect(res.chapters.chapters.map((c) => c.title)).toEqual(['Pasta', 'Sauce', 'A plug', 'Train', 'Hotel']);
  });

  it('the stored rows: stories at level 0, chapters at level 1 with their parent, in preorder', async () => {
    const res = await runStoryChapters(new FakeScorer(outlineFor), UNITS, STORIES, { totalSeconds: 1280 });
    const leaves = leafChapters(res.tree.flat);
    const pass2 = leaves.map((c, i) => ({ sequence: i + 1, start_time: `${c.startSeconds}`, end_time: `${c.endSeconds}`, title: c.title, summary: `about ${c.title}` }));
    const rows = nestAnalysisChapters(pass2, res.tree.flat);
    expect(rows.map((r) => [r.sequence, r.title, r.level, r.parent_sequence ?? null, r.summary])).toEqual([
      [1, 'Cooking', 0, null, ''],
      [2, 'Pasta', 1, 1, 'about Pasta'],
      [3, 'Sauce', 1, 1, 'about Sauce'],
      [4, 'A plug', 0, null, ''],
      [5, 'A plug', 1, 4, 'about A plug'],
      [6, 'Travel', 0, null, ''],
      [7, 'Train', 1, 6, 'about Train'],
      [8, 'Hotel', 1, 6, 'about Hotel'],
    ]);
  });

  it('asks per time window inside each story when windows are on', async () => {
    const scorer = new FakeScorer(outlineFor);
    await runStoryChapters(scorer, UNITS, STORIES, { totalSeconds: 1280, windows: { windowSeconds: 90, stepSeconds: 60 } });
    const assign = scorer.decides.flatMap((d) => d.questions).filter((q) => q.type === 'choice');
    expect(assign.length).toBeGreaterThan(0);
    expect(assign.every((q) => q.name.startsWith('w'))).toBe(true);
  });

  it('a story whose outline is unusable is one chapter, NAMED; on a one-story video it fails as it always did', async () => {
    const scorer = new FakeScorer((p) => (p.includes(' travel ') ? '' : outlineFor(p)));
    const res = await runStoryChapters(scorer, UNITS, STORIES, { totalSeconds: 1280 });
    expect(res.tree.tree[2].children.map((c) => c.title)).toEqual(['Travel']);
    expect(res.warnings).toEqual([expect.stringContaining('Chapters: the outline of story "Travel" (00:11:20) was unusable')]);

    await expect(
      runStoryChapters(new FakeScorer(() => ''), UNITS, [{ title: '', startSentence: 0, startSeconds: 0, endSeconds: 1280 }], { totalSeconds: 1280 }),
    ).rejects.toThrow('outline came back with no items');
  });

  it('a one-story video is chaptered as a whole video, even when short', async () => {
    const units = unitsOf([['cooking pasta', 6], ['cooking sauce', 6]]);
    const scorer = new FakeScorer(outlineFor);
    const res = await runStoryChapters(scorer, units, [{ title: '', startSentence: 0, startSeconds: 0, endSeconds: 120 }], { totalSeconds: 120 });
    expect(scorer.prompts).toHaveLength(1);
    expect(res.tree.tree).toHaveLength(1);
    expect(res.tree.tree[0].children.map((c) => [c.title, c.startSeconds, c.endSeconds])).toEqual([
      ['Pasta', 0, 60],
      ['Sauce', 60, 120],
    ]);
  });
});

describe('placing stories on units', () => {
  it('a story starts at the first unit that reaches its first sentence', () => {
    // Unit 1 folds sentences 1-2; unit 2 is sentence 3.
    const units = [{ sentenceTo: 0 }, { sentenceTo: 2 }, { sentenceTo: 3 }];
    expect(storyUnitRanges(units, [{ startSentence: 0 }, { startSentence: 2 }])).toEqual([[0, 1], [1, 3]]);
  });

  it('a story with no unit of its own joins the one before, named', () => {
    const units = [{ sentenceTo: 0 }, { sentenceTo: 3 }, { sentenceTo: 4 }];
    const placed = placeStories(units, [
      { title: 'A', startSentence: 0, startSeconds: 0, endSeconds: 10 },
      { title: 'B', startSentence: 2, startSeconds: 10, endSeconds: 20 },
      { title: 'C', startSentence: 3, startSeconds: 20, endSeconds: 30 },
    ]);
    expect(placed.stories.map((s) => [s.title, s.endSeconds])).toEqual([['A', 20], ['C', 30]]);
    expect(placed.ranges).toEqual([[0, 1], [1, 3]]);
    expect(placed.warnings).toEqual(['Stories: "B" (00:00:10) holds no whole sentence of its own and was joined to "A".']);
  });

  it('only a story of 3 minutes and 24 units gets a snap run (a one-story video always does)', () => {
    expect(storyNeedsScorer(24, 180, false)).toBe(true);
    expect(storyNeedsScorer(23, 600, false)).toBe(false);
    expect(storyNeedsScorer(100, 179, false)).toBe(false);
    expect(storyNeedsScorer(3, 20, true)).toBe(true);
  });

  it('flat chapters are placed under the stories, cut at story boundaries', () => {
    const tree = storyTreeFromChapters(
      [
        { title: 'S1', startSentence: 0, startSeconds: 0, endSeconds: 100 },
        { title: 'S2', startSentence: 5, startSeconds: 100, endSeconds: 200 },
      ],
      [
        { startSeconds: 0, endSeconds: 60, title: 'a', label: 'a', isAd: false, sentenceRange: [0, 3] },
        { startSeconds: 60, endSeconds: 150, title: 'b', label: 'b', isAd: false, sentenceRange: [3, 7] },
        { startSeconds: 150, endSeconds: 200, title: 'c', label: 'c', isAd: false, sentenceRange: [7, 9] },
      ],
    );
    expect(tree.tree.map((s) => [s.title, s.children.map((c) => [c.title, c.startSeconds, c.endSeconds])])).toEqual([
      ['S1', [['a', 0, 60], ['b', 60, 100]]],
      ['S2', [['b', 100, 150], ['c', 150, 200]]],
    ]);
  });
});
