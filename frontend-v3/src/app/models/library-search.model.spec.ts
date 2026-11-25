import { columnComparator, DEFAULT_RESULTS_SORT, startOfRange } from '../services/library-filter.service';
import { highlightPieces, orderSearchHits, SearchHit } from './library-search.model';
import { VideoItem } from './video.model';

describe('orderSearchHits', () => {
  const hit = (id: string, uploadDate: string, titleRank?: 0 | 1 | 2 | 3) =>
    ({ video: { id, name: `${uploadDate} ${id}.mp4` } as unknown as VideoItem, title: id, titleHighlights: [], titleRank, moments: [], momentCount: 0 }) as SearchHit;
  const newestFirst = columnComparator(DEFAULT_RESULTS_SORT);

  it('lists the closest file name matches first and transcript-only hits last, newest upload first within each', () => {
    const hits = [
      hit('said-new', '2026-10-10'),
      hit('loose-new', '2026-10-01', 3),
      hit('exact-old', '2020-11-04', 0),
      hit('loose-old', '2025-01-01', 3),
      hit('words', '2024-01-01', 2),
    ];
    expect(orderSearchHits(hits, newestFirst).map(h => h.video.id)).toEqual(['exact-old', 'words', 'loose-new', 'loose-old', 'said-new']);
  });

  it('then names holding some of it, then what is said, then partial matches in the order the search gave', () => {
    const named = (h: SearchHit): SearchHit => ({ ...h, titleHighlights: [[0, 1]] });
    const partial = (h: SearchHit, found: number): SearchHit => ({ ...h, partial: { found, of: 4 } });
    const hits = [
      partial(hit('most', '2020-01-01'), 3),
      hit('said', '2024-01-01'),
      partial(hit('some-new', '2026-01-01'), 2),
      named(hit('mixed', '2021-01-01')),
      hit('exact', '2019-01-01', 0),
    ];
    expect(orderSearchHits(hits, newestFirst).map(h => h.video.id)).toEqual(['exact', 'mixed', 'said', 'most', 'some-new']);
  });
});

describe('orderSearchHits, the closest matches', () => {
  const hit = (id: string, extra: Partial<SearchHit>) =>
    ({ video: { id, name: `2024-01-01 ${id}.mp4` } as unknown as VideoItem, title: id, titleHighlights: [], moments: [], momentCount: 0, ...extra }) as SearchHit;

  it('list after whole-name matches and before the rest, closest first, partial or not', () => {
    const hits = [
      hit('said', {}),
      hit('second', { closest: 1 }),
      hit('partial', { partial: { found: 2, of: 4 } }),
      hit('first', { closest: 0, partial: { found: 3, of: 4 } }),
      hit('named', { titleRank: 3 }),
    ];
    expect(orderSearchHits(hits, columnComparator(DEFAULT_RESULTS_SORT)).map(h => h.video.id)).toEqual(['named', 'first', 'second', 'said', 'partial']);
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
