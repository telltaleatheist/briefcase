import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, OnChanges, SimpleChanges, HostListener, ViewChild, ElementRef, TemplateRef, ContentChild } from '@angular/core';
import { MatMenuTrigger } from '@angular/material/menu';
import { CommonModule } from '@angular/common';
import { trigger, state, style, transition, animate } from '@angular/animations';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { Subscription } from 'rxjs';
import { CascadeSelectionService } from '../../services/cascade-selection.service';
import {
  ListItem,
  ItemGroup,
  ItemDisplayConfig,
  GroupConfig,
  KeyboardConfig,
  SelectionMode,
  ItemStatus,
  ItemProgress,
  ContextMenuAction,
  CascadeItem,
  CascadeChild,
  CascadeChildStatus,
  ChildrenConfig
} from '../../types/cascade.types';

@Component({
  selector: 'cascade-list',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatTooltipModule, MatMenuModule, MatDividerModule, DragDropModule, ScrollingModule],
  providers: [CascadeSelectionService],
  templateUrl: './cascade-list.component.html',
  styleUrls: ['./cascade-list.component.scss'],
  animations: [
    trigger('expandCollapse', [
      transition(':enter', [
        style({ height: 0, opacity: 0, overflow: 'hidden' }),
        animate('200ms ease-out', style({ height: '*', opacity: 1 }))
      ]),
      transition(':leave', [
        style({ height: '*', opacity: 1, overflow: 'hidden' }),
        animate('150ms ease-in', style({ height: 0, opacity: 0 }))
      ])
    ])
  ]
})
export class CascadeListComponent<T extends ListItem = ListItem> implements OnInit, OnDestroy, OnChanges {
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
  @Input() selectedItemIds: Set<string> = new Set(); // External selection state to sync with
  @Input() highlightedItemId: string | null = null; // External highlighted state to sync with
  @Input() contextMenuActions: ContextMenuAction[] = [];
  @Input() emptyMessage = 'No items to display';
  @Input() emptyIcon = 'inbox';

  // Status configuration
  @Input() statusMapper?: (item: T) => ItemStatus | null;

  // Progress configuration
  @Input() progressMapper?: (item: T) => ItemProgress | null;
  @Input() progressVersion: number = 0; // Increment this to force progress cache clear

  // Cascade-specific configuration (hierarchical children)
  @Input() childrenConfig?: ChildrenConfig<T>;

  // Drag and drop configuration
  @Input() enableDragDrop: boolean = false;

  // Input for initially collapsed groups
  @Input() set initialCollapsedGroups(groups: Set<string> | null) {
    if (groups && groups.size > 0) {
      this.collapsedGroups = new Set(groups);
    }
  }

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

  // Cascade-specific outputs
  @Output() childrenExpanded = new EventEmitter<{ item: T }>();
  @Output() childrenCollapsed = new EventEmitter<{ item: T }>();
  @Output() childClicked = new EventEmitter<{ parent: T; child: CascadeChild }>();

  // Drag and drop output
  @Output() itemsReordered = new EventEmitter<T[]>();

  // ========================================
  // Internal State
  // ========================================

  @ViewChild('listContainer') listContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('contextMenuTrigger', { read: MatMenuTrigger }) contextMenuTrigger?: MatMenuTrigger;

  // Context menu position
  contextMenuPosition = { x: 0, y: 0 };

  // Grouping
  groupedItems: ItemGroup<T>[] = [];
  collapsedGroups = new Set<string>();

  // Flattened items for virtual scrolling (includes group headers and items)
  flattenedItems: Array<{ type: 'group'; group: ItemGroup<T> } | { type: 'item'; item: T; groupId: string }> = [];
  readonly itemHeight = 44; // Height of each item in pixels

  // Selection - now managed by service
  selectedGroups = new Set<string>();
  private subscriptions = new Subscription();

  // Cascade: Track expanded items
  expandedItems = new Set<string>();

  // Type-ahead
  private typeAheadBuffer = '';
  private typeAheadTimer:  any;

  // Editing state (for inline editing)
  editingItems: { [itemId: string]: { [field: string]: boolean } } = {};

  // Performance caches (cleared on ngOnChanges)
  private statusCache = new Map<string, ItemStatus | null>();
  private progressCache = new Map<string, ItemProgress | null>();
  private iconCache = new Map<string, string>();
  private badgeCache = new Map<string, string | null>();

  constructor(private selectionService: CascadeSelectionService) {}

  // ========================================
  // Lifecycle
  // ========================================

  ngOnInit() {
    this.updateGroupedItems();
    this.initializeExpandedState(); // Initialize cascade expanded state

    // Subscribe to selection changes
    this.subscriptions.add(
      this.selectionService.selection$.subscribe(selectedIds => {
        // Emit selection events when selection changes
        const selected = this.items.filter(i => selectedIds.has(i.id));
        if (selected.length > 0) {
          this.itemsSelected.emit(selected);
        }
      })
    );

    // Subscribe to highlighted changes
    this.subscriptions.add(
      this.selectionService.highlighted$.subscribe(highlightedId => {
        const highlightedItem = highlightedId ? this.items.find(i => i.id === highlightedId) : null;
        this.itemHighlighted.emit(highlightedItem || null);
      })
    );
  }

  ngOnDestroy() {
    if (this.typeAheadTimer) {
      clearTimeout(this.typeAheadTimer);
    }
    this.subscriptions.unsubscribe();
    this.selectionService.destroy();
  }

  ngOnChanges(changes: SimpleChanges) {
    // Sync external selection state FIRST (before updating groups)
    if (changes['selectedItemIds']) {
      this.syncExternalSelection();
    }

    // Sync external highlighted state
    if (changes['highlightedItemId']) {
      this.syncExternalHighlighted();
    }

    // Then update grouped items
    this.updateGroupedItems();

    // Clear performance caches when items change
    if (changes['items']) {
      this.statusCache.clear();
      this.progressCache.clear();
      this.iconCache.clear();
      this.badgeCache.clear();
    }
  }

  /**
   * Sync selection service with external selection state
   * This ensures the child's internal state matches the parent's single source of truth
   */
  private syncExternalSelection() {
    const currentSelected = new Set(this.selectionService.getSelected());
    const externalSelected = this.selectedItemIds;

    // Only sync if there's a difference (prevents unnecessary updates)
    const needsSync =
      currentSelected.size !== externalSelected.size ||
      ![...currentSelected].every(id => externalSelected.has(id));

    if (needsSync) {
      // Clear and resync with external state
      this.selectionService.clear();
      if (externalSelected.size > 0) {
        this.selectionService.selectAll([...externalSelected]);
      }
    }
  }

  /**
   * Sync highlighted item with external state
   * This ensures the child's internal state matches the parent's single source of truth
   */
  private syncExternalHighlighted() {
    const currentHighlighted = this.selectionService.getHighlighted();
    const externalHighlighted = this.highlightedItemId;

    // Only sync if there's a difference (prevents unnecessary updates)
    if (currentHighlighted !== externalHighlighted) {
      if (externalHighlighted) {
        this.selectionService.setHighlighted(externalHighlighted);
        // Scroll to the highlighted item
        this.scrollToItem(externalHighlighted);
      } else {
        // Clear highlighted state if external is null
        this.selectionService.setHighlighted(null);
      }
    }
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

  /**
   * TrackBy function for flattened items (virtual scrolling)
   */
  trackByFlattenedItem(index: number, row: { type: 'group'; group: ItemGroup<T> } | { type: 'item'; item: T; groupId: string }): string {
    if (row.type === 'group') {
      return `group-${row.group.id}`;
    } else {
      return `item-${row.item.id}`;
    }
  }

  /**
   * Check if a flattened item is at the top edge of a selection
   */
  isFlattenedItemEdgeTop(index: number): boolean {
    const row = this.flattenedItems[index];
    if (!row || row.type !== 'item') return false;

    const currentItem = row.item;
    const highlightedId = this.selectionService.getHighlighted();
    const isCurrentActive = this.selectionService.isSelected(currentItem.id) || highlightedId === currentItem.id;

    if (!isCurrentActive) return false;

    // Find previous item in flattened list (skip group headers)
    for (let i = index - 1; i >= 0; i--) {
      const prevRow = this.flattenedItems[i];
      if (prevRow.type === 'item') {
        const isPrevActive = this.selectionService.isSelected(prevRow.item.id) || highlightedId === prevRow.item.id;
        return !isPrevActive;
      }
    }

    // No previous item found (or only group header), this is top edge
    return true;
  }

  /**
   * Check if a flattened item is at the bottom edge of a selection
   */
  isFlattenedItemEdgeBottom(index: number): boolean {
    const row = this.flattenedItems[index];
    if (!row || row.type !== 'item') return false;

    const currentItem = row.item;
    const highlightedId = this.selectionService.getHighlighted();
    const isCurrentActive = this.selectionService.isSelected(currentItem.id) || highlightedId === currentItem.id;

    if (!isCurrentActive) return false;

    // Find next item in flattened list (skip group headers)
    for (let i = index + 1; i < this.flattenedItems.length; i++) {
      const nextRow = this.flattenedItems[i];
      if (nextRow.type === 'item') {
        const isNextActive = this.selectionService.isSelected(nextRow.item.id) || highlightedId === nextRow.item.id;
        return !isNextActive;
      }
    }

    // No next item found (or only group header), this is bottom edge
    return true;
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

    // Update flattened items for virtual scrolling
    this.updateFlattenedItems();
  }

  private updateFlattenedItems() {
    const flattened: Array<{ type: 'group'; group: ItemGroup<T> } | { type: 'item'; item: T; groupId: string }> = [];

    for (const group of this.groupedItems) {
      // Add group header if grouping is enabled
      if (this.groupConfig?.enabled) {
        flattened.push({ type: 'group', group });
      }

      // Add items if group is not collapsed
      if (!group.collapsed) {
        for (const item of group.items) {
          flattened.push({ type: 'item', item, groupId: group.id });
        }
      }
    }

    this.flattenedItems = flattened;
  }

  toggleGroup(groupId: string) {
    if (this.collapsedGroups.has(groupId)) {
      this.collapsedGroups.delete(groupId);
    } else {
      this.collapsedGroups.add(groupId);
    }
    this.updateGroupedItems();
    this.updateFlattenedItems();
    this.groupToggle.emit({ groupId, collapsed: this.collapsedGroups.has(groupId) });
  }

  isGroupCollapsed(groupId: string): boolean {
    return this.collapsedGroups.has(groupId);
  }

  // ========================================
  // Selection Logic
  // ========================================

  isItemSelected(item: T): boolean {
    // Ghost parents and children can never be selected
    if (item['isGhostParent'] || item['isGhostChild']) {
      return false;
    }
    return this.selectionService.isSelected(item.id);
  }

  isItemHighlighted(item: T): boolean {
    // Ghost parents and children can never be highlighted
    if (item['isGhostParent'] || item['isGhostChild']) {
      return false;
    }
    return this.selectionService.getHighlighted() === item.id;
  }

  /**
   * Check if item is at the top edge of a selection group
   * (selected or highlighted, but previous item is not selected/highlighted)
   */
  isSelectionEdgeTop(items: T[], index: number): boolean {
    const currentItem = items[index];

    // Ghost items can never be selection edges
    if (currentItem['isGhostParent'] || currentItem['isGhostChild']) {
      return false;
    }

    const highlightedId = this.selectionService.getHighlighted();
    // Item must be either selected OR highlighted
    const isCurrentActive = this.selectionService.isSelected(currentItem.id) || highlightedId === currentItem.id;
    if (!isCurrentActive) {
      return false;
    }

    // First item in group is always a top edge if active
    if (index === 0) {
      return true;
    }

    // Check if previous item is not selected or highlighted
    const prevItem = items[index - 1];
    const isPrevActive = this.selectionService.isSelected(prevItem.id) || highlightedId === prevItem.id;
    return !isPrevActive;
  }

  /**
   * Check if item is at the bottom edge of a selection group
   * (selected or highlighted, but next item is not selected/highlighted)
   */
  isSelectionEdgeBottom(items: T[], index: number): boolean {
    const currentItem = items[index];

    // Ghost items can never be selection edges
    if (currentItem['isGhostParent'] || currentItem['isGhostChild']) {
      return false;
    }

    const highlightedId = this.selectionService.getHighlighted();
    // Item must be either selected OR highlighted
    const isCurrentActive = this.selectionService.isSelected(currentItem.id) || highlightedId === currentItem.id;
    if (!isCurrentActive) {
      return false;
    }

    // Last item in group is always a bottom edge if active
    if (index === items.length - 1) {
      return true;
    }

    // Check if next item is not selected or highlighted
    const nextItem = items[index + 1];
    const isNextActive = this.selectionService.isSelected(nextItem.id) || highlightedId === nextItem.id;
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

    // Handle highlighting even when selection is disabled
    // This allows browsing/navigating items without selecting them
    if (this.selectionMode === SelectionMode.None) {
      // Update highlighted item for visual feedback
      this.selectionService.setHighlighted(item.id);
      return;
    }

    // Handle multi-select with Cmd/Ctrl (Finder behavior)
    if ((event.metaKey || event.ctrlKey) && this.selectionMode === SelectionMode.Multiple) {
      const previousSelected = this.selectionService.getSelected();

      // Toggle the clicked item
      this.selectionService.toggle(item.id);

      const nowSelected = this.selectionService.getSelected();
      const wasSelected = previousSelected.includes(item.id);

      if (wasSelected) {
        // Item was deselected - clear highlight
        this.selectionService.setHighlighted(null);
        this.itemHighlighted.emit(null);
        this.itemsDeselected.emit([item]);
      } else {
        // Item was selected
        const itemsToSelect = [item];

        // Finder behavior: If there's a highlighted item that's not selected, select it first
        const highlightedId = this.selectionService.getHighlighted();
        if (highlightedId && !previousSelected.includes(highlightedId) && highlightedId !== item.id) {
          const highlightedItem = this.items.find(i => i.id === highlightedId);
          if (highlightedItem) {
            this.selectionService.select(highlightedId, false);
            itemsToSelect.unshift(highlightedItem);
          }
        }

        this.itemsSelected.emit(itemsToSelect);
      }

      return;
    }

    // Handle range select with Shift
    if (event.shiftKey && this.selectionMode === SelectionMode.Multiple) {
      const flatItems = this.getFlatItemList();
      const allItemIds = flatItems.map(i => i.id);
      const previousSelected = this.selectionService.getSelected();

      this.selectionService.selectRange(allItemIds, item.id);

      const nowSelected = this.selectionService.getSelected();
      const newlySelected = this.items.filter(i => nowSelected.includes(i.id) && !previousSelected.includes(i.id));
      const deselected = this.items.filter(i => previousSelected.includes(i.id) && !nowSelected.includes(i.id));

      // Emit deselected BEFORE selected to prevent race condition with parent's state sync
      if (deselected.length > 0) {
        this.itemsDeselected.emit(deselected);
      }
      if (newlySelected.length > 0) {
        this.itemsSelected.emit(newlySelected);
      }

      return;
    }

    // Single selection
    const previouslySelected = this.selectionService.getSelected();
    const wasSelected = previouslySelected.includes(item.id);

    // IMPORTANT: Deselect old items BEFORE selecting new item
    // This ensures parent's state is cleared before adding new selection
    // Prevents race condition with syncExternalSelection in ngOnChanges
    if (previouslySelected.length > 0) {
      const deselected = this.items.filter(i => previouslySelected.includes(i.id) && i.id !== item.id);
      if (deselected.length > 0) {
        this.itemsDeselected.emit(deselected);
      }
    }

    this.selectionService.select(item.id, true);
    // CRITICAL: Update highlighted state to the clicked item
    // Prevents stale highlighted state from selectAll() causing visual "lit up" bug
    this.selectionService.setHighlighted(item.id);

    if (!wasSelected) {
      this.itemsSelected.emit([item]);
    }
  }

  handleItemDoubleClick(item: T) {
    this.itemDoubleClick.emit(item);
  }

  /**
   * Handle clicks on the container (empty space) to deselect all items
   */
  handleContainerClick(event: MouseEvent) {
    // Only deselect if clicking directly on the container (empty space)
    // not on items or their children
    const target = event.target as HTMLElement;

    // Check if the click was on the container itself or the empty state
    if (target.classList.contains('item-list-container') ||
        target.classList.contains('empty-state') ||
        target.classList.contains('item-groups') ||
        target.classList.contains('items-list')) {
      // Clear selection when clicking empty space
      const previousSelected = this.selectionService.getSelected();
      if (previousSelected.length > 0) {
        const deselected = this.items.filter(i => previousSelected.includes(i.id));
        this.selectionService.clear();
        this.selectionService.setHighlighted(null);
        this.itemHighlighted.emit(null);
        if (deselected.length > 0) {
          this.itemsDeselected.emit(deselected);
        }
      }
    }
  }

  selectAll() {
    const previousSelected = this.selectionService.getSelected();

    // Filter out ghost items - they should never be selected
    const allItemIds = this.items
      .filter(i => !i['isGhostParent'] && !i['isGhostChild'])
      .map(i => i.id);

    this.selectionService.selectAll(allItemIds);

    if (this.groupConfig?.selectableGroups) {
      this.groupedItems.forEach(group => this.selectedGroups.add(group.id));
    }

    // Finder behavior: Set first item as highlighted
    const flatItems = this.getFlatItemList();
    if (flatItems.length > 0) {
      this.selectionService.setHighlighted(flatItems[0].id);
    }

    const nowSelected = this.selectionService.getSelected();
    if (nowSelected.length > previousSelected.length) {
      const newlySelected = this.items.filter(i => nowSelected.includes(i.id) && !previousSelected.includes(i.id));
      if (newlySelected.length > 0) {
        this.itemsSelected.emit(newlySelected);
      }
    }
  }

  deselectAll() {
    const previouslySelected = this.getSelectedItems();
    this.selectionService.clear();
    this.selectedGroups.clear();

    if (previouslySelected.length > 0) {
      this.itemsDeselected.emit(previouslySelected);
    }
  }

  getSelectedItems(): T[] {
    const selectedIds = this.selectionService.getSelected();
    return this.items.filter(item => selectedIds.includes(item.id));
  }

  // ========================================
  // Group Selection
  // ========================================

  handleGroupClick(group: ItemGroup<T>, event: MouseEvent) {
    if (!this.groupConfig?.selectableGroups) {
      return;
    }

    const isSelected = this.isGroupSelected(group.id);
    const groupItemIds = group.items.map(i => i.id);

    // Handle multi-select with Cmd/Ctrl
    if (event.metaKey || event.ctrlKey) {
      if (isSelected) {
        this.selectedGroups.delete(group.id);
        groupItemIds.forEach(id => this.selectionService.deselect(id));
        this.itemsDeselected.emit(group.items);
      } else {
        this.selectedGroups.add(group.id);
        this.selectionService.selectAll(groupItemIds);
        this.itemsSelected.emit(group.items);
      }
    } else {
      // Single group selection
      const previouslySelected = this.getSelectedItems();
      this.selectedGroups.clear();
      this.selectionService.clear();

      if (!isSelected) {
        this.selectedGroups.add(group.id);
        this.selectionService.selectAll(groupItemIds);
        this.itemsSelected.emit(group.items);
      }

      if (previouslySelected.length > 0) {
        this.itemsDeselected.emit(previouslySelected);
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
    if (this.keyboardConfig.enableDelete && this.selectionService.getSelected().length > 0) {
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

      // Handle Left/Right arrows for collapsing/expanding groups
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        if (!this.groupConfig?.enabled) return;

        const selectedIds = this.selectionService.getSelected();
        const groupsToToggle = new Set<string>();

        // Priority 1: If groups themselves are selected, use those
        if (this.selectedGroups.size > 0) {
          this.selectedGroups.forEach(groupId => groupsToToggle.add(groupId));
        }
        // Priority 2: If items are selected, use their containing groups
        else if (selectedIds.length > 0) {
          selectedIds.forEach(id => {
            const item = this.items.find(i => i.id === id);
            if (item && this.groupConfig?.groupBy) {
              const groupKey = this.groupConfig.groupBy(item);
              groupsToToggle.add(groupKey);
            }
          });
        }

        // If we found groups to toggle, do it
        if (groupsToToggle.size > 0) {
          event.preventDefault();
          event.stopPropagation();

          // Collapse or expand the groups
          groupsToToggle.forEach(groupKey => {
            if (event.code === 'ArrowLeft') {
              // Left arrow: collapse the group
              if (!this.collapsedGroups.has(groupKey)) {
                this.collapsedGroups.add(groupKey);
              }
            } else {
              // Right arrow: expand the group
              if (this.collapsedGroups.has(groupKey)) {
                this.collapsedGroups.delete(groupKey);
              }
            }
          });

          return;
        }
      }
    }

    // Handle Enter/Return to open highlighted or selected items (Finder behavior)
    if ((event.code === 'Enter' || event.code === 'NumpadEnter') && !isFocusedOnInput) {
      event.preventDefault();
      const selectedIds = this.selectionService.getSelected();
      // If there are selected items, emit double-click for all of them
      if (selectedIds.length > 0) {
        const selectedItems = this.getSelectedItems();
        selectedItems.forEach(item => this.itemDoubleClick.emit(item));
      }
      // Otherwise, if there's a highlighted item, emit double-click for it
      else {
        const highlightedId = this.selectionService.getHighlighted();
        if (highlightedId) {
          const highlightedItem = this.items.find(i => i.id === highlightedId);
          if (highlightedItem) {
            this.itemDoubleClick.emit(highlightedItem);
          }
        }
      }
      return;
    }

    // Handle spacebar action
    if (event.code === 'Space' && this.keyboardConfig.enableSpaceAction && !isFocusedOnInput) {
      event.preventDefault();
      const highlightedId = this.selectionService.getHighlighted();
      const highlightedItem = highlightedId
        ? this.items.find(i => i.id === highlightedId)
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

    const allItemIds = flatItems.map(i => i.id);
    const previouslySelected = this.selectionService.getSelected();

    // Use the service's navigate method
    const newItemId = this.selectionService.navigate(allItemIds, direction === 1 ? 1 : -1, false);

    if (!newItemId) return;

    // Finder behavior: Arrow keys without modifiers clear selection
    if (previouslySelected.length > 0) {
      this.selectionService.clear();
      const deselected = this.items.filter(i => previouslySelected.includes(i.id));
      if (deselected.length > 0) {
        this.itemsDeselected.emit(deselected);
      }
    }

    // Scroll into view
    this.scrollToItem(newItemId);
  }

  /**
   * Navigate items with Shift held (extend/contract selection like Finder)
   * This uses range selection from the anchor to the current position
   */
  private navigateItemsWithShift(direction: number) {
    const flatItems = this.getFlatItemList();
    if (flatItems.length === 0) return;

    const allItemIds = flatItems.map(i => i.id);
    const highlightedId = this.selectionService.getHighlighted();

    // Find current highlighted index
    let currentIndex = highlightedId
      ? flatItems.findIndex(i => i.id === highlightedId)
      : -1;

    if (currentIndex === -1) {
      currentIndex = direction > 0 ? 0 : flatItems.length - 1;
    }

    const previousSelected = this.selectionService.getSelected();

    // If nothing is selected yet, select the current highlighted item first
    // This sets the anchor for range selection
    if (previousSelected.length === 0 && highlightedId) {
      this.selectionService.select(highlightedId, true);
      const currentItem = flatItems[currentIndex];
      this.itemsSelected.emit([currentItem]);
    }

    // Now move to the next item
    currentIndex += direction;
    if (currentIndex < 0) currentIndex = 0;
    if (currentIndex >= flatItems.length) currentIndex = flatItems.length - 1;

    const newItem = flatItems[currentIndex];
    const previousSelectedAfterAnchor = this.selectionService.getSelected();

    // Use service's selectRange for range selection
    this.selectionService.selectRange(allItemIds, newItem.id);

    const nowSelected = this.selectionService.getSelected();
    const newlySelected = this.items.filter(i => nowSelected.includes(i.id) && !previousSelectedAfterAnchor.includes(i.id));
    const deselected = this.items.filter(i => previousSelectedAfterAnchor.includes(i.id) && !nowSelected.includes(i.id));

    if (newlySelected.length > 0) {
      this.itemsSelected.emit(newlySelected);
    }
    if (deselected.length > 0) {
      this.itemsDeselected.emit(deselected);
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
      this.selectionService.setHighlighted(match.id);
      this.scrollToItem(match.id);
    }
  }

  private getFlatItemList(): T[] {
    return this.groupedItems.flatMap(group =>
      group.collapsed ? [] : group.items.filter(i => !i['isGhostParent'] && !i['isGhostChild'])
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
    event.stopPropagation();

    // If item is not selected, select it and clear others
    if (!this.selectionService.isSelected(item.id)) {
      const previouslySelected = this.getSelectedItems();

      // Clear all selections and select only this item
      this.selectionService.select(item.id, true);

      // Emit deselection events for previously selected items
      if (previouslySelected.length > 0) {
        this.itemsDeselected.emit(previouslySelected);
      }

      // Emit selection event for the newly selected item
      this.itemsSelected.emit([item]);
    }

    // Emit raw context menu event for custom handling (e.g., Material menu)
    this.contextMenu.emit({ event, item });

    // If contextMenuActions are provided, open the built-in menu
    if (this.contextMenuActions && this.contextMenuActions.length > 0 && this.contextMenuTrigger) {
      // Position the menu at the mouse position
      this.contextMenuPosition = {
        x: event.clientX,
        y: event.clientY
      };

      // Open the menu
      setTimeout(() => {
        this.contextMenuTrigger?.openMenu();
      });
    }
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
  // Cascade: Hierarchical Children Methods
  // ========================================

  /**
   * Check if an item has children (ghost items)
   */
  hasChildren(item: T): boolean {
    if (!this.childrenConfig?.enabled) return false;

    // Check if item has children property
    const cascadeItem = item as unknown as CascadeItem;
    if (cascadeItem.children && cascadeItem.children.length > 0) {
      return true;
    }

    // Check if generator would create children
    if (this.childrenConfig.generator) {
      const generated = this.childrenConfig.generator(item);
      return generated && generated.length > 0;
    }

    return false;
  }

  /**
   * Get children for an item
   */
  getChildren(item: T): CascadeChild[] {
    if (!this.childrenConfig?.enabled) return [];

    const cascadeItem = item as unknown as CascadeItem;

    // Return existing children if present
    if (cascadeItem.children && cascadeItem.children.length > 0) {
      return cascadeItem.children;
    }

    // Generate children dynamically
    if (this.childrenConfig.generator) {
      return this.childrenConfig.generator(item) || [];
    }

    return [];
  }

  /**
   * Check if an item is expanded
   */
  isExpanded(item: T): boolean {
    return this.expandedItems.has(item.id);
  }

  /**
   * Toggle expand/collapse state of an item
   */
  toggleExpanded(itemId: string, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    const item = this.items.find(i => i.id === itemId);
    if (!item) return;

    if (this.expandedItems.has(itemId)) {
      this.expandedItems.delete(itemId);
      this.childrenCollapsed.emit({ item });
    } else {
      this.expandedItems.add(itemId);
      this.childrenExpanded.emit({ item });
    }
  }

  /**
   * Get master progress for an item (calculated from children)
   */
  getMasterProgress(item: T): number | null {
    if (!this.childrenConfig?.showMasterProgress) return null;
    if (!this.hasChildren(item)) return null;

    const cascadeItem = item as unknown as CascadeItem;

    // Use custom calculator if provided
    if (this.childrenConfig.masterProgressCalculator) {
      return this.childrenConfig.masterProgressCalculator(item);
    }

    // Use pre-calculated master progress if available
    if (typeof cascadeItem.masterProgress === 'number') {
      return cascadeItem.masterProgress;
    }

    // Calculate average from children's progress
    const children = this.getChildren(item);
    if (children.length === 0) return null;

    const progressValues = children
      .map(c => c.progress?.value)
      .filter((v): v is number => typeof v === 'number');

    if (progressValues.length === 0) return null;

    const sum = progressValues.reduce((a, b) => a + b, 0);
    return Math.round(sum / progressValues.length);
  }

  /**
   * Get Material icon for child status
   */
  getChildStatusIcon(status?: CascadeChildStatus): string {
    switch (status) {
      case 'completed':
        return 'check_circle';
      case 'active':
        return 'pending';
      case 'failed':
        return 'error';
      case 'skipped':
        return 'remove_circle_outline';
      case 'pending':
      default:
        return 'radio_button_unchecked';
    }
  }

  /**
   * Handle click on a child item
   */
  handleChildClick(parent: T, child: CascadeChild, event: Event): void {
    event.stopPropagation();

    if (this.childrenConfig?.clickable !== false) {
      this.childClicked.emit({ parent, child });
    }
  }

  /**
   * Initialize expanded state on component init
   */
  private initializeExpandedState(): void {
    if (!this.childrenConfig?.enabled) return;

    if (this.childrenConfig.defaultExpanded) {
      // Expand all items that have children
      this.items.forEach(item => {
        if (this.hasChildren(item)) {
          this.expandedItems.add(item.id);
        }
      });
    }
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

  // ========================================
  // Drag and Drop
  // ========================================

  /**
   * Handle drop event for drag-and-drop reordering
   */
  onDrop(event: CdkDragDrop<T[]>) {
    if (!this.enableDragDrop) return;

    // Get the flat list of items (all items across all groups)
    const flatItems = this.getFlatItemList();

    // Reorder the items array
    moveItemInArray(flatItems, event.previousIndex, event.currentIndex);

    // Emit the reordered items
    this.itemsReordered.emit(flatItems);
  }
}
