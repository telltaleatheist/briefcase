import { LibraryFilterService, startOfRange } from '../services/library-filter.service';
import { highlightPieces, orderSearchHits, SearchHit } from './library-search.model';
import { VideoItem } from './video.model';

describe('orderSearchHits', () => {
  const hit = (id: string, downloadDate: string, titleRank?: 0 | 1 | 2 | 3) =>
    ({ video: { id, name: id, downloadDate: new Date(downloadDate) } as unknown as VideoItem, title: id, titleHighlights: [], titleRank, moments: [], momentCount: 0 }) as SearchHit;
  const newestFirst = new LibraryFilterService().videoComparator({ sortBy: 'date', sortOrder: 'desc' });

  it('lists the closest file name matches first and transcript-only hits last, newest first within each', () => {
    const hits = [
      hit('said-new', '2026-10-10'),
      hit('loose-new', '2026-10-01', 3),
      hit('exact-old', '2020-11-04', 0),
      hit('loose-old', '2025-01-01', 3),
      hit('words', '2024-01-01', 2),
    ];
    expect(orderSearchHits(hits, newestFirst).map(h => h.video.id)).toEqual(['exact-old', 'words', 'loose-new', 'loose-old', 'said-new']);
  });
});

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
