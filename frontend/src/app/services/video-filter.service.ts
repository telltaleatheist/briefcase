import { Injectable } from '@angular/core';
import { DatabaseVideo } from './database-library.service';

export type SortField = 'date' | 'upload-date' | 'date-added' | 'filename' | 'size' | 'no-transcript' | 'no-analysis';
export type SortOrder = 'asc' | 'desc';

export interface SearchFilters {
  filename: boolean;
  aiDescription: boolean;
  transcript: boolean;
  analysis: boolean;
  tags: boolean;
}

export interface FileTypeFilters {
  video: boolean;
  audio: boolean;
  document: boolean;
  image: boolean;
  webpage: boolean;
}

export interface FilterCriteria {
  searchQuery: string;
  searchFilters: SearchFilters;
  selectedTags: string[];
  fileTypeFilters: FileTypeFilters;
  sortBy: SortField;
  sortOrder: SortOrder;
  showOnlyTitleSuggestions?: boolean;
}

/**
 * VideoFilterService
 *
 * Pure service for filtering, searching, and sorting videos.
 * Contains no state - all methods are pure functions.
 */
@Injectable({
  providedIn: 'root'
})
export class VideoFilterService {
  private readonly VIDEO_EXTENSIONS = ['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'];
  private readonly AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg'];
  private readonly DOCUMENT_EXTENSIONS = ['.pdf', '.epub', '.mobi', '.txt', '.md'];
  private readonly IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  private readonly WEBPAGE_EXTENSIONS = ['.html', '.htm', '.mhtml'];

  constructor() {}

  /**
   * Apply all filters to videos
   */
  applyFilters(videos: DatabaseVideo[], criteria: FilterCriteria): DatabaseVideo[] {
    let filtered = [...videos];

    // Apply search query
    if (criteria.searchQuery.trim()) {
      filtered = this.searchVideos(filtered, criteria.searchQuery, criteria.searchFilters);
    }

    // Apply tag filters
    if (criteria.selectedTags.length > 0) {
      filtered = this.filterByTags(filtered, criteria.selectedTags);
    }

    // Apply file type filters
    filtered = this.filterByFileType(filtered, criteria.fileTypeFilters);

    // Apply title suggestion filter
    if (criteria.showOnlyTitleSuggestions) {
      filtered = this.filterByTitleSuggestions(filtered);
    }

    // Apply sorting
    filtered = this.sortVideos(filtered, criteria.sortBy, criteria.sortOrder);

    return filtered;
  }

  /**
   * Search videos based on query and selected fields
   * Note: DatabaseVideo doesn't include inline transcript/analysis text or tags
   * For full-text search, use DatabaseLibraryService.searchVideos()
   */
  searchVideos(videos: DatabaseVideo[], query: string, filters: SearchFilters): DatabaseVideo[] {
    const lowerQuery = query.toLowerCase();

    return videos.filter(video => {
      // Search in filename
      if (filters.filename && video.filename.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Search in AI description
      if (filters.aiDescription && video.ai_description?.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Search in suggested title
      if (filters.filename && video.suggested_title?.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Note: transcript, analysis, and tags search require database queries
      // These should be handled by DatabaseLibraryService.searchVideos()
      // For now, just search filename and AI description

      return false;
    });
  }

  /**
   * Filter videos by selected tags (AND logic - video must have all selected tags)
   * Note: Tag data is not included in DatabaseVideo interface
   * Tag filtering should be handled by DatabaseLibraryService.getVideosByTags()
   */
  filterByTags(videos: DatabaseVideo[], selectedTags: string[]): DatabaseVideo[] {
    if (selectedTags.length === 0) {
      return videos;
    }

    // Tag data is not included in the interface
    // Component should use DatabaseLibraryService.getVideosByTags() instead
    console.warn('Tag filtering requires database query - use DatabaseLibraryService.getVideosByTags()');
    return videos;
  }

  /**
   * Filter videos by file type
   */
  filterByFileType(videos: DatabaseVideo[], filters: FileTypeFilters): DatabaseVideo[] {
    // If all filters are enabled, don't filter
    const allEnabled = Object.values(filters).every(v => v);
    if (allEnabled) {
      return videos;
    }

    return videos.filter(video => {
      const filename = video.filename.toLowerCase();

      if (filters.video && this.VIDEO_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        return true;
      }
      if (filters.audio && this.AUDIO_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        return true;
      }
      if (filters.document && this.DOCUMENT_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        return true;
      }
      if (filters.image && this.IMAGE_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        return true;
      }
      if (filters.webpage && this.WEBPAGE_EXTENSIONS.some(ext => filename.endsWith(ext))) {
        return true;
      }

      return false;
    });
  }

  /**
   * Filter videos by unresolved title suggestions
   * Shows only videos that have a suggested_title that differs from the current filename
   */
  filterByTitleSuggestions(videos: DatabaseVideo[]): DatabaseVideo[] {
    return videos.filter(video => {
      // Must have a suggested title
      if (!video.suggested_title) {
        return false;
      }
      // Suggested title must be different from current filename
      return video.suggested_title !== video.filename;
    });
  }

  /**
   * Sort videos based on field and order
   */
  sortVideos(videos: DatabaseVideo[], sortBy: SortField, sortOrder: SortOrder): DatabaseVideo[] {
    const sorted = [...videos].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'date':
          // Download date - when the user downloaded the file
          comparison = this.compareDates(a.download_date, b.download_date);
          break;

        case 'upload-date':
          // Upload date - when the content was originally posted/created
          comparison = this.compareDates(a.upload_date, b.upload_date);
          break;

        case 'date-added':
          // Added to library date
          comparison = this.compareDates(a.added_at, b.added_at);
          break;

        case 'filename':
          comparison = a.filename.localeCompare(b.filename);
          break;

        case 'size':
          comparison = (a.file_size_bytes || 0) - (b.file_size_bytes || 0);
          break;

        case 'no-transcript':
          // Videos without transcript first
          const aHasTranscript = !!a.has_transcript;
          const bHasTranscript = !!b.has_transcript;
          if (aHasTranscript === bHasTranscript) {
            comparison = this.compareDates(a.download_date, b.download_date);
          } else {
            comparison = aHasTranscript ? 1 : -1;
          }
          break;

        case 'no-analysis':
          // Videos without analysis first
          const aHasAnalysis = !!a.has_analysis;
          const bHasAnalysis = !!b.has_analysis;
          if (aHasAnalysis === bHasAnalysis) {
            comparison = this.compareDates(a.download_date, b.download_date);
          } else {
            comparison = aHasAnalysis ? 1 : -1;
          }
          break;

        default:
          comparison = 0;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }

  /**
   * Compare two date strings
   */
  private compareDates(dateA: string | null | undefined, dateB: string | null | undefined): number {
    if (!dateA && !dateB) return 0;
    if (!dateA) return 1;
    if (!dateB) return -1;

    const timeA = new Date(dateA).getTime();
    const timeB = new Date(dateB).getTime();
    return timeA - timeB;
  }

  /**
   * Check if a video matches the search criteria (for individual video checks)
   */
  videoMatchesSearch(video: DatabaseVideo, query: string, filters: SearchFilters): boolean {
    return this.searchVideos([video], query, filters).length > 0;
  }

  /**
   * Get media type from filename
   */
  getMediaType(filename: string): 'video' | 'audio' | 'document' | 'image' | 'webpage' | 'unknown' {
    const lower = filename.toLowerCase();

    if (this.VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'video';
    if (this.AUDIO_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'audio';
    if (this.DOCUMENT_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'document';
    if (this.IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'image';
    if (this.WEBPAGE_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'webpage';

    return 'unknown';
  }

  /**
   * Check if a file type can be analyzed (transcribed/AI analyzed)
   */
  canAnalyzeMedia(input: string | DatabaseVideo): boolean {
    if (typeof input === 'string') {
      const mediaType = this.getMediaType(input);
      return mediaType === 'video' || mediaType === 'audio';
    } else {
      return input.media_type === 'video' || input.media_type === 'audio';
    }
  }

  /**
   * Get videos missing transcript
   */
  getVideosMissingTranscript(videos: DatabaseVideo[]): DatabaseVideo[] {
    return videos.filter(v => !v.has_transcript && this.canAnalyzeMedia(v.filename));
  }

  /**
   * Get videos missing analysis
   */
  getVideosMissingAnalysis(videos: DatabaseVideo[]): DatabaseVideo[] {
    return videos.filter(v => !v.has_analysis && this.canAnalyzeMedia(v.filename));
  }

  /**
   * Get videos missing both transcript and analysis
   */
  getVideosMissingBoth(videos: DatabaseVideo[]): DatabaseVideo[] {
    return videos.filter(v =>
      !v.has_transcript &&
      !v.has_analysis &&
      this.canAnalyzeMedia(v.filename)
    );
  }

  /**
   * Check if file type filters have any disabled
   */
  hasActiveFileTypeFilter(filters: FileTypeFilters): boolean {
    return !Object.values(filters).every(v => v);
  }
}
