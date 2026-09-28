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
  generated: Array<{ prompt: string; task: string }> = [];
  snapRuns: SnapStageRequest[] = [];
  snapRun: (req: SnapStageRequest) => Promise<SnapStageResult> = async () => snapResult();
  /** Replaceable: every LLM call's answer. */
  answer: (prompt: string, task: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }> = async (_prompt, task) => ({
    text: task === 'flags'
      ? '{"verdict":"flag","reason":"The speaker calls them communists and vermin as their own view."}'
      : '{"title":"LLM title","summary":"A summary of it.","people":[],"topics":["cooking"],"hook":"A hook.","body":"A body."}',
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
    return new AIAnalysisService(provider as any, snap as any, undefined);
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

  it('every section is checked (past the old budget too), each keeps its own row, and the reason is its description', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: true });
    expect(h.snapRuns[0].signal).toBeDefined();

    // Chapters: the scorer's boundaries and outline labels; the LLM wrote only summaries.
    expect(res.chapters.map((c) => [c.start_time, c.title, c.summary])).toEqual([
      ['00:00:00', 'Pasta day', 'A summary of it.'],
      ['00:01:00', 'Summer travel', 'A summary of it.'],
    ]);

    // One check per (section, category): 2 + 1 + 1, the overflow window included.
    expect(h.generated.filter((g) => g.task === 'flags')).toHaveLength(4);
    const flags = res.sections.filter((s) => s.verdict === 'flag');
    expect(flags.map((s) => [s.start_time, s.end_time, s.category, s.ranker])).toEqual([
      ['00:00:20', '00:00:40', 'political-demonization', 'snap-v1'],
      ['00:00:40', '00:00:50', 'political-demonization', 'snap-v1'],
      ['00:01:10', '00:01:20', 'conspiracy', 'snap-v1'],
    ]);
    expect(flags[0].description).toBe('The speaker calls them communists and vermin as their own view. [also: dehumanization]');
    // The passage itself is still stored, as the quote.
    expect(flags[0].quotes[0].text).toContain('communists');
    expect(res.sections.some((s) => s.verdict === 'candidate')).toBe(false);
    expect(res.warnings).toBeUndefined();
  });

  it('a rejection is stored with its reason (shown at All), and the .txt report holds findings only', async () => {
    const h = new Harness();
    const svc = h.service();
    const base = h.answer;
    h.answer = async (prompt, task) =>
      task === 'flags' && !prompt.includes('communists')
        ? { text: '{"verdict":"skip","reason":"The speaker is describing a train delay, not asserting a plot."}', inputTokens: 1, outputTokens: 1 }
        : base(prompt, task);
    const res = await svc.analyzeTranscript(options());
    const skips = res.sections.filter((s) => s.verdict === 'skip');
    expect(skips.length).toBeGreaterThan(0);
    expect(skips[0].description).toBe('The speaker is describing a train delay, not asserting a plot.');

    const report = fs.readFileSync(path.join(tmp, 'analysis.txt'), 'utf8');
    expect(report).toContain('communists'); // the accepted flag
    expect(report).not.toContain('deep state'); // the rejection
  });

  it('a verdict with no reason (a prose answer) keeps the quote as the description', async () => {
    const h = new Harness();
    const base = h.answer;
    h.answer = async (prompt, task) => (task === 'flags' ? { text: '{"verdict":"flag"}', inputTokens: 1, outputTokens: 1 } : base(prompt, task));
    const res = await h.service().analyzeTranscript(options());
    const flag = res.sections.find((s) => s.verdict === 'flag' && s.category === 'conspiracy')!;
    expect(flag.description).toBe('"The deep state rigged the train timetable, folks."');
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

  it('a park mid-verification stops the whole run (never a quietly degraded flag)', async () => {
    const h = new Harness();
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

describe('AIAnalysisService: the parts a run makes', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
    jest_silence();
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-parts-spec-'));
    process.env.APPDATA = tmp;
  });

  const tasks = (h: Harness) => h.generated.map((g) => g.task);
  const metadataTasks = ['tags', 'description', 'title'];
  /** The video's stored chapters, as media-operations hands them over. */
  const stored = [
    { sequence: 1, start_time: '00:00:00', end_time: '00:01:00', title: 'Stored pasta', summary: 'They boil water.' },
    { sequence: 2, start_time: '00:01:00', end_time: '00:01:20', title: 'Stored travel', summary: 'Summer plans.' },
  ];

  it('no parts named is all three, chapters and flags sharing one scorer lease', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: true });
    expect(res.parts).toEqual(['chapters', 'flags', 'metadata']);
  });

  it('chapters and flags together: one scorer run for both, no metadata', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags', 'chapters'] });
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: true });
    expect(res.parts).toEqual(['chapters', 'flags']);
    expect(res.chapters).toHaveLength(2);
    expect(res.sections.length).toBeGreaterThan(0);
    expect(tasks(h).some((t) => metadataTasks.includes(t))).toBe(false);
    expect('tags' in res || 'description' in res || 'suggested_title' in res).toBe(false);
  });

  it('chapters alone: only the chapter pass and the summaries', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ flags: null });
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['chapters'] });
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(new Set(tasks(h))).toEqual(new Set(['chapter']));
    expect(res.parts).toEqual(['chapters']);
    expect(res.chapters.map((c) => c.title)).toEqual(['Pasta day', 'Summer travel']);
    expect(res.sections).toEqual([]);
    expect(res.tags).toBeUndefined();
  });

  it('flags alone: only the flag pass and the checks, no chapter or metadata call', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ chapters: null });
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(h.snapRuns[0]).toMatchObject({ chapters: false, flags: true });
    expect(new Set(tasks(h))).toEqual(new Set(['flags']));
    expect(res.parts).toEqual(['flags']);
    expect(res.chapters).toEqual([]);
    expect(res.sections.filter((s) => s.verdict === 'flag')).toHaveLength(3);
  });

  it("metadata alone is written from the video's stored chapters, with no scorer at all", async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['metadata'], existingChapters: stored });
    expect(h.snapRuns).toHaveLength(0);
    expect(tasks(h).sort()).toEqual(['description', 'description', 'tags', 'title']);
    const tagsPrompt = h.generated.find((g) => g.task === 'tags')!.prompt;
    expect(tagsPrompt).toContain('Stored pasta: They boil water.');
    expect(res.parts).toEqual(['metadata']);
    expect(res.chapters).toEqual([]);
    expect(res.tags).toEqual({ people: [], topics: ['cooking'] });
    expect(res.description).toContain('A hook.');
    expect(res.warnings).toBeUndefined();
  });

  it('metadata alone on a video with no chapters makes its chapters first, and the job says so', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ flags: null });
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['metadata'], existingChapters: [] });
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(res.parts).toEqual(['chapters', 'metadata']);
    expect(res.chapters.map((c) => c.title)).toEqual(['Pasta day', 'Summer travel']);
    expect(h.generated.find((g) => g.task === 'tags')!.prompt).toContain('Pasta day: A summary of it.');
    expect(res.warnings).toEqual(['Chapters were made first: metadata is written from chapter summaries, and this video had none.']);
  });

  it('flags and metadata on stored chapters: the flag pass alone in the scorer, metadata from the stored chapters', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ chapters: null });
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags', 'metadata'], existingChapters: stored });
    expect(h.snapRuns[0]).toMatchObject({ chapters: false, flags: true });
    expect(tasks(h).includes('chapter')).toBe(false);
    expect(res.parts).toEqual(['flags', 'metadata']);
    expect(h.generated.find((g) => g.task === 'title')!.prompt).toContain('Stored travel');
  });

  it("one chapter's flags: only its transcript is scored and checked, and every time is on the video's timeline", async () => {
    const h = new Harness();
    h.snapRun = async (req) => {
      // The scorer sees lines 2-5 (20 s to 60 s); its sentence indices are into them.
      expect(req.segments.map((s) => s.start)).toEqual([20, 30, 40, 50]);
      const window = {
        contextFrom: 0, contextTo: 3, firedFrom: 0, firedTo: 1,
        categories: [{ ...wcat('political-demonization', 0.9, [0, 1]), start: 20, end: 40 }],
        score: 0.9, spanIds: [0], strength: -3, heat: 1,
      } as FlagWindow;
      return snapResult({ chapters: null, flags: { ...snapResult().flags!, windows: [window] as any, overflow: [] } });
    };
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'], range: { start: 20, end: 60, label: 'Rant' } });
    expect(res.range).toEqual({ start: 20, end: 60, label: 'Rant' });
    expect(res.sections.map((s) => [s.start_time, s.end_time, s.verdict])).toEqual([['00:00:20', '00:00:40', 'flag']]);
    expect(res.sections[0].quotes[0].text).toBe(`${LINES[2]} ${LINES[3]}`);
    // The checker read the chapter's passage, not the video's start.
    const checked = h.generated.filter((g) => g.task === 'flags');
    expect(checked).toHaveLength(1);
    expect(checked[0].prompt).toContain('communists');
    expect(checked[0].prompt).not.toContain('pasta day');
  });

  it('a range that is not a flags-only run, or holds no transcript, fails by name', async () => {
    const h = new Harness();
    const both = await h.service().analyzeTranscript({ ...options(), parts: ['flags', 'chapters'], range: { start: 0, end: 30 } }).catch((e) => e);
    expect((both as Error).message).toMatch(/Only the flag analysis can run on part of a video/);
    const empty = await h.service().analyzeTranscript({ ...options(), parts: ['flags'], range: { start: 500, end: 600 } }).catch((e) => e);
    expect((empty as Error).message).toMatch(/no transcript falls inside 00:08:20-00:10:00/);
    expect(h.snapRuns).toHaveLength(0);
  });

  it('flags alone with every check failing fails (the stored flags stay), never an empty success', async () => {
    const h = new Harness();
    h.snapRun = async () => snapResult({ chapters: null });
    h.answer = async () => {
      throw new Error('Crucible http_500: the verifier fell over');
    };
    const err = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] }).catch((e) => e);
    expect((err as Error).message).toMatch(/no flag section could be checked.*the verifier fell over/);
  });

  it('metadata alone with neither tags nor description fails (the stored metadata stays)', async () => {
    const h = new Harness();
    h.answer = async () => {
      throw new Error('Crucible http_500: down');
    };
    const err = await h.service().analyzeTranscript({ ...options(), parts: ['metadata'], existingChapters: stored }).catch((e) => e);
    expect((err as Error).message).toMatch(/no metadata could be written.*down/);
  });

  it('progress: a skipped stage takes no share, the bar only moves forward, and it ends at 100', async () => {
    const run = async (extra: Partial<AnalysisOptions>, snap?: Partial<SnapStageResult>) => {
      const h = new Harness();
      h.snapRun = async (req) => {
        req.onProgress?.({ stage: 'chapters', fraction: 0.5, message: 'half' });
        req.onProgress?.({ stage: 'done', fraction: 1, message: 'done' });
        return snapResult(snap);
      };
      const seen: number[] = [];
      await h.service().analyzeTranscript({ ...options(), ...extra, onProgress: (p) => seen.push(p.progress) });
      return seen;
    };
    for (const seen of [
      await run({ parts: ['flags'] }, { chapters: null }),
      await run({ parts: ['chapters'] }, { flags: null }),
      await run({ parts: ['metadata'], existingChapters: stored }),
      await run({}),
    ]) {
      expect(seen[seen.length - 1]).toBe(100);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // Flags alone: the engine fills 3-84, the checks 84-98 (no chapter or metadata band).
    const flags = await run({ parts: ['flags'] }, { chapters: null });
    expect(flags).toContain(84);
    expect(flags.filter((p) => p > 84 && p < 100).length).toBeGreaterThan(0);
    // Metadata alone starts at 3 and fills the bar.
    const metadata = await run({ parts: ['metadata'], existingChapters: stored });
    expect(metadata).toEqual([0, 3, 35, 66, 100]);
  });

  it('a cancel during a flags-only run is a cancellation, with no metadata or chapter call after it', async () => {
    const h = new Harness();
    const svc = h.service();
    h.snapRun = async () => snapResult({ chapters: null });
    h.answer = async (_prompt, task) => {
      svc.cancelAnalysis('job-parts');
      return { text: '{"verdict":"flag","reason":"r"}', inputTokens: 1, outputTokens: 1, task } as any;
    };
    const err = await svc.analyzeTranscript({ ...options(), parts: ['flags'], jobId: 'job-parts' }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
    expect(tasks(h)).toEqual(['flags']);
  });
});

/** analyzeTranscript also console.logs; keep the test output readable. */
function jest_silence() {
  for (const k of ['log', 'warn', 'error'] as const) (console as any)[k] = () => undefined;
}
