import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

export interface TranscriptMatch {
  index: number;
  text: string;
  context: string;
  timestamp?: number; // Timestamp in seconds if we can parse it from SRT
}

export interface SavedSearch {
  id: string;
  query: string;
  useWildcards: boolean;
  useBooleanLogic: boolean;
  createdAt: string;
}

@Component({
  selector: 'app-transcript-search',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatTooltipModule
  ],
  templateUrl: './transcript-search.component.html',
  styleUrls: ['./transcript-search.component.scss']
})
export class TranscriptSearchComponent implements OnInit, OnDestroy {
  @Input() transcriptText: string | null = null;
  @Input() transcriptExists = false;
  @Output() seekToTime = new EventEmitter<number>();
  @Output() runAnalysis = new EventEmitter<void>();

  searchQuery = '';
  matches: TranscriptMatch[] = [];
  isSearching = false;
  selectedMatchIndex = -1;
  useWildcards = false;
  useBooleanLogic = false;

  savedSearches: SavedSearch[] = [];
  savedSearchesExpanded = false;
  searchOptionsExpanded = false;
  private readonly SAVED_SEARCHES_KEY = 'transcript_saved_searches';

  private searchSubject = new Subject<string>();

  ngOnInit() {
    // Debounce search input
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged()
      )
      .subscribe(query => {
        this.performSearch(query);
      });

    // Load saved searches from localStorage
    this.loadSavedSearches();
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  onSearchInput() {
    this.searchSubject.next(this.searchQuery);
  }

  performSearch(query: string) {
    if (!query || !this.transcriptText) {
      this.matches = [];
      return;
    }

    this.isSearching = true;
    this.matches = [];

    try {
      const lines = this.transcriptText.split('\n');

      if (this.useBooleanLogic) {
        this.performBooleanSearch(query, lines);
      } else if (this.useWildcards) {
        this.performWildcardSearch(query, lines);
      } else {
        this.performSimpleSearch(query, lines);
      }

      console.log('Total matches found:', this.matches.length);
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * Simple search (original behavior)
   */
  private performSimpleSearch(query: string, lines: string[]) {
    const regex = new RegExp(query, 'gi');
    const seenLines = new Set<number>();

    lines.forEach((line, lineIndex) => {
      if (seenLines.has(lineIndex)) return;

      const match = regex.exec(line);
      if (match) {
        this.addMatch(line, lineIndex, match.index, match[0], lines, seenLines);
      }
      regex.lastIndex = 0;
    });
  }

  /**
   * Wildcard search (* and ?)
   */
  private performWildcardSearch(query: string, lines: string[]) {
    // Convert wildcards to regex
    // Escape regex special chars except * and ?
    let regexPattern = query.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Convert * to .* and ? to .
    regexPattern = regexPattern.replace(/\*/g, '.*').replace(/\?/g, '.');

    const regex = new RegExp(regexPattern, 'gi');
    const seenLines = new Set<number>();

    lines.forEach((line, lineIndex) => {
      if (seenLines.has(lineIndex)) return;

      const match = regex.exec(line);
      if (match) {
        this.addMatch(line, lineIndex, match.index, match[0], lines, seenLines);
      }
      regex.lastIndex = 0;
    });
  }

  /**
   * Boolean search (AND, OR, NOT)
   * Examples:
   * - "bill AND congress" - both words must appear
   * - "senate OR house" - either word must appear
   * - "trump NOT impeachment" - first word but not second
   * - "bill AND (senate OR congress)" - supports grouping
   */
  private performBooleanSearch(query: string, lines: string[]) {
    const seenLines = new Set<number>();

    lines.forEach((line, lineIndex) => {
      if (seenLines.has(lineIndex)) return;

      if (this.evaluateBooleanQuery(query, line)) {
        // For boolean matches, we'll highlight the first matching term
        const firstTerm = this.getFirstTerm(query);
        const match = line.toLowerCase().indexOf(firstTerm.toLowerCase());
        if (match !== -1) {
          this.addMatch(line, lineIndex, match, line.substring(match, match + firstTerm.length), lines, seenLines);
        }
      }
    });
  }

  /**
   * Evaluate a boolean query against a line
   */
  private evaluateBooleanQuery(query: string, line: string): boolean {
    // Handle NOT operator (highest precedence)
    const notPattern = /(\w+)\s+NOT\s+(\w+)/gi;
    let processedQuery = query;
    let notMatches = [...query.matchAll(notPattern)];

    for (const match of notMatches) {
      const term1 = match[1];
      const term2 = match[2];
      const hasFirst = new RegExp(term1, 'i').test(line);
      const hasSecond = new RegExp(term2, 'i').test(line);
      const result = hasFirst && !hasSecond;
      processedQuery = processedQuery.replace(match[0], result ? 'TRUE' : 'FALSE');
    }

    // Handle AND operator
    const andPattern = /(\w+)\s+AND\s+(\w+)/gi;
    let andMatches = [...processedQuery.matchAll(andPattern)];

    for (const match of andMatches) {
      const term1 = match[1];
      const term2 = match[2];

      if (term1 === 'TRUE' || term1 === 'FALSE' || term2 === 'TRUE' || term2 === 'FALSE') {
        const val1 = term1 === 'TRUE';
        const val2 = term2 === 'TRUE';
        processedQuery = processedQuery.replace(match[0], (val1 && val2) ? 'TRUE' : 'FALSE');
      } else {
        const hasFirst = new RegExp(term1, 'i').test(line);
        const hasSecond = new RegExp(term2, 'i').test(line);
        processedQuery = processedQuery.replace(match[0], (hasFirst && hasSecond) ? 'TRUE' : 'FALSE');
      }
    }

    // Handle OR operator (lowest precedence)
    const orPattern = /(\w+)\s+OR\s+(\w+)/gi;
    let orMatches = [...processedQuery.matchAll(orPattern)];

    for (const match of orMatches) {
      const term1 = match[1];
      const term2 = match[2];

      if (term1 === 'TRUE' || term1 === 'FALSE' || term2 === 'TRUE' || term2 === 'FALSE') {
        const val1 = term1 === 'TRUE';
        const val2 = term2 === 'TRUE';
        processedQuery = processedQuery.replace(match[0], (val1 || val2) ? 'TRUE' : 'FALSE');
      } else {
        const hasFirst = new RegExp(term1, 'i').test(line);
        const hasSecond = new RegExp(term2, 'i').test(line);
        processedQuery = processedQuery.replace(match[0], (hasFirst || hasSecond) ? 'TRUE' : 'FALSE');
      }
    }

    // If no boolean operators, just search for the term
    if (!query.match(/\s+(AND|OR|NOT)\s+/i)) {
      return new RegExp(query, 'i').test(line);
    }

    return processedQuery.includes('TRUE');
  }

  /**
   * Extract the first search term from a boolean query
   */
  private getFirstTerm(query: string): string {
    const match = query.match(/^\w+/);
    return match ? match[0] : query;
  }

  /**
   * Helper to add a match to the results
   */
  private addMatch(line: string, lineIndex: number, matchIndex: number, matchText: string, lines: string[], seenLines: Set<number>) {
    seenLines.add(lineIndex);
    const startIdx = Math.max(0, matchIndex - 50);
    const endIdx = Math.min(line.length, matchIndex + matchText.length + 50);
    const context = line.substring(startIdx, endIdx);
    const timestamp = this.extractTimestamp(lines, lineIndex);

    console.log('Found match on line', lineIndex, 'with timestamp:', timestamp);

    this.matches.push({
      index: this.matches.length,
      text: matchText,
      context: startIdx > 0 ? '...' + context : context,
      timestamp: timestamp
    });
  }

  /**
   * Try to extract timestamp from preceding lines (SRT format detection)
   */
  private extractTimestamp(lines: string[], currentIndex: number): number | undefined {
    // Look backwards for a timestamp in SRT format (HH:MM:SS,mmm --> HH:MM:SS,mmm)
    // or also check for just the start timestamp (HH:MM:SS,mmm)
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
        const timestamp = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        console.log('Extracted timestamp', timestamp, 'from line', i, ':', line);
        return timestamp;
      }
    }
    console.log('No timestamp found for line', currentIndex);
    return undefined;
  }

  onMatchClick(match: TranscriptMatch) {
    console.log('Match clicked:', match);
    this.selectedMatchIndex = match.index;
    if (match.timestamp !== undefined) {
      console.log('Emitting seekToTime with timestamp:', match.timestamp);
      this.seekToTime.emit(match.timestamp);
    } else {
      console.warn('Match has no timestamp:', match);
    }
  }

  clearSearch() {
    this.searchQuery = '';
    this.matches = [];
    this.selectedMatchIndex = -1;
  }

  onRunAnalysis() {
    this.runAnalysis.emit();
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Load saved searches from localStorage
   */
  private loadSavedSearches(): void {
    try {
      const saved = localStorage.getItem(this.SAVED_SEARCHES_KEY);
      if (saved) {
        this.savedSearches = JSON.parse(saved);
        console.log('Loaded saved searches:', this.savedSearches);
      }
    } catch (error) {
      console.error('Failed to load saved searches:', error);
      this.savedSearches = [];
    }
  }

  /**
   * Save searches to localStorage
   */
  private saveSavedSearches(): void {
    try {
      localStorage.setItem(this.SAVED_SEARCHES_KEY, JSON.stringify(this.savedSearches));
      console.log('Saved searches to localStorage');
    } catch (error) {
      console.error('Failed to save searches:', error);
    }
  }

  /**
   * Save current search query
   */
  saveCurrentSearch(): void {
    if (!this.searchQuery || !this.searchQuery.trim()) {
      return;
    }

    // Check if this search already exists
    const existing = this.savedSearches.find(
      s => s.query === this.searchQuery &&
           s.useWildcards === this.useWildcards &&
           s.useBooleanLogic === this.useBooleanLogic
    );

    if (existing) {
      console.log('Search already saved');
      return;
    }

    // Add new saved search
    const newSearch: SavedSearch = {
      id: Date.now().toString(),
      query: this.searchQuery,
      useWildcards: this.useWildcards,
      useBooleanLogic: this.useBooleanLogic,
      createdAt: new Date().toISOString()
    };

    this.savedSearches.unshift(newSearch); // Add to beginning
    this.saveSavedSearches();
    console.log('Saved search:', newSearch);
  }

  /**
   * Load a saved search
   */
  loadSavedSearch(search: SavedSearch): void {
    this.searchQuery = search.query;
    this.useWildcards = search.useWildcards;
    this.useBooleanLogic = search.useBooleanLogic;
    this.onSearchInput();
  }

  /**
   * Delete a saved search
   */
  deleteSavedSearch(search: SavedSearch, event: Event): void {
    event.stopPropagation(); // Prevent accordion toggle
    this.savedSearches = this.savedSearches.filter(s => s.id !== search.id);
    this.saveSavedSearches();
    console.log('Deleted saved search:', search);
  }

  /**
   * Get tooltip text for a saved search
   */
  getSavedSearchTooltip(search: SavedSearch): string {
    let tooltip = `Query: ${search.query}`;
    if (search.useWildcards) {
      tooltip += '\nMode: Wildcards';
    } else if (search.useBooleanLogic) {
      tooltip += '\nMode: Boolean Logic';
    } else {
      tooltip += '\nMode: Simple';
    }
    tooltip += `\nSaved: ${new Date(search.createdAt).toLocaleDateString()}`;
    return tooltip;
  }

  /**
   * Get display label for a saved search
   */
  getSavedSearchLabel(search: SavedSearch): string {
    if (search.useWildcards) {
      return '🔍 ' + search.query;
    } else if (search.useBooleanLogic) {
      return '🔢 ' + search.query;
    } else {
      return search.query;
    }
  }
}
