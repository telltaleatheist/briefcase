import { Component, Input, Output, EventEmitter, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { SearchFilters, FileTypeFilters, SortField, SortOrder } from '../../../services/video-filter.service';

export interface TagData {
  people: Array<{ name: string; count: number }>;
  topic: Array<{ name: string; count: number }>;
}

export interface SearchCriteriaChange {
  searchQuery: string;
  searchFilters: SearchFilters;
  selectedTags: string[];
  fileTypeFilters: FileTypeFilters;
  sortBy: SortField;
  sortOrder: SortOrder;
}

/**
 * SearchBarComponent
 *
 * Reusable search bar with advanced filters for video library.
 * Includes:
 * - Search input with clear button
 * - Expandable filters accordion
 * - Search field filters (filename, transcript, analysis, tags)
 * - Sort options
 * - Tag filters (people, topics)
 */
@Component({
  selector: 'app-search-bar',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatExpansionModule,
    MatCheckboxModule,
    MatChipsModule
  ],
  templateUrl: './search-bar.component.html',
  styleUrls: ['./search-bar.component.scss']
})
export class SearchBarComponent implements OnDestroy {
  // Inputs
  @Input() searchQuery: string = '';
  @Input() searchFilters: SearchFilters = {
    filename: true,
    aiDescription: true,
    transcript: true,
    analysis: true,
    tags: true
  };
  @Input() selectedTags: string[] = [];
  @Input() fileTypeFilters: FileTypeFilters = {
    video: true,
    audio: true,
    document: true,
    image: true,
    webpage: true
  };
  @Input() sortBy: SortField = 'date';
  @Input() sortOrder: SortOrder = 'desc';
  @Input() allTags: TagData | null = null;
  @Input() filtersExpanded: boolean = false;

  // Outputs
  @Output() searchChange = new EventEmitter<string>();
  @Output() criteriaChange = new EventEmitter<SearchCriteriaChange>();
  @Output() clearAll = new EventEmitter<void>();
  @Output() filtersExpandedChange = new EventEmitter<boolean>();

  // Debounce timer for search
  private searchDebounceTimer: any;
  private readonly SEARCH_DEBOUNCE_MS = 300;

  ngOnDestroy(): void {
    // Clean up debounce timer
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
  }

  /**
   * Handle search query change with debouncing
   */
  onSearchQueryChange(): void {
    // Clear existing timer
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    // Emit immediate change for input binding
    this.searchChange.emit(this.searchQuery);

    // Debounce the actual criteria change (which triggers search)
    this.searchDebounceTimer = setTimeout(() => {
      this.emitCriteriaChange();
    }, this.SEARCH_DEBOUNCE_MS);
  }

  /**
   * Handle search input keydown
   */
  onSearchInputKeyDown(event: KeyboardEvent): void {
    // Allow parent to handle special keys if needed
    if (event.key === 'Escape') {
      this.clearSearch();
    }
  }

  /**
   * Clear search query and filters
   */
  clearSearch(): void {
    // Clear debounce timer since we want immediate clear
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    this.searchQuery = '';
    this.selectedTags = [];
    this.clearAll.emit();
    this.emitCriteriaChange();
  }

  /**
   * Toggle filters expanded state
   */
  toggleFiltersExpanded(): void {
    this.filtersExpanded = !this.filtersExpanded;
    this.filtersExpandedChange.emit(this.filtersExpanded);
  }

  /**
   * Handle filters expansion panel opened
   */
  onFiltersOpened(): void {
    this.filtersExpanded = true;
    this.filtersExpandedChange.emit(true);
  }

  /**
   * Handle filters expansion panel closed
   */
  onFiltersClosed(): void {
    this.filtersExpanded = false;
    this.filtersExpandedChange.emit(false);
  }

  /**
   * Handle search filter checkbox change
   */
  onSearchFilterChange(): void {
    this.emitCriteriaChange();
  }

  /**
   * Change sort field
   */
  changeSortBy(field: SortField): void {
    // If clicking the same field, toggle order
    if (this.sortBy === field) {
      this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortBy = field;
      // Default to descending for most sorts
      this.sortOrder = 'desc';
    }

    this.emitCriteriaChange();
  }

  /**
   * Toggle tag selection
   */
  toggleTag(tagName: string): void {
    const index = this.selectedTags.indexOf(tagName);
    if (index >= 0) {
      this.selectedTags.splice(index, 1);
    } else {
      this.selectedTags.push(tagName);
    }

    this.emitCriteriaChange();
  }

  /**
   * Check if tag is selected
   */
  isTagSelected(tagName: string): boolean {
    return this.selectedTags.includes(tagName);
  }

  /**
   * Clear tag filters
   */
  clearTagFilters(): void {
    this.selectedTags = [];
    this.emitCriteriaChange();
  }

  /**
   * Emit criteria change event
   */
  private emitCriteriaChange(): void {
    this.criteriaChange.emit({
      searchQuery: this.searchQuery,
      searchFilters: this.searchFilters,
      selectedTags: this.selectedTags,
      fileTypeFilters: this.fileTypeFilters,
      sortBy: this.sortBy,
      sortOrder: this.sortOrder
    });
  }

  /**
   * Get sort arrow indicator
   */
  getSortArrow(field: SortField): string {
    if (this.sortBy !== field) {
      return '';
    }
    return this.sortOrder === 'desc' ? '↓' : '↑';
  }

  /**
   * Check if any filters are active
   */
  hasActiveFilters(): boolean {
    return this.searchQuery.length > 0 || this.selectedTags.length > 0;
  }
}
