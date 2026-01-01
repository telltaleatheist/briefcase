import { Component, EventEmitter, Output, signal, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { LibraryFilterService, LibraryFilters, SearchInFields } from '../../services/library-filter.service';

// Re-export for backward compatibility
export { LibraryFilters, SearchInFields, SearchOptions } from '../../services/library-filter.service';

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
    this.filters = this.filterService.getDefaultFilters();
    this.emitFilters();
  }

  private emitFilters() {
    this.filtersChanged.emit({ ...this.filters });
  }
}
