import { LibraryFilterService } from './library-filter.service';
import { VideoItem } from '../models/video.model';

describe('LibraryFilterService.videoComparator', () => {
  const service = new LibraryFilterService();
  const video = (id: string, downloadDate: string, name: string) => ({ id, name, downloadDate: new Date(downloadDate) } as unknown as VideoItem);
  const videos = [video('b', '2025-06-29', 'beta'), video('c', '2026-01-02', 'alpha'), video('a', '2024-07-19', 'gamma')];
  const ids = (sortBy: 'date' | 'name', sortOrder: 'asc' | 'desc') =>
    [...videos].sort(service.videoComparator({ sortBy, sortOrder })).map(v => v.id);

  it('orders by download date, newest first or oldest first', () => {
    expect(ids('date', 'desc')).toEqual(['c', 'b', 'a']);
    expect(ids('date', 'asc')).toEqual(['a', 'b', 'c']);
  });

  it('orders by name either way', () => {
    expect(ids('name', 'asc')).toEqual(['c', 'b', 'a']);
    expect(ids('name', 'desc')).toEqual(['a', 'b', 'c']);
  });
});
