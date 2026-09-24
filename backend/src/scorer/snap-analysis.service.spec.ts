import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { AnalysisCancelledError, isCancellation } from '../analysis/cancellation';
import { SnapFlagRanker } from './flags/snap-flag-ranker.service';
import type { CrucibleScorerService } from './crucible-scorer.service';
import { SnapAnalysisService, SnapEngineError, SnapStageProgress } from './snap-analysis.service';
import type { ScorerHandle } from './scorer-handle';
import {
  ChoiceAnswer,
  ChoiceQuestion,
  DecideRequest,
  DecideResponse,
  GenerateResult,
  ScorerError,
  YesNoAnswer,
} from './scorer.types';

/** Chapters: sentences mentioning a section's first word pick it. Flags: "communists" is demonization. */
class FakeHandle {
  readonly decides: DecideRequest[] = [];
  generates = 0;
  outline = 'Cooking pasta\nTravel plans';
  /** Per-prompt outline (refinement tests); falls back to `outline`. */
  outlineFor?: (prompt: string) => string;
  failOn?: (req: DecideRequest, n: number) => Error | null;
  onDecide?: (n: number) => void;
  /** Mark answers as under the label-mass gate (flattened, no evidence). */
  gate?: (questionName: string) => boolean;

  handle(): ScorerHandle {
    return {
      decide: (req, o) => this.decide(req, o),
      generate: async (prompt: string) => {
        this.generates++;
        return { text: this.outlineFor ? this.outlineFor(prompt) : this.outline, promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' } as GenerateResult;
      },
      model: 'fake-qwen',
      countTokens: async (t: string) => Math.ceil(t.length / 4),
    };
  }

  async decide(req: DecideRequest, o: { signal?: AbortSignal } = {}): Promise<DecideResponse> {
    if (o.signal?.aborted) throw new ScorerError('cancelled', 'cancelled by the caller');
    this.decides.push(req);
    this.onDecide?.(this.decides.length);
    const err = this.failOn?.(req, this.decides.length);
    if (err) throw err;
    const answers: DecideResponse['answers'] = {};
    for (const q of req.questions) {
      if (q.type === 'yesno') {
        const a: YesNoAnswer = {
          type: 'yesno', p: 0.1, options: ['Yes', 'No'], probabilities: { Yes: 0.1, No: 0.9 },
          logProbs: [Math.log(0.1), Math.log(0.9)], rawLogProbs: [Math.log(0.1), Math.log(0.9)], labelMass: 1,
        };
        answers[q.name] = a;
        continue;
      }
      const cq = q as ChoiceQuestion;
      const sentence = /Sentence from the transcript above: "(.*)"/.exec(cq.instructions)![1].toLowerCase();
      const names = cq.options.map((o) => o.name);
      let pick: number;
      if (cq.name.startsWith('p1:')) pick = sentence.includes('communists') ? names.indexOf('political-demonization') : names.indexOf('none');
      else if (cq.name.startsWith('p2:')) pick = 0;
      else {
        // Topic sections only (never the ad/plug item): an unmatched sentence leans to section 1.
        const topic = (d: string) => !d.startsWith('An ad') && sentence.includes(d.split(' ')[0].toLowerCase());
        pick = Math.max(0, cq.options.findIndex((opt) => topic(opt.description)));
      }
      const probs = names.map((_, k) => (k === pick ? 0.95 : 0.05 / (names.length - 1)));
      const a: ChoiceAnswer = {
        type: 'choice', choice: names[pick], confidence: 0.95, options: names,
        probabilities: Object.fromEntries(names.map((n, k) => [n, probs[k]])),
        logProbs: probs.map(Math.log), rawLogProbs: probs.map(Math.log), labelMass: 0.99,
      };
      answers[q.name] = this.gate?.(q.name) ? { ...a, gated: true } : a;
    }
    return { model: 'fake-qwen', answers, timingMs: { total: 1, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

/** Crucible's scorer seam, faked: one lease per `withScorer`. */
function fakeServer(fake: FakeHandle, startError?: Error) {
  let leases = 0;
  const server = {
    withScorer: async <T>(fn: (h: ScorerHandle) => Promise<T>) => {
      leases++;
      if (startError) throw startError;
      return fn(fake.handle());
    },
  };
  return { server: server as unknown as CrucibleScorerService, leases: () => leases };
}

function segments() {
  const lines = [
    'Cooking pasta starts with a big pot of salted water.',
    'Cooking the sauce takes about twenty minutes on low heat.',
    'Those people are communists and enemies of this country.',
    'Travel plans for the summer start with the train tickets.',
    'Travel by train through the mountains is the best part.',
    'Travel home again is always the saddest bit of the trip.',
  ];
  return lines.map((text, i) => ({ start: i * 10, end: i * 10 + 10, text }));
}

const CATEGORIES = [{ name: 'political-demonization' }, { name: 'conspiracy' }];

describe('SnapAnalysisService', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('runs chapters then flags in ONE scorer lease over one transcript, with monotonic progress', async () => {
    const fake = new FakeHandle();
    const { server, leases } = fakeServer(fake);
    const events: SnapStageProgress[] = [];
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(),
      categories: CATEGORIES,
      chapters: true,
      flags: true,
      chapterOptions: { switchCost: 2 },
      onProgress: (p) => events.push(p),
    });
    expect(leases()).toBe(1);
    expect(res.model).toBe('fake-qwen');
    expect(res.labelMassGated).toEqual({ chapters: 0, flags: 0, refine: 0, total: 0 });
    expect(res.chapters!.chapters.map((c) => c.title)).toEqual(['Cooking pasta', 'Travel plans']);
    expect(res.chapters!.chapters[1].startSeconds).toBe(30);
    expect(res.flags!.windows.map((w) => w.categories[0].category)).toEqual(['political-demonization']);
    // Both passes asked about the same units.
    expect(res.flags!.ratingMap.units).toBe(res.transcript!.units);
    for (let i = 1; i < events.length; i++) expect(events[i].fraction).toBeGreaterThanOrEqual(events[i - 1].fraction);
    expect(events[events.length - 1]).toMatchObject({ stage: 'done', fraction: 1 });
    expect(events.some((e) => e.stage === 'chapters')).toBe(true);
    expect(events.some((e) => e.stage === 'flags')).toBe(true);
  });

  it('a scorer that cannot start fails the run BY NAME: there is no other engine', async () => {
    const fake = new FakeHandle();
    const { server } = fakeServer(fake, new ScorerError('engine_unreachable', 'Crucible "mac" stayed busy'));
    const err = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapEngineError);
    expect((err as SnapEngineError).stage).toBe('start');
    expect((err as Error).message).toMatch(/stayed busy/);
  });

  it('a one-item outline (a single-topic video) is one chapter spanning the video; flags still run', async () => {
    const fake = new FakeHandle();
    fake.outline = 'Just one section';
    const { server } = fakeServer(fake);
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    });
    expect(res.chapters!.chapters.map((c) => [c.title, c.startSeconds])).toEqual([['Just one section', 0]]);
    expect(res.flags!.windows.length).toBe(1);
  });

  it('an outline with no usable item fails the chapters BY NAME', async () => {
    const fake = new FakeHandle();
    fake.outline = '\n - \n';
    const { server } = fakeServer(fake);
    const err = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapEngineError);
    expect((err as SnapEngineError).stage).toBe('chapters');
    expect((err as Error).message).toMatch(/outline was unusable/);
  });

  it('an engine error during chaptering fails the run by name and asks nothing more', async () => {
    const fake = new FakeHandle();
    fake.failOn = () => new ScorerError('engine_unreachable', 'POST /v1/decide: connection refused');
    const { server } = fakeServer(fake);
    const err = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapEngineError);
    expect((err as Error).message).toMatch(/connection refused/);
    expect(fake.decides).toHaveLength(1);
  });

  it('a flag-pass engine error fails the run by name (the chapters are not shipped without their flags)', async () => {
    const fake = new FakeHandle();
    fake.failOn = (req) => (req.questions[0].name.startsWith('p1:') ? new ScorerError('engine_error', 'boom') : null);
    const { server } = fakeServer(fake);
    const err = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapEngineError);
    expect((err as SnapEngineError).stage).toBe('flags');
    expect((err as Error).message).toMatch(/boom/);
  });

  it('answers under the label-mass gate are counted per pass, never silently', async () => {
    const fake = new FakeHandle();
    fake.gate = (name) => name === 's0' || name.startsWith('p1:');
    const { server } = fakeServer(fake);
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    });
    expect(res.labelMassGated.chapters).toBe(1);
    expect(res.labelMassGated.flags).toBe(res.transcript!.units.length);
    expect(res.labelMassGated.total).toBe(res.labelMassGated.chapters + res.labelMassGated.flags);
  });

  it('cancel during chaptering throws a cancellation and asks nothing more', async () => {
    const fake = new FakeHandle();
    const controller = new AbortController();
    fake.onDecide = (n) => n === 1 && controller.abort();
    const { server } = fakeServer(fake);
    const err = await new SnapAnalysisService(server, new SnapFlagRanker())
      .run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: true, signal: controller.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnalysisCancelledError);
    expect(isCancellation(err)).toBe(true);
    expect(fake.decides.every((d) => !d.questions[0].name.startsWith('p1:'))).toBe(true);
  });

  it("an aborted in-flight request (the scorer's own 'cancelled') is a cancellation, not a failure", async () => {
    const fake = new FakeHandle();
    const controller = new AbortController();
    fake.failOn = () => {
      controller.abort();
      return new ScorerError('cancelled', 'decide was cancelled');
    };
    const { server } = fakeServer(fake);
    const err = await new SnapAnalysisService(server, new SnapFlagRanker())
      .run({ segments: segments(), categories: CATEGORIES, chapters: false, flags: true, signal: controller.signal })
      .catch((e) => e);
    expect(isCancellation(err)).toBe(true);
  });

  describe('outline refinement', () => {
    /** 31 units: a communists line, 10 boil, 10 sauce (Cooking), 10 travel. */
    function longSegments() {
      const lines = [
        'Those people are communists and enemies of this country.',
        ...Array.from({ length: 10 }, (_, i) => `Cooking pasta means you boil the water well, step ${i}.`),
        ...Array.from({ length: 10 }, (_, i) => `Cooking the sauce means stirring it slowly, step ${i}.`),
        ...Array.from({ length: 10 }, (_, i) => `Travel plans need train tickets booked early, step ${i}.`),
      ];
      return lines.map((text, i) => ({ start: i * 10, end: i * 10 + 10, text }));
    }
    const outlineFor = (p: string) =>
      p.includes('Travel') && p.includes('Cooking') ? 'Cooking pasta\nTravel plans' : p.includes('boil') ? 'Boil water\nSauce stirring' : 'Just one';
    const REFINE = { longUnits: 8, longSeconds: 1e9, minUnits: 4, maxDepth: 2 };

    it('refines long chapters AFTER the flag pass, on the section state, with monotone progress', async () => {
      const fake = new FakeHandle();
      fake.outlineFor = outlineFor;
      const { server, leases } = fakeServer(fake);
      const events: SnapStageProgress[] = [];
      const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
        segments: longSegments(), categories: CATEGORIES, chapters: true, flags: true,
        refineOptions: REFINE, onProgress: (p) => events.push(p),
      });
      expect(leases()).toBe(1);
      expect(res.chapterTreeError).toBeUndefined();
      const tree = res.chapterTree!;
      expect(tree.depth).toBe(2);
      expect(tree.flat.map((c) => [c.title, c.level, c.isLeaf])).toEqual([
        ['Cooking pasta', 0, false],
        ['Boil water', 1, true],
        ['Sauce stirring', 1, true],
        ['Travel plans', 0, true],
      ]);
      const units = res.transcript!.units;
      const cooking = units.slice(0, 21).map((u) => u.text).join('\n');
      const firstRefine = fake.decides.findIndex((d) => d.state === cooking);
      const lastFlag = fake.decides.map((d) => d.questions[0].name.startsWith('p')).lastIndexOf(true);
      expect(firstRefine).toBeGreaterThan(lastFlag);
      for (let i = 1; i < events.length; i++) expect(events[i].fraction).toBeGreaterThanOrEqual(events[i - 1].fraction);
      expect(events.some((e) => e.stage === 'refine')).toBe(true);
      expect(events[events.length - 1]).toMatchObject({ stage: 'done', fraction: 1 });
    });

    it('a short video runs no refinement and gets a flat one-level tree', async () => {
      const fake = new FakeHandle();
      const { server } = fakeServer(fake);
      const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
        segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
      });
      expect(fake.generates).toBe(1);
      expect(res.chapterTree!.flat.map((c) => [c.title, c.level, c.isLeaf])).toEqual([
        ['Cooking pasta', 0, true],
        ['Travel plans', 0, true],
      ]);
    });

    it('a refinement engine error keeps the top-level chapters and says why', async () => {
      const fake = new FakeHandle();
      fake.outlineFor = outlineFor;
      const { server } = fakeServer(fake);
      let cookingState = '';
      fake.failOn = (req) => (cookingState && req.state === cookingState ? new ScorerError('engine_error', 'boom') : null);
      const units = (await import('./chapters/units')).assembleUnits(longSegments());
      cookingState = units.slice(0, 21).map((u) => u.text).join('\n');
      const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
        segments: longSegments(), categories: CATEGORIES, chapters: true, flags: true, refineOptions: REFINE,
      });
      expect(res.chapterTreeError).toMatch(/refinement failed: .*boom/);
      expect(res.chapters!.chapters).toHaveLength(2);
      expect(res.chapterTree!.depth).toBe(1);
      expect(res.flags).not.toBeNull();
    });

    it('cancel during refinement throws a cancellation', async () => {
      const fake = new FakeHandle();
      fake.outlineFor = outlineFor;
      const controller = new AbortController();
      const { server } = fakeServer(fake);
      const err = await new SnapAnalysisService(server, new SnapFlagRanker())
        .run({
          segments: longSegments(), categories: CATEGORIES, chapters: true, flags: true, refineOptions: REFINE,
          signal: controller.signal,
          onProgress: (p) => p.stage === 'refine' && controller.abort(),
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AnalysisCancelledError);
    });
  });

  it('flags only: no outline is written', async () => {
    const fake = new FakeHandle();
    const { server } = fakeServer(fake);
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: false, flags: true,
    });
    expect(fake.generates).toBe(0);
    expect(res.chapters).toBeNull();
    expect(res.flags!.windows.length).toBe(1);
  });
});
