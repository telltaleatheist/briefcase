import { Component, Input, Output, EventEmitter, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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
  showOnlyTitleSuggestions?: boolean;
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
    MatChipsModule,
    MatDialogModule
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
  @Input() showOnlyTitleSuggestions: boolean = false;

  // Outputs
  @Output() searchChange = new EventEmitter<string>();
  @Output() criteriaChange = new EventEmitter<SearchCriteriaChange>();
  @Output() clearAll = new EventEmitter<void>();
  @Output() filtersExpandedChange = new EventEmitter<boolean>();

  // Debounce timer for search
  private searchDebounceTimer: any;
  private readonly SEARCH_DEBOUNCE_MS = 300;

  constructor(private dialog: MatDialog) {}

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
   * Handle title suggestion filter change
   */
  onTitleSuggestionFilterChange(): void {
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
      sortOrder: this.sortOrder,
      showOnlyTitleSuggestions: this.showOnlyTitleSuggestions
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

  /**
   * Show search help dialog
   */
  showSearchHelp(): void {
    this.dialog.open(SearchHelpDialogComponent, {
      width: '600px',
      maxHeight: '80vh'
    });
  }
}

/**
 * Search Help Dialog Component
 */
@Component({
  selector: 'app-search-help-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>search</mat-icon>
      Search Help
    </h2>
    <mat-dialog-content>
      <div class="help-content">
        <h3>Search Features</h3>

        <div class="feature-section">
          <h4>✓ Basic Search (AND logic by default)</h4>
          <p>All search terms must be present in results</p>
          <div class="example">
            <code>dad vax bribe</code>
            <span class="arrow">→</span>
            <span class="result">Videos with ALL three words</span>
          </div>
        </div>

        <div class="feature-section">
          <h4>⊖ Exclude Terms (NOT operator)</h4>
          <p>Use <code>-</code> before a word to exclude it from results</p>
          <div class="example">
            <code>vax -full</code>
            <span class="arrow">→</span>
            <span class="result">Videos with "vax" but NOT "full"</span>
          </div>
          <div class="example">
            <code>covid -vaccine -mask</code>
            <span class="arrow">→</span>
            <span class="result">Videos about covid, excluding vaccine & mask</span>
          </div>
        </div>

        <div class="feature-section">
          <h4>🔍 Exact Phrases</h4>
          <p>Use quotes for exact phrase matching</p>
          <div class="example">
            <code>"anti vax"</code>
            <span class="arrow">→</span>
            <span class="result">Exact phrase "anti vax"</span>
          </div>
          <div class="example">
            <code>dad "anti vax" bribe</code>
            <span class="arrow">→</span>
            <span class="result">Videos with "dad", "bribe", AND exact phrase "anti vax"</span>
          </div>
        </div>

        <div class="feature-section">
          <h4>∨ OR Operator</h4>
          <p>Use <code>OR</code> (uppercase) to match any term</p>
          <div class="example">
            <code>dad OR father</code>
            <span class="arrow">→</span>
            <span class="result">Videos with either "dad" or "father"</span>
          </div>
        </div>

        <div class="feature-section">
          <h4>* Wildcards</h4>
          <p>Automatic prefix matching (added by default)</p>
          <div class="example">
            <code>vax</code>
            <span class="arrow">→</span>
            <span class="result">Matches: vax, vaccine, vaxxed, vaccination</span>
          </div>
        </div>

        <div class="feature-section">
          <h4>📝 Advanced Examples</h4>
          <div class="example">
            <code>trump -full -complete</code>
            <span class="arrow">→</span>
            <span class="result">Videos about trump, excluding "full" and "complete"</span>
          </div>
          <div class="example">
            <code>"joe rogan" covid -vaccine</code>
            <span class="arrow">→</span>
            <span class="result">Joe Rogan discussing covid, but not vaccines</span>
          </div>
          <div class="example">
            <code>(trump OR biden) -debate</code>
            <span class="arrow">→</span>
            <span class="result">Either politician, but no debates</span>
          </div>
        </div>

        <div class="tip-section">
          <h3>💡 Pro Tips</h3>
          <ul>
            <li>Use the filters below to search in specific fields (filename, transcript, etc.)</li>
            <li>Combine multiple exclusions: <code>-word1 -word2 -word3</code></li>
            <li>Search is case-insensitive</li>
            <li>Partial word matching is automatic</li>
          </ul>
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-raised-button color="primary" mat-dialog-close>Got it!</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .help-content {
      padding: 16px 0;
    }

    h3 {
      color: #2196F3;
      margin-top: 0;
      margin-bottom: 16px;
      font-size: 18px;
    }

    .feature-section {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e0e0e0;
    }

    .feature-section:last-of-type {
      border-bottom: none;
    }

    h4 {
      margin: 0 0 8px 0;
      color: #555;
      font-size: 14px;
      font-weight: 600;
    }

    p {
      margin: 0 0 12px 0;
      color: #666;
      font-size: 13px;
    }

    .example {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      background: #f5f5f5;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 13px;
    }

    .example:last-child {
      margin-bottom: 0;
    }

    code {
      background: #fff;
      padding: 4px 8px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      color: #d32f2f;
      border: 1px solid #ddd;
      white-space: nowrap;
    }

    .arrow {
      color: #999;
      font-weight: bold;
    }

    .result {
      color: #4CAF50;
      font-weight: 500;
      flex: 1;
    }

    .tip-section {
      background: #E3F2FD;
      padding: 16px;
      border-radius: 8px;
      margin-top: 24px;
    }

    .tip-section h3 {
      margin-top: 0;
      color: #1976D2;
    }

    .tip-section ul {
      margin: 8px 0 0 0;
      padding-left: 20px;
    }

    .tip-section li {
      margin-bottom: 8px;
      color: #555;
      font-size: 13px;
    }

    .tip-section li:last-child {
      margin-bottom: 0;
    }

    mat-dialog-content {
      max-height: 70vh;
      overflow-y: auto;
    }

    /* Dark theme support */
    @media (prefers-color-scheme: dark) {
      .feature-section {
        border-bottom-color: #333;
      }

      h4 {
        color: #bbb;
      }

      p {
        color: #999;
      }

      .example {
        background: #2a2a2a;
      }

      code {
        background: #1a1a1a;
        color: #ff6b6b;
        border-color: #444;
      }

      .result {
        color: #81C784;
      }

      .tip-section {
        background: #1a2332;
      }

      .tip-section h3 {
        color: #64B5F6;
      }

      .tip-section li {
        color: #bbb;
      }
    }
  `]
})
export class SearchHelpDialogComponent {}
