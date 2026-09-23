import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { sectionScoringFields } from './analysis-section-copy';

describe('sectionScoringFields (re-inserting an existing analysis_sections row)', () => {
  it("keeps 'skip' and 'candidate' with their score and ranker (NULL would read as a confirmed flag)", () => {
    expect(sectionScoringFields({ verdict: 'skip', nli_score: 0.41, ranker: 'nli' })).toEqual({
      verdict: 'skip', nliScore: 0.41, ranker: 'nli',
    });
    expect(sectionScoringFields({ verdict: 'candidate', nli_score: 0.6, ranker: 'snap-v1' })).toEqual({
      verdict: 'candidate', nliScore: 0.6, ranker: 'snap-v1',
    });
    expect(sectionScoringFields({ verdict: 'flag', nli_score: 0.9, ranker: 'snap-v1' }).verdict).toBe('flag');
  });

  it('a legacy row (all NULL, or columns absent) stays legacy', () => {
    expect(sectionScoringFields({ verdict: null, nli_score: null, ranker: null })).toEqual({
      verdict: undefined, nliScore: undefined, ranker: undefined,
    });
    expect(sectionScoringFields({})).toEqual({ verdict: undefined, nliScore: undefined, ranker: undefined });
  });

  it('the transfer and the delete-undo both copy the scoring columns through', () => {
    // Both re-insert paths must spread these fields into insertAnalysisSection;
    // a copy that lists the columns by hand and forgets these three is the bug.
    for (const file of ['library-manager.service.ts', 'database.controller.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).toMatch(/\.\.\.sectionScoringFields\(/);
    }
  });
});
