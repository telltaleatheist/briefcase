import { Injectable } from '@angular/core';
import { VideoItem, VideoWeek } from '../models/video.model';

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
  /** 'relevance' orders search results best match first; the library itself has no relevance and sorts by date. */
  sortBy: 'date' | 'relevance' | 'name' | 'duration' | 'suggestions' | 'no-analysis' | 'no-transcript';
  sortOrder: 'asc' | 'desc';
}

@Injectable({
  providedIn: 'root'
})
export class LibraryFilterService {

  /**
   * Parse duration string (HH:MM:SS) to seconds
   */
  parseDurationToSeconds(duration: string | undefined): number {
    if (!duration) return 0;
    const parts = duration.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }

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
          const durationSeconds = this.parseDurationToSeconds(video.duration);
          return wantsUnder ? durationSeconds < threshold : durationSeconds >= threshold;
        })
      })).filter(week => week.videos.length > 0);
    }

    return result;
  }

  /**
   * Sort videos based on filter settings
   */
  sortVideos(weeks: VideoWeek[], filters: LibraryFilters): void {
    const { sortBy, sortOrder } = filters;
    const ascending = sortOrder === 'asc';

    // For date sorting (and relevance, which only search results have),
    // reorder the sections themselves
    if (sortBy === 'date' || sortBy === 'relevance') {
      weeks.sort((a, b) => {
        if (a.weekLabel === 'New') return ascending ? 1 : -1;
        if (b.weekLabel === 'New') return ascending ? -1 : 1;
        if (a.weekLabel === 'Unknown') return 1;
        if (b.weekLabel === 'Unknown') return -1;

        const comparison = a.weekLabel.localeCompare(b.weekLabel);
        return ascending ? comparison : -comparison;
      });

      // Also sort videos within each section by their specific date
      const byDate = this.videoComparator({ ...filters, sortBy: 'date' });
      for (const week of weeks) week.videos.sort(byDate);
      return;
    }

    // For other sorts, flatten into single group and sort all videos
    const allVideos = weeks.flatMap(w => w.videos).sort(this.videoComparator(filters));

    // Replace weeks content with single "All" section
    weeks.length = 0;
    if (allVideos.length > 0) {
      weeks.push({ weekLabel: 'All', videos: allVideos });
    }
  }

  /**
   * How two videos compare under the chosen Sort By and Order: the library's
   * order, and the order of search results unless Sort By is relevance.
   */
  videoComparator(filters: Pick<LibraryFilters, 'sortBy' | 'sortOrder'>): (a: VideoItem, b: VideoItem) => number {
    const sign = filters.sortOrder === 'asc' ? 1 : -1;
    const key = (video: VideoItem): number | string => {
      switch (filters.sortBy) {
        case 'name': return video.name || '';
        case 'duration': return this.parseDurationToSeconds(video.duration);
        case 'suggestions': return video.suggestedTitle && video.suggestedTitle.trim().length > 0 ? 1 : 0;
        case 'no-analysis': return video.hasAnalysis ? 0 : 1;
        case 'no-transcript': return video.hasTranscript ? 0 : 1;
        default: return video.downloadDate ? new Date(video.downloadDate).getTime() : 0;
      }
    };
    return (a, b) => {
      const ka = key(a);
      const kb = key(b);
      return sign * (typeof ka === 'string' ? ka.localeCompare(kb as string) : ka - (kb as number));
    };
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
      hasSuggestions: null,
      sortBy: 'date',
      sortOrder: 'desc'
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
