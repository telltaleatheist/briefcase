import { Injectable } from '@angular/core';

export interface TranscriptSearchResult {
  lineIndex: number;
  line: string;
  matchIndex: number;
  matchText: string;
  context: string;
  timestamp?: number;
}

export interface TranscriptSearchOptions {
  useSoundex: boolean;       // Enable phonetic matching
  usePhraseSearch: boolean;  // Match phrase (consecutive words) vs any word (OR) - default is word search
}

/**
 * Shared transcript search service
 * Provides consistent phonetic phrase matching across all transcript search components
 *
 * Search behavior:
 * - Unquoted: phonetic phrase match (words must appear in order, each matched phonetically)
 * - Double quotes: exact phrase match
 * - Uppercase AND/OR/NOT: boolean operators (auto-detected)
 */
@Injectable({
  providedIn: 'root'
})
export class TranscriptSearchService {

  /**
   * Search transcript lines for a query
   * Returns matching lines with context and timestamps
   */
  searchTranscript(query: string, lines: string[]): TranscriptSearchResult[] {
    const results: TranscriptSearchResult[] = [];
    if (!query || !lines.length) return results;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return results;

    // Auto-detect boolean operators (uppercase AND/OR/NOT)
    const hasBooleanOperators = /\s+(AND|OR|NOT)\s+/.test(trimmedQuery);

    const seenLines = new Set<number>();

    lines.forEach((line, lineIndex) => {
      if (seenLines.has(lineIndex)) return;

      let matches = false;
      if (hasBooleanOperators) {
        matches = this.evaluateBooleanQuery(trimmedQuery, line);
      } else {
        matches = this.matchesPhonetically(trimmedQuery, line);
      }

      if (matches) {
        seenLines.add(lineIndex);
        const searchWords = trimmedQuery.toLowerCase().split(/\s+/).filter(w => w.length > 0);
        const firstWord = searchWords[0] || trimmedQuery;
        const matchIndex = Math.max(0, line.toLowerCase().indexOf(firstWord));

        // Build context (surrounding text)
        const startIdx = Math.max(0, matchIndex - 50);
        const endIdx = Math.min(line.length, matchIndex + firstWord.length + 50);
        const context = (startIdx > 0 ? '...' : '') + line.substring(startIdx, endIdx);

        // Extract timestamp from preceding lines
        const timestamp = this.extractTimestamp(lines, lineIndex);

        results.push({
          lineIndex,
          line,
          matchIndex,
          matchText: firstWord,
          context,
          timestamp
        });
      }
    });

    return results;
  }

  /**
   * Check if a single text matches the query
   * Useful for filtering transcript segments
   */
  matchesQuery(query: string, text: string, options?: TranscriptSearchOptions): boolean {
    if (!query || !text) return false;

    const trimmedQuery = query.trim();
    if (!trimmedQuery) return false;

    // Auto-detect boolean operators
    const hasBooleanOperators = /\s+(AND|OR|NOT)\s+/.test(trimmedQuery);

    if (hasBooleanOperators) {
      return this.evaluateBooleanQuery(trimmedQuery, text);
    } else if (options?.usePhraseSearch) {
      // Phrase search: words must appear consecutively
      return this.matchesPhonetically(trimmedQuery, text, options);
    } else {
      // Word search: any word matches (OR logic) - default
      return this.matchesAnyWord(trimmedQuery, text, options);
    }
  }

  /**
   * Match if any search word appears in the text (OR logic)
   */
  private matchesAnyWord(query: string, text: string, options?: TranscriptSearchOptions): boolean {
    const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (searchWords.length === 0) return false;

    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    for (const searchWord of searchWords) {
      // Check if this word appears anywhere in the text
      for (const textWord of textWords) {
        if (this.wordsMatchPhonetically(searchWord, textWord, options)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Phonetic phrase matching
   * - Unquoted: words must appear in order, each matched phonetically
   * - Double quotes: exact phrase match
   */
  private matchesPhonetically(query: string, text: string, options?: TranscriptSearchOptions): boolean {
    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    // Check for exact phrase (double quotes)
    const exactPhraseMatch = query.match(/^"([^"]+)"$/);
    if (exactPhraseMatch) {
      return textLower.includes(exactPhraseMatch[1].toLowerCase());
    }

    // Unquoted: phonetic phrase match - find words in order
    const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (searchWords.length === 0) return false;

    // Find starting positions where all search words match consecutively
    for (let startIdx = 0; startIdx <= textWords.length - searchWords.length; startIdx++) {
      let allMatch = true;
      let textIdx = startIdx;

      for (const searchWord of searchWords) {
        if (textIdx >= textWords.length) {
          allMatch = false;
          break;
        }

        const textWord = textWords[textIdx];
        if (!this.wordsMatchPhonetically(searchWord, textWord, options)) {
          allMatch = false;
          break;
        }
        textIdx++;
      }

      if (allMatch) return true;
    }

    return false;
  }

  /**
   * Check if two words match phonetically
   */
  private wordsMatchPhonetically(search: string, text: string, options?: TranscriptSearchOptions): boolean {
    // Exact match
    if (text === search) return true;

    // Very short words (1-2 chars) - require exact match only
    if (search.length <= 2) {
      return text === search;
    }

    // Substring match (only if search is 3+ chars to avoid false positives)
    if (search.length >= 3 && (text.includes(search) || search.includes(text))) return true;

    // Soundex match (only if enabled and for 3+ char words)
    if (options?.useSoundex && search.length >= 3) {
      const searchSoundex = this.soundex(search);
      const textSoundex = this.soundex(text);
      if (searchSoundex && textSoundex && searchSoundex === textSoundex && searchSoundex !== '0000') return true;

      // Levenshtein distance scaled by word length (only with soundex enabled)
      const maxDistance = Math.max(1, Math.floor(search.length / 3));
      if (this.levenshteinDistance(search, text) <= maxDistance) return true;
    }

    return false;
  }

  /**
   * Boolean query evaluation (only uppercase AND, OR, NOT are operators)
   */
  private evaluateBooleanQuery(query: string, line: string): boolean {
    let processedQuery = query;

    // Handle OR operator
    const orPattern = /("?[\w]+"?)\s+OR\s+("?[\w]+"?)/g;
    let orMatches = [...query.matchAll(orPattern)];

    for (const match of orMatches) {
      const term1 = match[1];
      const term2 = match[2];
      const hasFirst = this.termMatches(term1, line);
      const hasSecond = this.termMatches(term2, line);
      processedQuery = processedQuery.replace(match[0], (hasFirst || hasSecond) ? 'TRUE' : 'FALSE');
    }

    // Handle AND operator
    const andPattern = /("?[\w]+"?)\s+AND\s+("?[\w]+"?)/g;
    let andMatches = [...processedQuery.matchAll(andPattern)];

    for (const match of andMatches) {
      const term1 = match[1];
      const term2 = match[2];
      if (term1 === 'TRUE' || term1 === 'FALSE' || term2 === 'TRUE' || term2 === 'FALSE') {
        const val1 = term1 === 'TRUE';
        const val2 = term2 === 'TRUE';
        processedQuery = processedQuery.replace(match[0], (val1 && val2) ? 'TRUE' : 'FALSE');
      } else {
        const hasFirst = this.termMatches(term1, line);
        const hasSecond = this.termMatches(term2, line);
        processedQuery = processedQuery.replace(match[0], (hasFirst && hasSecond) ? 'TRUE' : 'FALSE');
      }
    }

    // Handle NOT operator
    const notPattern = /("?[\w]+"?)\s+NOT\s+("?[\w]+"?)/g;
    let notMatches = [...processedQuery.matchAll(notPattern)];

    for (const match of notMatches) {
      const term1 = match[1];
      const term2 = match[2];
      const hasFirst = this.termMatches(term1, line);
      const hasSecond = this.termMatches(term2, line);
      processedQuery = processedQuery.replace(match[0], (hasFirst && !hasSecond) ? 'TRUE' : 'FALSE');
    }

    // If no boolean operators, just search for the term
    if (!query.match(/\s+(AND|OR|NOT)\s+/)) {
      return this.termMatches(query, line);
    }

    return processedQuery.includes('TRUE');
  }

  /**
   * Check if a term matches in text (handles quoted terms as whole word match)
   */
  private termMatches(term: string, text: string): boolean {
    // Quoted term = exact whole word match
    if (term.startsWith('"') && term.endsWith('"')) {
      const exactWord = term.slice(1, -1);
      const wordBoundary = new RegExp(`\\b${exactWord}\\b`, 'i');
      return wordBoundary.test(text);
    }
    // Unquoted = case-insensitive substring match
    return new RegExp(term, 'i').test(text);
  }

  /**
   * Extract timestamp from preceding lines (SRT format detection)
   */
  private extractTimestamp(lines: string[], currentIndex: number): number | undefined {
    for (let i = currentIndex - 1; i >= Math.max(0, currentIndex - 10); i--) {
      const line = lines[i];

      // Try SRT format with arrow
      let timestampMatch = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/);

      // If not found, try just timestamp at start of line
      if (!timestampMatch) {
        timestampMatch = line.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      }

      // Also try without milliseconds (MM:SS format)
      if (!timestampMatch) {
        timestampMatch = line.match(/^(\d{1,2}):(\d{2})/);
        if (timestampMatch) {
          const minutes = parseInt(timestampMatch[1], 10);
          const seconds = parseInt(timestampMatch[2], 10);
          return minutes * 60 + seconds;
        }
      }

      if (timestampMatch && timestampMatch.length >= 4) {
        const hours = parseInt(timestampMatch[1], 10);
        const minutes = parseInt(timestampMatch[2], 10);
        const seconds = parseInt(timestampMatch[3], 10);
        const milliseconds = timestampMatch[4] ? parseInt(timestampMatch[4], 10) : 0;
        return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
      }
    }
    return undefined;
  }

  /**
   * Soundex algorithm - encodes words by how they sound
   * Returns a 4-character code (letter + 3 digits)
   */
  private soundex(word: string): string {
    if (!word || word.length === 0) return '0000';

    const clean = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length === 0) return '0000';

    const firstLetter = clean[0];

    const codes: { [key: string]: string } = {
      'B': '1', 'F': '1', 'P': '1', 'V': '1',
      'C': '2', 'G': '2', 'J': '2', 'K': '2', 'Q': '2', 'S': '2', 'X': '2', 'Z': '2',
      'D': '3', 'T': '3',
      'L': '4',
      'M': '5', 'N': '5',
      'R': '6',
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

    return (result + '000').substring(0, 4);
  }

  /**
   * Levenshtein distance - minimum edits to transform one string to another
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;

    if (m === 0) return n;
    if (n === 0) return m;

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
}
