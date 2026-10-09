import { startOfRange } from '../services/library-filter.service';
import { highlightPieces } from './library-search.model';

describe('highlightPieces', () => {
  it('cuts text into plain and matched pieces, skipping ranges that overlap or fall outside', () => {
    expect(highlightPieces('I hate Logan Paul.', [[7, 12], [13, 17]])).toEqual([
      { text: 'I hate ', hit: false },
      { text: 'Logan', hit: true },
      { text: ' ', hit: false },
      { text: 'Paul', hit: true },
      { text: '.', hit: false },
    ]);
    expect(highlightPieces('abc', [[1, 2], [1, 3], [2, 9]])).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ]);
  });
});

describe('startOfRange (the Date filter)', () => {
  it('is local midnight today, the Sunday of this week, the 1st of the month, and January 1st', () => {
    const now = new Date(2026, 9, 9, 15, 30); // Friday, Oct 9 2026
    expect(startOfRange('today', now)).toEqual(new Date(2026, 9, 9));
    expect(startOfRange('week', now)).toEqual(new Date(2026, 9, 4));
    expect(startOfRange('month', now)).toEqual(new Date(2026, 9, 1));
    expect(startOfRange('year', now)).toEqual(new Date(2026, 0, 1));
  });
});
