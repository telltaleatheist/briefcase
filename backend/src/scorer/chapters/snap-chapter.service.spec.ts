import { describe, expect, it } from '@jest/globals';

import { ScorerServerService } from '../scorer-server.service';
import {
  ChoiceAnswer,
  ChoiceQuestion,
  DecideRequest,
  DecideResponse,
  GenerateResult,
  ScorerError,
  YesNoAnswer,
} from '../scorer.types';
import { OutlineError } from './segmenter';
import { ChapterProgress, ChapterScorer, SnapChapterService, runSnapChapters } from './snap-chapter.service';
import { PLUG } from './snap-prompts';
import { SentenceUnit } from './units';

/**
 * A fake scorer: the outline is canned, and each assign answer puts 0.999 on
 * the option whose label's first word appears in the sentence ("sponsor" picks
 * the plug item, the topic it mentions second). The yes/no returns `adP`.
 */
class FakeScorer implements ChapterScorer {
  readonly decides: DecideRequest[] = [];
  readonly prompts: string[] = [];
  constructor(
    private readonly outline: (prompt: string) => string = () => 'Cooking\nTravel',
    private readonly adP = 0.9,
    readonly countTokens?: (text: string) => Promise<number>,
  ) {}

  async generate(prompt: string): Promise<GenerateResult> {
    this.prompts.push(prompt);
    return { text: this.outline(prompt), promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'fake' };
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    this.decides.push(req);
    const answers: DecideResponse['answers'] = {};
    for (const q of req.questions) {
      if (q.type === 'yesno') {
        const a: YesNoAnswer = {
          type: 'yesno',
          p: this.adP,
          options: ['Yes', 'No'],
          probabilities: { Yes: this.adP, No: 1 - this.adP },
          logProbs: [Math.log(this.adP), Math.log(1 - this.adP)],
          rawLogProbs: [Math.log(this.adP), Math.log(1 - this.adP)],
          labelMass: 1,
        };
        answers[q.name] = a;
        continue;
      }
      const cq = q as ChoiceQuestion;
      const sentence = /^Sentence from the transcript above: "(.*)"\n/.exec(cq.instructions)![1].toLowerCase();
      const topic = cq.options.findIndex(
        (o) => o.description !== PLUG && sentence.includes(o.description.split(' ')[0].toLowerCase()),
      );
      const plug = cq.options.findIndex((o) => o.description === PLUG);
      const pick = plug >= 0 && sentence.includes('sponsor') ? plug : topic;
      const m = cq.options.length;
      const probs = cq.options.map((_, k) => (pick < 0 ? 1 / m : k === pick ? 0.999 : 0.001 / (m - 1)));
      // An ad read that mentions a topic leans to it as a second choice.
      if (pick === plug && topic >= 0) probs[topic] = 0.0008;
      const a: ChoiceAnswer = {
        type: 'choice',
        choice: cq.options[Math.max(0, pick)].name,
        confidence: Math.max(...probs),
        options: cq.options.map((o) => o.name),
        probabilities: Object.fromEntries(cq.options.map((o, k) => [o.name, probs[k]])),
        logProbs: probs.map(Math.log),
        rawLogProbs: probs.map(Math.log),
        labelMass: 0.99,
      };
      answers[q.name] = a;
    }
    return { model: 'fake', answers, timingMs: { total: 0, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

/** Units from topic tags: 'c' cooking, 's' sponsor, 't' travel; 10 s each. */
function unitsOf(tags: string): SentenceUnit[] {
  const words: Record<string, string> = { c: 'cooking', s: 'sponsor read about cooking', t: 'travel' };
  return Array.from(tags).map((t, i) => ({ start: i * 10 + 1, end: i * 10 + 9, text: `Some ${words[t]} talk, line ${i}.` }));
}

const video = 'c'.repeat(30) + 's'.repeat(8) + 't'.repeat(20) + 'c'.repeat(12); // 70 units

describe('runSnapChapters (fake scorer)', () => {
  it('outlines, assigns in batches of 64, confirms the ad and builds chapters', async () => {
    const fake = new FakeScorer();
    const units = unitsOf(video);
    const res = await runSnapChapters(fake, units);

    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain(units.map((u) => u.text).join('\n'));
    const assigns = fake.decides.filter((d) => d.questions[0].type === 'choice');
    expect(assigns.map((d) => d.questions.length)).toEqual([64, 6]);
    for (const d of assigns) {
      expect(d.state).toBe(units.map((u) => u.text).join('\n'));
      expect(d.missingLabels).toBe('floor');
    }
    const opts = (assigns[0].questions[0] as ChoiceQuestion).options;
    expect(opts.map((o) => o.description)).toEqual(['Cooking', 'Travel', PLUG]);
    expect(assigns[1].questions[0].name).toBe('s64');

    const yesnos = fake.decides.filter((d) => d.questions[0].type === 'yesno');
    expect(yesnos).toHaveLength(1);
    expect(yesnos[0].questions[0].instructions).toBe(
      `Passage from the transcript above: "${units.slice(30, 38).map((u) => u.text).join(' ')}"\n` +
        'In this passage the speaker is advertising or promoting something: a sponsor, their own Patreon, merch, ' +
        'a book, or asking viewers to subscribe, follow or support them.',
    );

    expect(res.outline).toEqual(['Cooking', 'Travel']);
    expect(res.chapters.map((c) => [c.title, c.sentenceRange, c.isAd])).toEqual([
      ['Cooking', [0, 30], false],
      ['Sponsor / self-promotion', [30, 38], true],
      ['Travel', [38, 58], false],
      ['Cooking (continued)', [58, 70], false],
    ]);
    expect(res.chapters[0].startSeconds).toBe(0);
    expect(res.chapters[1].startSeconds).toBe(301);
    expect(res.chapters[3].endSeconds).toBe(699);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].plugVerdicts).toEqual([{ start: 30, end: 38, p: 0.9 }]);
  });

  it('re-segments a rejected ad stretch without the ad option', async () => {
    const fake = new FakeScorer(undefined, 0.1);
    const res = await runSnapChapters(fake, unitsOf(video));
    expect(fake.decides.filter((d) => d.questions[0].type === 'yesno')).toHaveLength(1);
    expect(res.chapters.some((c) => c.isAd)).toBe(false);
    expect(res.chapters.map((c) => [c.title, c.sentenceRange])).toEqual([
      ['Cooking', [0, 38]],
      ['Travel', [38, 58]],
      ['Cooking (continued)', [58, 70]],
    ]);
  });

  it('with detectAds off, offers only the outline and asks no yes/no', async () => {
    const fake = new FakeScorer();
    const res = await runSnapChapters(fake, unitsOf(video), { detectAds: false });
    expect((fake.decides[0].questions[0] as ChoiceQuestion).options).toHaveLength(2);
    expect(fake.decides.every((d) => d.questions[0].type === 'choice')).toBe(true);
    expect(res.chapters.some((c) => c.isAd)).toBe(false);
  });

  it('the switch cost is the granularity dial', async () => {
    const units = unitsOf('c'.repeat(20) + 't'.repeat(2) + 'c'.repeat(20));
    const fine = await runSnapChapters(new FakeScorer(), units, { switchCost: 2 });
    const coarse = await runSnapChapters(new FakeScorer(), units, { switchCost: 20 });
    expect(fine.chapters).toHaveLength(3);
    expect(coarse.chapters).toHaveLength(1);
  });

  it('reports monotone progress through outline, assign and ads, ending at 1', async () => {
    const seen: ChapterProgress[] = [];
    await runSnapChapters(new FakeScorer(), unitsOf(video), { onProgress: (p) => seen.push({ ...p }) });
    expect(seen.map((p) => p.phase)).toEqual(['outline', 'assign', 'assign', 'assign', 'ads', 'done']);
    for (let i = 1; i < seen.length; i++) expect(seen[i].fraction).toBeGreaterThanOrEqual(seen[i - 1].fraction);
    expect(seen[seen.length - 1]).toMatchObject({ fraction: 1, unitsDone: 70, unitsTotal: 70 });
    expect(seen[2].unitsDone).toBe(64);
  });

  it('stops at the next step when the signal fires, and throws cancelled', async () => {
    const fake = new FakeScorer();
    const ac = new AbortController();
    const run = runSnapChapters(fake, unitsOf(video), {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'assign' && p.unitsDone === 64) ac.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await expect(run).rejects.toBeInstanceOf(ScorerError);
    expect(fake.decides).toHaveLength(1);
  });

  it('does nothing when already cancelled', async () => {
    const fake = new FakeScorer();
    const ac = new AbortController();
    ac.abort();
    await expect(runSnapChapters(fake, unitsOf(video), { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.prompts).toHaveLength(0);
  });

  it('propagates an unusable outline as OutlineError', async () => {
    await expect(runSnapChapters(new FakeScorer(() => 'Everything'), unitsOf(video))).rejects.toBeInstanceOf(OutlineError);
  });

  it('can route the outline to another writer', async () => {
    const fake = new FakeScorer();
    const prompts: string[] = [];
    const res = await runSnapChapters(fake, unitsOf(video), {
      writeOutline: async (p) => {
        prompts.push(p);
        return 'Travel\nCooking';
      },
    });
    expect(prompts).toHaveLength(1);
    expect(fake.prompts).toHaveLength(0);
    expect(res.outline).toEqual(['Travel', 'Cooking']);
  });

  it('chunks a long transcript, runs each chunk, and stitches one timeline', async () => {
    const tags = 'c'.repeat(40) + 't'.repeat(40) + 'c'.repeat(40) + 't'.repeat(40); // 160 units
    const units = unitsOf(tags);
    // 100 tokens per unit -> 16k total: over a 5k single limit, 4k cores, 1k overlap.
    const fake = new FakeScorer(undefined, 0.9, async (text) => text.split('\n').length * 100);
    const res = await runSnapChapters(fake, units, {
      chunking: { maxSingleTokens: 5000, maxCoreTokens: 4000, overlapTokens: 1000 },
    });
    expect(res.chunks).toHaveLength(4);
    expect(fake.prompts).toHaveLength(4);
    // Chunk 1's first question quotes the real previous unit, not "(start of the video)".
    const c1 = res.chunks[1];
    const firstQ = fake.decides.find((d) => d.state === units.slice(c1.start, c1.end).map((u) => u.text).join('\n'))!;
    expect(firstQ.questions[0].instructions).toContain(`(The sentence just before it: "${units[c1.start - 1].text}")`);
    // One contiguous timeline, the topic changes where the transcript changes.
    const ch = res.chapters;
    expect(ch[0].sentenceRange[0]).toBe(0);
    expect(ch[ch.length - 1].sentenceRange[1]).toBe(160);
    for (let i = 1; i < ch.length; i++) expect(ch[i].sentenceRange[0]).toBe(ch[i - 1].sentenceRange[1]);
    expect(ch.map((c) => c.sentenceRange[0])).toEqual([0, 40, 80, 120]);
    expect(ch.map((c) => c.label)).toEqual(['Cooking', 'Travel', 'Cooking', 'Travel']);
    expect(res.seams).toHaveLength(3);
  });
});

describe('SnapChapterService', () => {
  it('holds the scorer for the run and counts tokens with the engine tokenizer', async () => {
    const fake = new FakeScorer();
    let leases = 0;
    const tokenized: string[] = [];
    const server = {
      withScorer: async (fn: (h: unknown) => Promise<unknown>) => {
        leases++;
        return fn({
          decide: (req: DecideRequest) => fake.decide(req),
          generate: (m: string) => fake.generate(m),
          decider: async () => ({ engine: { tokenize: async (t: string) => (tokenized.push(t), [1, 2, 3]) } }),
        });
      },
    } as unknown as ScorerServerService;
    const svc = new SnapChapterService(server);
    const units = unitsOf(video);
    const res = await svc.buildChapters(units);
    expect(leases).toBe(1);
    expect(tokenized).toEqual([units.map((u) => u.text).join('\n')]);
    expect(res.chapters).toHaveLength(4);

    expect((await svc.buildChapters([])).chapters).toEqual([]);
    expect(leases).toBe(1);
  });

  it('builds units from whisper segments', () => {
    const svc = new SnapChapterService({} as ScorerServerService);
    expect(svc.unitsFromSegments([{ start: 0, end: 2, text: 'Hi. This is a whole sentence.' }])).toEqual([
      { start: 0, end: 2, text: 'Hi. This is a whole sentence.' },
    ]);
  });
});
