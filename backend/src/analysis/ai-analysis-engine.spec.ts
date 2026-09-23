import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AIAnalysisService, AnalysisOptions } from './ai-analysis.service';
import { AnalysisCancelledError, isCancellation } from './cancellation';
import type { FlagWindow, WindowCategory } from './nli-ranker.service';
import type { SnapStageRequest, SnapStageResult } from '../scorer/snap-analysis.service';

/**
 * The analysisEngine wiring in AIAnalysisService.analyzeTranscript, end to end
 * with fakes: no model, no scorer, no NLI worker, no network. The config dir is
 * a temp dir (APPDATA), so the developer's real app-config is never read.
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
  generated: Array<{ prompt: string; task: string }> = [];
  detections = 0;
  nliRanks = 0;
  snapRuns: SnapStageRequest[] = [];
  snapAvailable: { available: true } | { available: false; reason: string } = { available: true };
  snapRun: (req: SnapStageRequest) => Promise<SnapStageResult> = async () => snapResult();

  service(withSnap = true): AIAnalysisService {
    const provider = {
      generateText: async (prompt: string, _cfg: unknown, task: string) => {
        this.generated.push({ prompt, task });
        return {
          text: '{"title":"LLM title","summary":"A summary of it.","verdict":"flag","people":[],"topics":["cooking"],"hook":"A hook.","body":"A body."}',
          inputTokens: 1, outputTokens: 1,
        };
      },
      releaseOllamaModelKeys: async () => undefined,
    };
    const detection = {
      detectBoundaries: async () => {
        this.detections++;
        return { boundaries: [0, 40], placeCalls: 0, scorer: 'embedding' };
      },
    };
    const nli = {
      captureThreshold: 0.2, rescueFloor: 0.15, unavailable: null,
      isAvailable: async () => true,
      rankWindows: async () => {
        this.nliRanks++;
        return [swin(2, 2, [], [wcat('political-demonization', 0.97, [2])])];
      },
      stop: () => undefined,
      userFacingUnavailableMessage: (r: string) => `NLI unavailable: ${r}`,
    };
    const snap = {
      availability: () => this.snapAvailable,
      run: (req: SnapStageRequest) => {
        this.snapRuns.push(req);
        return this.snapRun(req);
      },
    };
    return new AIAnalysisService(
      provider as any, {} as any, {} as any, detection as any, nli as any, undefined, withSnap ? (snap as any) : undefined,
    );
  }
}

let tmp: string;
const savedEnv = { ...process.env };
function options(): AnalysisOptions {
  return {
    provider: 'claude', model: 'claude-test', apiKey: 'k', transcript: LINES.join(' '), segments: SEGMENTS,
    outputFile: path.join(tmp, 'analysis.txt'), categories: [{ name: 'political-demonization' } as any],
  };
}

describe('AIAnalysisService: the analysis engine setting', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
    jest_silence();
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-spec-'));
    process.env.APPDATA = tmp; // app-config reads land in the temp dir
    process.env.BRIEFCASE_PLACE_MODEL = 'none'; // no Ollama probe
    delete process.env.BRIEFCASE_ANALYSIS_ENGINE;
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it("default is classic: the scorer is never touched", async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(0);
    expect(h.detections).toBe(1);
    expect(h.nliRanks).toBe(1);
    expect(res.sections.every((s) => s.ranker === 'nli')).toBe(true);
    expect(res.warnings).toBeUndefined();
  });

  it('snap: outline titles and scorer boundaries, snap windows verified, sub-passages merged, candidates stored', async () => {
    process.env.BRIEFCASE_ANALYSIS_ENGINE = 'snap';
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: true });
    expect(h.snapRuns[0].signal).toBeDefined();
    expect(h.detections).toBe(0);
    expect(h.nliRanks).toBe(0);

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

  it('snap selected but unavailable: classic for both stages, one warning on the job', async () => {
    process.env.BRIEFCASE_ANALYSIS_ENGINE = 'snap';
    const h = new Harness();
    h.snapAvailable = { available: false, reason: 'scorer model not found: /m/Qwen3.5-9B-BF16.gguf' };
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(0);
    expect(h.detections).toBe(1);
    expect(h.nliRanks).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0]).toMatch(/^Chapters and flags were made with the classic analysis engine.*Qwen3\.5-9B-BF16/);
  });

  it('snap chapters failed, flags fine: classic chapters only, warning names chapters', async () => {
    process.env.BRIEFCASE_ANALYSIS_ENGINE = 'snap';
    const h = new Harness();
    h.snapRun = async () => snapResult({ chapters: null, chaptersError: 'the outline was unusable: 1 item' });
    const res = await h.service().analyzeTranscript(options());
    expect(h.detections).toBe(1);
    expect(h.nliRanks).toBe(0);
    expect(res.warnings).toEqual([expect.stringMatching(/^Chapters were made with the classic.*outline was unusable/)]);
    expect(res.sections.some((s) => s.ranker === 'snap-v1')).toBe(true);
  });

  it('no service registered (module absent): a warned classic run', async () => {
    process.env.BRIEFCASE_ANALYSIS_ENGINE = 'snap';
    const h = new Harness();
    const res = await h.service(false).analyzeTranscript(options());
    expect(h.detections).toBe(1);
    expect(res.warnings![0]).toMatch(/not registered/);
  });

  it('a cancel inside the scorer stage is a cancellation: no fallback, no LLM call', async () => {
    process.env.BRIEFCASE_ANALYSIS_ENGINE = 'snap';
    const h = new Harness();
    h.snapRun = async () => {
      throw new AnalysisCancelledError('Analysis cancelled during snap chaptering');
    };
    const err = await h.service().analyzeTranscript({ ...options(), jobId: 'job-1' }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
    expect(h.detections).toBe(0);
    expect(h.generated).toHaveLength(0);
  });

  it('cancelAnalysis(jobId) aborts the signal the scorer stage was given', async () => {
    process.env.BRIEFCASE_ANALYSIS_ENGINE = 'snap';
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
