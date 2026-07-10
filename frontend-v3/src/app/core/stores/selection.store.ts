import { Injectable, computed, signal } from '@angular/core';

/**
 * Shared selection state for the library/inspector.
 *
 * Phase 1 SCAFFOLD ONLY — not yet wired to the cascade. Phase 3 (inspector)
 * makes the cascade write here and the toolbar/inspector read from here,
 * replacing library-page's local selectedCount/selectedVideoIds signals.
 */
@Injectable({ providedIn: 'root' })
export class SelectionStore {
  selectedIds = signal<Set<string>>(new Set());

  count = computed(() => this.selectedIds().size);
  hasSelection = computed(() => this.count() > 0);
  singleId = computed(() => (this.count() === 1 ? [...this.selectedIds()][0] : null));

  set(ids: Iterable<string>): void {
    this.selectedIds.set(new Set(ids));
  }

  clear(): void {
    this.selectedIds.set(new Set());
  }
}
