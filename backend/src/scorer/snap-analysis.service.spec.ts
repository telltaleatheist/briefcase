import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';

import { AnalysisCancelledError, isCancellation } from '../analysis/cancellation';
import { SnapFlagRanker } from './flags/snap-flag-ranker.service';
import { SnapAnalysisService, SnapStageProgress } from './snap-analysis.service';
import { ScorerHandle, ScorerServerService } from './scorer-server.service';
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
  failOn?: (req: DecideRequest, n: number) => Error | null;
  onDecide?: (n: number) => void;

  handle(): ScorerHandle {
    return {
      decide: (req, o) => this.decide(req, o),
      generate: async () => {
        this.generates++;
        return { text: this.outline, promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' } as GenerateResult;
      },
      decider: async () =>
        ({ model: 'fake-qwen', engine: { tokenize: async (t: string) => new Array(Math.ceil(t.length / 4)).fill(1) } }) as any,
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
      answers[q.name] = a;
    }
    return { model: 'fake-qwen', answers, timingMs: { total: 1, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

function fakeServer(fake: FakeHandle, startError?: Error) {
  let leases = 0;
  const server = {
    availability: () => ({ available: true, binarySource: 'homebrew' }),
    withScorer: async <T>(fn: (h: ScorerHandle) => Promise<T>) => {
      leases++;
      if (startError) throw startError;
      return fn(fake.handle());
    },
  };
  return { server: server as unknown as ScorerServerService, leases: () => leases };
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
    expect(res.chaptersError).toBeUndefined();
    expect(res.flagsError).toBeUndefined();
    expect(res.model).toBe('fake-qwen');
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

  it('a scorer that cannot start is a per-stage error for BOTH passes, never a throw', async () => {
    const fake = new FakeHandle();
    const { server } = fakeServer(fake, new ScorerError('engine_unreachable', 'scorer llama-server exited with code 1'));
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    });
    expect(res.chapters).toBeNull();
    expect(res.flags).toBeNull();
    expect(res.chaptersError).toMatch(/could not start.*exited with code 1/);
    expect(res.flagsError).toMatch(/could not start/);
  });

  it('an unusable outline fails chapters only; flags still run', async () => {
    const fake = new FakeHandle();
    fake.outline = 'Just one section';
    const { server } = fakeServer(fake);
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    });
    expect(res.chapters).toBeNull();
    expect(res.chaptersError).toMatch(/outline was unusable/);
    expect(res.flags!.windows.length).toBe(1);
  });

  it('an engine that dies during chaptering is not asked again for flags', async () => {
    const fake = new FakeHandle();
    fake.failOn = () => new ScorerError('engine_unreachable', 'POST /completion: connection refused');
    const { server } = fakeServer(fake);
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    });
    expect(res.chaptersError).toMatch(/connection refused/);
    expect(res.flagsError).toMatch(/stopped answering during chaptering/);
    expect(fake.decides).toHaveLength(1);
  });

  it('a flag-pass engine error fails flags only; the chapters stand', async () => {
    const fake = new FakeHandle();
    fake.failOn = (req) => (req.questions[0].name.startsWith('p1:') ? new ScorerError('engine_error', 'boom') : null);
    const { server } = fakeServer(fake);
    const res = await new SnapAnalysisService(server, new SnapFlagRanker()).run({
      segments: segments(), categories: CATEGORIES, chapters: true, flags: true, chapterOptions: { switchCost: 2 },
    });
    expect(res.chapters!.chapters).toHaveLength(2);
    expect(res.flags).toBeNull();
    expect(res.flagsError).toMatch(/boom/);
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

  it("an aborted in-flight request (the scorer's own 'cancelled') is a cancellation, not a fallback", async () => {
    const fake = new FakeHandle();
    const controller = new AbortController();
    fake.failOn = () => {
      controller.abort();
      return new ScorerError('cancelled', 'POST /completion: cancelled by the caller');
    };
    const { server } = fakeServer(fake);
    const err = await new SnapAnalysisService(server, new SnapFlagRanker())
      .run({ segments: segments(), categories: CATEGORIES, chapters: false, flags: true, signal: controller.signal })
      .catch((e) => e);
    expect(isCancellation(err)).toBe(true);
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
