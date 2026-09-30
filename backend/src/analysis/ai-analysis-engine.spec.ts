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
  generated: Array<{ prompt: string; task: string; overrides?: Record<string, unknown> }> = [];
  snapRuns: SnapStageRequest[] = [];
  snapRun: (req: SnapStageRequest) => Promise<SnapStageResult> = async () => snapResult();
  /** Replaceable: every LLM call's answer. */
  answer: (prompt: string, task: string) => Promise<{ text: string; inputTokens: number; outputTokens: number; doneReason?: string }> = async (_prompt, task) => ({
    text: task === 'flags'
      ? '{"verdict":"flag","reason":"The speaker calls them communists and vermin as their own view."}'
      : '{"title":"LLM title","summary":"A summary of it.","people":[],"topics":["cooking"],"hook":"A hook.","body":"A body."}',
    inputTokens: 1, outputTokens: 1,
  });

  service(): AIAnalysisService {
    const provider = {
      generateText: async (prompt: string, _cfg: unknown, task: string, overrides?: Record<string, unknown>) => {
        this.generated.push({ prompt, task, overrides });
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

/** Write the temp app-config.json (APPDATA is the temp dir). */
function writeAppConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmp, 'briefcase'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'briefcase', 'app-config.json'), JSON.stringify(config));
}
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
    // These cases are the scorer's flag path ("How flags are found": Scorer).
    writeAppConfig({ flagFinder: 'snap' });
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
    writeAppConfig({ flagFinder: 'snap', taskModels: { boundary: 'ollama:qwen3.5:4b' } });
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
    writeAppConfig({ flagFinder: 'snap' });
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

describe('AIAnalysisService: the model reads the transcript for flags (the default)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
    jest_silence();
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-generate-spec-'));
    process.env.APPDATA = tmp; // no app-config: the default, generate
  });

  const isReading = (prompt: string) => prompt.startsWith('Read this part of a video transcript');
  const reads = (h: Harness) => h.generated.filter((g) => g.task === 'flags' && isReading(g.prompt));
  const checks = (h: Harness) => h.generated.filter((g) => g.task === 'flags' && !isReading(g.prompt));
  const passages = (...items: Array<[string, string, string[]]>) =>
    JSON.stringify({ passages: items.map(([first_words, last_words, categories]) => ({ first_words, last_words, categories })) });

  /** The reading answer, and a verifier that flags everything. */
  function generateHarness(reading: (prompt: string, n: number) => { text: string; doneReason?: string } | Promise<never>): Harness {
    const h = new Harness();
    const base = h.answer;
    let n = 0;
    h.answer = async (prompt, task) => {
      if (task === 'flags' && isReading(prompt)) {
        const r = await reading(prompt, ++n);
        return { inputTokens: 1, outputTokens: 1, ...r };
      }
      return base(prompt, task);
    };
    h.snapRun = async () => snapResult({ flags: null });
    return h;
  }

  it('reads the transcript on the flags model, finds each passage in it, checks it, and stores it as generate-v1 with its real times', async () => {
    const h = generateHarness(() => ({
      text: passages(
        ['Those people are communists and enemies', 'traitor to this great nation', ['political-demonization']],
        ['The deep state rigged the', 'train timetable folks', ['political-demonization']],
      ),
    }));
    const res = await h.service().analyzeTranscript(options());

    // The scorer still makes the chapters, and asks no flag question.
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });

    // One reading call (the whole transcript fits one chunk), sentence per line, local-model settings.
    expect(reads(h)).toHaveLength(1);
    const read = reads(h)[0];
    expect(read.prompt).toContain(`${LINES[2]}\n${LINES[3]}`);
    expect(read.prompt).toContain('- political-demonization: Calls political opponents communists');
    expect(read.overrides).toMatchObject({ temperature: 0, thinking: false, maxTokens: 4096 });
    expect((read.overrides!.format as any).properties.passages.items.properties.categories.items.enum).toEqual(['political-demonization']);

    // Two passages -> two windows -> one check each (the verifier prompt, unchanged).
    expect(checks(h)).toHaveLength(2);
    expect(checks(h)[0].prompt).toMatch(/^Transcript passage\./);
    const flags = res.sections.filter((s) => s.verdict === 'flag');
    expect(flags.map((s) => [s.start_time, s.end_time, s.category, s.ranker, s.nli_score])).toEqual([
      ['00:00:20', '00:00:50', 'political-demonization', 'generate-v1', undefined],
      ['00:01:10', '00:01:20', 'political-demonization', 'generate-v1', undefined],
    ]);
    expect(flags[0].quotes[0].text).toBe(LINES.slice(2, 5).join(' '));
    expect('nli_score' in flags[0]).toBe(false);
    expect(res.warnings).toBeUndefined();
  });

  it('a passage whose words are not in the transcript is dropped and counted, never guessed', async () => {
    const h = generateHarness(() => ({
      text: passages(
        ['They are vermin and they', 'should all be thrown out', ['political-demonization']],
        ['The moon landing was staged by', 'the government in a studio', ['political-demonization']],
      ),
    }));
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(res.sections.map((s) => s.start_time)).toEqual(['00:00:30']);
    expect(res.warnings).toEqual([
      'Flags: 1 of the 2 passages the model marked could not be found in the transcript (their first or last words did not match) and were dropped.',
    ]);
  });

  it('a cloud model gets no schema-bound answer: its prose-wrapped JSON is read all the same', async () => {
    const h = generateHarness(() => ({
      text: 'Sure! Here is what I found:\n```json\n' + passages(['The deep state rigged the train', 'timetable, folks.', ['Political demonization']]) + '\n```',
    }));
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(res.sections.map((s) => [s.start_time, s.category])).toEqual([['00:01:10', 'political-demonization']]);
  });

  /** 60 lines of ~150 characters: more than one 8,000-character chunk. */
  const LONG = Array.from({ length: 120 }, (_u, i) => `Line ${i} is about the weather and the garden and nothing else at all, said slowly and at some length for the tape ${'z'.repeat(40)}.`);
  const longOptions = (): AnalysisOptions => ({
    ...options(),
    parts: ['flags'],
    segments: LONG.map((text, i) => ({ start: i * 10, end: i * 10 + 10, text })),
    transcript: LONG.join(' '),
  });

  it('a long transcript is read chunk by chunk, one after another, and the bar says which chunk', async () => {
    const h = generateHarness((prompt) => {
      const first = /Line (\d+) is/.exec(prompt.split('TRANSCRIPT:\n')[1])![1];
      return { text: passages([`Line ${first} is about the weather`, `Line ${first} is about the weather`, ['political-demonization']]) };
    });
    const messages: string[] = [];
    const res = await h.service().analyzeTranscript({ ...longOptions(), onProgress: (p) => messages.push(p.message) });
    const n = reads(h).length;
    expect(n).toBeGreaterThan(1);
    for (let k = 1; k <= n; k++) expect(messages).toContain(`Reading for flags: chunk ${k}/${n}...`);
    // Chunks overlap by two lines and cut at lines.
    const firstLines = reads(h).map((r) => Number(/Line (\d+) is/.exec(r.prompt.split('TRANSCRIPT:\n')[1])![1]));
    const lastLines = reads(h).map((r) => Number([...r.prompt.matchAll(/Line (\d+) is/g)].at(-1)![1]));
    for (let k = 1; k < n; k++) expect(firstLines[k]).toBe(lastLines[k - 1] - 1);
    expect(res.sections.length).toBeGreaterThan(0);
    expect(res.sections.every((s) => s.ranker === 'generate-v1')).toBe(true);
  });

  it('a chunk that fails, or comes back unreadable, is named in the warnings and not asked again; the rest stand', async () => {
    const h = generateHarness((_prompt, n) => {
      if (n === 1) throw new Error('Crucible http_500: the engine fell over');
      if (n === 2) return { text: 'I am not able to help with that.' };
      return { text: passages(['Line', 'Line', ['political-demonization']]) };
    });
    const res = await h.service().analyzeTranscript(longOptions());
    const n = reads(h).length;
    expect(n).toBeGreaterThan(2);
    expect(res.warnings![0]).toMatch(
      new RegExp(`^Flags: 2 of ${n} transcript chunks could not be read, so no flags were looked for in them: chunk 1 \\(00:00:00-00:\\d\\d:\\d\\d\\): Crucible http_500: the engine fell over; chunk 2 \\(.*\\): the answer held no passages that could be read$`),
    );
  });

  it('a reply cut off at the token limit keeps its whole passages, and the job says which chunk was cut', async () => {
    const h = generateHarness(() => ({
      text: '{"passages":[{"first_words":"They are vermin and they","last_words":"thrown out","categories":["political-demonization"]},{"first_words":"Every one of',
      doneReason: 'length',
    }));
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(res.sections.map((s) => s.start_time)).toEqual(['00:00:30']);
    expect(res.warnings).toEqual([
      "Flags: 1 of 1 transcript chunks reached the model's output limit (4096 tokens); passages after the cut were not read: chunk 1 (00:00:00-00:01:20)",
    ]);
  });

  it('every chunk failing fails the analysis with the real error (the stored flags stay); no scorer is asked instead', async () => {
    const h = generateHarness(() => {
      throw new Error('Crucible http_500: out of memory');
    });
    const err = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] }).catch((e) => e);
    expect((err as Error).message).toMatch(/no part of the transcript could be read for flags — all 1 chunk\(s\) failed\. Last failure: chunk 1 .*out of memory/);
    expect(h.snapRuns).toHaveLength(0);
    expect(checks(h)).toHaveLength(0);
  });

  it('a cancel while reading stops at once: no further chunk, no check, a cancellation', async () => {
    const h = new Harness();
    const svc = h.service();
    h.answer = async () => {
      svc.cancelAnalysis('job-read');
      return { text: passages(['Line 0 is about', 'Line 0 is about', ['political-demonization']]), inputTokens: 1, outputTokens: 1 };
    };
    const err = await svc.analyzeTranscript({ ...longOptions(), jobId: 'job-read' }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
    expect(reads(h)).toHaveLength(1);
    expect(checks(h)).toHaveLength(0);
  });

  it('a park while reading is not a failed chunk: it stops the run and goes up as it is', async () => {
    const h = generateHarness(() => {
      throw new CrucibleParkedError('mac', "Crucible on mac isn't answering.");
    });
    const err = await h.service().analyzeTranscript({ ...options(), parts: ['flags'], jobId: 'job-park' }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
  });

  it("one chapter's range: only its transcript is read, and the flag stays on the video's timeline", async () => {
    const h = generateHarness(() => ({ text: passages(['They are vermin', 'thrown out', ['political-demonization']]) }));
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'], range: { start: 20, end: 60, label: 'Rant' } });
    const transcript = reads(h)[0].prompt.split('TRANSCRIPT:\n')[1];
    expect(transcript.split('\n')).toEqual(LINES.slice(2, 6));
    expect(res.sections.map((s) => [s.start_time, s.end_time])).toEqual([['00:00:30', '00:00:40']]);
    expect(res.range).toEqual({ start: 20, end: 60, label: 'Rant' });
  });

  it('the setting switches between the two: Scorer runs the decide ranking and no reading call', async () => {
    fs.mkdirSync(path.join(tmp, 'briefcase'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'briefcase', 'app-config.json'), JSON.stringify({ flagFinder: 'snap' }));
    const snap = new Harness();
    const snapRes = await snap.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(snap.snapRuns[0]).toMatchObject({ chapters: false, flags: true });
    expect(reads(snap)).toHaveLength(0);
    expect(snapRes.sections.every((s) => s.ranker === 'snap-v1' && typeof s.nli_score === 'number')).toBe(true);

    fs.writeFileSync(path.join(tmp, 'briefcase', 'app-config.json'), JSON.stringify({ flagFinder: 'generate' }));
    const gen = generateHarness(() => ({ text: passages(['They are vermin', 'thrown out', ['political-demonization']]) }));
    await gen.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(gen.snapRuns).toHaveLength(0); // flags alone: the scorer is not taken at all
    expect(reads(gen)).toHaveLength(1);
  });

  it('progress: flags alone fills the bar with reading then checking, only forward, ending at 100', async () => {
    const h = generateHarness(() => ({ text: passages(['They are vermin', 'thrown out', ['political-demonization']]) }));
    const seen: Array<[number, string]> = [];
    await h.service().analyzeTranscript({ ...options(), parts: ['flags'], onProgress: (p) => seen.push([p.progress, p.message]) });
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
    expect(seen.find(([, m]) => m === 'Reading for flags: chunk 1/1...')![0]).toBe(3);
    expect(seen.find(([, m]) => m.startsWith('Verifying flag candidates 1/1'))![0]).toBe(98);
    expect(seen.at(-1)![0]).toBe(100);
  });
});

describe('AIAnalysisService: stories are the chapters grouped', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
    jest_silence();
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-stories-spec-'));
    process.env.APPDATA = tmp;
    writeAppConfig({ flagFinder: 'snap' });
  });

  // A 20-minute show, a sentence every 20 s.
  const LONG = Array.from({ length: 60 }, (_, i) => ({ start: i * 20, end: i * 20 + 20, text: `Detail number ${i} was discussed at length.` }));
  const longOptions = (): AnalysisOptions => ({ ...options(), segments: LONG, transcript: LONG.map((s) => s.text).join(' '), parts: ['chapters'] });
  const grouping = (g: { prompt: string }) => g.prompt.startsWith('Below are the chapters of one video');
  const ch = (startSeconds: number, endSeconds: number, title: string, from: number, to: number, isAd = false) =>
    ({ startSeconds, endSeconds, title, label: title, sentenceRange: [from, to] as [number, number], isAd });
  const chapterRun = (list: ReturnType<typeof ch>[]) => ({
    chapters: list, outline: [], chunks: [], seams: [], timings: { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 },
  });
  const FOUR = [
    ch(0, 300, 'Prophetic timeline', 0, 15),
    ch(300, 600, 'The Purim pattern', 15, 30),
    ch(600, 660, 'Sponsor / self-promotion', 30, 33, true),
    ch(660, 1200, 'The midterms', 33, 60),
  ];

  function longHarness(groupingAnswers: string[], list = FOUR): Harness {
    const h = new Harness();
    const base = h.answer;
    h.answer = async (prompt, task) =>
      grouping({ prompt }) ? { text: groupingAnswers.shift() ?? '', inputTokens: 1, outputTokens: 1 } : base(prompt, task);
    h.snapRun = async () => snapResult({ chapters: chapterRun(list), flags: null });
    return h;
  }

  it('10 minutes or more: after the summaries, one call on the chapter model groups the chapters; sponsors stand alone', async () => {
    const h = longHarness(['1 | The prophetic timeline | Why 9/11 and Purim line up.\n3 | Ad | x\n4 | The midterms | What the midterms mean.']);
    const seen: string[] = [];
    const res = await h.service().analyzeTranscript({ ...longOptions(), onProgress: (p) => seen.push(p.message) });
    const calls = h.generated.filter(grouping);
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe('chapter');
    expect(calls[0].overrides).toMatchObject({ temperature: 0, thinking: false, maxTokens: 8192 });
    expect(calls[0].prompt).toContain('The video runs 20 minutes.');
    expect(calls[0].prompt).toContain('1. [00:00:00-00:05:00] Prophetic timeline\n   A summary of it.');
    expect(calls[0].prompt).toContain('3. [00:10:00-00:11:00] [SPONSOR] Sponsor / self-promotion');
    // The chapters are the whole video's, with no sub-chapters: stories are the second level.
    expect(h.snapRuns[0]).toMatchObject({ refineOptions: false });
    expect(res.chapters.map((c) => [c.start_time, c.end_time, c.title, c.summary, c.level, c.parent_sequence])).toEqual([
      ['00:00:00', '00:10:00', 'The prophetic timeline', 'Why 9/11 and Purim line up.', 0, undefined],
      ['00:00:00', '00:05:00', 'Prophetic timeline', 'A summary of it.', 1, 1],
      ['00:05:00', '00:10:00', 'The Purim pattern', 'A summary of it.', 1, 1],
      // A sponsor story is named by its chapter, whatever the model called it.
      ['00:10:00', '00:11:00', 'Sponsor / self-promotion', 'A summary of it.', 0, undefined],
      ['00:10:00', '00:11:00', 'Sponsor / self-promotion', 'A summary of it.', 1, 4],
      ['00:11:00', '00:20:00', 'The midterms', 'What the midterms mean.', 0, undefined],
      ['00:11:00', '00:20:00', 'The midterms', 'A summary of it.', 1, 6],
    ]);
    // After the summaries it reads.
    const summaries = seen.findIndex((m) => m.startsWith('Analyzing chapter'));
    expect(seen.indexOf('Grouping 4 chapters into stories...')).toBeGreaterThan(summaries);
    expect(res.warnings).toBeUndefined();
  });

  it('a sponsor the model left inside a story is split out, and the subject after it is a new story', async () => {
    const h = longHarness(['1 | One long argument | All of it.']);
    const res = await h.service().analyzeTranscript(longOptions());
    expect(res.chapters.filter((c) => c.level === 0).map((c) => [c.start_time, c.title])).toEqual([
      ['00:00:00', 'One long argument'],
      ['00:10:00', 'Sponsor / self-promotion'],
      ['00:11:00', 'One long argument'],
    ]);
  });

  it('one story keeps the outline flat: no story row', async () => {
    const list = [ch(0, 600, 'Part one', 0, 30), ch(600, 1200, 'Part two', 30, 60)];
    const h = longHarness(['1 | The whole thing | One subject.'], list);
    const res = await h.service().analyzeTranscript(longOptions());
    expect(res.chapters.map((c) => [c.title, (c as { level?: number }).level])).toEqual([['Part one', undefined], ['Part two', undefined]]);
  });

  it('an unusable grouping is asked again once with its problem named, then fails the Chapters part', async () => {
    const h = longHarness(['2 | Starts late | x', 'I cannot help with that.']);
    const err = await h.service().analyzeTranscript(longOptions()).catch((e) => e);
    const calls = h.generated.filter(grouping);
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('Your previous answer could not be used: the first story must start at chapter 1, not 2.');
    expect((err as Error).message).toMatch(/^AI analysis failed: the stories could not be found: .*could not be used twice. Last problem: no line had the form/);
  });

  it('a retry that reads is used', async () => {
    const h = longHarness(['nonsense', '1 | A | a.\n4 | B | b.']);
    const res = await h.service().analyzeTranscript(longOptions());
    expect(res.chapters.filter((c) => c.level === 0).map((c) => c.title)).toEqual(['A', 'Sponsor / self-promotion', 'B']);
  });

  it('a video under 10 minutes makes no grouping call and stays flat', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['chapters'] });
    expect(h.generated.some(grouping)).toBe(false);
    expect(res.chapters.map((c) => c.title)).toEqual(['Pasta day', 'Summer travel']);
  });
});

/** analyzeTranscript also console.logs; keep the test output readable. */
function jest_silence() {
  for (const k of ['log', 'warn', 'error'] as const) (console as any)[k] = () => undefined;
}
