import { Component, EventEmitter, Output, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LibraryFilterService, LibraryFilters, SearchInFields } from '../../services/library-filter.service';

// Re-export for backward compatibility
export { LibraryFilters, SearchInFields } from '../../services/library-filter.service';

@Component({
  selector: 'app-library-search-filters',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './library-search-filters.component.html',
  styleUrls: ['./library-search-filters.component.scss']
})
export class LibrarySearchFiltersComponent {
  private filterService = inject(LibraryFilterService);

  @Output() filtersChanged = new EventEmitter<LibraryFilters>();

  expanded = signal(false);

  filters: LibraryFilters = this.filterService.getDefaultFilters();

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
    this.filters = this.filterService.getDefaultFilters();
    this.emitFilters();
  }

  private emitFilters() {
    this.filtersChanged.emit({ ...this.filters });
  }
}
