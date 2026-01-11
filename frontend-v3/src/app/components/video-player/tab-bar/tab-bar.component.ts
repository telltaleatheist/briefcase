import { Component, Input, Output, EventEmitter, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EditorTab } from '../../../models/video-editor.model';

declare const window: Window & {
  electron: {
    getEditorGroups: () => Promise<{ groups: Array<{ groupNumber: number; windowId: string; isCurrent: boolean }>; currentGroupNumber: number | null }>;
    moveTabToGroup: (tabData: any, targetGroupNumber: number) => Promise<boolean>;
    createGroupWithTab: (tabData: any) => Promise<number>;
    consolidateGroups: () => Promise<{ success: boolean }>;
  };
};

export interface EditorGroupInfo {
  groupNumber: number;
  windowId: string;
  isCurrent: boolean;
}

@Component({
  selector: 'app-tab-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tab-bar.component.html',
  styleUrls: ['./tab-bar.component.scss']
})
export class TabBarComponent {
  @Input() tabs: EditorTab[] = [];
  @Input() activeTabId: string | null = null;
  @Input() maxTabs: number = 15;
  @Input() currentGroupNumber: number | null = null;

  @Output() tabSelect = new EventEmitter<string>();
  @Output() tabClose = new EventEmitter<string>();
  @Output() tabCloseOthers = new EventEmitter<string>();
  @Output() tabCloseAll = new EventEmitter<void>();
  @Output() tabRename = new EventEmitter<string>();
  @Output() tabReorder = new EventEmitter<{ fromIndex: number; toIndex: number }>();
  @Output() moveTabToGroup = new EventEmitter<{ tabId: string; targetGroupNumber: number }>();
  @Output() moveTabToNewGroup = new EventEmitter<string>();
  @Output() consolidateGroups = new EventEmitter<void>();

  // Track if tab context menu is open
  contextMenuTabId = signal<string | null>(null);
  contextMenuPosition = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  // Drag and drop state
  dragIndex = signal<number | null>(null);
  dragOverIndex = signal<number | null>(null);

  // Available groups for moving tabs
  availableGroups = signal<EditorGroupInfo[]>([]);
  showGroupSubmenu = signal<boolean>(false);

  onTabClick(tabId: string, event: MouseEvent): void {
    // Middle click to close
    if (event.button === 1) {
      event.preventDefault();
      this.tabClose.emit(tabId);
      return;
    }

    // Left click to select
    if (event.button === 0) {
      this.tabSelect.emit(tabId);
    }
  }

  onTabClose(tabId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.tabClose.emit(tabId);
  }

  async onTabContextMenu(tabId: string, event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuTabId.set(tabId);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.showGroupSubmenu.set(false);

    // Fetch available groups
    try {
      if (window.electron?.getEditorGroups) {
        const result = await window.electron.getEditorGroups();
        this.availableGroups.set(result.groups);
      }
    } catch (error) {
      console.error('Error fetching editor groups:', error);
      this.availableGroups.set([]);
    }
  }

  closeContextMenu(): void {
    this.contextMenuTabId.set(null);
    this.showGroupSubmenu.set(false);
  }

  toggleGroupSubmenu(event: MouseEvent): void {
    event.stopPropagation();
    this.showGroupSubmenu.set(!this.showGroupSubmenu());
  }

  onCloseTab(tabId: string): void {
    this.closeContextMenu();
    this.tabClose.emit(tabId);
  }

  onCloseOtherTabs(tabId: string): void {
    this.closeContextMenu();
    this.tabCloseOthers.emit(tabId);
  }

  onCloseAllTabs(): void {
    this.closeContextMenu();
    this.tabCloseAll.emit();
  }

  // Truncate title if too long
  getTruncatedTitle(title: string, maxLength: number = 25): string {
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + '...';
  }

  // Check if at max tabs
  get isAtMaxTabs(): boolean {
    return this.tabs.length >= this.maxTabs;
  }

  // Get groups that are not the current window (for moving tabs to)
  get otherGroups(): EditorGroupInfo[] {
    return this.availableGroups().filter(g => !g.isCurrent);
  }

  // Check if there are other groups to move to
  get hasOtherGroups(): boolean {
    return this.otherGroups.length > 0;
  }

  // Handle moving tab to existing group
  onMoveToGroup(tabId: string, groupNumber: number): void {
    this.closeContextMenu();
    this.moveTabToGroup.emit({ tabId, targetGroupNumber: groupNumber });
  }

  // Handle moving tab to new group
  onMoveToNewGroup(tabId: string): void {
    this.closeContextMenu();
    this.moveTabToNewGroup.emit(tabId);
  }

  // Handle consolidate all groups
  onConsolidateGroups(): void {
    this.closeContextMenu();
    this.consolidateGroups.emit();
  }

  // Handle rename tab
  onRenameTab(tabId: string): void {
    this.closeContextMenu();
    this.tabRename.emit(tabId);
  }

  // Drag and drop handlers
  onDragStart(event: DragEvent, index: number): void {
    this.dragIndex.set(index);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', index.toString());
    }
  }

  onDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (this.dragIndex() !== null && this.dragIndex() !== index) {
      this.dragOverIndex.set(index);
    }
  }

  onDragLeave(): void {
    this.dragOverIndex.set(null);
  }

  onDrop(event: DragEvent, toIndex: number): void {
    event.preventDefault();
    const fromIndex = this.dragIndex();
    if (fromIndex !== null && fromIndex !== toIndex) {
      this.tabReorder.emit({ fromIndex, toIndex });
    }
    this.dragIndex.set(null);
    this.dragOverIndex.set(null);
  }

  onDragEnd(): void {
    this.dragIndex.set(null);
    this.dragOverIndex.set(null);
  }
}
