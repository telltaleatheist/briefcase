import { Component, EventEmitter, Output, signal, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { LibraryFilterService, LibraryFilters, rememberDeepSearch } from '../../services/library-filter.service';

export { LibraryFilters } from '../../services/library-filter.service';

@Component({
  selector: 'app-library-search-filters',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './library-search-filters.component.html',
  styleUrls: ['./library-search-filters.component.scss']
})
export class LibrarySearchFiltersComponent implements OnDestroy {
  private filterService = inject(LibraryFilterService);

  @Output() filtersChanged = new EventEmitter<LibraryFilters>();

  expanded = signal(false);
  isSearching = signal(false);

  filters: LibraryFilters = this.filterService.getDefaultFilters();

  // Debounce search input
  private searchSubject = new Subject<void>();
  private searchSubscription = this.searchSubject.pipe(
    debounceTime(300)
  ).subscribe(() => {
    this.emitFilters();
    this.isSearching.set(false);
  });

  ngOnDestroy() {
    this.searchSubscription.unsubscribe();
  }

  toggleAccordion() {
    this.expanded.set(!this.expanded());
  }

  onSearchFocus() {
    // Auto-expand filters when search box is focused
    this.expanded.set(true);
  }

  onSearchChange() {
    this.isSearching.set(true);
    this.searchSubject.next();
  }

  onFilterChange() {
    this.emitFilters();
  }

  clearFilters() {
    // Deep search is a preference, not a filter: clearing keeps it.
    this.filters = { ...this.filterService.getDefaultFilters(), deepSearch: this.filters.deepSearch };
    this.emitFilters();
  }

  onDeepSearchChange(on: boolean) {
    this.filters.deepSearch = on;
    rememberDeepSearch(on);
    this.emitFilters();
  }

  private emitFilters() {
    // Relevance is offered only while searching; without a search the library sorts by date.
    if (this.filters.sortBy === 'relevance' && !this.filters.searchQuery.trim()) this.filters.sortBy = 'date';
    this.filtersChanged.emit({ ...this.filters });
  }
}
