import { describe, expect, it } from '@jest/globals';

import {
  ANALYSIS_ENGINE_ENV,
  engineLabel,
  parseAnalysisEngine,
  resolveAnalysisEngine,
  snapFallbackMessage,
  wantsScorer,
} from './analysis-engine';

const cfg = (o: unknown) => () => JSON.stringify(o);

describe('analysis engine setting', () => {
  it("defaults to 'classic' for both stages (today's pipeline) until the live eval passes", () => {
    const s = resolveAnalysisEngine({ env: {}, configDir: '/cfg', readFile: () => null });
    expect(s).toEqual({ chapters: 'classic', flags: 'classic', source: 'default' });
    expect(wantsScorer(s)).toBe(false);
  });

  it("reads app-config analysisEngine: 'snap' or per stage", () => {
    expect(resolveAnalysisEngine({ env: {}, readFile: cfg({ analysisEngine: 'snap' }) })).toEqual({
      chapters: 'snap', flags: 'snap', source: 'config',
    });
    const mixed = resolveAnalysisEngine({ env: {}, readFile: cfg({ analysisEngine: { chapters: 'snap', flags: 'nli' } }) });
    expect(mixed).toEqual({ chapters: 'snap', flags: 'classic', source: 'config' });
    expect(engineLabel(mixed)).toBe('mixed');
    expect(wantsScorer(mixed)).toBe(true);
    expect(parseAnalysisEngine({ flags: 'snap' })).toEqual({ chapters: 'classic', flags: 'snap' });
  });

  it(`${ANALYSIS_ENGINE_ENV} beats app-config`, () => {
    const s = resolveAnalysisEngine({ env: { [ANALYSIS_ENGINE_ENV]: 'SNAP' }, readFile: cfg({ analysisEngine: 'classic' }) });
    expect(s).toEqual({ chapters: 'snap', flags: 'snap', source: 'env' });
  });

  it('an unknown value is ignored by name and never enables snap', () => {
    const s = resolveAnalysisEngine({ env: { [ANALYSIS_ENGINE_ENV]: 'turbo' }, readFile: cfg({ analysisEngine: 'fast' }) });
    expect(s.chapters).toBe('classic');
    expect(s.flags).toBe('classic');
    expect(s.source).toBe('default');
    expect(s.ignored).toContain('turbo');
    expect(parseAnalysisEngine({ chapters: 'snap', flags: 'bogus' })).toBeNull();
  });

  it('an unreadable app-config is the default', () => {
    expect(resolveAnalysisEngine({ env: {}, readFile: () => '{not json' }).source).toBe('default');
  });

  it('the fallback warning says which stages fell back and why, briefly', () => {
    expect(snapFallbackMessage(['chapters', 'flags'], 'scorer model not found: /x.gguf')).toMatch(
      /^Chapters and flags were made with the classic analysis engine.*scorer model not found/,
    );
    expect(snapFallbackMessage(['flags'], 'x'.repeat(500)).length).toBeLessThan(400);
  });
});
