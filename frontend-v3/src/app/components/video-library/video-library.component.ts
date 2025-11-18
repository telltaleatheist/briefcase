import { Component, Input, Output, EventEmitter, signal, computed, ChangeDetectionStrategy, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { VideoWeek, VideoItem, VideoContextMenuAction } from '../../models/video.model';
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
  selector: 'app-video-library',
  standalone: true,
  imports: [CommonModule, ScrollingModule, ContextMenuComponent, FilenameModalComponent],
  templateUrl: './video-library.component.html',
  styleUrls: ['./video-library.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VideoLibraryComponent {
  private electronService = inject(ElectronService);
  private libraryService = inject(LibraryService);

  @Input() set weeks(value: VideoWeek[]) {
    // Convert to expandable weeks (all expanded by default)
    const expandableWeeks = value.map(week => ({
      ...week,
      expanded: true
    }));
    this.videoWeeks.set(expandableWeeks);
  }

  @Output() selectionChanged = new EventEmitter<{ count: number; ids: Set<string> }>();
  @Output() videoAction = new EventEmitter<{ action: string; videos: VideoItem[] }>();

  videoWeeks = signal<ExpandableVideoWeek[]>([]);
  selectedVideos = signal<Set<string>>(new Set());
  contextMenuVisible = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuVideo = signal<VideoItem | null>(null);

  // Filename modal
  filenameModalVisible = signal(false);
  editingVideo = signal<VideoItem | null>(null);

  selectedCount = computed(() => this.selectedVideos().size);

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

    const actions: VideoContextMenuAction[] = [];

    // Single video actions
    if (count <= 1) {
      actions.push({ label: 'Open in Editor', icon: '🎬', action: 'openInEditor' });
      actions.push({ label: 'Rename', icon: '✏️', action: 'rename' });
      actions.push({ label: 'View Details', icon: 'ℹ️', action: 'viewDetails' });
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
    const countSuffix = count > 1 ? ` (${count})` : '';
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

      case 'viewDetails':
        this.videoAction.emit({ action: 'viewDetails', videos: [video] });
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
        this.videoAction.emit({ action: 'editSuggestedTitle', videos: [video] });
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
        this.videoAction.emit({ action: 'delete', videos });
        break;
    }
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

  /**
   * Handle inline delete button click
   */
  onDeleteClick(video: VideoItem, event: Event) {
    event.stopPropagation();
    this.videoAction.emit({ action: 'delete', videos: [video] });
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
   * - red: unprocessed (only downloaded)
   * - orange: transcribed only
   * - green: transcribed + analyzed
   * - blue: transcribed + analyzed + > 10 minutes
   */
  getProcessingStatus(video: VideoItem): string {
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
      const durationMinutes = this.parseDurationToMinutes(video.duration);
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
}
