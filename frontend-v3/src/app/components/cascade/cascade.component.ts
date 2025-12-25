import { Component, Input, Output, EventEmitter, signal, computed, ChangeDetectionStrategy, ChangeDetectorRef, effect, inject, HostListener, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { trigger, transition, style, animate } from '@angular/animations';
import { VideoWeek, VideoItem, VideoContextMenuAction, ItemProgress, VideoChild, ChildrenConfig, ChildStatus, DeleteMode } from '../../models/video.model';
import { ContextMenuComponent } from '../context-menu/context-menu.component';
import { ContextMenuPosition } from '../../models/file.model';
import { FilenameModalComponent } from '../filename-modal/filename-modal.component';
import { ElectronService } from '../../services/electron.service';
import { LibraryService } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';
import { TabsService } from '../../services/tabs.service';
import { extractTitleFromFilename } from '@shared/filename-utils';

interface ExpandableVideoWeek extends VideoWeek {
  expanded: boolean;
}

// Union type for virtual scroll items
export type VirtualListItem =
  | { type: 'header'; week: ExpandableVideoWeek }
  | { type: 'video'; video: VideoItem; weekLabel: string; itemId: string };

@Component({
  selector: 'app-cascade',
  standalone: true,
  imports: [CommonModule, ScrollingModule, DragDropModule, ContextMenuComponent, FilenameModalComponent],
  templateUrl: './cascade.component.html',
  styleUrls: ['./cascade.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
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
export class CascadeComponent {
  private electronService = inject(ElectronService);
  private libraryService = inject(LibraryService);
  private notificationService = inject(NotificationService);
  private router = inject(Router);
  private tabsService = inject(TabsService);
  private cdr = inject(ChangeDetectorRef);

  @Input() set weeks(value: VideoWeek[]) {
    // Convert to expandable weeks (all expanded by default)
    const expandableWeeks = value.map(week => ({
      ...week,
      expanded: true
    }));
    this.videoWeeks.set(expandableWeeks);

    // Manually trigger change detection for OnPush strategy
    this.cdr.markForCheck();
  }

  // Progress configuration
  @Input() progressMapper?: (video: VideoItem) => ItemProgress | null;

  // AI Processing indicator
  @Input() aiProcessingVideoId?: string | null;

  // Children configuration
  @Input() childrenConfig?: ChildrenConfig;

  // Drag & drop configuration
  @Input() draggable = false;

  // Display options
  @Input() showStatusIndicator = true;
  @Input() showDuration = true;
  @Input() showDeleteButton = true;
  @Input() showEditButton = false;

  // Delete behavior: 'options' shows 3-option modal, 'simple' emits directly
  @Input() deleteMode: 'options' | 'simple' = 'options';

  // Tabs mode: show "Remove from Tab" instead of delete for tabs view
  @Input() tabsMode = false;

  @Output() selectionChanged = new EventEmitter<{ count: number; ids: Set<string> }>();
  @Output() videoAction = new EventEmitter<{ action: string; videos: VideoItem[] }>();
  @Output() childClicked = new EventEmitter<{ parent: VideoItem; child: VideoChild }>();
  @Output() itemsReordered = new EventEmitter<{ weekLabel: string; videos: VideoItem[] }>();
  @Output() configureItem = new EventEmitter<VideoItem>();
  @Output() previewRequested = new EventEmitter<VideoItem>();
  @Output() headerAction = new EventEmitter<{ action: string; weekLabel: string }>();

  @ViewChild(CdkVirtualScrollViewport) private viewport?: CdkVirtualScrollViewport;

  // Track expanded items for children
  expandedItems = signal<Set<string>>(new Set());

  /**
   * Scroll to the top of the list (where processing queue items are)
   */
  scrollToTop(): void {
    if (this.viewport) {
      this.viewport.scrollToIndex(0, 'smooth');
    }
  }

  /**
   * Scroll to a specific index in the list
   */
  scrollToIndex(index: number, behavior: 'auto' | 'smooth' = 'smooth'): void {
    if (this.viewport) {
      this.viewport.scrollToIndex(index, behavior);
    }
  }

  /**
   * Get progress for a video item
   */
  getProgress(video: VideoItem): ItemProgress | null {
    if (!this.progressMapper) return null;
    return this.progressMapper(video);
  }

  videoWeeks = signal<ExpandableVideoWeek[]>([]);
  selectedVideos = signal<Set<string>>(new Set());
  highlightedItemId = signal<string | null>(null);
  // Selection anchor for range selections (the last clicked item that starts a potential range)
  selectionAnchorId = signal<string | null>(null);
  contextMenuVisible = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuVideo = signal<VideoItem | null>(null);
  contextMenuHeader = signal<VideoWeek | null>(null);

  // Filename modal
  filenameModalVisible = signal(false);
  editingVideo = signal<VideoItem | null>(null);
  editingFilename = signal<string>(''); // Extracted title for editing (without date/extension)

  // Suggested title modal
  suggestedTitleModalVisible = signal(false);
  editingSuggestedTitleVideo = signal<VideoItem | null>(null);

  // Delete options modal
  deleteModalVisible = signal(false);
  deletingVideos = signal<VideoItem[]>([]);
  selectedDeleteMode = signal<DeleteMode | null>(null);

  // Drag selection (marquee) state
  isDragSelecting = signal(false);
  dragStartPoint = signal<{ x: number; y: number } | null>(null);
  dragCurrentPoint = signal<{ x: number; y: number } | null>(null);
  private dragSelectionInitialSelected = new Set<string>();

  selectedCount = computed(() => this.selectedVideos().size);

  // Computed selection rectangle style
  selectionRect = computed(() => {
    const start = this.dragStartPoint();
    const current = this.dragCurrentPoint();
    if (!start || !current) return null;

    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);

    return { left, top, width, height };
  });

  /**
   * Check if item is highlighted (keyboard navigation cursor)
   */
  isHighlighted(itemId: string): boolean {
    return this.highlightedItemId() === itemId;
  }

  /**
   * Check if video is currently processing an AI task
   */
  isProcessingAi(video: VideoItem): boolean {
    return this.aiProcessingVideoId != null && video.id === this.aiProcessingVideoId;
  }

  /**
   * Check if item is at the top edge of a selection group
   */
  isSelectionEdgeTop(index: number): boolean {
    const items = this.virtualItems();
    const row = items[index];
    if (!row || row.type !== 'video') return false;

    const itemId = row.itemId;
    const isCurrentActive = this.selectedVideos().has(itemId) || this.highlightedItemId() === itemId;
    if (!isCurrentActive) return false;

    // Find previous video item
    for (let i = index - 1; i >= 0; i--) {
      const prevRow = items[i];
      if (prevRow.type === 'video') {
        const isPrevActive = this.selectedVideos().has(prevRow.itemId) || this.highlightedItemId() === prevRow.itemId;
        return !isPrevActive;
      }
    }
    return true; // First item is always top edge
  }

  /**
   * Check if item is at the bottom edge of a selection group
   */
  isSelectionEdgeBottom(index: number): boolean {
    const items = this.virtualItems();
    const row = items[index];
    if (!row || row.type !== 'video') return false;

    const itemId = row.itemId;
    const isCurrentActive = this.selectedVideos().has(itemId) || this.highlightedItemId() === itemId;
    if (!isCurrentActive) return false;

    // Find next video item
    for (let i = index + 1; i < items.length; i++) {
      const nextRow = items[i];
      if (nextRow.type === 'video') {
        const isNextActive = this.selectedVideos().has(nextRow.itemId) || this.highlightedItemId() === nextRow.itemId;
        return !isNextActive;
      }
    }
    return true; // Last item is always bottom edge
  }

  // Flattened list for virtual scrolling
  virtualItems = computed<VirtualListItem[]>(() => {
    const items: VirtualListItem[] = [];
    const weeks = this.videoWeeks();

    for (const week of weeks) {
      // Add week header
      items.push({ type: 'header', week });
      // Add videos if week is expanded
      if (week.expanded) {
        for (const video of week.videos) {
          // Create unique itemId combining section and video ID
          const itemId = `${week.weekLabel}|${video.id}`;
          items.push({ type: 'video', video, weekLabel: week.weekLabel, itemId });
        }
      }
    }
    return items;
  });

  // Computed list of ALL videos in display order (for navigation)
  // This includes videos from collapsed sections so navigation is stable
  allVideosInOrder = computed<Array<{ itemId: string; video: VideoItem; weekLabel: string }>>(() => {
    const videos: Array<{ itemId: string; video: VideoItem; weekLabel: string }> = [];
    const weeks = this.videoWeeks();

    for (const week of weeks) {
      // Include ALL videos regardless of expand state
      for (const video of week.videos) {
        const itemId = `${week.weekLabel}|${video.id}`;
        videos.push({ itemId, video, weekLabel: week.weekLabel });
      }
    }
    console.log(`[NAV] allVideosInOrder computed: ${videos.length} videos from ${weeks.length} weeks`);
    return videos;
  });

  private initialized = false;
  private lastLibraryId: string | null = null;

  constructor() {
    // Load tabs for context menu only when library is available
    // Also reload tabs when library changes
    effect(() => {
      const library = this.libraryService.currentLibrary();
      if (library && library.id !== this.lastLibraryId) {
        this.lastLibraryId = library.id;
        this.tabsService.loadTabs().subscribe();
      }
    });

    // Emit selection changes (skip initial)
    effect(() => {
      const ids = this.selectedVideos();
      if (this.initialized) {
        this.selectionChanged.emit({ count: ids.size, ids });
      } else {
        this.initialized = true;
      }
    }, { allowSignalWrites: true });
  }

  // Context menu actions - computed based on selection
  contextMenuActions = computed<VideoContextMenuAction[]>(() => {
    // Check if this is a header context menu
    const header = this.contextMenuHeader();
    if (header) {
      // Header-specific actions
      return [
        { label: 'Rename Tab', icon: '✏️', action: 'renameTab' },
        { label: 'Delete Tab', icon: '🗑️', action: 'deleteTab' }
      ];
    }

    const count = this.selectedCount();
    const video = this.contextMenuVideo();
    const hasSuggestedTitle = video?.suggestedTitle && video.suggestedTitle !== video.name;
    const isQueue = video ? this.isQueueItem(video) : false;
    const isStaging = video ? this.isStagingItem(video) : false;
    const isProcessing = video ? this.isProcessingItem(video) : false;

    // Check if any selected videos have suggestions (for multi-select discard)
    const selectedVideos = this.getSelectedVideos();
    const selectedWithSuggestions = selectedVideos.filter(v => v.suggestedTitle && v.suggestedTitle !== v.name);
    const hasAnySuggestions = selectedWithSuggestions.length > 0;

    const actions: VideoContextMenuAction[] = [];
    const countSuffix = count > 1 ? ` (${count})` : '';

    // Processing queue item specific actions
    if (isProcessing) {
      if (count === 1) {
        actions.push({ label: 'View in Library', icon: '📚', action: 'view-in-library' });
        actions.push({ label: '', icon: '', action: '', divider: true });
      }
      actions.push({ label: `Cancel${countSuffix}`, icon: '⛔', action: 'cancel' });
      return actions;
    }

    // Staging queue item specific actions
    if (isStaging) {
      actions.push({ label: `Configure${countSuffix}`, icon: '⚙️', action: 'processing' });
      actions.push({ label: '', icon: '', action: '', divider: true });
      actions.push({ label: `Remove from Queue${countSuffix}`, icon: '🗑️', action: 'removeFromQueue' });
      return actions;
    }

    // Queue item specific actions
    if (isQueue) {
      actions.push({ label: `Configure${countSuffix}`, icon: '⚙️', action: 'processing' });
      actions.push({ label: '', icon: '', action: '', divider: true });
      actions.push({ label: `Remove from Queue${countSuffix}`, icon: '🗑️', action: 'removeFromQueue' });
      return actions;
    }

    // Check for manager tab items based on tags
    const isOrphanedFile = video?.tags?.includes('orphaned-file');
    const isOrphanedEntry = video?.tags?.includes('orphaned-entry');
    const isDuplicate = video?.tags?.includes('duplicate');

    // Orphaned Files (files on disk not in database)
    if (isOrphanedFile) {
      actions.push({ label: `Import${countSuffix}`, icon: '📥', action: 'import' });
      actions.push({ label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' });
      if (count <= 1) {
        actions.push({ label: '', icon: '', action: '', divider: true });
        actions.push({ label: 'Open File Location', icon: '📁', action: 'openLocation' });
        actions.push({ label: 'Copy Filename', icon: '📋', action: 'copyFilename' });
      }
      return actions;
    }

    // Orphaned Entries (database entries with missing files)
    if (isOrphanedEntry) {
      actions.push({ label: `Relink${countSuffix}`, icon: '🔗', action: 'relink' });
      actions.push({ label: `Browse for Folder...${countSuffix}`, icon: '📁', action: 'relinkWithFolder' });
      actions.push({ label: '', icon: '', action: '', divider: true });
      actions.push({ label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' });
      return actions;
    }

    // Duplicate Entries
    if (isDuplicate) {
      actions.push({ label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' });
      if (count <= 1) {
        actions.push({ label: '', icon: '', action: '', divider: true });
        actions.push({ label: 'Open File Location', icon: '📁', action: 'openLocation' });
        actions.push({ label: 'Copy Filename', icon: '📋', action: 'copyFilename' });
      }
      return actions;
    }

    // Saved Link items (from Save for Later)
    const isSavedLink = video?.tags?.includes('saved-link');
    const isDownloading = video?.tags?.includes('downloading');
    const isDownloadComplete = video?.tags?.includes('download-complete');
    const isDownloadFailed = video?.tags?.includes('download-failed');

    if (isSavedLink) {
      // Only show Import if download is complete
      if (isDownloadComplete) {
        actions.push({ label: `Import to Library${countSuffix}`, icon: '📥', action: 'add-to-library' });
      }
      // Show retry for failed downloads
      if (isDownloadFailed) {
        actions.push({ label: `Retry Download${countSuffix}`, icon: '🔄', action: 'retry' });
      }
      // Open URL in browser
      actions.push({ label: 'Open URL', icon: '🌐', action: 'open' });
      // Copy URL to clipboard
      actions.push({ label: 'Copy URL', icon: '📋', action: 'copy-url' });
      actions.push({ label: '', icon: '', action: '', divider: true });
      actions.push({ label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' });
      return actions;
    }

    // Library item actions
    // "Open" action - available for both single and multi-select
    actions.push({ label: `Open${countSuffix}`, icon: '▶️', action: 'open' });

    // Single video actions
    if (count <= 1) {
      actions.push({ label: 'More Info', icon: '🎬', action: 'openInEditor' });
      actions.push({ label: 'Details', icon: 'ℹ️', action: 'viewMore' });
      actions.push({ label: 'Rename', icon: '✏️', action: 'rename' });
      actions.push({ label: 'Copy Filename', icon: '📋', action: 'copyFilename' });
      actions.push({ label: 'Open File Location', icon: '📁', action: 'openLocation' });

      if (hasSuggestedTitle) {
        actions.push({ label: 'Edit Suggested Title', icon: '✨', action: 'editSuggestedTitle' });
      }
    }

    // Divider before multi-select actions
    if (actions.length > 0) {
      actions.push({ label: '', icon: '', action: '', divider: true });
    }

    // Multi-select capable actions
    // Build submenu for "Add to Tab" with recent tabs
    const recentTabs = this.tabsService.recentTabs();
    const tabSubmenu: VideoContextMenuAction[] = [
      { label: 'New Tab...', icon: '➕', action: 'addToNewTab' }
    ];

    if (recentTabs.length > 0) {
      tabSubmenu.push({ label: '', icon: '', action: '', divider: true });
      recentTabs.forEach(tab => {
        tabSubmenu.push({
          label: tab.name,
          icon: '📑',
          action: `addToTab:${tab.id}`
        });
      });
    }

    actions.push({
      label: `Add to Tab${countSuffix}`,
      icon: '📑',
      action: 'addToTab',
      submenu: tabSubmenu,
      hasArrow: true
    });

    // Another divider
    actions.push({ label: '', icon: '', action: '', divider: true });

    // Discard Suggestions (for videos with AI suggestions)
    if (hasAnySuggestions) {
      const suggestionCount = selectedWithSuggestions.length;
      const suggestionSuffix = suggestionCount > 1 ? ` (${suggestionCount})` : '';
      actions.push({ label: `Discard Suggestions${suggestionSuffix}`, icon: '✨', action: 'discardSuggestions' });
    }

    // Processing actions
    actions.push({ label: `Run Analysis${countSuffix}`, icon: '🧠', action: 'analyze' });
    actions.push({ label: `Move to...${countSuffix}`, icon: '📦', action: 'moveToLibrary' });

    // Final divider and delete/remove
    actions.push({ label: '', icon: '', action: '', divider: true });

    // Show "Remove from Tab" in tabs mode, otherwise "Delete"
    if (this.tabsMode) {
      actions.push({ label: `Remove from Tab${countSuffix}`, icon: '✖️', action: 'removeFromTab' });
    } else {
      actions.push({ label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' });
    }

    return actions;
  });

  toggleWeek(week: ExpandableVideoWeek, event: Event) {
    event.stopPropagation();
    this.closeContextMenu();
    week.expanded = !week.expanded;
    this.videoWeeks.set([...this.videoWeeks()]);
  }

  selectVideo(itemId: string, video: VideoItem, event: MouseEvent) {
    event.stopPropagation();
    this.closeContextMenu();

    const hasModifier = event.ctrlKey || event.metaKey;
    const hasShift = event.shiftKey;

    if (hasModifier && hasShift) {
      // Cmd/Ctrl+Shift+click: Add range to existing selection
      // Range from anchor to clicked item, keeping existing selection
      this.rangeSelect(itemId, true);
      // Update anchor for next potential range
      this.selectionAnchorId.set(itemId);
    } else if (hasModifier) {
      // Cmd/Ctrl+click: Toggle single item in selection
      const selected = new Set(this.selectedVideos());
      const isDeselecting = selected.has(itemId);

      if (isDeselecting) {
        selected.delete(itemId);
      } else {
        selected.add(itemId);
      }
      this.selectedVideos.set(selected);

      // Only update anchor and highlight when adding, not when removing
      if (!isDeselecting) {
        this.selectionAnchorId.set(itemId);
        this.highlightedItemId.set(itemId);
      }
    } else if (hasShift && (this.selectionAnchorId() || this.selectedVideos().size > 0)) {
      // Shift+click: Range select from anchor, replace selection
      this.rangeSelect(itemId, false);
    } else {
      // Single click: Select only this item
      this.selectedVideos.set(new Set([itemId]));
      this.highlightedItemId.set(itemId);
      // Set anchor for potential range select
      this.selectionAnchorId.set(itemId);
    }
  }

  /**
   * Select a range of items from the anchor to the target
   * @param endItemId The item to extend selection to
   * @param addToExisting If true, add to existing selection; if false, replace selection
   */
  rangeSelect(endItemId: string, addToExisting: boolean = false) {
    // Get all items from virtual list
    const allItems = this.virtualItems().filter(item => item.type === 'video') as Array<{ type: 'video'; video: VideoItem; weekLabel: string; itemId: string }>;

    // Use anchor if set, otherwise use first selected item
    const anchorId = this.selectionAnchorId();
    const startId = anchorId || Array.from(this.selectedVideos())[0];

    if (!startId) return;

    const startIndex = allItems.findIndex(item => item.itemId === startId);
    const endIndex = allItems.findIndex(item => item.itemId === endItemId);

    if (startIndex === -1 || endIndex === -1) return;

    // Calculate range
    const rangeStart = Math.min(startIndex, endIndex);
    const rangeEnd = Math.max(startIndex, endIndex);

    // Build new selection
    const selected = addToExisting ? new Set(this.selectedVideos()) : new Set<string>();

    for (let i = rangeStart; i <= rangeEnd; i++) {
      selected.add(allItems[i].itemId);
    }

    this.selectedVideos.set(selected);
    this.highlightedItemId.set(endItemId);
  }

  isSelected(itemId: string): boolean {
    return this.selectedVideos().has(itemId);
  }

  onContextMenu(itemId: string, video: VideoItem, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    // If right-clicking on an unselected item, clear all selections and select only this item
    if (!this.isSelected(itemId)) {
      this.selectedVideos.set(new Set([itemId]));
      this.highlightedItemId.set(itemId);
    }
    // If right-clicking on a selected item, keep all selections but update highlight to this item
    else {
      this.highlightedItemId.set(itemId);
    }

    this.contextMenuVideo.set(video);
    this.contextMenuHeader.set(null); // Clear header context
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.contextMenuVisible.set(true);
  }

  onHeaderContextMenu(week: VideoWeek, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    this.contextMenuHeader.set(week);
    this.contextMenuVideo.set(null); // Clear video context
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.contextMenuVisible.set(true);
  }

  onContextMenuAction(action: string) {
    // Check if this is a header action
    const header = this.contextMenuHeader();
    if (header) {
      this.headerAction.emit({ action, weekLabel: header.weekLabel });
      this.closeContextMenu();
      return;
    }

    const video = this.contextMenuVideo();
    if (!video) return;

    // Get all selected videos for multi-select actions
    const selectedVideos = this.getSelectedVideos();
    const videos = selectedVideos.length > 0 ? selectedVideos : [video];

    switch (action) {
      case 'open':
        // Open all selected files in their default application
        // If multiple files, use batch method to open as tabs (if supported)
        const filePaths = videos
          .filter(v => v.filePath)
          .map(v => v.filePath!);

        if (filePaths.length === 0) {
          console.warn('No file paths available for selected videos');
        } else if (filePaths.length === 1) {
          this.electronService.openFile(filePaths[0]);
        } else {
          // Open multiple files at once (will open as tabs in QuickTime on macOS)
          this.electronService.openMultipleFiles(filePaths);
        }
        break;

      case 'rename':
        this.openFilenameModal(video);
        break;

      case 'viewMore':
        // Navigate to video info page
        // Use videoId if available (for queue items), otherwise use id
        const detailsId = video.videoId || video.id;
        this.router.navigate(['/video', detailsId]);
        break;

      case 'openInEditor':
        this.videoAction.emit({ action: 'openInEditor', videos: [video] });
        break;

      case 'copyFilename':
        navigator.clipboard.writeText(video.name);
        // Show toast/notification in the future
        console.log('Copied filename:', video.name);
        break;

      case 'openLocation':
        if (video.filePath) {
          this.electronService.showInFolder(video.filePath);
        } else {
          console.warn('No file path available for video:', video.id);
        }
        break;

      case 'editSuggestedTitle':
        this.openSuggestedTitleModal(video);
        break;

      case 'discardSuggestions':
        // Discard suggestions for all selected videos that have them
        this.discardSuggestionsForVideos(videos);
        break;

      case 'addToTab':
        this.videoAction.emit({ action: 'addToTab', videos });
        break;

      case 'analyze':
        this.videoAction.emit({ action: 'analyze', videos });
        break;

      case 'processing':
        this.videoAction.emit({ action: 'processing', videos });
        break;

      case 'moveToLibrary':
        this.videoAction.emit({ action: 'moveToLibrary', videos });
        break;

      case 'delete':
        // For queue items, emit delete directly (removes from queue, no modal needed)
        if (videos.every(v => this.isQueueItem(v))) {
          this.videoAction.emit({ action: 'delete', videos });
        } else {
          this.openDeleteModal(videos);
        }
        break;

      case 'removeFromQueue':
        // Remove queue items from processing queue
        this.videoAction.emit({ action: 'removeFromQueue', videos });
        break;

      default:
        // For any unhandled actions (like 'relink', 'relinkWithFolder', 'import'), emit to parent
        this.videoAction.emit({ action, videos });
        break;
    }
  }

  /**
   * Open delete options modal or emit directly based on deleteMode
   */
  openDeleteModal(videos: VideoItem[]) {
    if (this.deleteMode === 'simple') {
      // Simple mode: emit directly without options modal
      this.videoAction.emit({ action: 'delete', videos });
    } else {
      // Options mode: show 3-option modal
      this.deletingVideos.set(videos);
      this.deleteModalVisible.set(true);
    }
  }

  /**
   * Select delete mode (doesn't confirm yet)
   */
  selectDeleteMode(mode: DeleteMode) {
    this.selectedDeleteMode.set(mode);
  }

  /**
   * Confirm and execute the delete
   */
  confirmDelete() {
    const mode = this.selectedDeleteMode();
    const videos = this.deletingVideos();
    if (mode && videos.length > 0) {
      this.videoAction.emit({ action: `delete:${mode}`, videos });
    }
    this.closeDeleteModal();
  }

  /**
   * Close delete modal
   */
  closeDeleteModal() {
    this.deleteModalVisible.set(false);
    this.deletingVideos.set([]);
    this.selectedDeleteMode.set(null);
  }

  /**
   * Get all currently selected video items
   */
  private getSelectedVideos(): VideoItem[] {
    const selectedItemIds = this.selectedVideos();
    const allItems = this.virtualItems().filter(item => item.type === 'video') as Array<{ type: 'video'; video: VideoItem; weekLabel: string; itemId: string }>;

    // Get unique videos (a video might be selected in multiple sections)
    const videoMap = new Map<string, VideoItem>();
    for (const item of allItems) {
      if (selectedItemIds.has(item.itemId)) {
        videoMap.set(item.video.id, item.video);
      }
    }

    return Array.from(videoMap.values());
  }

  closeContextMenu() {
    this.contextMenuVisible.set(false);
    this.contextMenuVideo.set(null);
  }

  openFilenameModal(video: VideoItem) {
    this.editingVideo.set(video);

    // Extract just the title portion (without date prefix and extension) for editing
    // This allows the user to edit only the title while date and extension are preserved
    const titleOnly = extractTitleFromFilename(video.name);

    // Use suggested filename if available, otherwise use extracted title
    this.editingFilename.set(video.suggestedFilename || titleOnly);

    this.filenameModalVisible.set(true);
  }

  onFilenameSaved(newFilename: string) {
    const video = this.editingVideo();
    if (video) {
      // Call API to rename the file
      this.libraryService.renameVideoFile(video.id, newFilename).subscribe({
        next: (response: any) => {
          if (response.success) {
            console.log('File renamed successfully:', video.id, newFilename);
            // Update local state - change name and clear AI suggestion
            video.name = response.newFilename || newFilename;
            video.suggestedFilename = undefined;
            video.suggestedTitle = undefined;

            // Clear suggested title from database
            this.libraryService.clearSuggestedTitle(video.id).subscribe({
              next: () => console.log('Suggested title cleared from database'),
              error: (err) => console.warn('Failed to clear suggested title:', err)
            });

            // Update display
            this.videoWeeks.set([...this.videoWeeks()]);
          } else {
            console.error('Failed to rename file:', response.error);
            this.notificationService.error('Rename Failed', response.error || 'Failed to rename file');
          }
        },
        error: (error: any) => {
          console.error('Error renaming file:', error);
          this.notificationService.error('Rename Failed', error.error?.error || error.message);
        }
      });
    }
  }

  onFilenameModalClosed() {
    this.filenameModalVisible.set(false);
    this.editingVideo.set(null);
    this.editingFilename.set('');
  }

  openSuggestedTitleModal(video: VideoItem) {
    this.editingSuggestedTitleVideo.set(video);
    this.suggestedTitleModalVisible.set(true);
  }

  /**
   * Copy text to clipboard
   */
  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      this.notificationService.success('Copied', 'URL copied to clipboard');
    }).catch((err) => {
      console.error('Failed to copy to clipboard:', err);
      this.notificationService.error('Error', 'Failed to copy to clipboard');
    });
  }

  onSuggestedTitleSaved(newTitle: string) {
    const video = this.editingSuggestedTitleVideo();
    if (video) {
      // Accept suggested title - renames file and clears suggested title
      this.libraryService.acceptSuggestedTitle(video.id, newTitle).subscribe({
        next: (response: any) => {
          if (response.success) {
            console.log('Suggested title accepted, file renamed:', video.id, newTitle);
            // Update local state - change name and clear suggested title
            video.name = response.newFilename || newTitle;
            video.suggestedTitle = undefined;
            // Update display
            this.videoWeeks.set([...this.videoWeeks()]);
          } else {
            console.error('Failed to accept suggested title:', response.error);
            this.notificationService.error('Rename Failed', response.error || 'Failed to rename file');
          }
        },
        error: (error: any) => {
          console.error('Error accepting suggested title:', error);
          this.notificationService.error('Rename Failed', error.error?.error || error.message);
        }
      });
    }
  }

  onSuggestedTitleDiscarded() {
    const video = this.editingSuggestedTitleVideo();
    if (video) {
      // Discard suggested title - clears it without renaming
      this.libraryService.clearSuggestedTitle(video.id).subscribe({
        next: (response: any) => {
          if (response.success) {
            console.log('Suggested title discarded:', video.id);

            // Update local state - clear suggested title by creating new objects
            const updatedWeeks = this.videoWeeks().map(week => ({
              ...week,
              videos: week.videos.map(v =>
                v.id === video.id
                  ? { ...v, suggestedTitle: undefined }
                  : v
              )
            }));

            // Update display with new array
            this.videoWeeks.set(updatedWeeks);
            this.notificationService.success('Suggestion Discarded', 'AI title suggestion has been removed');

            // Note: The parent component will reload the library when it receives the
            // 'suggestion-rejected' WebSocket event from the backend
          } else {
            console.error('Failed to discard suggested title:', response.error);
            this.notificationService.error('Discard Failed', response.error || 'Failed to discard suggestion');
          }
        },
        error: (error) => {
          console.error('Error discarding suggested title:', error);
          this.notificationService.error('Discard Failed', 'An error occurred while discarding the suggestion');
        }
      });
    }
  }

  onSuggestedTitleModalClosed() {
    this.suggestedTitleModalVisible.set(false);
    this.editingSuggestedTitleVideo.set(null);
  }

  /**
   * Discard suggested titles for multiple videos
   */
  discardSuggestionsForVideos(videos: VideoItem[]) {
    // Filter to only videos with suggestions
    const videosWithSuggestions = videos.filter(v => v.suggestedTitle && v.suggestedTitle !== v.name);

    if (videosWithSuggestions.length === 0) return;

    let successCount = 0;
    let errorCount = 0;

    // Track video IDs to update local state after all requests complete
    const videoIdsToUpdate = new Set<string>();

    videosWithSuggestions.forEach(video => {
      this.libraryService.clearSuggestedTitle(video.id).subscribe({
        next: (response: any) => {
          if (response.success) {
            videoIdsToUpdate.add(video.id);
            successCount++;
          } else {
            errorCount++;
          }

          // Check if all requests are done
          if (successCount + errorCount === videosWithSuggestions.length) {
            this.finishDiscardSuggestions(videoIdsToUpdate, successCount, errorCount);
          }
        },
        error: () => {
          errorCount++;

          // Check if all requests are done
          if (successCount + errorCount === videosWithSuggestions.length) {
            this.finishDiscardSuggestions(videoIdsToUpdate, successCount, errorCount);
          }
        }
      });
    });
  }

  private finishDiscardSuggestions(videoIds: Set<string>, successCount: number, errorCount: number) {
    if (videoIds.size > 0) {
      // Update local state - clear suggested titles
      const updatedWeeks = this.videoWeeks().map(week => ({
        ...week,
        videos: week.videos.map(v =>
          videoIds.has(v.id)
            ? { ...v, suggestedTitle: undefined }
            : v
        )
      }));
      this.videoWeeks.set(updatedWeeks);
    }

    // Show notification
    if (errorCount === 0) {
      this.notificationService.success(
        'Suggestions Discarded',
        `Discarded ${successCount} AI suggestion${successCount > 1 ? 's' : ''}`
      );
    } else if (successCount > 0) {
      this.notificationService.success(
        'Partially Discarded',
        `Discarded ${successCount} suggestion${successCount > 1 ? 's' : ''}, ${errorCount} failed`
      );
    } else {
      this.notificationService.error('Discard Failed', 'Failed to discard suggestions');
    }
  }

  /**
   * Handle inline delete button click
   */
  onDeleteClick(video: VideoItem, event: Event) {
    event.stopPropagation();

    // For processing items, emit cancel action
    if (this.isProcessingItem(video)) {
      this.videoAction.emit({ action: 'cancel', videos: [video] });
      return;
    }

    // For staging/queue items, emit delete directly (removes from queue, no modal needed)
    if (this.isStagingItem(video) || this.isQueueItem(video)) {
      this.videoAction.emit({ action: 'delete', videos: [video] });
      return;
    }

    this.openDeleteModal([video]);
  }

  /**
   * Handle inline edit button click
   */
  onEditClick(video: VideoItem, event: Event) {
    event.stopPropagation();
    this.videoAction.emit({ action: 'edit', videos: [video] });
  }

  /**
   * Handle quick action button clicks (reveal, openInEditor, process)
   */
  onQuickAction(video: VideoItem, action: string, event: Event) {
    event.stopPropagation();
    this.videoAction.emit({ action, videos: [video] });
  }

  /**
   * Check if a video is a queue item (not yet in library)
   */
  isQueueItem(video: VideoItem): boolean {
    return video.id.startsWith('queue-') || video.tags?.some(t => t.startsWith('queue:')) || false;
  }

  /**
   * Check if a video is a staging queue item
   */
  isStagingItem(video: VideoItem): boolean {
    return video.id.startsWith('staging-') || video.tags?.some(t => t.startsWith('staging:')) || false;
  }

  /**
   * Check if a video is a processing queue item
   */
  isProcessingItem(video: VideoItem): boolean {
    return video.id.startsWith('processing-') || video.tags?.some(t => t.startsWith('processing:')) || false;
  }

  /**
   * Check if a video is a completed queue item
   */
  isCompletedItem(video: VideoItem): boolean {
    return video.id.startsWith('completed-') || video.tags?.some(t => t.startsWith('completed:')) || false;
  }

  /**
   * Handle configure button click for queue items
   */
  onConfigureClick(video: VideoItem, event: Event) {
    event.stopPropagation();
    this.configureItem.emit(video);
  }

  /**
   * Handle keyboard shortcuts for navigation, delete, and preview
   */
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    // Don't handle if user is typing in an input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    // Check for Delete key or Cmd/Ctrl+Backspace
    const isDelete = event.key === 'Delete';
    const isCmdBackspace = event.key === 'Backspace' && (event.metaKey || event.ctrlKey);

    if (isDelete || isCmdBackspace) {
      const selectedVideos = this.getSelectedVideos();
      if (selectedVideos.length > 0) {
        event.preventDefault();
        this.openDeleteModal(selectedVideos);
      }
      return;
    }

    // Arrow key navigation
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.navigateWithArrowKey(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      return;
    }

    // Spacebar to toggle preview (open/close)
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
      const highlightedId = this.highlightedItemId();
      if (highlightedId) {
        event.preventDefault();
        const video = this.getVideoByItemId(highlightedId);
        // Don't allow preview for queue, staging, or processing items
        if (video && !this.isQueueItem(video) && !this.isStagingItem(video) && !this.isProcessingItem(video)) {
          // Emit null to signal toggle (parent handles open/close logic)
          this.previewRequested.emit(video);
        }
      }
      return;
    }

    // Enter to open in editor
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      const highlightedId = this.highlightedItemId();
      if (highlightedId) {
        event.preventDefault();
        const video = this.getVideoByItemId(highlightedId);
        // Don't allow opening queue, staging, or processing items in editor
        if (video && !this.isQueueItem(video) && !this.isStagingItem(video) && !this.isProcessingItem(video)) {
          this.videoAction.emit({ action: 'openInEditor', videos: [video] });
        }
      }
      return;
    }

    // Cmd+A / Ctrl+A to select all
    if (event.key === 'a' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.handleSelectAll();
      return;
    }
  }

  // Track if last select-all was for a section (to know if next should be all)
  private lastSelectAllWasSection = false;

  /**
   * Handle Cmd+A / Ctrl+A select all
   * First press: select all in current section(s)
   * Second press: select all in library
   */
  private handleSelectAll(): void {
    const allItems = this.virtualItems();
    const videoItems = allItems.filter(item => item.type === 'video') as Array<{ type: 'video'; video: VideoItem; weekLabel: string; itemId: string }>;

    if (videoItems.length === 0) return;

    // Get all video itemIds for "select all"
    const allVideoIds = new Set(videoItems.map(item => item.itemId));

    // Check if all videos are already selected (then this is already "select all")
    const currentSelection = this.selectedVideos();
    const allSelected = allVideoIds.size === currentSelection.size &&
      [...allVideoIds].every(id => currentSelection.has(id));

    if (allSelected) {
      // Already have everything selected, nothing more to do
      return;
    }

    // Check if we should select all (second press) or select section (first press)
    if (this.lastSelectAllWasSection && currentSelection.size > 0) {
      // Second press - select all videos
      this.selectedVideos.set(allVideoIds);
      this.lastSelectAllWasSection = false;
      return;
    }

    // First press - select section
    let targetWeekLabels: Set<string>;

    if (currentSelection.size > 0) {
      // Get week labels of currently selected videos
      targetWeekLabels = new Set<string>();
      for (const item of videoItems) {
        if (currentSelection.has(item.itemId)) {
          targetWeekLabels.add(item.weekLabel);
        }
      }
    } else {
      // No selection - find section at top of viewport
      targetWeekLabels = new Set<string>();
      const topWeekLabel = this.getWeekLabelAtViewportTop();
      if (topWeekLabel) {
        targetWeekLabels.add(topWeekLabel);
      }
    }

    // Select all videos in target sections
    if (targetWeekLabels.size > 0) {
      const sectionSelection = new Set<string>();
      for (const item of videoItems) {
        if (targetWeekLabels.has(item.weekLabel)) {
          sectionSelection.add(item.itemId);
        }
      }
      this.selectedVideos.set(sectionSelection);
      this.lastSelectAllWasSection = true;
    }
  }

  /**
   * Get the week label of the section at the top of the viewport
   */
  private getWeekLabelAtViewportTop(): string | null {
    if (!this.viewport) return null;

    const scrollOffset = this.viewport.measureScrollOffset('top');
    const itemSize = 56;
    const topIndex = Math.floor(scrollOffset / itemSize);

    const allItems = this.virtualItems();
    if (topIndex >= allItems.length) return null;

    // Find the week label for the item at/near the top
    // Walk backwards from topIndex to find the most recent header
    for (let i = Math.min(topIndex, allItems.length - 1); i >= 0; i--) {
      const item = allItems[i];
      if (item.type === 'header') {
        return item.week.weekLabel;
      }
      if (item.type === 'video') {
        return item.weekLabel;
      }
    }

    // Fallback: use first video's week label
    for (const item of allItems) {
      if (item.type === 'video') {
        return item.weekLabel;
      }
    }

    return null;
  }

  /**
   * Navigate up/down in the list with arrow keys
   */
  private navigateWithArrowKey(direction: 1 | -1, extendSelection: boolean): void {
    // Use stable list of ALL videos for navigation (not just visible ones)
    const videoItems = this.allVideosInOrder();
    console.log(`[NAV] Total videos in list: ${videoItems.length}`);
    if (videoItems.length === 0) return;

    const currentId = this.highlightedItemId();
    let currentIndex = currentId ? videoItems.findIndex(item => item.itemId === currentId) : -1;
    console.log(`[NAV] Current ID: ${currentId}, Current Index: ${currentIndex}, Direction: ${direction > 0 ? 'DOWN' : 'UP'}`);

    // If current item doesn't exist in list, start from beginning or end
    if (currentIndex === -1) {
      // Nothing highlighted or highlighted item not in current list
      // Start from beginning if going down, or end if going up
      currentIndex = direction === 1 ? -1 : videoItems.length - 1;
      console.log(`[NAV] No current item found, starting at index: ${currentIndex}`);
    }

    // Calculate new index
    const newIndex = Math.max(0, Math.min(videoItems.length - 1, currentIndex + direction));
    console.log(`[NAV] Calculated new index: ${newIndex} (from ${currentIndex} + ${direction})`);

    // Don't navigate if we're already at the boundary
    if (newIndex === currentIndex) {
      console.log(`[NAV] At boundary, not navigating (newIndex=${newIndex}, currentIndex=${currentIndex})`);
      return;
    }

    const newItem = videoItems[newIndex];
    console.log(`[NAV] Moving to item: ${newItem?.itemId} (index ${newIndex})`);

    if (newItem) {
      this.highlightedItemId.set(newItem.itemId);

      if (extendSelection) {
        // Shift+Arrow: extend selection
        const selected = new Set(this.selectedVideos());
        selected.add(newItem.itemId);
        this.selectedVideos.set(selected);
      } else {
        // Arrow only: move selection to new item
        this.selectedVideos.set(new Set([newItem.itemId]));
      }

      // Scroll to make the item visible
      this.scrollToItemId(newItem.itemId);
    }
  }

  /**
   * Scroll to make an item visible in the viewport, centered vertically when possible
   */
  private scrollToItemId(itemId: string): void {
    const allItems = this.virtualItems();
    const targetIndex = allItems.findIndex(item =>
      item.type === 'video' && item.itemId === itemId
    );
    if (targetIndex < 0 || !this.viewport) return;

    const itemSize = 56; // itemSize from template
    const viewportHeight = this.viewport.getViewportSize();
    const currentScroll = this.viewport.measureScrollOffset('top');

    // Calculate where the item currently is
    const itemTop = targetIndex * itemSize;
    const itemBottom = itemTop + itemSize;

    // Check if item is already visible (with some margin)
    const visibleTop = currentScroll;
    const visibleBottom = currentScroll + viewportHeight;
    const margin = itemSize; // One item margin

    const isFullyVisible = itemTop >= visibleTop + margin && itemBottom <= visibleBottom - margin;

    if (isFullyVisible) {
      // Item is already visible with margin, no need to scroll
      return;
    }

    // Calculate ideal scroll position to center the item
    const targetOffset = itemTop - (viewportHeight / 2) + (itemSize / 2);

    // Clamp to valid range (can't scroll negative or past content)
    const totalContentHeight = allItems.length * itemSize;
    const maxScroll = Math.max(0, totalContentHeight - viewportHeight);
    const scrollOffset = Math.max(0, Math.min(targetOffset, maxScroll));

    this.viewport.scrollToOffset(scrollOffset, 'auto');
  }

  /**
   * Public method to highlight and scroll to a video by its database ID
   * Used by parent component when preview modal changes selection
   */
  highlightAndScrollToVideoId(videoId: string): void {
    // Find the itemId for this video (could be in multiple weeks)
    // IMPORTANT: Filter out ghost items - they are duplicates and shouldn't be selected
    const allItems = this.virtualItems().filter(item => item.type === 'video') as Array<{ type: 'video'; video: VideoItem; weekLabel: string; itemId: string }>;
    const found = allItems.find(item => item.video.id === videoId && !item.video.isGhost);

    if (found) {
      this.highlightedItemId.set(found.itemId);
      this.selectedVideos.set(new Set([found.itemId]));
      this.scrollToItemId(found.itemId);
    }
  }

  /**
   * Get a video by its itemId
   */
  private getVideoByItemId(itemId: string): VideoItem | null {
    const allItems = this.virtualItems().filter(item => item.type === 'video') as Array<{ type: 'video'; video: VideoItem; weekLabel: string; itemId: string }>;
    const found = allItems.find(item => item.itemId === itemId);
    return found?.video || null;
  }

  /**
   * Get the currently highlighted video
   */
  getHighlightedVideo(): VideoItem | null {
    const highlightedId = this.highlightedItemId();
    if (!highlightedId) return null;
    return this.getVideoByItemId(highlightedId);
  }

  /**
   * Remove videos from the local display (called by parent after successful delete)
   */
  removeVideosFromDisplay(videoIds: string[]) {
    const weeks = this.videoWeeks();
    const idsToRemove = new Set(videoIds);

    const updatedWeeks = weeks.map(week => ({
      ...week,
      videos: week.videos.filter(v => !idsToRemove.has(v.id))
    })).filter(week => week.videos.length > 0);

    this.videoWeeks.set(updatedWeeks);

    // Clear selection for deleted videos
    const selected = new Set(this.selectedVideos());
    videoIds.forEach(id => selected.delete(id));
    this.selectedVideos.set(selected);
  }

  clearSelection() {
    // Don't clear if we just finished a drag selection
    if (this.justFinishedDrag) {
      return;
    }
    this.selectedVideos.set(new Set());
    this.highlightedItemId.set(null);
    this.selectionAnchorId.set(null);
    this.lastSelectAllWasSection = false;
    this.closeContextMenu();
  }

  // ========================================
  // Drag Selection (Marquee) Methods
  // ========================================

  private dragMinDistance = 5; // Minimum pixels to move before showing selection rectangle
  private dragHasMoved = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private justFinishedDrag = false; // Prevent click after drag
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollSpeed = 0; // Pixels per frame (negative = up, positive = down)
  private readonly AUTO_SCROLL_ZONE = 50; // Pixels from edge to trigger auto-scroll
  private readonly AUTO_SCROLL_MAX_SPEED = 15; // Max pixels per frame
  // Track selection bounds in absolute list coordinates for virtual scroll compatibility
  private dragMinY = 0; // Minimum Y in list-space
  private dragMaxY = 0; // Maximum Y in list-space

  /**
   * Start drag selection on mousedown
   */
  onDragSelectStart(event: MouseEvent): void {
    // Only start drag on left click
    if (event.button !== 0) return;

    // Don't start drag on buttons or interactive elements
    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('.week-header')) {
      return;
    }

    // Store client coordinates to calculate drag distance
    this.dragStartClientX = event.clientX;
    this.dragStartClientY = event.clientY;
    this.dragHasMoved = false;

    // Store initial selection if shift/cmd is held, otherwise we'll clear on actual drag
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      this.dragSelectionInitialSelected = new Set(this.selectedVideos());
    } else {
      this.dragSelectionInitialSelected = new Set();
    }

    const container = event.currentTarget as HTMLElement;
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Initialize scroll-space Y bounds
    // Use the viewport's rendered content wrapper to get accurate position
    const contentWrapper = container.querySelector('.cdk-virtual-scroll-content-wrapper');
    if (contentWrapper && this.viewport) {
      const contentRect = contentWrapper.getBoundingClientRect();
      const renderedRange = this.viewport.getRenderedRange();
      const itemSize = 56;
      // Calculate absolute Y position in the full list
      // contentRect.top is where rendered items start visually
      // renderedRange.start * itemSize is the offset of rendered items from list start
      const scrollSpaceY = (event.clientY - contentRect.top) + (renderedRange.start * itemSize);
      this.dragMinY = scrollSpaceY;
      this.dragMaxY = scrollSpaceY;
    }

    this.dragStartPoint.set({ x, y });
    this.dragCurrentPoint.set({ x, y });

    // Add document listeners for drag
    document.addEventListener('mousemove', this.onDragSelectMove);
    document.addEventListener('mouseup', this.onDragSelectEnd);
  }

  /**
   * Update drag selection on mousemove
   */
  private onDragSelectMove = (event: MouseEvent): void => {
    const start = this.dragStartPoint();
    if (!start) return;

    // Calculate distance moved
    const dx = event.clientX - this.dragStartClientX;
    const dy = event.clientY - this.dragStartClientY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Only start actual drag selection after minimum distance
    if (!this.dragHasMoved && distance >= this.dragMinDistance) {
      this.dragHasMoved = true;
      this.isDragSelecting.set(true);

      // Clear selection when starting drag (unless modifier held)
      if (this.dragSelectionInitialSelected.size === 0) {
        this.selectedVideos.set(new Set());
      }

      // Start auto-scroll interval
      this.startAutoScroll();
    }

    if (!this.dragHasMoved) return;

    const container = document.querySelector('.cascade') as HTMLElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    this.dragCurrentPoint.set({ x, y });

    // Calculate auto-scroll speed and update scroll-space Y bounds
    const viewportEl = container.querySelector('cdk-virtual-scroll-viewport');
    const contentWrapper = container.querySelector('.cdk-virtual-scroll-content-wrapper');
    if (viewportEl && contentWrapper && this.viewport) {
      const viewportRect = viewportEl.getBoundingClientRect();
      const contentRect = contentWrapper.getBoundingClientRect();
      const renderedRange = this.viewport.getRenderedRange();
      const itemSize = 56;
      const mouseY = event.clientY;

      // Update scroll-space Y bounds (expand to include current mouse position)
      // Calculate absolute Y in full list coordinates
      const scrollSpaceY = (mouseY - contentRect.top) + (renderedRange.start * itemSize);
      this.dragMinY = Math.min(this.dragMinY, scrollSpaceY);
      this.dragMaxY = Math.max(this.dragMaxY, scrollSpaceY);

      if (mouseY < viewportRect.top + this.AUTO_SCROLL_ZONE) {
        // Near top - scroll up
        const distanceFromEdge = viewportRect.top + this.AUTO_SCROLL_ZONE - mouseY;
        this.autoScrollSpeed = -Math.min(distanceFromEdge / 2, this.AUTO_SCROLL_MAX_SPEED);
      } else if (mouseY > viewportRect.bottom - this.AUTO_SCROLL_ZONE) {
        // Near bottom - scroll down
        const distanceFromEdge = mouseY - (viewportRect.bottom - this.AUTO_SCROLL_ZONE);
        this.autoScrollSpeed = Math.min(distanceFromEdge / 2, this.AUTO_SCROLL_MAX_SPEED);
      } else {
        // Not near edge - stop scrolling
        this.autoScrollSpeed = 0;
      }
    }

    this.updateDragSelection();
  };

  /**
   * Start auto-scroll interval for drag selection
   */
  private startAutoScroll(): void {
    if (this.autoScrollInterval) return;

    this.autoScrollInterval = setInterval(() => {
      if (this.autoScrollSpeed === 0 || !this.viewport) return;

      const currentScroll = this.viewport.measureScrollOffset('top');
      const newScroll = currentScroll + this.autoScrollSpeed;
      this.viewport.scrollTo({ top: Math.max(0, newScroll) });

      // Expand scroll-space bounds as we scroll
      if (this.autoScrollSpeed > 0) {
        // Scrolling down - expand max Y
        this.dragMaxY += this.autoScrollSpeed;
      } else {
        // Scrolling up - expand min Y
        this.dragMinY += this.autoScrollSpeed;
      }

      // Update the drag point to account for scroll (keep rectangle extending visually)
      const current = this.dragCurrentPoint();
      if (current) {
        this.dragCurrentPoint.set({ x: current.x, y: current.y + this.autoScrollSpeed });
        this.updateDragSelection();
      }
    }, 16); // ~60fps
  }

  /**
   * Stop auto-scroll interval
   */
  private stopAutoScroll(): void {
    if (this.autoScrollInterval) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
    this.autoScrollSpeed = 0;
  }

  /**
   * End drag selection on mouseup
   */
  private onDragSelectEnd = (): void => {
    const wasDragging = this.dragHasMoved;

    // Stop auto-scrolling
    this.stopAutoScroll();

    this.isDragSelecting.set(false);
    this.dragStartPoint.set(null);
    this.dragCurrentPoint.set(null);
    this.dragSelectionInitialSelected = new Set();
    this.dragHasMoved = false;

    // Prevent click handler from firing after drag
    if (wasDragging) {
      this.justFinishedDrag = true;
      setTimeout(() => {
        this.justFinishedDrag = false;
      }, 0);
    }

    document.removeEventListener('mousemove', this.onDragSelectMove);
    document.removeEventListener('mouseup', this.onDragSelectEnd);
  };

  /**
   * Update selection based on current drag rectangle
   * Uses scroll-space coordinates to handle virtual scrolling correctly
   * Toggles items that were already selected before drag started
   */
  private updateDragSelection(): void {
    if (!this.isDragSelecting()) return;

    const itemSize = 56; // Must match itemSize in template
    const allItems = this.virtualItems();
    const newSelection = new Set(this.dragSelectionInitialSelected);

    // Calculate which items fall within the scroll-space Y bounds
    let currentY = 0;
    for (const item of allItems) {
      if (item.type === 'video') {
        const itemTop = currentY;
        const itemBottom = currentY + itemSize;

        // Check if item intersects with selection bounds
        if (itemBottom > this.dragMinY && itemTop < this.dragMaxY) {
          // Toggle: if it was already selected before drag, deselect it; otherwise select it
          if (this.dragSelectionInitialSelected.has(item.itemId)) {
            newSelection.delete(item.itemId);
          } else {
            newSelection.add(item.itemId);
          }
        }
      }
      // Both headers and videos take up space
      currentY += itemSize;
    }

    this.selectedVideos.set(newSelection);
  }

  formatDownloadDate(date?: Date): string {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // TrackBy function for virtual scroll
  // IMPORTANT: Use unique itemId (includes week label) to avoid duplicate tracking keys
  // for ghost videos that appear in multiple weeks
  trackItem(index: number, item: VirtualListItem): string {
    if (item.type === 'header') {
      return `header-${item.week.weekLabel}`;
    }
    // Use itemId which is unique per week: `${weekLabel}|${video.id}`
    return `video-${item.itemId}`;
  }

  /**
   * Get the processing status class for a video's indicator dot
   * - green: non-video file (image, pdf, etc.) - no processing needed
   * - red: unprocessed video (only downloaded)
   * - orange: transcribed only
   * - green: transcribed + analyzed
   * - blue: transcribed + analyzed + > 10 minutes
   */
  getProcessingStatus(video: VideoItem): string {
    // Check if it's a saved link item
    if (video.tags?.includes('saved-link')) {
      if (video.tags?.includes('download-complete')) {
        return 'status-complete'; // Green - ready to import
      }
      if (video.tags?.includes('download-failed')) {
        return 'status-failed'; // Red - failed
      }
      if (video.tags?.includes('downloading')) {
        return 'status-downloading'; // Orange/animated - in progress
      }
      return 'status-pending'; // Pending
    }

    // Check if it's a webpage link (from saved links)
    if (video.tags?.includes('webpage') || video.mediaType === 'text/html') {
      return 'status-webpage'; // Purple - webpage link
    }

    // Check if it's a non-video file (image, pdf, etc.)
    const mediaType = video.mediaType?.toLowerCase() || '';
    const ext = video.fileExtension?.toLowerCase() || '';

    const nonVideoExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.doc', '.docx', '.txt', '.md', '.mhtml', '.html', '.htm'];
    const isNonVideo = mediaType.startsWith('image/') ||
                       mediaType === 'application/pdf' ||
                       nonVideoExtensions.some(e => ext === e || video.name?.toLowerCase().endsWith(e));

    if (isNonVideo) {
      return 'status-complete'; // Green - no processing needed
    }

    const hasTranscript = video.hasTranscript || false;
    const hasAnalysis = video.hasAnalysis || false;

    if (!hasTranscript && !hasAnalysis) {
      return 'status-unprocessed';
    }

    if (hasTranscript && !hasAnalysis) {
      return 'status-transcribed';
    }

    if (hasTranscript && hasAnalysis) {
      // Check if longer than 10 minutes
      const durationMinutes = this.parseDurationToMinutes(video.duration || '');
      if (durationMinutes > 10) {
        return 'status-complete-long';
      }
      return 'status-complete';
    }

    return 'status-unprocessed';
  }

  /**
   * Parse duration string (hh:mm:ss or mm:ss) to minutes
   */
  private parseDurationToMinutes(duration: string): number {
    if (!duration) return 0;

    const parts = duration.split(':').map(p => parseInt(p, 10));

    if (parts.length === 3) {
      // hh:mm:ss
      return parts[0] * 60 + parts[1] + parts[2] / 60;
    } else if (parts.length === 2) {
      // mm:ss
      return parts[0] + parts[1] / 60;
    }

    return 0;
  }

  // ========================================
  // Hierarchical Children Methods
  // ========================================

  /**
   * Check if a video has children (processing tasks)
   */
  hasChildren(video: VideoItem): boolean {
    if (!this.childrenConfig?.enabled) return false;

    if (this.childrenConfig.generator) {
      const generated = this.childrenConfig.generator(video);
      return generated && generated.length > 0;
    }

    return false;
  }

  /**
   * Check if a video has any relationships (task children, video children, or parents)
   */
  hasRelationships(video: VideoItem): boolean {
    // Check for task-based children
    if (this.hasChildren(video)) return true;

    // Check for video relationships (parents or children)
    return this.hasVideoChildren(video) || this.isVideoChild(video);
  }

  /**
   * Get video relationships (both parents and children)
   */
  getVideoRelationships(video: VideoItem): Array<{id: string; type: 'parent' | 'child'; video: VideoItem}> {
    const relationships: Array<{id: string; type: 'parent' | 'child'; video: VideoItem}> = [];

    // Debug logging
    console.log('Getting relationships for video:', video.name, {
      parentIds: video.parentIds,
      childIds: video.childIds,
      parents: video.parents,
      children: video.children
    });

    // Add parents
    if (video.parents && video.parents.length > 0) {
      video.parents.forEach(parent => {
        relationships.push({
          id: `parent-${parent.id}`,
          type: 'parent',
          video: parent
        });
      });
    }

    // Add children
    if (video.children && video.children.length > 0) {
      video.children.forEach(child => {
        relationships.push({
          id: `child-${child.id}`,
          type: 'child',
          video: child
        });
      });
    }

    console.log('Total relationships found:', relationships.length);

    return relationships;
  }

  /**
   * Handle click on a relationship item (navigate to related video)
   */
  handleRelationshipClick(relationship: {id: string; type: 'parent' | 'child'; video: VideoItem}, event: Event): void {
    event.stopPropagation();
    // Navigate to the related video's info page
    this.router.navigate(['/video', relationship.video.id]);
  }

  /**
   * Remove a relationship between videos
   */
  removeRelationship(currentVideo: VideoItem, relationship: {id: string; type: 'parent' | 'child'; video: VideoItem}, event: Event): void {
    event.stopPropagation();

    const relatedVideoId = relationship.video.id;
    const confirmMessage = relationship.type === 'parent'
      ? `Remove parent relationship with "${relationship.video.name}"?`
      : `Remove child relationship with "${relationship.video.name}"?`;

    if (!confirm(confirmMessage)) {
      return;
    }

    // Determine parent and child based on relationship type
    const parentId = relationship.type === 'parent' ? relatedVideoId : currentVideo.id;
    const childId = relationship.type === 'parent' ? currentVideo.id : relatedVideoId;

    // Call library service to remove the relationship
    this.libraryService.removeParentChildRelationship(parentId, childId).subscribe({
      next: (response: any) => {
        if (response.success) {
          console.log('Relationship removed successfully');

          // Update local state - remove from parents or children arrays
          if (relationship.type === 'parent' && currentVideo.parents) {
            currentVideo.parents = currentVideo.parents.filter(p => p.id !== relatedVideoId);
            if (currentVideo.parentIds) {
              currentVideo.parentIds = currentVideo.parentIds.filter(id => id !== relatedVideoId);
            }
          } else if (relationship.type === 'child' && currentVideo.children) {
            currentVideo.children = currentVideo.children.filter(c => c.id !== relatedVideoId);
            if (currentVideo.childIds) {
              currentVideo.childIds = currentVideo.childIds.filter(id => id !== relatedVideoId);
            }
          }

          // Trigger change detection
          this.videoWeeks.set([...this.videoWeeks()]);
        } else {
          console.error('Failed to remove relationship:', response.error);
          this.notificationService.error('Remove Failed', response.error || 'Failed to remove relationship');
        }
      },
      error: (error: any) => {
        console.error('Error removing relationship:', error);
        this.notificationService.error('Remove Failed', error.error?.error || error.message);
      }
    });
  }

  /**
   * Check if a video has child videos (parent-child relationship)
   */
  hasVideoChildren(video: VideoItem): boolean {
    return !!(video.childIds && video.childIds.length > 0);
  }

  /**
   * Check if a video is a child (has parents)
   */
  isVideoChild(video: VideoItem): boolean {
    return !!(video.parentIds && video.parentIds.length > 0);
  }

  /**
   * Handle video click (select for normal items, prevent for ghost items)
   */
  handleVideoClick(itemId: string, video: VideoItem, event: MouseEvent): void {
    // Skip if we just finished a drag selection
    if (this.justFinishedDrag) {
      event.stopPropagation();
      return;
    }

    if (video.isGhost) {
      // Ghost items are not selectable
      event.stopPropagation();
      return;
    }
    this.selectVideo(itemId, video, event);
  }

  /**
   * Handle video double-click (navigate to actual location for ghost items)
   */
  handleVideoDoubleClick(video: VideoItem, event: MouseEvent): void {
    if (video.isGhost) {
      event.stopPropagation();
      event.preventDefault();
      // Scroll to and highlight the actual video
      this.scrollToVideo(video.id);
    }
  }

  /**
   * Scroll to a video and highlight it
   */
  private scrollToVideo(videoId: string): void {
    // Find the video's actual position in the list
    const virtualItems = this.virtualItems();
    const index = virtualItems.findIndex(item =>
      item.type === 'video' && item.video.id === videoId && !item.video.isGhost
    );

    if (index !== -1 && this.viewport) {
      const item = virtualItems[index];

      // Scroll to the video
      this.viewport.scrollToIndex(index, 'smooth');

      // Temporarily highlight it using the correct itemId format
      if (item.type === 'video') {
        this.highlightedItemId.set(item.itemId);
        setTimeout(() => {
          this.highlightedItemId.set(null);
        }, 2000);
      }
    }
  }

  /**
   * Get children for a video
   */
  getChildren(video: VideoItem): VideoChild[] {
    if (!this.childrenConfig?.enabled) return [];

    if (this.childrenConfig.generator) {
      return this.childrenConfig.generator(video) || [];
    }

    return [];
  }

  /**
   * Check if a video's children are expanded
   */
  isExpanded(videoId: string): boolean {
    return this.expandedItems().has(videoId);
  }

  /**
   * Toggle expand/collapse state of a video's children
   */
  toggleExpanded(videoId: string, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }

    const expanded = new Set(this.expandedItems());
    if (expanded.has(videoId)) {
      expanded.delete(videoId);
    } else {
      expanded.add(videoId);
    }
    this.expandedItems.set(expanded);
  }

  /**
   * Get master progress for a video (calculated from children)
   */
  getMasterProgress(video: VideoItem): number | null {
    if (!this.childrenConfig?.showMasterProgress) return null;
    if (!this.hasChildren(video)) return null;

    if (this.childrenConfig.masterProgressCalculator) {
      return this.childrenConfig.masterProgressCalculator(video);
    }

    // Calculate average from children's progress
    const children = this.getChildren(video);
    if (children.length === 0) return null;

    const progressValues = children
      .map(c => c.progress?.value)
      .filter((v): v is number => typeof v === 'number');

    if (progressValues.length === 0) return null;

    const sum = progressValues.reduce((a, b) => a + b, 0);
    return Math.round(sum / progressValues.length);
  }

  /**
   * Get icon for child status
   */
  getChildStatusIcon(status?: ChildStatus): string {
    switch (status) {
      case 'completed': return '✓';
      case 'active': return '⟳';
      case 'failed': return '✗';
      case 'skipped': return '⊘';
      case 'pending': return '⏳';
      default: return '○';
    }
  }

  /**
   * Handle click on a child item
   */
  handleChildClick(parent: VideoItem, child: VideoChild, event: Event): void {
    event.stopPropagation();

    if (this.childrenConfig?.clickable !== false) {
      this.childClicked.emit({ parent, child });
    }
  }

  // ========================================
  // Drag & Drop Methods
  // ========================================

  /**
   * Handle drop event for reordering items within a week
   */
  onDrop(event: CdkDragDrop<VideoItem[]>, weekLabel: string): void {
    if (!this.draggable) return;
    if (event.previousIndex === event.currentIndex) return;

    // Find the week and update video order
    const weeks = this.videoWeeks();
    const weekIndex = weeks.findIndex(w => w.weekLabel === weekLabel);
    if (weekIndex === -1) return;

    const week = weeks[weekIndex];
    const videos = [...week.videos];
    moveItemInArray(videos, event.previousIndex, event.currentIndex);

    // Update the week's videos
    const updatedWeeks = [...weeks];
    updatedWeeks[weekIndex] = { ...week, videos };
    this.videoWeeks.set(updatedWeeks);

    // Emit the reorder event
    this.itemsReordered.emit({ weekLabel, videos });
  }
}
