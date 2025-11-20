import { Component, Input, Output, EventEmitter, signal, computed, ChangeDetectionStrategy, effect, inject, HostListener, ViewChild } from '@angular/core';
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
  private router = inject(Router);

  @Input() set weeks(value: VideoWeek[]) {
    // Convert to expandable weeks (all expanded by default)
    const expandableWeeks = value.map(week => ({
      ...week,
      expanded: true
    }));
    this.videoWeeks.set(expandableWeeks);
  }

  // Progress configuration
  @Input() progressMapper?: (video: VideoItem) => ItemProgress | null;

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

  @Output() selectionChanged = new EventEmitter<{ count: number; ids: Set<string> }>();
  @Output() videoAction = new EventEmitter<{ action: string; videos: VideoItem[] }>();
  @Output() childClicked = new EventEmitter<{ parent: VideoItem; child: VideoChild }>();
  @Output() itemsReordered = new EventEmitter<{ weekLabel: string; videos: VideoItem[] }>();
  @Output() configureItem = new EventEmitter<VideoItem>();

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
  contextMenuVisible = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuVideo = signal<VideoItem | null>(null);

  // Filename modal
  filenameModalVisible = signal(false);
  editingVideo = signal<VideoItem | null>(null);

  // Suggested title modal
  suggestedTitleModalVisible = signal(false);
  editingSuggestedTitleVideo = signal<VideoItem | null>(null);

  // Delete options modal
  deleteModalVisible = signal(false);
  deletingVideos = signal<VideoItem[]>([]);
  selectedDeleteMode = signal<DeleteMode | null>(null);

  selectedCount = computed(() => this.selectedVideos().size);

  /**
   * Check if item is highlighted (keyboard navigation cursor)
   */
  isHighlighted(itemId: string): boolean {
    return this.highlightedItemId() === itemId;
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
    for (const week of this.videoWeeks()) {
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

  private initialized = false;

  constructor() {
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
    const count = this.selectedCount();
    const video = this.contextMenuVideo();
    const hasSuggestedTitle = video?.suggestedTitle && video.suggestedTitle !== video.name;
    const isQueue = video ? this.isQueueItem(video) : false;

    const actions: VideoContextMenuAction[] = [];
    const countSuffix = count > 1 ? ` (${count})` : '';

    // Queue item specific actions
    if (isQueue) {
      actions.push({ label: `Configure Tasks${countSuffix}`, icon: '⚙️', action: 'analyze' });
      actions.push({ label: '', icon: '', action: '', divider: true });
      actions.push({ label: `Remove from Queue${countSuffix}`, icon: '🗑️', action: 'removeFromQueue' });
      return actions;
    }

    // Library item actions
    // Single video actions
    if (count <= 1) {
      actions.push({ label: 'Open in Editor', icon: '🎬', action: 'openInEditor' });
      actions.push({ label: 'View More', icon: 'ℹ️', action: 'viewMore' });
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
    actions.push({ label: `Add to Tab${countSuffix}`, icon: '📑', action: 'addToTab' });

    // Another divider
    actions.push({ label: '', icon: '', action: '', divider: true });

    // Processing actions
    actions.push({ label: `Run Analysis${countSuffix}`, icon: '🧠', action: 'analyze' });
    actions.push({ label: `Move to...${countSuffix}`, icon: '📦', action: 'moveToLibrary' });

    // Final divider and delete
    actions.push({ label: '', icon: '', action: '', divider: true });
    actions.push({ label: `Delete${countSuffix}`, icon: '🗑️', action: 'delete' });

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

    if (event.ctrlKey || event.metaKey) {
      // Multi-select
      const selected = new Set(this.selectedVideos());
      if (selected.has(itemId)) {
        selected.delete(itemId);
        // Clear highlight if deselecting the highlighted item
        if (this.highlightedItemId() === itemId) {
          this.highlightedItemId.set(null);
        }
      } else {
        selected.add(itemId);
      }
      this.selectedVideos.set(selected);
    } else if (event.shiftKey && this.selectedVideos().size > 0) {
      // Range select (optional enhancement)
      this.rangeSelect(itemId);
    } else {
      // Single select
      this.selectedVideos.set(new Set([itemId]));
      // Set highlighted to clicked item
      this.highlightedItemId.set(itemId);
    }
  }

  rangeSelect(endItemId: string) {
    // Get all items from virtual list
    const allItems = this.virtualItems().filter(item => item.type === 'video') as Array<{ type: 'video'; video: VideoItem; weekLabel: string; itemId: string }>;

    // Find the first selected item and the clicked item
    const selectedArray = Array.from(this.selectedVideos());
    const firstSelectedId = selectedArray[0];
    const firstIndex = allItems.findIndex(item => item.itemId === firstSelectedId);
    const endIndex = allItems.findIndex(item => item.itemId === endItemId);

    if (firstIndex === -1 || endIndex === -1) return;

    // Select all items in range
    const start = Math.min(firstIndex, endIndex);
    const end = Math.max(firstIndex, endIndex);
    const selected = new Set<string>();

    for (let i = start; i <= end; i++) {
      selected.add(allItems[i].itemId);
    }

    this.selectedVideos.set(selected);
  }

  isSelected(itemId: string): boolean {
    return this.selectedVideos().has(itemId);
  }

  onContextMenu(itemId: string, video: VideoItem, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (!this.isSelected(itemId)) {
      this.selectedVideos.set(new Set([itemId]));
    }

    this.contextMenuVideo.set(video);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.contextMenuVisible.set(true);
  }

  onContextMenuAction(action: string) {
    const video = this.contextMenuVideo();
    if (!video) return;

    // Get all selected videos for multi-select actions
    const selectedVideos = this.getSelectedVideos();
    const videos = selectedVideos.length > 0 ? selectedVideos : [video];

    switch (action) {
      case 'rename':
        this.openFilenameModal(video);
        break;

      case 'viewMore':
        // Navigate to video info page
        this.router.navigate(['/video', video.id]);
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

      case 'addToTab':
        this.videoAction.emit({ action: 'addToTab', videos });
        break;

      case 'analyze':
        this.videoAction.emit({ action: 'analyze', videos });
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
    this.filenameModalVisible.set(true);
  }

  onFilenameSaved(newFilename: string) {
    const video = this.editingVideo();
    if (video) {
      video.suggestedFilename = newFilename;
      console.log('Updated filename:', video.id, newFilename);
      // Here you would typically make an API call to save the new filename
      this.videoWeeks.set([...this.videoWeeks()]);
    }
  }

  onFilenameModalClosed() {
    this.filenameModalVisible.set(false);
    this.editingVideo.set(null);
  }

  openSuggestedTitleModal(video: VideoItem) {
    this.editingSuggestedTitleVideo.set(video);
    this.suggestedTitleModalVisible.set(true);
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
            alert(response.error || 'Failed to rename file');
          }
        },
        error: (error: any) => {
          console.error('Error accepting suggested title:', error);
          alert('Failed to rename file: ' + (error.error?.error || error.message));
        }
      });
    }
  }

  onSuggestedTitleModalClosed() {
    this.suggestedTitleModalVisible.set(false);
    this.editingSuggestedTitleVideo.set(null);
  }

  /**
   * Handle inline delete button click
   */
  onDeleteClick(video: VideoItem, event: Event) {
    event.stopPropagation();

    // For queue items, emit delete directly (removes from queue, no modal needed)
    if (this.isQueueItem(video)) {
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
   * Check if a video is a queue item (not yet in library)
   */
  isQueueItem(video: VideoItem): boolean {
    return video.id.startsWith('queue-') || video.tags?.some(t => t.startsWith('queue:')) || false;
  }

  /**
   * Handle configure button click for queue items
   */
  onConfigureClick(video: VideoItem, event: Event) {
    event.stopPropagation();
    this.configureItem.emit(video);
  }

  /**
   * Handle keyboard shortcuts for delete
   */
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    // Check for Delete key or Cmd/Ctrl+Backspace
    const isDelete = event.key === 'Delete';
    const isCmdBackspace = event.key === 'Backspace' && (event.metaKey || event.ctrlKey);

    if (isDelete || isCmdBackspace) {
      const selectedVideos = this.getSelectedVideos();
      if (selectedVideos.length > 0) {
        event.preventDefault();
        this.openDeleteModal(selectedVideos);
      }
    }
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
    this.selectedVideos.set(new Set());
    this.highlightedItemId.set(null);
    this.closeContextMenu();
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
  trackItem(index: number, item: VirtualListItem): string {
    if (item.type === 'header') {
      return `header-${item.week.weekLabel}`;
    }
    return `video-${item.video.id}`;
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
    // Check if it's a non-video file (image, pdf, etc.)
    const mediaType = video.mediaType?.toLowerCase() || '';
    const ext = video.fileExtension?.toLowerCase() || '';

    const nonVideoExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.doc', '.docx', '.txt', '.md'];
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
   * Check if a video has children
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
