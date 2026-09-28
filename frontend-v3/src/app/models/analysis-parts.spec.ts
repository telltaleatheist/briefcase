import { analysisPartsOf, describeAnalysisParts } from './analysis-parts';

describe('analysis parts on an ai-analyze config', () => {
  it('a config from before parts existed means all three', () => {
    expect(analysisPartsOf({ aiModel: 'claude:sonnet' })).toEqual(['metadata', 'chapters', 'flags']);
    expect(analysisPartsOf(undefined)).toEqual(['metadata', 'chapters', 'flags']);
  });

  it('a list is read in canonical order, unknown entries dropped, and an empty list stays empty', () => {
    expect(analysisPartsOf({ parts: ['flags', 'metadata', 'bogus'] })).toEqual(['metadata', 'flags']);
    expect(analysisPartsOf({ parts: [] })).toEqual([]);
  });

  it('describes the parts by their labels', () => {
    expect(describeAnalysisParts(['metadata', 'chapters', 'flags'])).toBe('Metadata, Chapters and Analysis');
    expect(describeAnalysisParts(['flags'])).toBe('Analysis');
  });
});
