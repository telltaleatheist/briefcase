/**
 * P6: THE SCORER ON CRUCIBLE'S DECISION DOOR, against the fake.
 *
 * The boundary: Crucible only reserves the card and returns data. These pin
 * that the transport swap moved no logic — the chapter and flag pipelines send
 * the same questions over the wire they hand the seam — and the transport's
 * own duties: report mode with Briefcase's floor applied client-side, the
 * label-mass gate, one lease across a whole chapters + flags pass, a park on a
 * busy card inside a queue run, cancel mid-pass, decide_not_served and every
 * other "can't" failing BY NAME with no fallback, and 26 options.
 */
import { Logger } from '@nestjs/common';
import type { DecideAnswer as WireAnswer, ModelInfo } from '@crucible/client';
import { AnalysisCancelledError } from '../../src/analysis/cancellation';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { AI_VIA_ENV } from '../../src/crucible/llm/ai-via';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleParkedError } from '../../src/crucible/llm/errors';
import { runSnapChapters, type ChapterScorer } from '../../src/scorer/chapters/snap-chapter.service';
import { PLUG } from '../../src/scorer/chapters/snap-prompts';
import type { SentenceUnit } from '../../src/scorer/chapters/units';
import * as crucibleDecide from '../../src/scorer/crucible-decide';
import { DECIDE_TOP_K_MARGIN, LABEL_MASS_GATE, floorAnswer, toWireRequest } from '../../src/scorer/crucible-decide';
import { CrucibleScorerService, SCORER_LOAD_CONTEXT, pickDecideModel } from '../../src/scorer/crucible-scorer.service';
import { SnapFlagRanker } from '../../src/scorer/flags/snap-flag-ranker.service';
import { SnapAnalysisService, SnapEngineError } from '../../src/scorer/snap-analysis.service';
import type { ScorerHandle, ScorerServerService } from '../../src/scorer/scorer-server.service';
import { ScorerError, type ChoiceAnswer, type DecideRequest, type DecideResponse, type ScorerQuestion } from '../../src/scorer/scorer.types';
import { startFakeCrucible, type FakeCrucible, type FakeCrucibleOptions, type FakeDecideQuestion } from '../fake-crucible/fake-crucible';
import { harness } from './harness';
import { tempDir } from './helpers';

Logger.overrideLogger(false);

// ── fixtures ──────────────────────────────────────────────────────────────

/** Units from topic tags: 'c' cooking, 's' sponsor, 't' travel. */
function unitsOf(tags: string): SentenceUnit[] {
  const words: Record<string, string> = { c: 'cooking', s: 'sponsor read about cooking', t: 'travel' };
  return Array.from(tags).map((t, i) => ({ start: i * 10 + 1, end: i * 10 + 9, text: `Some ${words[t]} talk, line ${i}.` }));
}
const VIDEO = 'c'.repeat(30) + 's'.repeat(8) + 't'.repeat(20) + 'c'.repeat(12); // 70 units

/**
 * The raw (full-vocabulary) probabilities a fake engine reads: the option whose
 * description's first word is in the sentence gets 0.9, the rest share 0.08
 * (label mass 0.98); a sponsor read picks the plug. Yes/no (the ad check): Yes.
 */
function rawProbs(q: FakeDecideQuestion): Record<string, number> {
  if (q.type === 'yesno') return { Yes: 0.85, No: 0.13 };
  const sentence = (/^Sentence from the transcript above: "(.*)"\n/.exec(q.instructions)?.[1] ?? q.instructions).toLowerCase();
  const descriptions = q.descriptions ?? q.labels;
  const plug = descriptions.findIndex((d) => d === PLUG);
  const topic = descriptions.findIndex((d) => d !== PLUG && sentence.includes(d.split(' ')[0].toLowerCase()));
  const pick = plug >= 0 && sentence.includes('sponsor') ? plug : Math.max(0, topic);
  return Object.fromEntries(q.labels.map((l, k) => [l, k === pick ? 0.9 : 0.08 / (q.labels.length - 1)]));
}

/** The same numbers as a llama-server-path answer, straight into the seam (no transport). */
class DirectScorer implements ChapterScorer {
  readonly decides: DecideRequest[] = [];
  async generate(): Promise<{ text: string; promptTokens: number; completionTokens: number; finishReason: string; model: string }> {
    return { text: 'Cooking\nTravel', promptTokens: 0, completionTokens: 0, finishReason: 'stop', model: 'direct' };
  }
  async decide(req: DecideRequest): Promise<DecideResponse> {
    this.decides.push(req);
    const answers: DecideResponse['answers'] = {};
    for (const q of req.questions) {
      const labels = q.type === 'choice' ? q.options.map((o) => o.name) : q.type === 'score' ? q.levels : ['Yes', 'No'];
      const raw = rawProbs({
        name: q.name, type: q.type, instructions: q.instructions, labels,
        ...(q.type === 'choice' ? { descriptions: q.options.map((o) => o.description) } : {}),
      });
      const mass = labels.reduce((n, l) => n + raw[l], 0);
      const probs = labels.map((l) => raw[l] / mass);
      const base = {
        options: labels, probabilities: Object.fromEntries(labels.map((l, i) => [l, probs[i]])),
        logProbs: probs.map(Math.log), rawLogProbs: labels.map((l) => Math.log(raw[l])), labelMass: mass,
      };
      const best = probs.indexOf(Math.max(...probs));
      answers[q.name] = q.type === 'yesno' ? { type: 'yesno', p: probs[0], ...base }
        : { type: 'choice', choice: labels[best], confidence: probs[best], ...base } as ChoiceAnswer;
    }
    return { model: 'direct', answers, timingMs: { total: 0, perQuestion: {} }, tokens: { perQuestion: {}, images: 0 } };
  }
}

const savedEnv = { ...process.env };

async function rig(options: FakeCrucibleOptions = {}) {
  const fake = await startFakeCrucible({
    models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 }],
    decideProbs: rawProbs,
    chatReplies: { '*': 'Cooking\nTravel' },
    ...options,
  });
  const h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes);
  chat.heartbeatMs = 40;
  const scorer = new CrucibleScorerService(chat, servers);
  return { fake, chat, scorer };
}

let open: FakeCrucible[] = [];
beforeEach(() => {
  process.env = { ...savedEnv, APPDATA: tempDir('scorer-appdata-'), [AI_VIA_ENV]: 'crucible' };
});
afterEach(async () => {
  process.env = savedEnv;
  await Promise.all(open.map((f) => f.close()));
  open = [];
});
async function started(options: FakeCrucibleOptions = {}) {
  const r = await rig(options);
  open.push(r.fake);
  return r;
}

/** Semantic content of a wire decide body, in wire order. */
function wireContent(body: Record<string, unknown>) {
  const questions = body['questions'] as Record<string, Record<string, unknown>>;
  return {
    state: body['state'],
    questions: Object.entries(questions).map(([name, q]) => ({
      name,
      type: q['type'],
      instructions: q['instructions'],
      options: q['options'] ? Object.entries(q['options'] as Record<string, string>) : q['levels'] ?? null,
    })),
  };
}
/** The same for a request the pipeline handed the seam. */
function seamContent(req: DecideRequest) {
  return {
    state: req.state,
    questions: req.questions.map((q: ScorerQuestion) => ({
      name: q.name,
      type: q.type,
      instructions: q.instructions,
      options: q.type === 'choice' ? q.options.map((o) => [o.name, o.description]) : q.type === 'score' ? q.levels : null,
    })),
  };
}

// ── the pure mapping ──────────────────────────────────────────────────────

describe('crucible-decide: the wire request', () => {
  it('carries state, instructions, option names and descriptions verbatim and in order, always in report mode', () => {
    const wire = toWireRequest('qwen3.5-9b', {
      state: 'the transcript',
      nProbs: 40,
      missingLabels: 'floor',
      questions: [
        { type: 'choice', name: 's0', instructions: 'Which?', options: [{ name: 'section 2', description: 'B' }, { name: 'section 1', description: 'A' }] },
        { type: 'score', name: 'anger', instructions: 'How angry?', levels: ['Calm', 'Hot'] },
        { type: 'yesno', name: 'ad', instructions: 'An ad.' },
      ],
    });
    expect(wire).toEqual({
      model: 'qwen3.5-9b',
      state: 'the transcript',
      questions: {
        s0: { type: 'choice', instructions: 'Which?', options: { 'section 2': 'B', 'section 1': 'A' } },
        anger: { type: 'score', instructions: 'How angry?', levels: ['Calm', 'Hot'] },
        ad: { type: 'yesno', instructions: 'An ad.' },
      },
      missing: 'report',
    });
    expect(Object.keys((wire.questions['s0'] as { options: Record<string, string> }).options)).toEqual(['section 2', 'section 1']);
  });

  it('refuses by name what the wire would reorder or cannot carry, before anything is sent', () => {
    const q = (options: Array<{ name: string; description: string }>) => ({ state: 's', questions: [{ type: 'choice' as const, name: 'q', instructions: 'i', options }] });
    expect(() => toWireRequest('m', q([{ name: '2', description: 'b' }, { name: '1', description: 'a' }]))).toThrow(/integer-like/);
    const many = Array.from({ length: 27 }, (_, i) => ({ name: `o${i}`, description: `d${i}` }));
    expect(() => toWireRequest('m', q(many))).toThrow(expect.objectContaining({ code: 'too_many_options' }));
    expect(() => toWireRequest('m', { state: 's', questions: [{ type: 'yesno', name: '7', instructions: 'i' }] })).toThrow(/integer-like/);
  });
});

describe('crucible-decide: Briefcase\'s floor, client-side, and the label-mass gate', () => {
  const choice = (probabilities: Record<string, number | null>, labelMass: number, missing: string[]): WireAnswer => ({
    type: 'choice',
    choice: Object.keys(probabilities)[0],
    probabilities,
    logprobs: Object.fromEntries(Object.entries(probabilities).map(([k, p]) => [k, p === null ? null : Math.log(p)])),
    confidence: 0.5,
    labelMass,
    missingLabels: missing,
  });

  it('nothing missing: the renormalised logprobs are what Viterbi gets, labelMass as returned', () => {
    const d = floorAnswer(choice({ a: 0.75, b: 0.25 }, 0.9, []), ['a', 'b'], 'q');
    expect(d.logProbs[0]).toBeCloseTo(Math.log(0.75), 10);
    expect(d.logProbs[1]).toBeCloseTo(Math.log(0.25), 10);
    expect(d.rawLogProbs[0]).toBeCloseTo(Math.log(0.75 * 0.9), 10);
    expect(d.mass).toBe(0.9);
    expect(d.missing).toEqual([]);
  });

  it('a missing label takes the tighter upper bound (smallest returned label, or the unreturned mass over the top-K\'s others), then the row is renormalised', () => {
    // a 0.6, b 0.3 raw (mass 0.9); c outside the top-K.
    const d = floorAnswer(choice({ a: 2 / 3, b: 1 / 3, c: null }, 0.9, ['c']), ['a', 'b', 'c'], 'q');
    const shared = Math.log(0.1 / (1 + DECIDE_TOP_K_MARGIN)); // 0.02 < 0.3
    expect(d.rawLogProbs[2]).toBeCloseTo(shared, 10);
    const z = 0.6 + 0.3 + 0.02;
    expect(d.probs.map((p) => +p.toFixed(6))).toEqual([0.6 / z, 0.3 / z, 0.02 / z].map((p) => +p.toFixed(6)));
    expect(d.missing).toEqual(['c']);
    // When the smallest returned label is the tighter bound, it is the floor.
    const tight = floorAnswer(choice({ a: 0.99, b: 0.01, c: null }, 0.5, ['c']), ['a', 'b', 'c'], 'q');
    expect(tight.rawLogProbs[2]).toBeCloseTo(Math.log(0.01 * 0.5), 10);
  });

  it('a yes/no with Yes missing is floored, not read as p = 0', () => {
    const d = floorAnswer({ type: 'yesno', p: 0, logprob: null, labelMass: 0.6, missingLabels: ['Yes'] }, ['Yes', 'No'], 'ad');
    expect(d.missing).toEqual(['Yes']);
    expect(d.probs[0]).toBeGreaterThan(0);
    expect(d.probs[0]).toBeLessThan(0.5);
  });

  it('under the gate the answer says nothing: flattened to uniform', () => {
    const d = floorAnswer(choice({ a: 0.9, b: 0.1 }, LABEL_MASS_GATE / 2, []), ['a', 'b'], 'q');
    expect(d.gated).toBe(true);
    expect(d.probs).toEqual([0.5, 0.5]);
  });

  it('every label missing is label_not_in_probs, by name', () => {
    expect(() => floorAnswer(choice({ a: null, b: null }, 0, ['a', 'b']), ['a', 'b'], 'q')).toThrow(expect.objectContaining({ code: 'label_not_in_probs' }));
  });
});

describe('pickDecideModel: the 9B, one form per server session', () => {
  const row = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
    id, family: id.split('-')[0], paramsB: 9, revision: 'r', fingerprint: `${id}@r`, modalities: ['text'], backendSupported: true,
    installed: true, weightsOf: null, resident: false, loadable: true, memoryBytesEstimate: 1, contextDefault: 16384, maxModelLen: 16384, ...extra,
  });
  const models = [row('qwen3.8-27b-4bit'), row('qwen3.5-9b'), row('qwen3.5-9b-vl', { modalities: ['text', 'image'], weightsOf: 'qwen3.5-9b' }), row('dots-ocr', { family: 'dots' })];

  it('prefers the base 9B; takes the -vl alias only when it is already on the card', () => {
    expect(pickDecideModel(models)).toBe('qwen3.5-9b');
    expect(pickDecideModel(models, { resident: 'qwen3.5-9b-vl' })).toBe('qwen3.5-9b-vl');
  });
  it('keeps the session\'s form: no flip between a base and its alias mid-session', () => {
    expect(pickDecideModel(models, { kept: 'qwen3.5-9b-vl' })).toBe('qwen3.5-9b-vl');
    expect(pickDecideModel(models, { kept: 'qwen3.5-9b', resident: 'qwen3.5-9b-vl' })).toBe('qwen3.5-9b');
  });
  it('without a 9B, the decide class\'s own pick; never a model outside its families', () => {
    expect(pickDecideModel([row('qwen3.8-27b-4bit'), row('dots-ocr', { family: 'dots' })], { selected: 'qwen3.8-27b-4bit' })).toBe('qwen3.8-27b-4bit');
    expect(pickDecideModel([row('dots-ocr', { family: 'dots' })], { selected: 'dots-ocr' })).toBeNull();
  });
});

// ── the transport, end to end against the fake ───────────────────────────

describe('the transport swap moves no logic', () => {
  it('chapters through Crucible send the seam\'s questions verbatim, and come out the same as the same numbers straight into the seam', async () => {
    const { fake, chat, scorer } = await started();
    const units = unitsOf(VIDEO);
    const seen: DecideRequest[] = [];
    const viaCrucible = await chat.withRun(() => scorer.withScorer(async (h: ScorerHandle) => runSnapChapters({
      decide: (r, o) => (seen.push(r), h.decide(r, o)),
      generate: (m, o) => h.generate(m, o),
      countTokens: (t, s) => h.countTokens(t, s),
    }, units)));
    const direct = new DirectScorer();
    const straight = await runSnapChapters(direct, units, { chunkPlan: viaCrucible.chunks.map(({ start, end, coreStart, coreEnd }) => ({ start, end, coreStart, coreEnd })) });

    // Every decide crossed the wire with exactly the seam's content, in order.
    const bodies = fake.decideBodies();
    expect(bodies).toHaveLength(seen.length);
    bodies.forEach((b, i) => expect(wireContent(b)).toEqual(seamContent(seen[i])));
    expect(bodies.every((b) => b['missing'] === 'report' && b['model'] === 'qwen3.5-9b')).toBe(true);
    // ...and the pipeline asked the transport exactly what it asks the direct seam.
    expect(seen.map(seamContent)).toEqual(direct.decides.map(seamContent));
    // Same numbers in, same chapters out.
    expect(viaCrucible.chapters).toEqual(straight.chapters);
    expect(viaCrucible.chunks[0].path).toEqual(straight.chunks[0].path);
    for (const [i, row] of viaCrucible.chunks[0].logProbs.entries()) {
      row.forEach((lp, k) => expect(lp).toBeCloseTo(straight.chunks[0].logProbs[i][k], 4));
    }
    // The acts: decisions are `decide`, the outline and the token count `generate`.
    expect(fake.requestsTo('/v1/decide', 'POST').every((r) => r.headers['x-crucible-act'] === 'decide')).toBe(true);
    const chats = fake.requestsTo('/v1/openai/chat/completions', 'POST');
    expect(chats.every((r) => r.headers['x-crucible-act'] === 'generate')).toBe(true);
    expect(chats.every((r) => (r.body as Record<string, unknown>)['temperature'] === 0
      && JSON.stringify((r.body as Record<string, unknown>)['chat_template_kwargs']) === '{"enable_thinking":false}')).toBe(true);
  });

  it('a label outside the top-K is floored client-side (report mode), counted, and the pass goes on', async () => {
    const { fake, chat, scorer } = await started({
      // Every assign question: the last option (the plug) is outside the engine's top-K.
      decideProbs: (q) => {
        const raw = rawProbs(q);
        if (q.type === 'choice') delete raw[q.labels[q.labels.length - 1]];
        return raw;
      },
    });
    const units = unitsOf('c'.repeat(10) + 't'.repeat(10));
    const res = await chat.withRun(() => scorer.withScorer((h) => runSnapChapters(h, units)));
    expect(res.chunks[0].flooredUnits).toBe(20);
    expect(res.chapters.map((c) => c.title)).toEqual(['Cooking', 'Travel']);
    expect(fake.decideBodies().every((b) => b['missing'] === 'report')).toBe(true);
  });

  it('26 options cross and come back (the Mac\'s patched cap)', async () => {
    const { chat, scorer } = await started();
    const options = Array.from({ length: 26 }, (_, i) => ({ name: `category ${String.fromCharCode(97 + i)}`, description: `about ${i}` }));
    const res = await chat.withRun(() => scorer.withScorer((h) => h.decide({ state: 'Some cooking talk.', questions: [{ type: 'choice', name: 'p1', instructions: 'Sentence from the transcript above: "x"\nWhich?', options }] })));
    const a = res.answers['p1'] as ChoiceAnswer;
    expect(a.options).toHaveLength(26);
    expect(a.logProbs).toHaveLength(26);
    expect(a.probabilities['category a']).toBeCloseTo(0.9 / 0.98, 6);
  });
});

describe('one lease across the pass, and every "can\'t" by name', () => {
  function snap(scorer: CrucibleScorerService, own?: Partial<ScorerServerService>) {
    const ownServer = { availability: () => ({ available: true }), withScorer: jest.fn(async () => { throw new Error('the own llama-server must never be used on Crucible'); }), ...own };
    return { service: new SnapAnalysisService(ownServer as unknown as ScorerServerService, new SnapFlagRanker(), scorer), own: ownServer };
  }
  const segments = () => unitsOf(VIDEO).map((u) => ({ start: u.start, end: u.end, text: u.text }));
  const CATEGORIES = [{ name: 'political-demonization' }, { name: 'conspiracy' }];

  it('chapters + flags hold ONE lease on the 9B, loaded at the scorer\'s window, released at the end; every decide rides it', async () => {
    const { fake, scorer } = await started();
    const underLease: boolean[] = [];
    fake.setDecideProbs((q) => (underLease.push(fake.openLease()?.model === 'qwen3.5-9b'), rawProbs(q)));
    const { service, own } = snap(scorer);
    const asked = jest.spyOn(crucibleDecide, 'toWireRequest');
    const res = await service.run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: true });
    // Flags as well as chapters: every question the pipelines asked crossed verbatim.
    const bodies = fake.decideBodies();
    expect(asked.mock.calls).toHaveLength(bodies.length);
    bodies.forEach((b, i) => expect(wireContent(b)).toEqual(seamContent(asked.mock.calls[i][1])));
    expect(bodies.some((b) => Object.keys(b['questions'] as object).some((n) => n.startsWith('p1:')))).toBe(true);
    asked.mockRestore();
    expect(res.chapters?.chapters.length).toBeGreaterThan(1);
    expect(res.flags).not.toBeNull();
    expect(res.model).toBe('qwen3.5-9b');
    expect(fake.jobs.filter((j) => j.type === 'load-model').map((j) => [j.model, j.params['context']])).toEqual([['qwen3.5-9b', SCORER_LOAD_CONTEXT]]);
    expect(fake.leases.taken).toHaveLength(1);
    expect(fake.leases.released).toEqual([fake.leases.taken[0].leaseId]);
    expect(underLease.length).toBeGreaterThan(2);
    expect(underLease.every(Boolean)).toBe(true);
    expect(own.withScorer).not.toHaveBeenCalled();
  });

  it('409 on the load inside a queue run PARKS the task (never waited out, never a fallback)', async () => {
    const { fake, chat, scorer } = await started();
    fake.leaseAsOther('qwen3.8-27b-4bit', 'bookforge');
    const { service, own } = snap(scorer);
    const err = await chat.withRun(() => service.run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: true }), { parkOnBusy: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect(own.withScorer).not.toHaveBeenCalled();
    expect(fake.decideBodies()).toHaveLength(0);
  });

  it('a server that goes silent mid-pass parks the task inside a queue run', async () => {
    const { fake, chat, scorer } = await started();
    let n = 0;
    fake.setDecideProbs((q) => {
      if (++n === 2) fake.faults.connectDelay = [{ match: { path: '/v1/decide' }, ms: 1 }];
      return rawProbs(q);
    });
    const { service } = snap(scorer);
    let parked: unknown = null;
    const err = await chat.withRun(async () => {
      try {
        return await service.run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: false });
      } finally {
        parked = chat.parkedInRun();
      }
    }, { parkOnBusy: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect(parked).toMatchObject({ server: 'mac' });
    expect(fake.leases.released).toEqual(fake.leases.taken.map((l) => l.leaseId));
  });

  it('cancel mid-pass stops at once, as a cancellation, and the lease is given back', async () => {
    const { fake, scorer } = await started();
    const controller = new AbortController();
    let n = 0;
    fake.setDecideProbs((q) => {
      if (++n === 1) {
        fake.inject({ chatDelayMs: 5_000 });
        setTimeout(() => controller.abort(), 20);
      }
      return rawProbs(q);
    });
    const { service } = snap(scorer);
    const t = Date.now();
    const err = await service.run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: true, signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisCancelledError);
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(fake.leases.taken).toHaveLength(1);
    expect(fake.leases.released).toEqual([fake.leases.taken[0].leaseId]);
  });

  it('decide_not_served (more options than the engine\'s cap) fails the stage BY NAME: no classic, no own llama-server', async () => {
    const { scorer } = await started({ decideMaxOptions: 2 });
    const { service, own } = snap(scorer);
    const err = await service.run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapEngineError);
    expect((err as Error).message).toMatch(/decide_not_served/);
    expect(own.withScorer).not.toHaveBeenCalled();
  });

  it('no model the decide class can use, a disabled class, or a server older than the door: failed by name before anything loads', async () => {
    for (const options of [
      { models: [{ id: 'dots-ocr', paramsB: 3, modalities: ['text', 'image'] }] },
      { disabledClasses: { decide: 'nothing fits in 8 GB' } },
      { version: '1.0.23' },
    ] as FakeCrucibleOptions[]) {
      const { fake, scorer } = await started(options);
      const { service, own } = snap(scorer);
      const err = await service.run({ segments: segments(), categories: CATEGORIES, chapters: true, flags: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SnapEngineError);
      expect((err as Error).message).toMatch(/Download it|does not serve decisions|1\.0\.24 or newer/);
      expect(fake.jobs).toHaveLength(0);
      expect(own.withScorer).not.toHaveBeenCalled();
    }
  });

  it('model_not_resident mid-pass (another load evicted it): loaded again at the scorer\'s window, and the pass carries on', async () => {
    const { fake, chat, scorer } = await started({ models: [{ id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.5-4b', paramsB: 4 }] });
    let n = 0;
    fake.setDecideProbs((q) => rawProbs(q));
    const res = await chat.withRun(() => scorer.withScorer(async (h) => {
      await h.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] });
      fake.setResident('qwen3.5-4b');
      n++;
      return h.decide({ state: 's', questions: [{ type: 'yesno', name: 'b', instructions: 'y' }] });
    }));
    expect(n).toBe(1);
    expect(res.answers['b'].type).toBe('yesno');
    expect(fake.jobs.filter((j) => j.type === 'load-model').map((j) => j.params['context'])).toEqual([SCORER_LOAD_CONTEXT, SCORER_LOAD_CONTEXT]);
  });

  it('503 chat_queue_full on the door is waited out after its retry_after', async () => {
    const { fake, chat, scorer } = await started({
      faults: { refuse: [{ match: { path: '/v1/decide' }, status: 503, code: 'chat_queue_full', details: { retry_after: 0.05 }, times: 2 }] },
    });
    const res = await chat.withRun(() => scorer.withScorer((h) => h.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] })));
    expect(res.answers['a'].type).toBe('yesno');
    expect(fake.requestsTo('/v1/decide', 'POST')).toHaveLength(3);
  });

  it('inside a run that holds a card, the scorer uses that server, not the first by rank', async () => {
    const { fake: mac } = await started();
    const pc = await startFakeCrucible({ models: [{ id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.8-27b-4bit', paramsB: 27 }], decideProbs: rawProbs, chatReplies: { '*': 'x' } });
    open.push(pc);
    const h = harness();
    h.registry.add({ name: 'mac', url: mac.url, token: mac.token });
    h.registry.add({ name: 'pc', url: pc.url, token: pc.token });
    const servers = new CrucibleServersService(h.registry, h.factory);
    const chat = new CrucibleChatService(servers, h.factory, h.probes);
    const scorer = new CrucibleScorerService(chat, servers);
    // The lane reserved pc for the analysis model; the scorer switches the hold there, on pc.
    await chat.withModel('pc', 'qwen3.8-27b-4bit', () => scorer.withScorer((sh) => sh.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] })));
    expect(pc.decideBodies()).toHaveLength(1);
    expect(mac.decideBodies()).toHaveLength(0);
    expect(mac.jobs).toHaveLength(0);
  });

  it('countTokens is the text\'s prompt tokens less the template\'s, measured once', async () => {
    const { fake, chat, scorer } = await started();
    const counts = await chat.withRun(() => scorer.withScorer(async (h) => [await h.countTokens('one two three'), await h.countTokens('four five')]));
    expect(counts).toEqual([3, 2]);
    // One chat for the template, one per text.
    expect(fake.chatBodies().filter((b) => b['max_tokens'] === 1)).toHaveLength(3);
  });

  it('a decide refused by the SDK for asking the wrong thing is a ScorerError by name, not a park', async () => {
    const { chat, scorer } = await started();
    const err = await chat.withRun(() => scorer.withScorer((h) => h.decide({ state: 's', questions: [{ type: 'choice', name: 'q', instructions: 'i', options: [{ name: '1', description: 'a' }, { name: '2', description: 'b' }] }] })), { parkOnBusy: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScorerError);
    expect(err).toMatchObject({ code: 'bad_request' });
  });
});
