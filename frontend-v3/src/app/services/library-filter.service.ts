import { Injectable } from '@angular/core';
import { VideoItem, VideoWeek } from '../models/video.model';
import { extractDateFromFilename, extractTitleFromFilename } from '@shared/filename-utils';

export interface LibraryFilters {
  /** The library search (backend search/library-search.ts); filters below narrow its results too. */
  searchQuery: string;
  /**
   * Deep search: also what is said in the transcripts, by its words and by
   * its meaning (the meaning index). Off, only file names are searched. Remembered.
   */
  deepSearch: boolean;
  dateRange: 'all' | 'today' | 'week' | 'month' | 'year';
  mediaType: 'all' | 'video' | 'audio' | 'image' | 'document' | 'webpage';
  duration: 'all' | 'under10' | 'over10';
  hasTranscript: boolean | null;
  hasAnalysis: boolean | null;
  hasSuggestions: boolean | null;
}

/**
 * A column of the search results (the header over them, like Finder's list
 * view): the name, the upload date (the file name's date prefix, when it was
 * recorded or posted), the download date (when it was grabbed) and the length.
 */
export type ResultsColumn = 'name' | 'upload' | 'download' | 'length';

export interface ColumnSort {
  column: ResultsColumn;
  order: 'asc' | 'desc';
}

/** Search results open newest upload first. */
export const DEFAULT_RESULTS_SORT: ColumnSort = { column: 'upload', order: 'desc' };

/**
 * The sort after a column header is clicked: the same column flips, another
 * starts the way it is most often wanted (names A to Z; dates and lengths
 * newest or longest first).
 */
export function nextColumnSort(current: ColumnSort, column: ResultsColumn): ColumnSort {
  if (current.column === column) return { column, order: current.order === 'asc' ? 'desc' : 'asc' };
  return { column, order: column === 'name' ? 'asc' : 'desc' };
}

/**
 * The upload date as a sortable string: the file name's date prefix (a third
 * of a month, YYYY-MM-T#, sorts mid-way through it), else the stored upload
 * date; empty when there is neither, so undated videos sort as the oldest.
 */
export function uploadDateKey(video: VideoItem): string {
  const prefix = extractDateFromFilename(video.name);
  if (prefix) return prefix.replace(/-T([123])$/, (_, third: string) => `-${['05', '15', '25'][Number(third) - 1]}`);
  if (!video.uploadDate) return '';
  const d = new Date(video.uploadDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** How two videos compare under a column sort (Name: the title shown, without the date prefix); ties go newest download first, then by file name. */
export function columnComparator(sort: ColumnSort): (a: VideoItem, b: VideoItem) => number {
  const sign = sort.order === 'asc' ? 1 : -1;
  const downloaded = (v: VideoItem) => (v.downloadDate ? new Date(v.downloadDate).getTime() : 0);
  const byName = (a: VideoItem, b: VideoItem) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
  // The name as the list shows it: without its date prefix and extension.
  const byTitle = (a: VideoItem, b: VideoItem) =>
    extractTitleFromFilename(a.name).localeCompare(extractTitleFromFilename(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const primary = (a: VideoItem, b: VideoItem): number => {
    switch (sort.column) {
      case 'name': return byTitle(a, b);
      case 'upload': return uploadDateKey(a).localeCompare(uploadDateKey(b));
      case 'download': return downloaded(a) - downloaded(b);
      case 'length': return parseDurationToSeconds(a.duration) - parseDurationToSeconds(b.duration);
    }
  };
  return (a, b) => sign * primary(a, b) || downloaded(b) - downloaded(a) || byName(a, b);
}

/** A duration (HH:MM:SS or MM:SS) in seconds; 0 when there is none. */
export function parseDurationToSeconds(duration: string | undefined): number {
  if (!duration) return 0;
  const parts = duration.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

@Injectable({
  providedIn: 'root'
})
export class LibraryFilterService {

  /**
   * Apply all non-search filters to video weeks
   */
  applyFilters(weeks: VideoWeek[], filters: LibraryFilters, now: Date = new Date()): VideoWeek[] {
    let result = [...weeks];

    // Apply dateRange: downloaded (else added) since the start of today, this
    // week (Sunday), this month or this year, in local time.
    if (filters.dateRange !== 'all') {
      const since = startOfRange(filters.dateRange, now).getTime();
      result = result.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video => {
          const when = video.downloadDate ?? video.addedAt;
          return when !== undefined && new Date(when).getTime() >= since;
        })
      })).filter(week => week.videos.length > 0);
    }

    // Apply hasSuggestions filter
    if (filters.hasSuggestions !== null) {
      const wantsSuggestions = filters.hasSuggestions;
      result = result.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video =>
          wantsSuggestions
            ? video.suggestedTitle && video.suggestedTitle.trim().length > 0
            : !video.suggestedTitle || video.suggestedTitle.trim().length === 0
        )
      })).filter(week => week.videos.length > 0);
    }

    // Apply hasTranscript filter
    if (filters.hasTranscript !== null) {
      const wantsTranscript = filters.hasTranscript;
      result = result.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video =>
          wantsTranscript ? video.hasTranscript : !video.hasTranscript
        )
      })).filter(week => week.videos.length > 0);
    }

    // Apply hasAnalysis filter
    if (filters.hasAnalysis !== null) {
      const wantsAnalysis = filters.hasAnalysis;
      result = result.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video =>
          wantsAnalysis ? video.hasAnalysis : !video.hasAnalysis
        )
      })).filter(week => week.videos.length > 0);
    }

    // Apply mediaType filter
    if (filters.mediaType && filters.mediaType !== 'all') {
      const targetType = filters.mediaType;
      result = result.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video => {
          const videoMediaType = video.mediaType?.toLowerCase() || 'video';
          return videoMediaType === targetType;
        })
      })).filter(week => week.videos.length > 0);
    }

    // Apply duration filter (10 minutes = 600 seconds)
    if (filters.duration && filters.duration !== 'all') {
      const threshold = 600;
      const wantsUnder = filters.duration === 'under10';
      result = result.map(week => ({
        weekLabel: week.weekLabel,
        videos: week.videos.filter(video => {
          const durationSeconds = parseDurationToSeconds(video.duration);
          return wantsUnder ? durationSeconds < threshold : durationSeconds >= threshold;
        })
      })).filter(week => week.videos.length > 0);
    }

    return result;
  }

  /**
   * The library's order: its week sections newest first ("New" on top,
   * "Unknown" last), newest download first within each.
   */
  sortVideos(weeks: VideoWeek[]): void {
    weeks.sort((a, b) => {
      if (a.weekLabel === 'New') return -1;
      if (b.weekLabel === 'New') return 1;
      if (a.weekLabel === 'Unknown') return 1;
      if (b.weekLabel === 'Unknown') return -1;
      return b.weekLabel.localeCompare(a.weekLabel);
    });
    const newestDownloadFirst = columnComparator({ column: 'download', order: 'desc' });
    for (const week of weeks) week.videos.sort(newestDownloadFirst);
  }

  /**
   * Get default filters
   */
  getDefaultFilters(): LibraryFilters {
    return {
      searchQuery: '',
      deepSearch: readDeepSearch(),
      dateRange: 'all',
      mediaType: 'all',
      duration: 'all',
      hasTranscript: null,
      hasAnalysis: null,
      hasSuggestions: null
    };
  }
}

/** The local start of today, this week (Sunday), this month or this year. */
export function startOfRange(range: 'today' | 'week' | 'month' | 'year', now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'week') start.setDate(start.getDate() - start.getDay());
  if (range === 'month') start.setDate(1);
  if (range === 'year') start.setMonth(0, 1);
  return start;
}

const DEEP_SEARCH_KEY = 'briefcase-library-deep-search';
/** Before 2026-10-17 the choice was "Expanded search" (meaning on top of words); Deep search covers it. */
const OLD_EXPANDED_SEARCH_KEY = 'briefcase-library-expanded-search';

/** The remembered Deep search choice (off when storage is unavailable). */
export function readDeepSearch(): boolean {
  try {
    const old = localStorage.getItem(OLD_EXPANDED_SEARCH_KEY);
    if (old !== null) {
      localStorage.removeItem(OLD_EXPANDED_SEARCH_KEY);
      if (localStorage.getItem(DEEP_SEARCH_KEY) === null) localStorage.setItem(DEEP_SEARCH_KEY, old);
    }
    return localStorage.getItem(DEEP_SEARCH_KEY) === 'true';
  } catch {
    return false;
  }
}

export function rememberDeepSearch(on: boolean): void {
  try {
    localStorage.setItem(DEEP_SEARCH_KEY, String(on));
  } catch {
    // Remembering the choice is a convenience; the search works without it.
  }
}
