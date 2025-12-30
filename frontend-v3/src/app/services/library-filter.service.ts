import { Injectable } from '@angular/core';
import { VideoWeek, VideoItem } from '../models/video.model';

export interface SearchInFields {
  filename: boolean;
  transcript: boolean;
  analysis: boolean;
}

export interface LibraryFilters {
  searchQuery: string;
  searchIn: SearchInFields;
  dateRange: 'all' | 'today' | 'week' | 'month' | 'year';
  mediaType: 'all' | 'video' | 'audio' | 'image' | 'document' | 'webpage';
  duration: 'all' | 'under10' | 'over10';
  hasTranscript: boolean | null;
  hasAnalysis: boolean | null;
  hasSuggestions: boolean | null;
  sortBy: 'date' | 'name' | 'duration' | 'suggestions' | 'no-analysis' | 'no-transcript';
  sortOrder: 'asc' | 'desc';
}

export interface ParsedSearchQuery {
  requiredTerms: string[];      // Words that must be present
  excludedTerms: string[];      // Words prefixed with - that must NOT be present
  exactPhrases: string[];       // "quoted phrases"
  fuzzyTerms: string[];         // Words suffixed with ~ for fuzzy matching
  wildcardTerms: string[];      // Words with * wildcard
}

@Injectable({
  providedIn: 'root'
})
export class LibraryFilterService {

  /**
   * Parse search query into structured components
   * Supports:
   * - Regular words (all must match)
   * - "exact phrases" in quotes
   * - -excluded words (must NOT match)
   * - fuzzy~ words (phonetic/typo tolerant)
   * - wild* cards
   */
  parseSearchQuery(query: string): ParsedSearchQuery {
    const result: ParsedSearchQuery = {
      requiredTerms: [],
      excludedTerms: [],
      exactPhrases: [],
      fuzzyTerms: [],
      wildcardTerms: []
    };

    if (!query || !query.trim()) {
      return result;
    }

    // Extract exact phrases first (quoted strings)
    const phraseRegex = /"([^"]+)"/g;
    let match;
    while ((match = phraseRegex.exec(query)) !== null) {
      result.exactPhrases.push(match[1].toLowerCase());
    }
    // Remove quoted phrases from query for further processing
    let remaining = query.replace(phraseRegex, ' ').trim();

    // Split into words
    const words = remaining.split(/\s+/).filter(w => w.length > 0);

    for (const word of words) {
      const lowerWord = word.toLowerCase();

      if (lowerWord.startsWith('-') && lowerWord.length > 1) {
        // Exclusion term
        result.excludedTerms.push(lowerWord.substring(1));
      } else if (lowerWord.endsWith('~') && lowerWord.length > 1) {
        // Fuzzy term
        result.fuzzyTerms.push(lowerWord.slice(0, -1));
      } else if (lowerWord.includes('*')) {
        // Wildcard term
        result.wildcardTerms.push(lowerWord);
      } else {
        // Regular required term
        result.requiredTerms.push(lowerWord);
      }
    }

    return result;
  }

  /**
   * Check if text matches the parsed search query
   * @param text The text to search in
   * @param parsed The parsed search query
   * @param usePhonetic Whether to use phonetic matching (for transcripts)
   */
  matchesSearchQuery(text: string, parsed: ParsedSearchQuery, usePhonetic: boolean = false): boolean {
    if (!text) return false;
    const lowerText = text.toLowerCase();

    // Check exclusions first - if any excluded term is found, reject
    for (const excluded of parsed.excludedTerms) {
      if (lowerText.includes(excluded)) {
        return false;
      }
    }

    // Check exact phrases - all must match
    for (const phrase of parsed.exactPhrases) {
      if (!lowerText.includes(phrase)) {
        return false;
      }
    }

    // Check required terms - all must match (with phonetic fallback for transcripts)
    for (const term of parsed.requiredTerms) {
      if (!this.termMatchesText(term, lowerText, usePhonetic)) {
        return false;
      }
    }

    // Check fuzzy terms - use Levenshtein distance
    for (const fuzzyTerm of parsed.fuzzyTerms) {
      if (!this.fuzzyMatchesText(fuzzyTerm, lowerText)) {
        return false;
      }
    }

    // Check wildcard terms
    for (const wildcardTerm of parsed.wildcardTerms) {
      if (!this.wildcardMatchesText(wildcardTerm, lowerText)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a term matches text, with optional phonetic matching
   */
  private termMatchesText(term: string, text: string, usePhonetic: boolean): boolean {
    // Direct match
    if (text.includes(term)) {
      return true;
    }

    // Phonetic matching for transcripts
    if (usePhonetic) {
      const termSoundex = this.soundex(term);
      const words = text.split(/\s+/);

      for (const word of words) {
        // Clean the word of punctuation
        const cleanWord = word.replace(/[^\w]/g, '');
        if (cleanWord.length < 2) continue;

        // Check soundex match (sounds similar)
        if (this.soundex(cleanWord) === termSoundex) {
          return true;
        }

        // Also check for close Levenshtein distance (typos)
        if (this.levenshteinDistance(term, cleanWord) <= Math.max(1, Math.floor(term.length / 4))) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if a fuzzy term matches anywhere in text using Levenshtein distance
   */
  private fuzzyMatchesText(fuzzyTerm: string, text: string): boolean {
    const words = text.split(/\s+/);
    const maxDistance = Math.max(2, Math.floor(fuzzyTerm.length / 3));

    for (const word of words) {
      const cleanWord = word.replace(/[^\w]/g, '').toLowerCase();
      if (cleanWord.length < 2) continue;

      if (this.levenshteinDistance(fuzzyTerm, cleanWord) <= maxDistance) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a wildcard pattern matches text
   * Supports * as wildcard (e.g., "test*" matches "testing")
   */
  private wildcardMatchesText(pattern: string, text: string): boolean {
    // Convert wildcard pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
      .replace(/\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(regexPattern, 'i');
    return regex.test(text);
  }

  /**
   * Soundex algorithm - encodes words by how they sound
   * Returns a 4-character code (letter + 3 digits)
   */
  soundex(word: string): string {
    if (!word || word.length === 0) return '0000';

    const clean = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length === 0) return '0000';

    const firstLetter = clean[0];

    // Soundex encoding map
    const codes: { [key: string]: string } = {
      'B': '1', 'F': '1', 'P': '1', 'V': '1',
      'C': '2', 'G': '2', 'J': '2', 'K': '2', 'Q': '2', 'S': '2', 'X': '2', 'Z': '2',
      'D': '3', 'T': '3',
      'L': '4',
      'M': '5', 'N': '5',
      'R': '6',
      // A, E, I, O, U, H, W, Y are not coded
    };

    let result = firstLetter;
    let prevCode = codes[firstLetter] || '';

    for (let i = 1; i < clean.length && result.length < 4; i++) {
      const code = codes[clean[i]];
      if (code && code !== prevCode) {
        result += code;
        prevCode = code;
      } else if (!code) {
        prevCode = ''; // Vowels/H/W/Y reset the previous code
      }
    }

    // Pad with zeros
    return (result + '000').substring(0, 4);
  }

  /**
   * Levenshtein distance - minimum edits to transform one string to another
   */
  levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    if (m === 0) return n;
    if (n === 0) return m;

    // Use two rows instead of full matrix for memory efficiency
    let prevRow = Array(n + 1).fill(0).map((_, i) => i);
    let currRow = Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      currRow[0] = i;

      for (let j = 1; j <= n; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        currRow[j] = Math.min(
          prevRow[j] + 1,      // deletion
          currRow[j - 1] + 1,  // insertion
          prevRow[j - 1] + cost // substitution
        );
      }

      [prevRow, currRow] = [currRow, prevRow];
    }

    return prevRow[n];
  }

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
  applyFilters(weeks: VideoWeek[], filters: LibraryFilters): VideoWeek[] {
    let result = [...weeks];

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

    // For date sorting, reorder the sections themselves
    if (sortBy === 'date') {
      weeks.sort((a, b) => {
        if (a.weekLabel === 'New') return ascending ? 1 : -1;
        if (b.weekLabel === 'New') return ascending ? -1 : 1;
        if (a.weekLabel === 'Unknown') return 1;
        if (b.weekLabel === 'Unknown') return -1;

        const comparison = a.weekLabel.localeCompare(b.weekLabel);
        return ascending ? comparison : -comparison;
      });

      // Also sort videos within each section by their specific date
      for (const week of weeks) {
        week.videos.sort((a, b) => {
          const dateA = a.downloadDate ? new Date(a.downloadDate).getTime() : 0;
          const dateB = b.downloadDate ? new Date(b.downloadDate).getTime() : 0;
          return ascending ? dateA - dateB : dateB - dateA;
        });
      }
      return;
    }

    // For other sorts, flatten into single group and sort all videos
    const allVideos = weeks.flatMap(w => w.videos);

    switch (sortBy) {
      case 'name':
        allVideos.sort((a, b) => {
          const comparison = (a.name || '').localeCompare(b.name || '');
          return ascending ? comparison : -comparison;
        });
        break;

      case 'duration':
        allVideos.sort((a, b) => {
          const durationA = this.parseDurationToSeconds(a.duration);
          const durationB = this.parseDurationToSeconds(b.duration);
          return ascending ? durationA - durationB : durationB - durationA;
        });
        break;

      case 'suggestions':
        allVideos.sort((a, b) => {
          const hasSuggestionsA = a.suggestedTitle && a.suggestedTitle.trim().length > 0 ? 1 : 0;
          const hasSuggestionsB = b.suggestedTitle && b.suggestedTitle.trim().length > 0 ? 1 : 0;
          return ascending ? hasSuggestionsA - hasSuggestionsB : hasSuggestionsB - hasSuggestionsA;
        });
        break;

      case 'no-analysis':
        allVideos.sort((a, b) => {
          const missingAnalysisA = a.hasAnalysis ? 0 : 1;
          const missingAnalysisB = b.hasAnalysis ? 0 : 1;
          return ascending ? missingAnalysisA - missingAnalysisB : missingAnalysisB - missingAnalysisA;
        });
        break;

      case 'no-transcript':
        allVideos.sort((a, b) => {
          const missingTranscriptA = a.hasTranscript ? 0 : 1;
          const missingTranscriptB = b.hasTranscript ? 0 : 1;
          return ascending ? missingTranscriptA - missingTranscriptB : missingTranscriptB - missingTranscriptA;
        });
        break;
    }

    // Replace weeks content with single "All" section
    weeks.length = 0;
    if (allVideos.length > 0) {
      weeks.push({ weekLabel: 'All', videos: allVideos });
    }
  }

  /**
   * Get default filters
   */
  getDefaultFilters(): LibraryFilters {
    return {
      searchQuery: '',
      searchIn: { filename: true, transcript: true, analysis: true },
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
