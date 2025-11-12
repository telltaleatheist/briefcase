import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, HostListener, ViewChild, ElementRef, TemplateRef, ContentChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import {
  ListItem,
  ItemGroup,
  ItemDisplayConfig,
  GroupConfig,
  KeyboardConfig,
  SelectionMode,
  ItemStatus,
  ItemProgress,
  ContextMenuAction
} from './item-list.types';

@Component({
  selector: 'app-item-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatMenuModule
  ],
  templateUrl: './item-list.component.html',
  styleUrls: ['./item-list.component.scss']
})
export class ItemListComponent<T extends ListItem = ListItem> implements OnInit, OnDestroy {
  // ========================================
  // Inputs
  // ========================================

  @Input() items: T[] = [];
  @Input() displayConfig!: ItemDisplayConfig;
  @Input() groupConfig?: GroupConfig<T>;
  @Input() keyboardConfig: KeyboardConfig = {
    enableArrowNavigation: true,
    enableTypeAhead: true,
    typeAheadField: 'title',
    enableSpaceAction: true,
    enableDelete: true,
    enableSelectAll: true,
    enableEscapeDeselect: true
  };
  @Input() selectionMode: SelectionMode = SelectionMode.Multiple;
  @Input() contextMenuActions: ContextMenuAction[] = [];
  @Input() emptyMessage = 'No items to display';
  @Input() emptyIcon = 'inbox';

  // Status configuration
  @Input() statusMapper?: (item: T) => ItemStatus | null;

  // Progress configuration
  @Input() progressMapper?: (item: T) => ItemProgress | null;
  @Input() progressVersion: number = 0; // Increment this to force progress cache clear

  // Custom action template (for buttons like delete, remove, etc.)
  @ContentChild('itemActions') itemActionsTemplate: TemplateRef<any> | null = null;

  // ========================================
  // Outputs
  // ========================================

  @Output() itemClick = new EventEmitter<T>();
  @Output() itemDoubleClick = new EventEmitter<T>();
  @Output() itemsSelected = new EventEmitter<T[]>();
  @Output() itemsDeselected = new EventEmitter<T[]>();
  @Output() itemHighlighted = new EventEmitter<T | null>(); // Emitted when highlighted item changes
  @Output() spaceAction = new EventEmitter<T | null>();
  @Output() deleteAction = new EventEmitter<T[]>();
  @Output() contextMenu = new EventEmitter<{ event: MouseEvent; item: T }>(); // Raw context menu event for custom handling
  @Output() contextMenuAction = new EventEmitter<{ action: string; items: T[] }>();
  @Output() groupToggle = new EventEmitter<{ groupId: string; collapsed: boolean }>();
  @Output() groupSelect = new EventEmitter<{ groupId: string; items: T[] }>();

  // ========================================
  // Internal State
  // ========================================

  @ViewChild('listContainer') listContainer?: ElementRef<HTMLDivElement>;

  // Grouping
  groupedItems: ItemGroup<T>[] = [];
  collapsedGroups = new Set<string>();

  // Selection
  selectedItems = new Set<string>();
  highlightedItemId: string | null = null;
  selectedGroups = new Set<string>();
  private selectionAnchorId: string | null = null; // For Shift+Click and Shift+Arrow range selection

  // Type-ahead
  private typeAheadBuffer = '';
  private typeAheadTimer: any;

  // Editing state (for inline editing)
  editingItems: { [itemId: string]: { [field: string]: boolean } } = {};

  // Performance caches (cleared on ngOnChanges)
  private statusCache = new Map<string, ItemStatus | null>();
  private progressCache = new Map<string, ItemProgress | null>();
  private iconCache = new Map<string, string>();
  private badgeCache = new Map<string, string | null>();

  // ========================================
  // Lifecycle
  // ========================================

  ngOnInit() {
    this.updateGroupedItems();
  }

  ngOnDestroy() {
    if (this.typeAheadTimer) {
      clearTimeout(this.typeAheadTimer);
    }
  }

  ngOnChanges() {
    this.updateGroupedItems();
    // Clear performance caches when items change
    this.statusCache.clear();
    this.progressCache.clear();
    this.iconCache.clear();
    this.badgeCache.clear();
  }

  // ========================================
  // TrackBy Functions (Performance Optimization)
  // ========================================

  /**
   * TrackBy function for groups to prevent unnecessary DOM recreation
   */
  trackByGroupId(index: number, group: ItemGroup<T>): string {
    return group.id;
  }

  /**
   * TrackBy function for items to prevent unnecessary DOM recreation
   */
  trackByItemId(index: number, item: T): string {
    return item.id;
  }

  // ========================================
  // Grouping Logic
  // ========================================

  private updateGroupedItems() {
    if (!this.groupConfig || !this.groupConfig.enabled) {
      // No grouping - create single group with all items
      this.groupedItems = [{
        id: 'all',
        label: 'All Items',
        items: this.items,
        collapsed: false
      }];
      return;
    }

    // Group items
    const groups = new Map<string, T[]>();

    this.items.forEach(item => {
      const groupKey = this.groupConfig!.groupBy(item);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(item);
    });

    // Convert to ItemGroup array
    const groupKeys = Array.from(groups.keys());
    if (this.groupConfig.sortDescending) {
      groupKeys.sort((a, b) => b.localeCompare(a));
    } else {
      groupKeys.sort((a, b) => a.localeCompare(b));
    }

    this.groupedItems = groupKeys.map(key => ({
      id: key,
      label: this.groupConfig!.groupLabel(key),
      items: groups.get(key)!,
      collapsed: this.collapsedGroups.has(key)
    }));
  }

  toggleGroup(groupId: string) {
    if (this.collapsedGroups.has(groupId)) {
      this.collapsedGroups.delete(groupId);
    } else {
      this.collapsedGroups.add(groupId);
    }
    this.updateGroupedItems();
    this.groupToggle.emit({ groupId, collapsed: this.collapsedGroups.has(groupId) });
  }

  isGroupCollapsed(groupId: string): boolean {
    return this.collapsedGroups.has(groupId);
  }

  // ========================================
  // Selection Logic
  // ========================================

  isItemSelected(itemId: string): boolean {
    // Ghost parents and children can never be selected
    const item = this.items.find(i => i.id === itemId);
    if (item && (item['isGhostParent'] || item['isGhostChild'])) {
      return false;
    }
    return this.selectedItems.has(itemId);
  }

  isItemHighlighted(itemId: string): boolean {
    // Ghost parents and children can never be highlighted
    const item = this.items.find(i => i.id === itemId);
    if (item && (item['isGhostParent'] || item['isGhostChild'])) {
      return false;
    }
    return this.highlightedItemId === itemId;
  }

  /**
   * Check if item is at the top edge of a selection group
   * (selected or highlighted, but previous item is not selected/highlighted)
   */
  isSelectionEdgeTop(items: T[], index: number): boolean {
    const currentItem = items[index];
    // Item must be either selected OR highlighted
    const isCurrentActive = this.selectedItems.has(currentItem.id) || this.highlightedItemId === currentItem.id;
    if (!isCurrentActive) {
      return false;
    }

    // First item in group is always a top edge if active
    if (index === 0) {
      return true;
    }

    // Check if previous item is not selected or highlighted
    const prevItem = items[index - 1];
    const isPrevActive = this.selectedItems.has(prevItem.id) || this.highlightedItemId === prevItem.id;
    return !isPrevActive;
  }

  /**
   * Check if item is at the bottom edge of a selection group
   * (selected or highlighted, but next item is not selected/highlighted)
   */
  isSelectionEdgeBottom(items: T[], index: number): boolean {
    const currentItem = items[index];
    // Item must be either selected OR highlighted
    const isCurrentActive = this.selectedItems.has(currentItem.id) || this.highlightedItemId === currentItem.id;
    if (!isCurrentActive) {
      return false;
    }

    // Last item in group is always a bottom edge if active
    if (index === items.length - 1) {
      return true;
    }

    // Check if next item is not selected or highlighted
    const nextItem = items[index + 1];
    const isNextActive = this.selectedItems.has(nextItem.id) || this.highlightedItemId === nextItem.id;
    return !isNextActive;
  }

  handleItemClick(item: T, event: MouseEvent) {
    // Check if this is a ghost parent - if so, scroll to real parent instead
    if (item['isGhostParent']) {
      // Scroll to the real parent
      const realParentId = item.id;  // Ghost has the same ID as the real parent
      this.scrollToItem(realParentId);
      return;  // Don't emit click or allow selection
    }

    // Check if this is a ghost child - if so, scroll to real child instead
    if (item['isGhostChild']) {
      // Scroll to the real child
      const realChildId = item.id;  // Ghost has the same ID as the real child
      this.scrollToItem(realChildId);
      return;  // Don't emit click or allow selection
    }

    this.itemClick.emit(item);

    if (this.selectionMode === SelectionMode.None) {
      return;
    }

    // Handle multi-select with Cmd/Ctrl (Finder behavior)
    if ((event.metaKey || event.ctrlKey) && this.selectionMode === SelectionMode.Multiple) {
      // Finder behavior: If there's a highlighted item that's not selected, select it first
      const itemsToSelect: T[] = [];
      if (this.highlightedItemId && !this.selectedItems.has(this.highlightedItemId) && this.highlightedItemId !== item.id) {
        const highlightedItem = this.items.find(i => i.id === this.highlightedItemId);
        if (highlightedItem) {
          this.selectedItems.add(this.highlightedItemId);
          itemsToSelect.push(highlightedItem);
        }
      }

      // Toggle the clicked item
      const wasSelected = this.selectedItems.has(item.id);
      if (wasSelected) {
        this.selectedItems.delete(item.id);
        this.itemsDeselected.emit([item]);

        // When deselecting, update highlight to another selected item or clear it
        if (this.selectedItems.size > 0) {
          // Find the last selected item (or any selected item) to highlight
          const flatItems = this.getFlatItemList();
          // Find the closest selected item (prefer items near the deselected one)
          const itemIndex = flatItems.findIndex(i => i.id === item.id);
          let newHighlight: T | null = null;

          // Try to find a selected item after this one
          for (let i = itemIndex + 1; i < flatItems.length; i++) {
            if (this.selectedItems.has(flatItems[i].id)) {
              newHighlight = flatItems[i];
              break;
            }
          }

          // If none found, try before
          if (!newHighlight) {
            for (let i = itemIndex - 1; i >= 0; i--) {
              if (this.selectedItems.has(flatItems[i].id)) {
                newHighlight = flatItems[i];
                break;
              }
            }
          }

          // If still none found, just pick the first selected item
          if (!newHighlight) {
            const firstSelectedId = Array.from(this.selectedItems)[0];
            newHighlight = flatItems.find(i => i.id === firstSelectedId) || null;
          }

          this.highlightedItemId = newHighlight?.id || null;
          this.selectionAnchorId = newHighlight?.id || null;
          if (newHighlight) {
            this.itemHighlighted.emit(newHighlight);
          }
        } else {
          // No items selected, clear highlight
          this.highlightedItemId = null;
          this.selectionAnchorId = null;
          this.itemHighlighted.emit(null);
        }
      } else {
        this.selectedItems.add(item.id);
        itemsToSelect.push(item);
        this.highlightedItemId = item.id;
        this.selectionAnchorId = item.id; // Update anchor
      }

      // Emit selection events for all newly selected items
      if (itemsToSelect.length > 0) {
        this.itemsSelected.emit(itemsToSelect);
      }

      return;
    }

    // Handle range select with Shift
    if (event.shiftKey && this.selectionMode === SelectionMode.Multiple) {
      const anchorId = this.selectionAnchorId || this.highlightedItemId;
      if (anchorId) {
        this.selectRange(anchorId, item.id);
      }
      return;
    }

    // Single selection
    const wasSelected = this.selectedItems.has(item.id);
    const previouslySelected = Array.from(this.selectedItems);

    this.selectedItems.clear();

    if (!wasSelected) {
      this.selectedItems.add(item.id);
      this.itemsSelected.emit([item]);
    }

    if (previouslySelected.length > 0) {
      const deselected = this.items.filter(i => previouslySelected.includes(i.id) && i.id !== item.id);
      if (deselected.length > 0) {
        this.itemsDeselected.emit(deselected);
      }
    }

    this.highlightedItemId = item.id;
    this.selectionAnchorId = item.id; // Update anchor
  }

  handleItemDoubleClick(item: T) {
    this.itemDoubleClick.emit(item);
  }

  private selectRange(fromId: string, toId: string) {
    const flatItems = this.getFlatItemList();
    const fromIndex = flatItems.findIndex(i => i.id === fromId);
    const toIndex = flatItems.findIndex(i => i.id === toId);

    if (fromIndex === -1 || toIndex === -1) return;

    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);

    // Finder behavior: Deselect all items outside the range
    const previouslySelected = Array.from(this.selectedItems);
    this.selectedItems.clear();

    // Select all items in the range
    const itemsToSelect: T[] = [];
    const itemsToDeselect: T[] = [];

    for (let i = start; i <= end; i++) {
      this.selectedItems.add(flatItems[i].id);
      if (!previouslySelected.includes(flatItems[i].id)) {
        itemsToSelect.push(flatItems[i]);
      }
    }

    // Find items that were deselected
    for (const id of previouslySelected) {
      if (!this.selectedItems.has(id)) {
        const item = this.items.find(i => i.id === id);
        if (item) {
          itemsToDeselect.push(item);
        }
      }
    }

    if (itemsToSelect.length > 0) {
      this.itemsSelected.emit(itemsToSelect);
    }

    if (itemsToDeselect.length > 0) {
      this.itemsDeselected.emit(itemsToDeselect);
    }

    this.highlightedItemId = toId;
  }

  selectAll() {
    const previousSize = this.selectedItems.size;
    this.items.forEach(item => this.selectedItems.add(item.id));

    if (this.groupConfig?.selectableGroups) {
      this.groupedItems.forEach(group => this.selectedGroups.add(group.id));
    }

    // Finder behavior: Set first item as highlighted
    const flatItems = this.getFlatItemList();
    if (flatItems.length > 0) {
      this.highlightedItemId = flatItems[0].id;
      this.itemHighlighted.emit(flatItems[0]);
    }

    if (this.selectedItems.size > previousSize) {
      this.itemsSelected.emit(this.items);
    }
  }

  deselectAll() {
    const previouslySelected = this.getSelectedItems();
    this.selectedItems.clear();
    this.selectedGroups.clear();
    this.highlightedItemId = null;

    if (previouslySelected.length > 0) {
      this.itemsDeselected.emit(previouslySelected);
    }
  }

  getSelectedItems(): T[] {
    return this.items.filter(item => this.selectedItems.has(item.id));
  }

  // ========================================
  // Group Selection
  // ========================================

  handleGroupClick(group: ItemGroup<T>, event: MouseEvent) {
    if (!this.groupConfig?.selectableGroups) {
      return;
    }

    const isSelected = this.isGroupSelected(group.id);

    // Handle multi-select with Cmd/Ctrl
    if (event.metaKey || event.ctrlKey) {
      if (isSelected) {
        this.selectedGroups.delete(group.id);
        group.items.forEach(item => this.selectedItems.delete(item.id));
        this.itemsDeselected.emit(group.items);
      } else {
        this.selectedGroups.add(group.id);
        group.items.forEach(item => this.selectedItems.add(item.id));
        this.itemsSelected.emit(group.items);
      }
    } else {
      // Single group selection
      this.selectedGroups.clear();
      this.selectedItems.clear();

      if (!isSelected) {
        this.selectedGroups.add(group.id);
        group.items.forEach(item => this.selectedItems.add(item.id));
        this.itemsSelected.emit(group.items);
      }
    }

    this.groupSelect.emit({ groupId: group.id, items: group.items });
  }

  isGroupSelected(groupId: string): boolean {
    return this.selectedGroups.has(groupId);
  }

  // ========================================
  // Keyboard Navigation
  // ========================================

  @HostListener('keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    // Check if user is editing any field
    const isEditing = Object.values(this.editingItems).some(fields =>
      Object.values(fields).some(editing => editing)
    );

    // Check if focus is on an input/textarea element
    const activeElement = document.activeElement;
    const target = event.target as HTMLElement;
    const isFocusedOnInput = (activeElement && ['INPUT', 'TEXTAREA'].includes(activeElement.tagName)) ||
                             target instanceof HTMLInputElement ||
                             target instanceof HTMLTextAreaElement ||
                             target.tagName === 'INPUT' ||
                             target.tagName === 'TEXTAREA' ||
                             target.closest('input') ||
                             target.closest('textarea') ||
                             target.closest('.mat-mdc-input-element') ||
                             target.classList.contains('mat-mdc-input-element');

    // If editing or focused on input, only allow Escape
    if (isEditing || isFocusedOnInput) {
      if (event.code === 'Escape' && this.keyboardConfig.enableEscapeDeselect) {
        this.cancelEditing();
        if (activeElement && activeElement instanceof HTMLElement) {
          activeElement.blur();
        }
      }
      return;
    }

    // Handle Cmd/Ctrl+A for select all
    if ((event.metaKey || event.ctrlKey) && event.code === 'KeyA' && this.keyboardConfig.enableSelectAll) {
      event.preventDefault();
      this.selectAll();
      return;
    }

    // Handle Delete/Backspace
    if (this.keyboardConfig.enableDelete && this.selectedItems.size > 0) {
      if (event.code === 'Delete' || (event.code === 'Backspace' && event.metaKey)) {
        event.preventDefault();
        event.stopPropagation(); // Prevent event from bubbling to parent handlers
        this.deleteAction.emit(this.getSelectedItems());
        return;
      }
    }

    // Handle Escape to deselect
    if (event.code === 'Escape' && this.keyboardConfig.enableEscapeDeselect) {
      this.deselectAll();
      return;
    }

    // Handle arrow navigation
    if (this.keyboardConfig.enableArrowNavigation) {
      if (event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation(); // Stop event from bubbling to parent handlers
        const direction = event.code === 'ArrowUp' ? -1 : 1;

        // Shift+Arrow: Extend selection (like Finder)
        if (event.shiftKey && this.selectionMode === SelectionMode.Multiple) {
          this.navigateItemsWithShift(direction);
        }
        // Plain Arrow: Move highlight and clear selection (like Finder)
        else {
          this.navigateItems(direction);
        }
        return;
      }
    }

    // Handle Enter/Return to open highlighted or selected items (Finder behavior)
    if ((event.code === 'Enter' || event.code === 'NumpadEnter') && !isFocusedOnInput) {
      event.preventDefault();
      // If there are selected items, emit double-click for all of them
      if (this.selectedItems.size > 0) {
        const selectedItems = this.getSelectedItems();
        selectedItems.forEach(item => this.itemDoubleClick.emit(item));
      }
      // Otherwise, if there's a highlighted item, emit double-click for it
      else if (this.highlightedItemId) {
        const highlightedItem = this.items.find(i => i.id === this.highlightedItemId);
        if (highlightedItem) {
          this.itemDoubleClick.emit(highlightedItem);
        }
      }
      return;
    }

    // Handle spacebar action
    if (event.code === 'Space' && this.keyboardConfig.enableSpaceAction && !isFocusedOnInput) {
      event.preventDefault();
      const highlightedItem = this.highlightedItemId
        ? this.items.find(i => i.id === this.highlightedItemId)
        : null;
      this.spaceAction.emit(highlightedItem || null);
      return;
    }

    // Handle type-ahead
    if (this.keyboardConfig.enableTypeAhead && !isFocusedOnInput && !event.metaKey && !event.ctrlKey && !event.altKey &&
        event.key.length === 1 && event.key.match(/[a-z0-9 ]/i)) {
      event.preventDefault();
      this.handleTypeAhead(event.key);
    }
  }

  private navigateItems(direction: number) {
    const flatItems = this.getFlatItemList();
    if (flatItems.length === 0) return;

    let currentIndex = this.highlightedItemId
      ? flatItems.findIndex(i => i.id === this.highlightedItemId)
      : -1;

    if (currentIndex === -1) {
      currentIndex = direction > 0 ? 0 : flatItems.length - 1;
    } else {
      currentIndex += direction;
      if (currentIndex < 0) currentIndex = 0;
      if (currentIndex >= flatItems.length) currentIndex = flatItems.length - 1;
    }

    const newItem = flatItems[currentIndex];

    // Finder behavior: Arrow keys without modifiers clear selection and just highlight
    const previouslySelected = Array.from(this.selectedItems);
    this.selectedItems.clear();
    this.highlightedItemId = newItem.id;
    this.selectionAnchorId = newItem.id; // Update anchor

    // Emit deselection event if items were previously selected
    if (previouslySelected.length > 0) {
      const deselected = this.items.filter(i => previouslySelected.includes(i.id));
      if (deselected.length > 0) {
        this.itemsDeselected.emit(deselected);
      }
    }

    // Emit highlighted item changed event
    this.itemHighlighted.emit(newItem);

    // Scroll into view
    this.scrollToItem(newItem.id);
  }

  /**
   * Navigate items with Shift held (extend/contract selection like Finder)
   * This uses range selection from the anchor to the current position
   */
  private navigateItemsWithShift(direction: number) {
    const flatItems = this.getFlatItemList();
    if (flatItems.length === 0) return;

    // Find current highlighted index
    let currentIndex = this.highlightedItemId
      ? flatItems.findIndex(i => i.id === this.highlightedItemId)
      : -1;

    if (currentIndex === -1) {
      currentIndex = direction > 0 ? 0 : flatItems.length - 1;
      // Set anchor if not set
      if (!this.selectionAnchorId) {
        this.selectionAnchorId = flatItems[currentIndex].id;
      }
    } else {
      currentIndex += direction;
      if (currentIndex < 0) currentIndex = 0;
      if (currentIndex >= flatItems.length) currentIndex = flatItems.length - 1;
    }

    const newItem = flatItems[currentIndex];

    // Use anchor for range selection (Finder behavior)
    const anchorId = this.selectionAnchorId || this.highlightedItemId;
    if (anchorId) {
      this.selectRange(anchorId, newItem.id);
    }

    // Scroll into view
    this.scrollToItem(newItem.id);
  }

  private handleTypeAhead(key: string) {
    this.typeAheadBuffer += key.toLowerCase();

    if (this.typeAheadTimer) {
      clearTimeout(this.typeAheadTimer);
    }

    this.typeAheadTimer = setTimeout(() => {
      this.typeAheadBuffer = '';
    }, 1000);

    const field = this.keyboardConfig.typeAheadField || 'title';
    const flatItems = this.getFlatItemList();
    const match = flatItems.find(item => {
      const value = item[field]?.toString().toLowerCase() || '';
      return value.startsWith(this.typeAheadBuffer);
    });

    if (match) {
      this.highlightedItemId = match.id;
      this.scrollToItem(match.id);
    }
  }

  private getFlatItemList(): T[] {
    return this.groupedItems.flatMap(group =>
      group.collapsed ? [] : group.items
    );
  }

  private scrollToItem(itemId: string) {
    // Use requestAnimationFrame for immediate, smoother scrolling without setTimeout delay
    requestAnimationFrame(() => {
      const element = document.getElementById(`item-${itemId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      }
    });
  }

  private cancelEditing() {
    this.editingItems = {};
  }

  // ========================================
  // Context Menu
  // ========================================

  handleContextMenu(event: MouseEvent, item: T) {
    event.preventDefault();

    // If item is not selected, select it
    if (!this.selectedItems.has(item.id)) {
      this.selectedItems.clear();
      this.selectedItems.add(item.id);
      this.highlightedItemId = item.id;
    }

    // Emit raw context menu event for custom handling (e.g., Material menu)
    this.contextMenu.emit({ event, item });
  }

  executeContextAction(actionId: string) {
    const selectedItems = this.getSelectedItems();
    this.contextMenuAction.emit({ action: actionId, items: selectedItems });
  }

  // ========================================
  // Display Helpers
  // ========================================

  getPrimaryText(item: T): string {
    if (this.displayConfig.renderPrimary) {
      return this.displayConfig.renderPrimary(item);
    }
    return item[this.displayConfig.primaryField]?.toString() || '';
  }

  getSecondaryText(item: T): string | null {
    if (!this.displayConfig.secondaryField) return null;

    if (this.displayConfig.renderSecondary) {
      return this.displayConfig.renderSecondary(item);
    }
    return item[this.displayConfig.secondaryField]?.toString() || null;
  }

  getIcon(item: T): string {
    // Check cache first
    if (this.iconCache.has(item.id)) {
      return this.iconCache.get(item.id)!;
    }

    // Calculate and cache
    let icon: string;
    if (!this.displayConfig.iconField) {
      icon = 'description';
    } else if (this.displayConfig.renderIcon) {
      icon = this.displayConfig.renderIcon(item);
    } else {
      icon = item[this.displayConfig.iconField]?.toString() || 'description';
    }

    this.iconCache.set(item.id, icon);
    return icon;
  }

  getBadge(item: T): string | null {
    // Check cache first
    if (this.badgeCache.has(item.id)) {
      return this.badgeCache.get(item.id)!;
    }

    // Calculate and cache
    const badge = this.displayConfig.badgeField
      ? (item[this.displayConfig.badgeField]?.toString() || null)
      : null;

    this.badgeCache.set(item.id, badge);
    return badge;
  }

  getMetadata(item: T): string | null {
    if (!this.displayConfig.metadataField) return null;

    if (this.displayConfig.renderMetadata) {
      return this.displayConfig.renderMetadata(item);
    }
    return item[this.displayConfig.metadataField]?.toString() || null;
  }

  getStatus(item: T): ItemStatus | null {
    if (!this.statusMapper) return null;

    // Check cache first
    if (this.statusCache.has(item.id)) {
      return this.statusCache.get(item.id)!;
    }

    // Calculate and cache
    const status = this.statusMapper(item);
    this.statusCache.set(item.id, status);
    return status;
  }

  getProgress(item: T): ItemProgress | null {
    if (!this.progressMapper) return null;

    // Check cache first
    if (this.progressCache.has(item.id)) {
      return this.progressCache.get(item.id)!;
    }

    // Calculate and cache
    const progress = this.progressMapper(item);
    this.progressCache.set(item.id, progress);
    return progress;
  }

  // ========================================
  // Empty State
  // ========================================

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get hasItemActions(): boolean {
    return !!this.itemActionsTemplate;
  }
}
