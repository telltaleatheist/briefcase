import { Component, EventEmitter, Output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface LibraryFilters {
  searchQuery: string;
  dateRange: 'all' | 'today' | 'week' | 'month' | 'year';
  mediaType: 'all' | 'video' | 'audio' | 'image' | 'document' | 'webpage';
  hasTranscript: boolean | null;
  hasAnalysis: boolean | null;
  hasSuggestions: boolean | null;
  sortBy: 'date' | 'name' | 'duration' | 'suggestions' | 'no-analysis' | 'no-transcript';
  sortOrder: 'asc' | 'desc';
}

@Component({
  selector: 'app-library-search-filters',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './library-search-filters.component.html',
  styleUrls: ['./library-search-filters.component.scss']
})
export class LibrarySearchFiltersComponent {
  @Output() filtersChanged = new EventEmitter<LibraryFilters>();

  expanded = signal(false);

  filters: LibraryFilters = {
    searchQuery: '',
    dateRange: 'all',
    mediaType: 'all',
    hasTranscript: null,
    hasAnalysis: null,
    hasSuggestions: null,
    sortBy: 'date',
    sortOrder: 'desc'
  };

  toggleAccordion() {
    this.expanded.set(!this.expanded());
  }

  onSearchFocus() {
    // Auto-expand filters when search box is focused
    this.expanded.set(true);
  }

  onSearchChange() {
    this.emitFilters();
  }

  onFilterChange() {
    this.emitFilters();
  }

  clearFilters() {
    this.filters = {
      searchQuery: '',
      dateRange: 'all',
      mediaType: 'all',
      hasTranscript: null,
      hasAnalysis: null,
      hasSuggestions: null,
      sortBy: 'date',
      sortOrder: 'desc'
    };
    this.emitFilters();
  }

  private emitFilters() {
    this.filtersChanged.emit({ ...this.filters });
  }
}
