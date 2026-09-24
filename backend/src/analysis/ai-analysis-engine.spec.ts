import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AIAnalysisService, AnalysisOptions } from './ai-analysis.service';
import { AnalysisCancelledError, isCancellation } from './cancellation';
import type { FlagWindow, WindowCategory } from './flag-windows';
import { SnapEngineError, type SnapStageRequest, type SnapStageResult } from '../scorer/snap-analysis.service';
import { CrucibleParkedError } from '../crucible/llm/errors';

/**
 * The snap engine wiring in AIAnalysisService.analyzeTranscript, end to end
 * with fakes: no model, no scorer, no network. Snap is the only engine (P7):
 * a stage it cannot make fails the analysis by name, a busy Crucible parks it,
 * and nothing falls back to another path. The config dir is a temp dir
 * (APPDATA), so the developer's real app-config is never read.
 */

const LINES = [
  'Welcome back to the kitchen everybody, today is pasta day.', // 0
  'We start with a big pot of well salted water.', // 1
  'Those people are communists and enemies of this country.', // 2
  'They are vermin and they should all be thrown out.', // 3
  'Every one of them is a traitor to this great nation.', // 4
  'They will destroy everything we love if we let them.', // 5
  'Now let us talk about our summer travel plans.', // 6
  'The deep state rigged the train timetable, folks.', // 7
];
const SEGMENTS = LINES.map((text, i) => ({ start: i * 10, end: i * 10 + 10, text }));

function wcat(category: string, score: number, sentences: number[]): WindowCategory {
  return {
    category, proposition: `${category} proposition`, score, sentenceIndex: sentences[0], text: LINES[sentences[0]],
    start: sentences[0] * 10, end: sentences[0] * 10 + 10, sentenceIndices: sentences, rescued: false,
  };
}

function swin(from: number, to: number, spanIds: number[], cats: WindowCategory[]): FlagWindow {
  return {
    contextFrom: Math.max(0, from - 1), contextTo: Math.min(LINES.length - 1, to + 1), firedFrom: from, firedTo: to,
    categories: cats, score: Math.max(...cats.map((c) => c.score)), spanIds, strength: -3, heat: 1,
  } as FlagWindow;
}

/** Two chapters, and one long span verified as two sub-passages plus one over-budget window. */
function snapResult(over: Partial<SnapStageResult> = {}): SnapStageResult {
  const inBudget = [
    swin(2, 3, [0], [wcat('political-demonization', 0.93, [2]), wcat('dehumanization', 0.9, [3])]),
    swin(4, 5, [0], [wcat('political-demonization', 0.8, [4])]),
  ];
  const overflow = [swin(7, 7, [1], [wcat('conspiracy', 0.6, [7])])];
  return {
    transcript: null,
    model: 'fake-qwen',
    timings: { startMs: 0, prepareMs: 0, chaptersMs: 0, flagsMs: 0, totalMs: 0 },
    labelMassGated: { chapters: 0, flags: 0, refine: 0, total: 0 },
    chapters: {
      chapters: [
        { startSeconds: 0, endSeconds: 60, title: 'Pasta day', label: 'Pasta day', sentenceRange: [0, 6], isAd: false },
        { startSeconds: 60, endSeconds: 80, title: 'Summer travel', label: 'Summer travel', sentenceRange: [6, 8], isAd: false },
      ],
      outline: ['Pasta day', 'Summer travel'],
      chunks: [],
      seams: [],
      timings: { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 },
    },
    flags: {
      windows: inBudget as any,
      overflow: overflow as any,
      spans: [],
      ratingMap: {} as any,
      plan: [],
      notes: [],
      stats: { units: 8, spans: 2, verifyBudget: 3 } as any,
    },
    ...over,
  };
}

class Harness {
  /** The LLM check on flag sections (off in the app for now; the verified-path tests turn it on). */
  verify = false;
  generated: Array<{ prompt: string; task: string }> = [];
  snapRuns: SnapStageRequest[] = [];
  snapRun: (req: SnapStageRequest) => Promise<SnapStageResult> = async () => snapResult();
  /** Replaceable: every LLM call's answer. */
  answer: (prompt: string, task: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }> = async () => ({
    text: '{"title":"LLM title","summary":"A summary of it.","verdict":"flag","people":[],"topics":["cooking"],"hook":"A hook.","body":"A body."}',
    inputTokens: 1, outputTokens: 1,
  });

  service(): AIAnalysisService {
    const provider = {
      generateText: async (prompt: string, _cfg: unknown, task: string) => {
        this.generated.push({ prompt, task });
        return this.answer(prompt, task);
      },
      withRun: <T>(fn: () => Promise<T>) => fn(),
      crucibleOllamaStandInChoice: async () => null,
      crucibleOllamaTakesContext: async () => true,
      crucibleContextWindow: async () => 32768,
    };
    const snap = {
      run: (req: SnapStageRequest) => {
        this.snapRuns.push(req);
        return this.snapRun(req);
      },
    };
    const service = new AIAnalysisService(provider as any, snap as any, undefined);
    service.verifyFlagsWithLlm = this.verify;
    return service;
  }
}

let tmp: string;
const savedEnv = { ...process.env };
function options(): AnalysisOptions {
  return {
    provider: 'claude', model: 'claude-test', transcript: LINES.join(' '), segments: SEGMENTS,
    outputFile: path.join(tmp, 'analysis.txt'), categories: [{ name: 'political-demonization' } as any],
  };
}

describe('AIAnalysisService: snap is the analysis engine', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
    jest_silence();
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-spec-'));
    process.env.APPDATA = tmp; // app-config reads land in the temp dir
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it('decide only (the default): every window of the map is a flag section, sub-passages merged, no LLM check', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.generated.filter((g) => g.task === 'flags')).toHaveLength(0);
    const flags = res.sections.filter((s) => s.verdict === 'flag');
    expect(flags.map((s) => [s.start_time, s.end_time, s.category, s.ranker])).toEqual([
      ['00:00:20', '00:00:50', 'political-demonization', 'snap-v1'],
      ['00:01:10', '00:01:20', 'conspiracy', 'snap-v1'],
    ]);
    expect(flags[0].description).toContain('[also: dehumanization]');
    expect(res.sections.every((s) => s.verdict === 'flag')).toBe(true);
  });

  it('with the LLM check on: snap windows verified, sub-passages merged, candidates stored', async () => {
    const h = new Harness();
    h.verify = true;
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: true });
    expect(h.snapRuns[0].signal).toBeDefined();

    // Chapters: the scorer's boundaries and outline labels; the LLM wrote only summaries.
    expect(res.chapters.map((c) => [c.start_time, c.title, c.summary])).toEqual([
      ['00:00:00', 'Pasta day', 'A summary of it.'],
      ['00:01:00', 'Summer travel', 'A summary of it.'],
    ]);

    // Flags: both sub-passages of span 0 were accepted -> ONE section 00:00:20-00:00:50.
    const flags = res.sections.filter((s) => s.verdict === 'flag');
    expect(flags).toHaveLength(1);
    expect([flags[0].start_time, flags[0].end_time, flags[0].category, flags[0].ranker]).toEqual([
      '00:00:20', '00:00:50', 'political-demonization', 'snap-v1',
    ]);
    expect(flags[0].description).toContain('[also: dehumanization]');
    // The over-budget window was never verified: a candidate row, not a flag.
    const candidates = res.sections.filter((s) => s.verdict === 'candidate');
    expect(candidates.map((s) => [s.start_time, s.category, s.nli_score, s.ranker])).toEqual([
      ['00:01:10', 'conspiracy', 0.6, 'snap-v1'],
    ]);
    const verifications = h.generated.filter((g) => g.task === 'flags');
    expect(verifications).toHaveLength(3); // (w1: 2 categories) + (w2: 1); none for the candidate
    expect(res.warnings).toBeUndefined();
  });

  it('with the LLM check on, the .txt report holds findings only: no candidate and no skip rows', async () => {
    const h = new Harness();
    h.verify = true;
    const svc = h.service();
    // The verifier rejects the second sub-passage (sentences 4-5; its prompt's
    // context does not reach sentence 2): a 'skip' row.
    const base = h.answer;
    h.answer = async (prompt, task) =>
      task === 'flags' && !prompt.includes('communists') ? { text: '{"verdict":"skip"}', inputTokens: 1, outputTokens: 1 } : base(prompt, task);
    const res = await svc.analyzeTranscript(options());
    expect(res.sections.some((s) => s.verdict === 'skip')).toBe(true);
    expect(res.sections.some((s) => s.verdict === 'candidate')).toBe(true);

    const report = fs.readFileSync(path.join(tmp, 'analysis.txt'), 'utf8');
    expect(report).toContain('communists'); // the accepted flag
    expect(report).not.toContain('destroy everything'); // the skip row
    expect(report).not.toContain('deep state'); // the unverified candidate
  });

  it('a stage the engine cannot make fails the analysis BY NAME: no other engine, no LLM call', async () => {
    const h = new Harness();
    h.snapRun = async () => {
      throw new SnapEngineError('chapters', 'the outline was unusable: outline came back with no items');
    };
    const err = await h.service().analyzeTranscript(options()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/AI analysis failed: The analysis engine on Crucible could not make the chapters: the outline was unusable/);
    expect(h.generated).toHaveLength(0);
  });

  it('a busy or silent Crucible in the scorer stage PARKS the task: the park goes up as it is', async () => {
    const h = new Harness();
    h.snapRun = async () => {
      throw new CrucibleParkedError('mac', 'Crucible is busy: the card is held by the settlement clearing the card');
    };
    const err = await h.service().analyzeTranscript({ ...options(), jobId: 'job-p' }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect(h.generated).toHaveLength(0);
  });

  it('with the LLM check on, a park mid-verification stops the whole run (never a quietly degraded flag)', async () => {
    const h = new Harness();
    h.verify = true;
    const base = h.answer;
    h.answer = async (prompt, task) => {
      if (task === 'flags') throw new CrucibleParkedError('mac', "Crucible on mac isn't answering.");
      return base(prompt, task);
    };
    const err = await h.service().analyzeTranscript({ ...options(), jobId: 'job-q' }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect(h.generated.filter((g) => g.task === 'flags')).toHaveLength(1);
    expect(h.generated.some((g) => g.task === 'tags' || g.task === 'description' || g.task === 'title')).toBe(false);
  });

  it('a single-topic video: one chapter spanning it, analysed like any other', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({
      chapters: {
        chapters: [{ startSeconds: 0, endSeconds: 80, title: 'Pasta day', label: 'Pasta day', sentenceRange: [0, 8], isAd: false }],
        outline: ['Pasta day'], chunks: [], seams: [], timings: { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 },
      },
    });
    const res = await h.service().analyzeTranscript(options());
    expect(res.chapters.map((c) => [c.start_time, c.end_time, c.title])).toEqual([['00:00:00', '00:01:20', 'Pasta day']]);
  });

  it('answers under the label-mass gate are counted and said on the job, never silent', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ labelMassGated: { chapters: 2, flags: 3, refine: 0, total: 5 } });
    const res = await h.service().analyzeTranscript(options());
    expect(res.warnings).toEqual([expect.stringMatching(/^5 of the analysis engine's answers were read as no evidence/)]);
  });

  it('sub-chapters that could not be refined keep the top-level chapters and say so', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ chapterTreeError: 'chapter refinement failed: boom' });
    const res = await h.service().analyzeTranscript(options());
    expect(res.warnings).toEqual(['Sub-chapters were skipped: chapter refinement failed: boom']);
  });

  it('zero successful chapters fails the analysis with the real reason (never an empty success)', async () => {
    const h = new Harness();
    h.answer = async (_prompt, task) => {
      if (task === 'chapter') throw new Error('Crucible http_500: the engine fell over');
      return { text: '{}', inputTokens: 1, outputTokens: 1 };
    };
    const svc = h.service();
    (svc as unknown as { delay: () => Promise<void> }).delay = async () => undefined; // no retry backoff in a spec
    const err = await svc.analyzeTranscript(options()).catch((e) => e);
    expect((err as Error).message).toMatch(/no chapters could be analyzed.*the engine fell over/);
  });

  it("a stored taskModels.boundary (the retired classic placement task) is read and ignored", async () => {
    fs.mkdirSync(path.join(tmp, 'briefcase'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'briefcase', 'app-config.json'), JSON.stringify({ taskModels: { boundary: 'ollama:qwen3.5:4b' } }));
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(res.chapters).toHaveLength(2);
    expect(h.generated.some((g) => g.task === 'boundary')).toBe(false);
  });

  it('a cancel inside the scorer stage is a cancellation: no LLM call', async () => {
    const h = new Harness();
    h.snapRun = async () => {
      throw new AnalysisCancelledError('Analysis cancelled during snap chaptering');
    };
    const err = await h.service().analyzeTranscript({ ...options(), jobId: 'job-1' }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
    expect(err).not.toBeInstanceOf(CrucibleParkedError);
    expect(h.generated).toHaveLength(0);
  });

  it('cancelAnalysis(jobId) aborts the signal the scorer stage was given', async () => {
    const h = new Harness();
    const svc = h.service();
    h.snapRun = async (req) => {
      svc.cancelAnalysis('job-2');
      expect(req.signal!.aborted).toBe(true);
      throw new AnalysisCancelledError('cancelled');
    };
    const err = await svc.analyzeTranscript({ ...options(), jobId: 'job-2' }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
  });
});

/** analyzeTranscript also console.logs; keep the test output readable. */
function jest_silence() {
  for (const k of ['log', 'warn', 'error'] as const) (console as any)[k] = () => undefined;
}
