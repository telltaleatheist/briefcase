import { ColumnSort, LibraryFilterService, columnComparator, nextColumnSort, readDeepSearch, rememberDeepSearch, uploadDateKey } from './library-filter.service';
import { VideoItem } from '../models/video.model';

describe('columnComparator (the search results column headers)', () => {
  const video = (id: string, name: string, downloadDate: string, duration: string) =>
    ({ id, name, downloadDate: new Date(downloadDate), duration } as unknown as VideoItem);
  const videos = [
    video('b', '2025-06-29 beta.mp4', '2026-01-05', '00:10:00'),
    video('c', '2026-01-02 alpha.mp4', '2025-03-01', '01:00:00'),
    video('a', '2024-07-19 gamma.mp4', '2026-02-01', '00:00:30'),
    video('u', 'undated.mp4', '2024-01-01', ''),
  ];
  const ids = (column: ColumnSort['column'], order: ColumnSort['order']) =>
    [...videos].sort(columnComparator({ column, order })).map(v => v.id);

  it('orders by upload date (the file name date), newest first by default, undated last', () => {
    expect(ids('upload', 'desc')).toEqual(['c', 'b', 'a', 'u']);
    expect(ids('upload', 'asc')).toEqual(['u', 'a', 'b', 'c']);
  });

  it('orders by download date, by name and by length, either way', () => {
    expect(ids('download', 'desc')).toEqual(['a', 'b', 'c', 'u']);
    expect(ids('download', 'asc')).toEqual(['u', 'c', 'b', 'a']);
    expect(ids('name', 'asc')).toEqual(['c', 'b', 'a', 'u']); // alpha, beta, gamma, undated: the date prefix is not part of the name
    expect(ids('name', 'desc')).toEqual(['u', 'a', 'b', 'c']);
    expect(ids('length', 'desc')).toEqual(['c', 'b', 'a', 'u']);
    expect(ids('length', 'asc')).toEqual(['u', 'a', 'b', 'c']);
  });

  it('breaks ties newest download first', () => {
    const same = [video('old', '2025-01-01 x.mp4', '2025-02-01', ''), video('new', '2025-01-01 y.mp4', '2025-03-01', '')];
    expect([...same].sort(columnComparator({ column: 'upload', order: 'asc' })).map(v => v.id)).toEqual(['new', 'old']);
  });
});

describe('uploadDateKey', () => {
  const named = (name: string, uploadDate?: Date) => ({ name, uploadDate } as unknown as VideoItem);
  it('reads the file name date, placing a third of a month mid-way through it, else the stored upload date', () => {
    expect(uploadDateKey(named('2025-03-14 a.mp4'))).toBe('2025-03-14');
    expect(uploadDateKey(named('2025-03-T2 a.mp4'))).toBe('2025-03-15');
    expect(uploadDateKey(named('2025 a.mp4'))).toBe('2025');
    expect(uploadDateKey(named('a.mp4', new Date(2024, 4, 9)))).toBe('2024-05-09');
    expect(uploadDateKey(named('a.mp4'))).toBe('');
  });
});

describe('nextColumnSort', () => {
  it('flips the sorted column, and starts another names A to Z, dates and lengths newest or longest first', () => {
    expect(nextColumnSort({ column: 'upload', order: 'desc' }, 'upload')).toEqual({ column: 'upload', order: 'asc' });
    expect(nextColumnSort({ column: 'upload', order: 'asc' }, 'upload')).toEqual({ column: 'upload', order: 'desc' });
    expect(nextColumnSort({ column: 'upload', order: 'desc' }, 'name')).toEqual({ column: 'name', order: 'asc' });
    expect(nextColumnSort({ column: 'name', order: 'asc' }, 'download')).toEqual({ column: 'download', order: 'desc' });
    expect(nextColumnSort({ column: 'name', order: 'asc' }, 'length')).toEqual({ column: 'length', order: 'desc' });
  });
});

describe('LibraryFilterService.sortVideos (the library)', () => {
  it('lists New first, then weeks newest first, Unknown last, newest download first within each', () => {
    const v = (id: string, downloadDate: string) => ({ id, name: id, downloadDate: new Date(downloadDate) } as unknown as VideoItem);
    const weeks = [
      { weekLabel: '2025-W10', videos: [v('a', '2025-03-03'), v('b', '2025-03-05')] },
      { weekLabel: 'Unknown', videos: [v('u', '2020-01-01')] },
      { weekLabel: '2026-W02', videos: [v('c', '2026-01-06')] },
      { weekLabel: 'New', videos: [v('n', '2026-10-01')] },
    ];
    new LibraryFilterService().sortVideos(weeks);
    expect(weeks.map(w => w.weekLabel)).toEqual(['New', '2026-W02', '2025-W10', 'Unknown']);
    expect(weeks[2].videos.map(x => x.id)).toEqual(['b', 'a']);
  });
});

describe('readDeepSearch', () => {
  afterEach(() => {
    localStorage.removeItem('briefcase-library-deep-search');
    localStorage.removeItem('briefcase-library-expanded-search');
  });

  it('remembers the choice, and carries over the old Expanded search choice once', () => {
    expect(readDeepSearch()).toBe(false);
    rememberDeepSearch(true);
    expect(readDeepSearch()).toBe(true);

    localStorage.removeItem('briefcase-library-deep-search');
    localStorage.setItem('briefcase-library-expanded-search', 'true');
    expect(readDeepSearch()).toBe(true);
    expect(localStorage.getItem('briefcase-library-expanded-search')).toBeNull();
    rememberDeepSearch(false);
    expect(readDeepSearch()).toBe(false);
  });
});
