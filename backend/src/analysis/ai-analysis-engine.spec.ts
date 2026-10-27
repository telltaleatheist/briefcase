import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AIAnalysisService, AnalysisOptions } from './ai-analysis.service';
import { AnalysisCancelledError, isCancellation } from './cancellation';
import { SnapEngineError, type SnapStageRequest, type SnapStageResult } from '../scorer/snap-analysis.service';
import { CrucibleChatError, CrucibleParkedError } from '../crucible/llm/errors';
import type { ChatMessage, TransportReply } from '../tool-harness';

/**
 * The analysis pipeline in AIAnalysisService.analyzeTranscript, end to end
 * with fakes: no model, no scorer, no network. The scorer makes the chapters
 * (snap is their only engine: a stage it cannot make fails the analysis by
 * name, a busy Crucible parks it); the flags are the clip-worthy moments the
 * flags model marks with add_marker (flag-highlights.ts). The config dir is a
 * temp dir (APPDATA), so the developer's real app-config is never read.
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

/** Two chapters from the scorer. */
function snapResult(over: Partial<SnapStageResult> = {}): SnapStageResult {
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
    flags: null,
    ...over,
  } as SnapStageResult;
}

/** One add_marker call in Claude's format. */
const invoke = (args: Record<string, string>) =>
  `<function_calls>\n<invoke name="add_marker">\n${Object.entries(args).map(([k, v]) => `<parameter name="${k}">${v}</parameter>`).join('\n')}\n</invoke>\n</function_calls>`;

/** The flags model's default answer: one moment (lines 2-5), then its closing line. */
const MARK_RANT = invoke({
  title: 'Calls opponents vermin', category: 'political-demonization', why: 'He calls them communists, vermin and traitors.',
  first_words: 'Those people are communists and enemies', last_words: 'everything we love if we let them',
});

class Harness {
  generated: Array<{ prompt: string; task: string; overrides?: Record<string, unknown> }> = [];
  snapRuns: SnapStageRequest[] = [];
  /** Crucible runs (queue sessions) opened. */
  runsOpened = 0;
  /** What the flag stage asked for: its context fit and its tool chat. */
  fitted: Array<Record<string, unknown>> = [];
  toolChats: Array<Record<string, unknown>> = [];
  /** Every flag-stage call's messages. */
  flagCalls: ChatMessage[][] = [];
  snapRun: (req: SnapStageRequest) => Promise<SnapStageResult> = async () => snapResult();
  /** Replaceable: every non-tool LLM call's answer. */
  answer: (prompt: string, task: string) => Promise<{ text: string; inputTokens: number; outputTokens: number; doneReason?: string }> = async () => ({
    text: '{"title":"LLM title","summary":"A summary of it.","people":[],"topics":["cooking"],"hook":"A hook.","body":"A body."}',
    inputTokens: 1, outputTokens: 1,
  });
  /** Replaceable: the flags model's reply to a flag-stage call (n counts calls from 1). */
  flagReply: (messages: ChatMessage[], n: number) => Promise<TransportReply> = async (messages) =>
    ({ text: messages.length === 2 ? `<candidates>1. the rant</candidates>\n${MARK_RANT}` : 'Calls opponents vermin' });
  /** The context the flag stage is told it has, and the tool format. */
  context: Record<string, unknown> = { tokens: 128000 };
  format: 'claude' | 'native' | 'tags' = 'claude';

  service(): AIAnalysisService {
    const provider = {
      generateText: async (prompt: string, _cfg: unknown, task: string, overrides?: Record<string, unknown>) => {
        this.generated.push({ prompt, task, overrides });
        return this.answer(prompt, task);
      },
      withRun: <T>(fn: () => Promise<T>) => {
        this.runsOpened++;
        return fn();
      },
      crucibleOllamaStandInChoice: async () => null,
      crucibleOllamaTakesContext: async () => true,
      crucibleContextWindow: async () => 32768,
      fitToolContext: async (_cfg: unknown, options: Record<string, unknown>) => {
        this.fitted.push(options);
        return this.context;
      },
      toolChat: async (_cfg: unknown, options: Record<string, unknown>) => {
        this.toolChats.push(options);
        const transport = async (messages: ChatMessage[]) => {
          const signal = options['signal'] as AbortSignal | undefined;
          if (signal?.aborted) throw new AnalysisCancelledError('cancelled');
          this.flagCalls.push(messages);
          this.generated.push({ prompt: messages[messages.length - 1].content, task: 'flags' });
          return this.flagReply(messages, this.flagCalls.length);
        };
        return { transport, format: this.format };
      },
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
    outputFile: path.join(tmp, 'analysis.txt'), categories: [{ name: 'political-demonization', description: 'Calls opponents communists.' } as any],
  };
}

describe('AIAnalysisService: chapters from the scorer, flags from the flags model', () => {
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

  it('each marked moment is one flag row: its category, title and "title — why" reason, verdict flag, ranker highlights-v1, padded to a clip', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(h.snapRuns[0].signal).toBeDefined();

    // Chapters: the scorer's boundaries and outline labels; the LLM wrote only summaries.
    expect(res.chapters.map((c) => [c.start_time, c.title, c.summary])).toEqual([
      ['00:00:00', 'Pasta day', 'A summary of it.'],
      ['00:01:00', 'Summer travel', 'A summary of it.'],
    ]);

    expect(res.sections).toEqual([{
      category: 'political-demonization',
      title: 'Calls opponents vermin',
      description: 'Calls opponents vermin — He calls them communists, vermin and traitors.',
      start_time: '00:00:20',
      end_time: '00:01:00',
      quotes: [{ timestamp: '00:00:20', text: LINES.slice(2, 6).join(' ') }],
      verdict: 'flag',
      ranker: 'highlights-v1',
    }]);
    expect(res.sections[0]).not.toHaveProperty('nli_score');
    expect(res.warnings).toBeUndefined();

    // One question (the 80 s video is one stretch) and its closing reply, on the flags model's tool chat:
    // the whole transcript in the system prompt, the stretch named in the question.
    expect(h.flagCalls).toHaveLength(2);
    expect(h.flagCalls[0][0].content).toContain(`TRANSCRIPT:\n${LINES.join('\n')}`);
    expect(h.flagCalls[0][0].content).toContain('- political-demonization: Calls opponents communists.');
    expect(h.flagCalls[0][1].content).toContain(`from the sentence "${LINES[0]}" to the sentence "${LINES[7]}"`);
    // The report holds the flag.
    expect(fs.readFileSync(path.join(tmp, 'analysis.txt'), 'utf8')).toContain('Calls opponents vermin');
  });

  it('a local model: the stage asks for its context fit, then a reply ceiling, thinking off and the load context it was fitted at', async () => {
    const h = new Harness();
    h.context = { tokens: 65536, loadContext: 65536, maxTokens: 131072 };
    await h.service().analyzeTranscript({ ...options(), provider: 'local', model: 'qwen3.5-9b', parts: ['flags'] });
    expect(h.fitted).toHaveLength(1);
    expect(h.fitted[0]['needed']).toBeGreaterThan(9000);
    expect(h.toolChats[0]).toMatchObject({ maxTokens: 6144, thinking: false, loadContext: 65536 });
  });

  it('a context too small for even a 3-minute stretch fails the flags by name', async () => {
    const h = new Harness();
    h.context = { tokens: 4096 };
    const err = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] }).catch((e) => e);
    expect((err as Error).message).toMatch(/context \(4,096 tokens\) is too small to read even a 3-minute stretch of transcript for flags/);
    expect(h.flagCalls).toHaveLength(0);
  });

  it('a Crucible that refuses native tools for the model is answered with tool tags instead', async () => {
    const h = new Harness();
    h.format = 'native';
    h.flagReply = async (messages, n) => {
      if (n === 1) throw new CrucibleChatError(400, 'tools_unsupported', 'qwen-x declares no tool format');
      return { text: messages.length === 2 ? `<tool_use>\n${JSON.stringify({ name: 'add_marker', arguments: { title: 'T', category: 'political-demonization', why: 'w', first_words: 'Those people are communists and enemies', last_words: 'traitor to this great nation' } })}\n</tool_use>` : 'T' };
    };
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(res.sections.map((s) => s.title)).toEqual(['T']);
    expect(h.flagCalls[1][0].content).toContain('<tool_use>');
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

  it('a park while finding flags stops the whole run (never a quietly skipped stretch)', async () => {
    const h = new Harness();
    h.flagReply = async () => {
      throw new CrucibleParkedError('mac', "Crucible on mac isn't answering.");
    };
    const err = await h.service().analyzeTranscript({ ...options(), jobId: 'job-q' }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect(h.flagCalls).toHaveLength(1);
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
    h.snapRun = async () => snapResult({ labelMassGated: { chapters: 2, flags: 0, refine: 0, total: 2 } });
    const res = await h.service().analyzeTranscript(options());
    expect(res.warnings).toEqual([expect.stringMatching(/^2 of the analysis engine's answers were read as no evidence/)]);
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
    writeAppConfig({ taskModels: { boundary: 'ollama:qwen3.5:4b' } });
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(res.chapters).toHaveLength(2);
    expect(h.generated.some((g) => g.task === 'boundary')).toBe(false);
  });

  it('a stored flagFinder (the retired "How flags are found" setting) is ignored: the flags model marks the flags', async () => {
    writeAppConfig({ flagFinder: 'snap' });
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns[0]).toMatchObject({ flags: false });
    expect(res.sections.map((s) => s.ranker)).toEqual(['highlights-v1']);
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

  it('no parts named is all three: the scorer for chapters only, the flags from the flags model', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(options());
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(res.parts).toEqual(['chapters', 'flags', 'metadata']);
    expect(res.sections).toHaveLength(1);
  });

  it('chapters and flags together, no metadata', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags', 'chapters'] });
    expect(h.snapRuns).toHaveLength(1);
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(res.parts).toEqual(['chapters', 'flags']);
    expect(res.chapters).toHaveLength(2);
    expect(res.sections.length).toBeGreaterThan(0);
    expect(tasks(h).some((t) => metadataTasks.includes(t))).toBe(false);
    expect('tags' in res || 'description' in res || 'suggested_title' in res).toBe(false);
  });

  it('chapters alone: only the chapter pass and the summaries', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['chapters'] });
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(new Set(tasks(h))).toEqual(new Set(['chapter']));
    expect(res.parts).toEqual(['chapters']);
    expect(res.chapters.map((c) => c.title)).toEqual(['Pasta day', 'Summer travel']);
    expect(res.sections).toEqual([]);
    expect(res.tags).toBeUndefined();
    expect(h.toolChats).toHaveLength(0);
  });

  it('flags alone: no scorer, no chapter or metadata call; only the flags model', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(h.snapRuns).toHaveLength(0);
    expect(new Set(tasks(h))).toEqual(new Set(['flags']));
    expect(res.parts).toEqual(['flags']);
    expect(res.chapters).toEqual([]);
    expect(res.sections.filter((s) => s.verdict === 'flag')).toHaveLength(1);
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
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['metadata'], existingChapters: [] });
    expect(h.snapRuns[0]).toMatchObject({ chapters: true, flags: false });
    expect(res.parts).toEqual(['chapters', 'metadata']);
    expect(res.chapters.map((c) => c.title)).toEqual(['Pasta day', 'Summer travel']);
    expect(h.generated.find((g) => g.task === 'tags')!.prompt).toContain('Pasta day: A summary of it.');
    expect(res.warnings).toEqual(['Chapters were made first: metadata is written from chapter summaries, and this video had none.']);
  });

  it('flags and metadata on stored chapters: no scorer, metadata from the stored chapters', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags', 'metadata'], existingChapters: stored });
    expect(h.snapRuns).toHaveLength(0);
    expect(tasks(h).includes('chapter')).toBe(false);
    expect(res.parts).toEqual(['flags', 'metadata']);
    expect(h.generated.find((g) => g.task === 'title')!.prompt).toContain('Stored travel');
  });

  it("one chapter's flags: only its transcript is read, and every time is on the video's timeline", async () => {
    const h = new Harness();
    h.flagReply = async (messages) => ({
      text: messages.length === 2
        ? invoke({ title: 'Vermin', category: 'political-demonization', why: 'w', first_words: 'They are vermin and they should', last_words: 'all be thrown out' })
        : 'Vermin',
    });
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'], range: { start: 20, end: 60, label: 'Rant' } });
    expect(res.range).toEqual({ start: 20, end: 60, label: 'Rant' });
    // Line 3 alone is 10 s: padded with whole sentences inside the range (two before for one after).
    expect(res.sections.map((s) => [s.start_time, s.end_time, s.verdict])).toEqual([['00:00:20', '00:00:50', 'flag']]);
    expect(res.sections[0].quotes[0].text).toBe(`${LINES[2]} ${LINES[3]} ${LINES[4]}`);
    // The flags model read the chapter's transcript, not the video's start.
    expect(h.flagCalls[0][0].content).toContain(LINES[2]);
    expect(h.flagCalls[0][0].content).not.toContain(LINES[0]);
    expect(h.flagCalls[0][0].content).not.toContain(LINES[6]);
  });

  it('a range that is not a flags-only run, or holds no transcript, fails by name', async () => {
    const h = new Harness();
    const both = await h.service().analyzeTranscript({ ...options(), parts: ['flags', 'chapters'], range: { start: 0, end: 30 } }).catch((e) => e);
    expect((both as Error).message).toMatch(/Only the flag analysis can run on part of a video/);
    const empty = await h.service().analyzeTranscript({ ...options(), parts: ['flags'], range: { start: 500, end: 600 } }).catch((e) => e);
    expect((empty as Error).message).toMatch(/no transcript falls inside 00:08:20-00:10:00/);
    expect(h.snapRuns).toHaveLength(0);
  });

  it('flags alone with every stretch failing fails (the stored flags stay), never an empty success', async () => {
    const h = new Harness();
    h.flagReply = async () => {
      throw new Error('Crucible http_500: the flags model fell over');
    };
    const err = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] }).catch((e) => e);
    expect((err as Error).message).toMatch(/no stretch of the transcript could be asked about.*the flags model fell over/);
  });

  it('a stretch with nothing clip-worthy is no flags and no warning: an empty answer is an answer', async () => {
    const h = new Harness();
    h.flagReply = async () => ({ text: 'Nothing clip-worthy in this stretch.' });
    const res = await h.service().analyzeTranscript({ ...options(), parts: ['flags'] });
    expect(res.sections).toEqual([]);
    expect(res.warnings).toBeUndefined();
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
    const run = async (extra: Partial<AnalysisOptions>) => {
      const h = new Harness();
      h.snapRun = async (req) => {
        req.onProgress?.({ stage: 'chapters', fraction: 0.5, message: 'half' });
        req.onProgress?.({ stage: 'done', fraction: 1, message: 'done' });
        return snapResult();
      };
      const seen: number[] = [];
      await h.service().analyzeTranscript({ ...options(), ...extra, onProgress: (p) => seen.push(p.progress) });
      return seen;
    };
    for (const seen of [
      await run({ parts: ['flags'] }),
      await run({ parts: ['chapters'] }),
      await run({ parts: ['metadata'], existingChapters: stored }),
      await run({}),
    ]) {
      expect(seen[seen.length - 1]).toBe(100);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // Metadata alone starts at 3 and fills the bar.
    const metadata = await run({ parts: ['metadata'], existingChapters: stored });
    expect(metadata).toEqual([0, 3, 35, 66, 100]);
  });

  it('a cancel during a flags-only run is a cancellation, with no metadata or chapter call after it', async () => {
    const h = new Harness();
    const svc = h.service();
    h.flagReply = async () => {
      svc.cancelAnalysis('job-parts');
      return { text: MARK_RANT };
    };
    const err = await svc.analyzeTranscript({ ...options(), parts: ['flags'], jobId: 'job-parts' }).catch((e) => e);
    expect(isCancellation(err)).toBe(true);
    expect(tasks(h)).toEqual(['flags']);
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

describe('AIAnalysisService: a video with no speech', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
    jest_silence();
  });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-spec-'));
    process.env.APPDATA = tmp;
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  // The real case: a 31.4 s clip of music whose transcript is one stray lyric.
  const noSpeech = (over: Partial<AnalysisOptions> = {}): AnalysisOptions => ({
    ...options(),
    transcript: 'I want to be a man',
    segments: [{ start: 0.16, end: 1.996, text: 'I want to be a man' }],
    durationSeconds: 31.4,
    ...over,
  });
  const untouched = (h: Harness) => {
    expect(h.runsOpened).toBe(0);
    expect(h.snapRuns).toHaveLength(0);
    expect(h.generated).toHaveLength(0);
  };

  it('makes no model call and stores the placeholder for every part', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(noSpeech());
    untouched(h);
    expect(res.parts).toEqual(['chapters', 'flags', 'metadata']);
    expect(res.chapters).toEqual([
      { sequence: 1, start_time: '00:00:00', end_time: '00:00:31', title: 'No speech', summary: 'No speech in this video (music, ambient sound or silence).' },
    ]);
    expect(res.sections).toEqual([]);
    expect(res.sections_count).toBe(0);
    expect(res.tags).toEqual({ people: [], topics: [] });
    expect(res.description).toBe('No speech in this video.');
    expect(res.suggested_title).toBeUndefined();
    const report = fs.readFileSync(path.join(tmp, 'analysis.txt'), 'utf-8');
    expect(report).toContain('VIDEO ANALYSIS RESULTS');
    expect(report).toContain('**VIDEO OVERVIEW**\n\nNo speech in this video.');
  });

  it('makes only the parts asked for', async () => {
    const h = new Harness();
    const svc = h.service();
    const chapters = await svc.analyzeTranscript(noSpeech({ parts: ['chapters'] }));
    expect(chapters.parts).toEqual(['chapters']);
    expect(chapters.chapters.map((c) => c.title)).toEqual(['No speech']);
    expect(chapters).not.toHaveProperty('description');

    const flags = await svc.analyzeTranscript(noSpeech({ parts: ['flags'], range: { start: 0, end: 10 } }));
    expect(flags).toMatchObject({ parts: ['flags'], sections: [], chapters: [], range: { start: 0, end: 10 } });

    // Metadata alone keeps the stored chapters, or makes the placeholder one when there are none.
    const stored = [{ sequence: 1, start_time: '00:00:00', end_time: '00:00:31', title: 'Old', summary: 'Old.' }];
    const metadata = await svc.analyzeTranscript(noSpeech({ parts: ['metadata'], existingChapters: stored }));
    expect(metadata).toMatchObject({ parts: ['metadata'], chapters: [], description: 'No speech in this video.' });
    const first = await svc.analyzeTranscript(noSpeech({ parts: ['metadata'], existingChapters: [] }));
    expect(first.parts).toEqual(['chapters', 'metadata']);
    expect(first.chapters.map((c) => c.title)).toEqual(['No speech']);
    untouched(h);
  });

  it('an empty transcript is no speech even with no known duration', async () => {
    const h = new Harness();
    const res = await h.service().analyzeTranscript(noSpeech({ transcript: '', segments: [], durationSeconds: undefined, parts: ['chapters'] }));
    untouched(h);
    expect(res.chapters.map((c) => c.title)).toEqual(['No speech']);
  });

  it('a short clip that is all speech is analyzed as usual', async () => {
    const h = new Harness();
    await h.service().analyzeTranscript(noSpeech({ durationSeconds: 3, parts: ['chapters'] }));
    expect(h.runsOpened).toBe(1);
    expect(h.snapRuns).toHaveLength(1);
  });
});

/** analyzeTranscript also console.logs; keep the test output readable. */
function jest_silence() {
  for (const k of ['log', 'warn', 'error'] as const) (console as any)[k] = () => undefined;
}
