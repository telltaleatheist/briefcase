import { describe, expect, it } from '@jest/globals';
import {
  AnalysisRequestError,
  analysisProgressBands,
  describeParts,
  resolveAnalysisParts,
  resolveAnalysisRange,
  segmentsInRange,
} from './analysis-parts';

describe('the parts a task asks for', () => {
  it('absent is all three (every job queued before parts existed)', () => {
    expect([...resolveAnalysisParts(undefined)].sort()).toEqual(['chapters', 'flags', 'metadata']);
    expect([...resolveAnalysisParts(null)].sort()).toEqual(['chapters', 'flags', 'metadata']);
  });

  it('a list is taken as it is', () => {
    expect([...resolveAnalysisParts(['metadata'])]).toEqual(['metadata']);
    expect([...resolveAnalysisParts(['flags', 'chapters'])].sort()).toEqual(['chapters', 'flags']);
  });

  it('an empty or unknown list is refused by name, never read as everything', () => {
    expect(() => resolveAnalysisParts([])).toThrow(AnalysisRequestError);
    expect(() => resolveAnalysisParts([])).toThrow(/at least one part/);
    expect(() => resolveAnalysisParts(['flags', 'summary'])).toThrow(/Unknown analysis part: summary/);
    expect(() => resolveAnalysisParts('flags')).toThrow(/must be a list/);
  });

  it('says what it makes in words', () => {
    expect(describeParts(['metadata', 'flags', 'chapters'])).toBe('chapters, flags and metadata');
    expect(describeParts(['metadata', 'chapters'])).toBe('chapters and metadata');
    expect(describeParts(['flags'])).toBe('flags');
  });
});

describe('a chapter range', () => {
  const flagsOnly = resolveAnalysisParts(['flags']);

  it('belongs to a flags-only run', () => {
    expect(resolveAnalysisRange({ start: 600, end: 1200, label: ' Q&A ' }, flagsOnly)).toEqual({ start: 600, end: 1200, label: 'Q&A' });
    expect(resolveAnalysisRange(undefined, flagsOnly)).toBeNull();
    expect(() => resolveAnalysisRange({ start: 0, end: 60 }, resolveAnalysisParts(['flags', 'chapters']))).toThrow(
      /Only the flag analysis can run on part of a video/,
    );
    expect(() => resolveAnalysisRange({ start: 0, end: 60 }, resolveAnalysisParts(undefined))).toThrow(AnalysisRequestError);
  });

  it('must be a real stretch of time', () => {
    expect(() => resolveAnalysisRange({ start: 60, end: 60 }, flagsOnly)).toThrow(/00:01:00-00:01:00 is empty/);
    expect(() => resolveAnalysisRange({ start: -5, end: 60 }, flagsOnly)).toThrow(AnalysisRequestError);
    expect(() => resolveAnalysisRange({ start: 'a', end: 60 }, flagsOnly)).toThrow(/needs a start and an end/);
  });

  it('keeps the segments that start inside it, at their real times', () => {
    const segments = [0, 10, 20, 30, 40].map((start) => ({ start, end: start + 10, text: `s${start}` }));
    expect(segmentsInRange(segments, { start: 10, end: 30 })).toEqual([
      { start: 10, end: 20, text: 's10' },
      { start: 20, end: 30, text: 's20' },
    ]);
  });
});

describe('progress bands', () => {
  const all = { engine: true, summaries: true, flags: true, metadata: true };

  it('with every stage running, the bands the pipeline always had', () => {
    expect(analysisProgressBands(all)).toEqual({ engine: [3, 70], summaries: [71, 80], flags: [80, 92], metadata: [92, 98] });
  });

  it('a skipped stage takes no share: the stages that run fill 3-98 in order, without gaps', () => {
    const cases = [
      { engine: true, summaries: true, flags: false, metadata: false },
      { engine: true, summaries: false, flags: true, metadata: false },
      { engine: false, summaries: false, flags: false, metadata: true },
      { engine: true, summaries: true, flags: false, metadata: true },
      { engine: true, summaries: false, flags: true, metadata: true },
    ];
    for (const run of cases) {
      const bands = analysisProgressBands(run);
      const on = (['engine', 'summaries', 'flags', 'metadata'] as const).filter((s) => run[s]);
      for (const stage of ['engine', 'summaries', 'flags', 'metadata'] as const) {
        expect(bands[stage] === null).toBe(!run[stage]);
      }
      const ranges = on.map((s) => bands[s]!);
      expect(ranges[0][0]).toBe(3);
      expect(ranges[ranges.length - 1][1]).toBe(98);
      for (let i = 1; i < ranges.length; i++) {
        // Each band starts where the last ended (the summaries one point past the engine).
        expect(ranges[i][0] - ranges[i - 1][1]).toBeGreaterThanOrEqual(0);
        expect(ranges[i][0] - ranges[i - 1][1]).toBeLessThanOrEqual(1);
        expect(ranges[i][1]).toBeGreaterThan(ranges[i][0]);
      }
    }
  });

  it('metadata alone is the whole bar; flags alone keeps the engine most of it', () => {
    expect(analysisProgressBands({ engine: false, summaries: false, flags: false, metadata: true }).metadata).toEqual([3, 98]);
    const flags = analysisProgressBands({ engine: true, summaries: false, flags: true, metadata: false });
    expect(flags).toEqual({ engine: [3, 84], summaries: null, flags: [84, 98], metadata: null });
  });

  it('nothing to run is no bands', () => {
    expect(analysisProgressBands({ engine: false, summaries: false, flags: false, metadata: false })).toEqual({
      engine: null, summaries: null, flags: null, metadata: null,
    });
  });
});
