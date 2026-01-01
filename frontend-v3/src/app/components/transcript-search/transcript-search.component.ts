import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, ViewChild, ElementRef, inject } from '@angular/core';
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
import { TranscriptSearchService } from '../../services/transcript-search.service';

export interface TranscriptMatch {
  index: number;
  text: string;
  context: string;
  timestamp?: number; // Timestamp in seconds if we can parse it from SRT
}

export interface SavedSearch {
  id: string;
  query: string;
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
  private transcriptSearchService = inject(TranscriptSearchService);

  @Input() transcriptText: string | null = null;
  @Input() transcriptExists = false;
  @Output() seekToTime = new EventEmitter<number>();
  @Output() runAnalysis = new EventEmitter<void>();

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  searchQuery = '';
  matches: TranscriptMatch[] = [];
  isSearching = false;
  selectedMatchIndex = -1;

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

  /**
   * Handle keyboard events on the search input to prevent interference
   * from global keyboard handlers
   */
  onInputKeyDown(event: KeyboardEvent) {
    // Stop all keyboard events from propagating up when the search input is focused
    // This prevents video player shortcuts and other global handlers
    // from interfering with typing in the search box
    event.stopPropagation();
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
      const results = this.transcriptSearchService.searchTranscript(query, lines);

      // Convert service results to component matches
      this.matches = results.map((result, index) => ({
        index,
        text: result.matchText,
        context: result.context,
        timestamp: result.timestamp
      }));
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      this.isSearching = false;
    }
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
    const existing = this.savedSearches.find(s => s.query === this.searchQuery);

    if (existing) {
      return;
    }

    // Add new saved search
    const newSearch: SavedSearch = {
      id: Date.now().toString(),
      query: this.searchQuery,
      createdAt: new Date().toISOString()
    };

    this.savedSearches.unshift(newSearch);
    this.saveSavedSearches();
  }

  /**
   * Load a saved search
   */
  loadSavedSearch(search: SavedSearch): void {
    this.searchQuery = search.query;
    this.onSearchInput();
  }

  /**
   * Delete a saved search
   */
  deleteSavedSearch(search: SavedSearch, event: Event): void {
    event.stopPropagation();
    this.savedSearches = this.savedSearches.filter(s => s.id !== search.id);
    this.saveSavedSearches();
  }

  /**
   * Get tooltip text for a saved search
   */
  getSavedSearchTooltip(search: SavedSearch): string {
    return `Query: ${search.query}\nSaved: ${new Date(search.createdAt).toLocaleDateString()}`;
  }

  /**
   * Get display label for a saved search
   */
  getSavedSearchLabel(search: SavedSearch): string {
    return search.query;
  }
}
