import { Injectable } from '@angular/core';
import { SelectionModel } from '@angular/cdk/collections';
import { BehaviorSubject } from 'rxjs';

/**
 * Centralized selection service for Cascade list component
 * Provides a single source of truth for selection state
 */
@Injectable()
export class CascadeSelectionService {
  // Single source of truth for selection
  private selectionModel = new SelectionModel<string>(true); // true = multi-select

  // Observable for external components to react to selection changes
  public selection$ = new BehaviorSubject<Set<string>>(new Set());

  // Highlighted item (focused but not necessarily selected)
  private highlightedId: string | null = null;
  public highlighted$ = new BehaviorSubject<string | null>(null);

  // Anchor for range selection (Shift+Click)
  private anchorId: string | null = null;

  constructor() {
    // Sync selection model changes to observable
    this.selectionModel.changed.subscribe(() => {
      this.selection$.next(new Set(this.selectionModel.selected));
    });
  }

  /**
   * Select a single item
   * @param id - Item ID to select
   * @param clearOthers - If true, clear all other selections (default: true)
   */
  select(id: string, clearOthers = true): void {
    if (clearOthers) {
      this.selectionModel.clear();
    }
    this.selectionModel.select(id);
    this.anchorId = id;
  }

  /**
   * Toggle selection of an item
   */
  toggle(id: string): void {
    this.selectionModel.toggle(id);
    if (this.selectionModel.isSelected(id)) {
      this.anchorId = id;
    }
  }

  /**
   * Select a range of items from anchor to target
   * @param allItemIds - All item IDs in display order
   * @param targetId - The target item ID for range selection
   */
  selectRange(allItemIds: string[], targetId: string): void {
    if (!this.anchorId) {
      this.select(targetId, true);
      return;
    }

    const anchorIndex = allItemIds.indexOf(this.anchorId);
    const targetIndex = allItemIds.indexOf(targetId);

    if (anchorIndex === -1 || targetIndex === -1) {
      return;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);

    // Clear current selection
    this.selectionModel.clear();

    // Select range
    for (let i = start; i <= end; i++) {
      this.selectionModel.select(allItemIds[i]);
    }
  }

  /**
   * Deselect an item
   */
  deselect(id: string): void {
    this.selectionModel.deselect(id);
  }

  /**
   * Clear all selections
   */
  clear(): void {
    this.selectionModel.clear();
    this.anchorId = null;
  }

  /**
   * Select all items
   */
  selectAll(ids: string[]): void {
    this.selectionModel.select(...ids);
  }

  /**
   * Check if an item is selected
   */
  isSelected(id: string): boolean {
    return this.selectionModel.isSelected(id);
  }

  /**
   * Get all selected item IDs
   */
  getSelected(): string[] {
    return this.selectionModel.selected;
  }

  /**
   * Set highlighted item (focus without selection)
   */
  setHighlighted(id: string | null): void {
    this.highlightedId = id;
    this.highlighted$.next(id);
  }

  /**
   * Get highlighted item ID
   */
  getHighlighted(): string | null {
    return this.highlightedId;
  }

  /**
   * Navigate to next/previous item
   * @param allItemIds - All item IDs in display order
   * @param direction - 1 for next, -1 for previous
   * @param select - If true, select the item. If false, just highlight it
   */
  navigate(allItemIds: string[], direction: 1 | -1, select = false): string | null {
    if (allItemIds.length === 0) {
      return null;
    }

    let currentIndex = -1;

    // Find current position (use highlighted or last selected)
    if (this.highlightedId) {
      currentIndex = allItemIds.indexOf(this.highlightedId);
    } else if (this.selectionModel.selected.length > 0) {
      const lastSelected = this.selectionModel.selected[this.selectionModel.selected.length - 1];
      currentIndex = allItemIds.indexOf(lastSelected);
    }

    // Calculate next index
    const nextIndex = currentIndex === -1
      ? (direction === 1 ? 0 : allItemIds.length - 1)
      : Math.max(0, Math.min(allItemIds.length - 1, currentIndex + direction));

    const nextId = allItemIds[nextIndex];

    if (select) {
      this.select(nextId, true);
    } else {
      this.setHighlighted(nextId);
    }

    return nextId;
  }

  /**
   * Destroy the service and clean up
   */
  destroy(): void {
    this.selectionModel.clear();
    this.selection$.complete();
    this.highlighted$.complete();
  }
}
