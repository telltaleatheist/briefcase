import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MediaOperationsService } from './media-operations.service';
import type { AnalysisOptions, AnalysisResult } from '../analysis/ai-analysis.service';
import { AnalysisCancelledError } from '../analysis/cancellation';
import type { AnalysisPart } from '../analysis/analysis-parts';
import type { DatabaseService } from '../database/database.service';

/**
 * analyzeVideo's storage rule, on a real library database: a run replaces the
 * stored output of the parts it MADE and keeps everything else. The analysis
 * itself is a fake that returns what each part would; the pipeline's own
 * behaviour per part is ai-analysis-engine.spec.ts.
 *
 * Needs a better-sqlite3 built for this Node (npm rebuild better-sqlite3).
 */
let Database: any = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  Database = null;
}
const suite = Database ? describe : describe.skip;

const RULE = '-'.repeat(80);
const BANNER = `${'='.repeat(80)}\nVIDEO ANALYSIS RESULTS\n${'='.repeat(80)}\n\n`;
const hms = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
const srtTime = (s: number) => `${hms(s)},000`;

/** 30 cues of 60 s: a half-hour video. */
const SRT = Array.from({ length: 30 }, (_, i) => `${i + 1}\n${srtTime(i * 60)} --> ${srtTime(i * 60 + 60)}\nLine ${i}.\n`).join('\n');

/** What a run of the given parts returns (and writes to its report file). */
function fakeRun(opts: AnalysisOptions): AnalysisResult {
  const parts = (opts.parts ?? ['chapters', 'flags', 'metadata']) as AnalysisPart[];
  const made: AnalysisPart[] = (['chapters', 'flags', 'metadata'] as const).filter((p) => parts.includes(p));
  const flags = made.includes('flags')
    ? opts.range
      ? [{ start: opts.range.start + 30, what: 'new in chapter' }]
      : [{ start: 120, what: 'new early' }, { start: 1500, what: 'new late' }]
    : [];
  let report = BANNER;
  if (made.includes('metadata')) report += `**VIDEO OVERVIEW**\n\nNew description.\n\n${RULE}\n\n`;
  for (const f of flags) report += `**${hms(f.start)} - ${hms(f.start + 20)} - ${f.what} [hate]**\n\n${RULE}\n\n`;
  fs.writeFileSync(opts.outputFile, report);
  return {
    parts: made,
    ...(opts.range ? { range: opts.range } : {}),
    sections_count: flags.length,
    sections: flags.map((f) => ({
      category: 'hate', description: f.what, start_time: hms(f.start), end_time: hms(f.start + 20), quotes: [],
      verdict: 'flag' as const, nli_score: 0.9, ranker: 'snap-v1' as const,
    })),
    chapters: made.includes('chapters')
      ? [
          { sequence: 1, start_time: '00:00:00', end_time: '00:15:00', title: 'New one', summary: 'First.' },
          { sequence: 2, start_time: '00:15:00', end_time: '00:30:00', title: 'New two', summary: 'Second.' },
        ]
      : [],
    ...(made.includes('metadata')
      ? { tags: { people: ['New Person'], topics: ['new topic'] }, description: 'New description.', suggested_title: 'a new suggested title' }
      : {}),
  };
}

suite('analyzeVideo replaces only the parts it made', () => {
  let dir = '';
  let db: DatabaseService;
  let media: MediaOperationsService;
  let calls: AnalysisOptions[];
  let run: (opts: AnalysisOptions) => Promise<AnalysisResult>;

  beforeAll(() => {
    Logger.overrideLogger(false);
    for (const k of ['log', 'warn', 'error'] as const) (console as any)[k] = () => undefined;
  });

  beforeEach(async () => {
    const { DatabaseService } = await import('../database/database.service');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-analyze-parts-'));
    fs.writeFileSync(path.join(dir, 'analysis-categories.json'), JSON.stringify({ categories: [{ name: 'hate' }] }));
    db = new DatabaseService({ setLibraryPath: () => undefined } as any);
    db.initializeDatabase(path.join(dir, 'library.db'));
    db.insertVideo({ id: 'v1', filename: 'show.mp4', fileHash: 'h1', currentPath: path.join(dir, 'show.mp4') });
    db.insertTranscript({ videoId: 'v1', plainText: 'Line.', srtFormat: SRT });

    // The previous analysis: two chapters (the second nested), three flags, a user marker, metadata.
    db.insertChapter({ id: 'old-1', videoId: 'v1', sequence: 1, startSeconds: 0, endSeconds: 600, title: 'Old one', description: 'Old first.', source: 'ai', level: 0 });
    db.insertChapter({ id: 'old-2', videoId: 'v1', sequence: 2, startSeconds: 600, endSeconds: 1800, title: 'Old two', description: '', source: 'ai', level: 0 });
    db.insertChapter({ id: 'old-2a', videoId: 'v1', sequence: 3, startSeconds: 600, endSeconds: 1200, title: 'Old two A', description: 'Old 2A.', source: 'ai', level: 1, parentId: 'old-2' });
    db.insertChapter({ id: 'old-2b', videoId: 'v1', sequence: 4, startSeconds: 1200, endSeconds: 1800, title: 'Old two B', description: 'Old 2B.', source: 'ai', level: 1, parentId: 'old-2' });
    for (const [id, start] of [['f-early', 100], ['f-mid', 700], ['f-late', 1300]] as const) {
      db.insertAnalysisSection({ id, videoId: 'v1', startSeconds: start, endSeconds: start + 20, title: 'hate', description: id, category: 'hate', source: 'ai', verdict: 'flag' });
    }
    db.insertCustomMarker({ id: 'user-1', videoId: 'v1', startSeconds: 650, endSeconds: 660, title: 'mine', category: 'marker' });
    db.insertTag({ id: 't-ai', videoId: 'v1', tagName: 'Old Person', source: 'ai' });
    db.insertTag({ id: 't-user', videoId: 'v1', tagName: 'my tag', source: 'user' });
    db.updateVideoDescription('v1', 'Old description.');
    db.updateVideoSuggestedTitle('v1', 'an old suggested title');
    db.insertAnalysis({
      videoId: 'v1',
      aiAnalysis:
        `${BANNER}**VIDEO OVERVIEW**\n\nOld description.\n\n${RULE}\n\n` +
        ['00:01:40 - old early', '00:11:40 - old mid', '00:21:40 - old late'].map((t) => `**${t} [hate]**\n\n${RULE}\n\n`).join(''),
      summary: 'an old suggested title',
      sectionsCount: 3,
      aiModel: 'old-model',
    });

    calls = [];
    run = async (opts) => fakeRun(opts);
    const aiAnalysis = {
      analyzeTranscript: async (opts: AnalysisOptions) => {
        calls.push(opts);
        return run(opts);
      },
    };
    const events = { emitTaskProgress: () => undefined, emitAnalysisCompleted: jestFn() };
    media = new MediaOperationsService(
      {} as any, {} as any, db, {} as any, {} as any, aiAnalysis as any, events as any, {} as any, {} as any, {} as any,
      { getConfigDir: () => dir } as any,
    );
    (media as any).verifyVideoMetadata = async () => undefined; // no ffprobe in a spec
  });

  afterEach(() => {
    db.closeDatabase();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const analyze = (options: Record<string, unknown>) =>
    media.analyzeVideo('v1', { aiModel: 'claude:claude-test', ...options } as any, 'job-1');
  const flagIds = () => db.getAnalysisSections('v1').filter((s: any) => s.id.startsWith('f-') || s.id.startsWith('section-')).map((s: any) => s.description);
  const chapterTitles = () => db.getChapters('v1').map((c) => c.title);
  const tagNames = () => db.getTags('v1').map((t) => t.tag_name).sort();
  const video = () => db.getVideoById('v1') as any;

  it('flags alone replace every AI flag and keep chapters, metadata and the user marker', async () => {
    const result = await analyze({ parts: ['flags'] });
    expect(result.success).toBe(true);
    expect(flagIds()).toEqual(['new early', 'new late']);
    expect(db.getAnalysisSections('v1').some((s: any) => s.id === 'user-1')).toBe(true);
    expect(chapterTitles()).toEqual(['Old one', 'Old two', 'Old two A', 'Old two B']);
    expect(tagNames()).toEqual(['Old Person', 'my tag']);
    expect(video().ai_description).toBe('Old description.');
    expect(video().suggested_title).toBe('an old suggested title');
    const row = db.getAnalysis('v1')!;
    expect(row.summary).toBe('an old suggested title');
    expect(row.sections_count).toBe(2);
    expect(row.ai_analysis).toContain('Old description.');
    expect(row.ai_analysis).toContain('new early');
    expect(row.ai_analysis).not.toContain('old mid');
    expect(calls[0].parts).toEqual(['flags']);
    expect(calls[0].existingChapters).toBeUndefined();
  });

  it('chapters alone replace the outline and keep flags and metadata', async () => {
    expect((await analyze({ parts: ['chapters'] })).success).toBe(true);
    expect(chapterTitles()).toEqual(['New one', 'New two']);
    expect(flagIds()).toEqual(['f-early', 'f-mid', 'f-late']);
    expect(tagNames()).toEqual(['Old Person', 'my tag']);
    expect(video().ai_description).toBe('Old description.');
    expect(db.getAnalysis('v1')!.ai_analysis).toContain('old mid');
  });

  it("metadata alone is written from the stored outline's leaves, and replaces only the metadata", async () => {
    expect((await analyze({ parts: ['metadata'] })).success).toBe(true);
    expect(calls[0].existingChapters!.map((c) => [c.start_time, c.title, c.summary])).toEqual([
      ['00:00:00', 'Old one', 'Old first.'],
      ['00:10:00', 'Old two A', 'Old 2A.'],
      ['00:20:00', 'Old two B', 'Old 2B.'],
    ]);
    expect(tagNames()).toEqual(['New Person', 'my tag', 'new topic']);
    expect(video().ai_description).toBe('New description.');
    expect(video().suggested_title).toBe('a new suggested title');
    expect(db.getAnalysis('v1')!.summary).toBe('a new suggested title');
    expect(chapterTitles()).toEqual(['Old one', 'Old two', 'Old two A', 'Old two B']);
    expect(flagIds()).toEqual(['f-early', 'f-mid', 'f-late']);
    const report = db.getAnalysis('v1')!.ai_analysis;
    expect(report).toContain('New description.');
    expect(report).toContain('old mid');
  });

  it('metadata alone on a video with no chapters stores the chapters the run made first', async () => {
    db.deleteChapters('v1');
    run = async (opts) => {
      expect(opts.existingChapters).toEqual([]);
      return { ...fakeRun({ ...opts, parts: ['chapters', 'metadata'] }) };
    };
    expect((await analyze({ parts: ['metadata'] })).success).toBe(true);
    expect(chapterTitles()).toEqual(['New one', 'New two']);
    expect(flagIds()).toEqual(['f-early', 'f-mid', 'f-late']);
  });

  it("one chapter's flags replace only the flags that start inside it, on the real timeline", async () => {
    const result = await analyze({ parts: ['flags'], range: { start: 600, end: 1200, label: 'Old two A' } });
    expect(result.success).toBe(true);
    expect(calls[0].range).toEqual({ start: 600, end: 1200, label: 'Old two A' });
    const rows = db.getAnalysisSections('v1') as any[];
    expect(rows.map((s) => [s.start_seconds, s.id === 'user-1' ? 'user marker' : s.description])).toEqual([
      [100, 'f-early'],
      [630, 'new in chapter'],
      [650, 'user marker'],
      [1300, 'f-late'],
    ]);
    expect(db.getAnalysis('v1')!.sections_count).toBe(3);
    const report = db.getAnalysis('v1')!.ai_analysis;
    expect(report.indexOf('old early')).toBeGreaterThan(-1);
    expect(report).not.toContain('old mid');
    expect(report.indexOf('new in chapter')).toBeGreaterThan(report.indexOf('old early'));
    expect(report.indexOf('old late')).toBeGreaterThan(report.indexOf('new in chapter'));
    expect(chapterTitles()).toHaveLength(4);
    expect(video().ai_description).toBe('Old description.');
  });

  it('every part (no parts named) replaces everything, as a full analysis always has', async () => {
    expect((await analyze({})).success).toBe(true);
    expect(flagIds()).toEqual(['new early', 'new late']);
    expect(chapterTitles()).toEqual(['New one', 'New two']);
    expect(tagNames()).toEqual(['New Person', 'my tag', 'new topic']);
  });

  it('a cancelled or failed run keeps the previous analysis whole', async () => {
    run = async () => {
      throw new AnalysisCancelledError('Analysis cancelled during snap flag ranking');
    };
    expect(await analyze({ parts: ['flags'], range: { start: 600, end: 1200 } })).toEqual({ success: false, error: 'Analysis cancelled' });
    run = async () => {
      throw new Error('AI analysis failed: no flag section could be checked');
    };
    expect((await analyze({ parts: ['flags'] })).success).toBe(false);
    expect(flagIds()).toEqual(['f-early', 'f-mid', 'f-late']);
    expect(chapterTitles()).toHaveLength(4);
    expect(video().ai_description).toBe('Old description.');
    expect(db.getAnalysis('v1')!.sections_count).toBe(3);
  });

  it('an impossible request fails by name before any work', async () => {
    const result = await analyze({ parts: ['chapters', 'flags'], range: { start: 600, end: 1200 } });
    expect(result).toEqual({ success: false, error: expect.stringMatching(/Only the flag analysis can run on part of a video/) });
    expect(calls).toHaveLength(0);
    expect((await analyze({ parts: [] })).error).toMatch(/at least one part/);
  });
});

function jestFn() {
  return (..._args: unknown[]) => undefined;
}
