import { Component, signal, computed, inject, input, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CascadeComponent } from '../cascade/cascade.component';
import { NewTabDialogComponent } from '../new-tab-dialog/new-tab-dialog.component';
import { VideoWeek, VideoItem } from '../../models/video.model';
import { TabsService } from '../../services/tabs.service';
import { NotificationService } from '../../services/notification.service';
import { LibraryService } from '../../services/library.service';

@Component({
  selector: 'app-tabs-tab',
  standalone: true,
  imports: [CommonModule, CascadeComponent, NewTabDialogComponent],
  templateUrl: './tabs-tab.component.html',
  styleUrls: ['./tabs-tab.component.scss']
})
export class TabsTabComponent {
  private tabsService = inject(TabsService);
  private notificationService = inject(NotificationService);
  private libraryService = inject(LibraryService);
  private router = inject(Router);

  // Input: callbacks for parent coordination
  onSelectionChanged = input<(event: { count: number; ids: Set<string> }) => void>();
  onVideoAction = input<(event: { action: string; videos: VideoItem[] }) => void>();
  onPreviewRequested = input<(video: VideoItem) => void>();

  /** When set (/collections/:id), the view scopes to that single collection. */
  collectionId = input<string | null>(null);

  // Tabs state
  allTabs = signal<any[]>([]);
  tabVideosMap = signal<Map<string, VideoItem[]>>(new Map());

  // New tab dialog
  newTabDialogOpen = signal(false);
  pendingTabVideos = signal<string[]>([]);

  // Rename tab dialog
  tabDialogMode = signal<'create' | 'rename'>('create');
  renamingTabName = signal<string>('');
  renamingTabId = signal<string>('');

  // Track initialization state
  private initialized = false;

  constructor() {
    // Watch the service's tabs signal for external updates (e.g., tab created from library page)
    effect(() => {
      const serviceTabs = this.tabsService.tabs();
      // Only react to changes after initial load
      if (this.initialized && serviceTabs.length > 0) {
        // Check if our local tabs are out of sync with the service
        const localTabs = this.allTabs();
        const serviceTabIds = new Set(serviceTabs.map(t => t.id));
        const localTabIds = new Set(localTabs.map(t => t.id));

        // If there's a new tab in the service that we don't have locally, reload
        const hasNewTabs = serviceTabs.some(t => !localTabIds.has(t.id));
        const hasRemovedTabs = localTabs.some(t => !serviceTabIds.has(t.id));

        if (hasNewTabs || hasRemovedTabs) {
          this.loadTabsData();
        }
      }
    });
  }

  /** The scoped collection when on /collections/:id (null = all-collections view). */
  activeCollection = computed<{ id: string; name: string } | null>(() => {
    const id = this.collectionId();
    if (!id) return null;
    return this.allTabs().find(t => t.id === id) ?? null;
  });

  /** Item count of the scoped collection. */
  activeCollectionCount = computed(() => {
    const active = this.activeCollection();
    if (!active) return 0;
    return (this.tabVideosMap().get(active.id) || []).length;
  });

  // Computed property for tab weeks — scoped to one collection when :id is set
  tabWeeks = computed<VideoWeek[]>(() => {
    const tabs = this.allTabs();
    const videosMap = this.tabVideosMap();
    const scopedId = this.collectionId();

    const visible = scopedId ? tabs.filter(t => t.id === scopedId) : tabs;
    return visible.map(tab => ({
      weekLabel: tab.name,
      videos: videosMap.get(tab.id) || []
    }));
  });

  /**
   * Initialize and load tabs data
   */
  async ngOnInit() {
    // Only load tabs if a library is active
    try {
      const response = await firstValueFrom(this.libraryService.getCurrentLibrary());
      if (response.success && response.data) {
        await this.loadTabsData();
        this.initialized = true;
      } else {
        console.log('No active library, skipping tabs load');
        this.initialized = true;
      }
    } catch (error) {
      console.log('No active library available, skipping tabs load');
      this.initialized = true;
    }
  }

  /**
   * Load all tabs and their videos
   */
  async loadTabsData() {
    try {
      // Load all tabs
      const tabs = await firstValueFrom(this.tabsService.getAllTabs());
      this.allTabs.set(tabs);

      // Load videos for each tab
      const videosMap = new Map<string, VideoItem[]>();
      for (const tab of tabs) {
        try {
          const videoRecords = await firstValueFrom(this.tabsService.getTabVideos(tab.id));
          // Map backend video records to VideoItem format
          const videos: VideoItem[] = videoRecords.map((v: any) => ({
            id: v.id,
            name: v.filename,
            suggestedFilename: v.suggested_title || undefined,
            suggestedTitle: v.suggested_title || undefined,
            duration: v.duration_seconds ? `${String(Math.floor(v.duration_seconds / 3600)).padStart(2, '0')}:${String(Math.floor((v.duration_seconds % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(v.duration_seconds % 60)).padStart(2, '0')}` : undefined,
            size: v.file_size_bytes || undefined,
            uploadDate: v.upload_date ? new Date(v.upload_date) : undefined,
            downloadDate: v.download_date ? new Date(v.download_date) : undefined,
            lastProcessedDate: v.last_processed_date ? new Date(v.last_processed_date) : undefined,
            filePath: v.current_path,
            hasTranscript: v.has_transcript === 1,
            hasAnalysis: v.has_analysis === 1,
            aiDescription: v.ai_description || undefined,
            sourceUrl: v.source_url || undefined,
            mediaType: v.media_type || 'video',
            fileExtension: v.file_extension || undefined,
          }));
          videosMap.set(tab.id, videos);
        } catch (error) {
          console.error(`Failed to load videos for tab ${tab.id}:`, error);
          videosMap.set(tab.id, []);
        }
      }
      this.tabVideosMap.set(videosMap);
    } catch (error: any) {
      console.error('Failed to load tabs:', error);
      // Don't show error notification if it's a database not initialized error (expected on first run)
      if (error?.error?.message?.includes('Database not initialized') ||
          error?.message?.includes('Database not initialized')) {
        console.log('Database not initialized yet, skipping tabs notification');
        return;
      }
      this.notificationService.error('Failed to Load Tabs', 'An error occurred while loading tabs');
    }
  }

  /**
   * Handle selection changes
   */
  handleSelectionChanged(event: { count: number; ids: Set<string> }) {
    const callback = this.onSelectionChanged();
    if (callback) {
      callback(event);
    }
  }

  /**
   * Handle video actions
   */
  handleVideoAction(event: { action: string; videos: VideoItem[] }) {
    const callback = this.onVideoAction();
    if (callback) {
      callback(event);
    }
  }

  /**
   * Handle tab header context menu actions (e.g., delete tab, rename tab)
   */
  handleHeaderAction(event: { action: string; weekLabel: string }) {
    const { action, weekLabel } = event;

    switch (action) {
      case 'deleteTab':
        this.deleteTabByName(weekLabel);
        break;
      case 'renameTab':
        this.openRenameDialog(weekLabel);
        break;
      case 'openAllInScout':
        this.openAllInScout(weekLabel);
        break;
      default:
        console.warn('Unknown tab header action:', action);
    }
  }

  // ── Scoped single-collection header actions ────────────────────────────

  openActiveInScout() {
    const active = this.activeCollection();
    if (active) this.openAllInScout(active.name);
  }

  renameActive() {
    const active = this.activeCollection();
    if (active) this.openRenameDialog(active.name);
  }

  async deleteActive() {
    const active = this.activeCollection();
    if (!active) return;
    await this.deleteTabByName(active.name);
    // If the scoped collection is gone, fall back to the all-collections view.
    if (!this.allTabs().some(t => t.id === active.id)) {
      this.router.navigate(['/collections']);
    }
  }

  backToAll() {
    this.router.navigate(['/collections']);
  }

  /**
   * Open every video in this collection in Scout, in display order — the
   * run-of-show flow (each video becomes an editor tab).
   */
  openAllInScout(tabName: string) {
    const week = this.tabWeeks().find(w => w.weekLabel === tabName);
    const videos = week?.videos ?? [];
    if (videos.length === 0) {
      this.notificationService.info('Empty Collection', 'This collection has no videos to open');
      return;
    }
    const callback = this.onVideoAction();
    if (callback) {
      callback({ action: 'openInEditor', videos });
    }
  }

  /**
   * Open rename dialog for a tab
   */
  openRenameDialog(tabName: string) {
    const tab = this.allTabs().find(t => t.name === tabName);
    if (!tab) {
      this.notificationService.error('Collection Not Found', `Could not find collection "${tabName}"`);
      return;
    }

    this.tabDialogMode.set('rename');
    this.renamingTabName.set(tabName);
    this.renamingTabId.set(tab.id);
    this.newTabDialogOpen.set(true);
  }

  /**
   * Handle tab renamed
   */
  async onTabRenamed(newName: string) {
    try {
      const tabId = this.renamingTabId();
      const oldName = this.renamingTabName();

      if (!tabId) {
        this.notificationService.error('Error', 'No tab selected for renaming');
        return;
      }

      // Call the service to rename the tab
      await firstValueFrom(this.tabsService.updateTab(tabId, newName));

      // Clear local state immediately for UI reactivity
      this.allTabs.set([]);
      this.tabVideosMap.set(new Map());

      // Force fresh reload from backend
      await this.loadTabsData();

      this.notificationService.success('Collection Renamed', `Renamed "${oldName}" to "${newName}"`);
    } catch (error: any) {
      console.error('Failed to rename tab:', error);
      this.notificationService.error(
        'Failed to Rename Collection',
        error?.message || 'An error occurred while renaming the collection'
      );
    } finally {
      // Reset rename state
      this.tabDialogMode.set('create');
      this.renamingTabName.set('');
      this.renamingTabId.set('');
    }
  }

  /**
   * Handle preview requested
   */
  handlePreviewRequested(video: VideoItem) {
    const callback = this.onPreviewRequested();
    if (callback) {
      callback(video);
    }
  }

  /**
   * Delete a tab by its name
   */
  async deleteTabByName(tabName: string) {
    try {
      // Find the tab by name
      const tab = this.allTabs().find(t => t.name === tabName);
      if (!tab) {
        this.notificationService.error('Collection Not Found', `Could not find collection "${tabName}"`);
        return;
      }

      // Confirm deletion
      if (!confirm(`Are you sure you want to delete the collection "${tabName}"? Items will remain in your library.`)) {
        return;
      }

      // Delete the tab from backend
      await firstValueFrom(this.tabsService.deleteTab(tab.id));

      // Clear local state immediately for UI reactivity
      this.allTabs.set([]);
      this.tabVideosMap.set(new Map());

      // Force fresh reload from backend (bypass cache by calling loadTabs directly)
      const freshTabs = await firstValueFrom(this.tabsService.loadTabs());
      this.allTabs.set(freshTabs);

      // Load videos for each remaining tab
      const videosMap = new Map<string, VideoItem[]>();
      for (const remainingTab of freshTabs) {
        try {
          const videoRecords = await firstValueFrom(this.tabsService.getTabVideos(remainingTab.id));
          // Map backend video records to VideoItem format
          const videos: VideoItem[] = videoRecords.map((v: any) => ({
            id: v.id,
            name: v.filename,
            suggestedFilename: v.suggested_title || undefined,
            suggestedTitle: v.suggested_title || undefined,
            duration: v.duration_seconds ? `${String(Math.floor(v.duration_seconds / 3600)).padStart(2, '0')}:${String(Math.floor((v.duration_seconds % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(v.duration_seconds % 60)).padStart(2, '0')}` : undefined,
            size: v.file_size_bytes || undefined,
            uploadDate: v.upload_date ? new Date(v.upload_date) : undefined,
            downloadDate: v.download_date ? new Date(v.download_date) : undefined,
            lastProcessedDate: v.last_processed_date ? new Date(v.last_processed_date) : undefined,
            filePath: v.current_path,
            hasTranscript: v.has_transcript === 1,
            hasAnalysis: v.has_analysis === 1,
            aiDescription: v.ai_description || undefined,
            sourceUrl: v.source_url || undefined,
            mediaType: v.media_type || 'video',
            fileExtension: v.file_extension || undefined,
          }));
          videosMap.set(remainingTab.id, videos);
        } catch (error) {
          console.error(`Failed to load videos for tab ${remainingTab.id}:`, error);
          videosMap.set(remainingTab.id, []);
        }
      }
      this.tabVideosMap.set(videosMap);

      this.notificationService.success('Collection Deleted', `Collection "${tabName}" has been deleted`);
    } catch (error: any) {
      console.error('Failed to delete tab:', error);
      this.notificationService.error(
        'Failed to Delete Collection',
        error?.message || 'An error occurred while deleting the collection'
      );
    }
  }

  /**
   * Remove videos from the current tab
   */
  async removeVideosFromCurrentTab(videoIds: string[]) {
    try {
      if (videoIds.length === 0) return;

      // Remove only from the collection in view — never from every collection a
      // video happens to belong to. In the scoped single-collection view that's
      // the active collection; in the all-collections view there is no single
      // target, so we scope to the first collection the video is shown under
      // (its topmost week) rather than stripping it from all of them.
      const active = this.activeCollection();
      const weeks = this.tabWeeks();
      const videoTabMap = new Map<string, string>(); // videoId -> single target tabId

      for (const week of weeks) {
        const tab = this.allTabs().find(t => t.name === week.weekLabel);
        if (!tab) continue;
        if (active && tab.id !== active.id) continue;
        for (const video of week.videos) {
          if (videoIds.includes(video.id) && !videoTabMap.has(video.id)) {
            videoTabMap.set(video.id, tab.id);
          }
        }
      }

      // Remove each video from its single scoped collection
      for (const [videoId, tabId] of videoTabMap.entries()) {
        await firstValueFrom(this.tabsService.removeVideoFromTab(tabId, videoId));
      }

      // Clear the current tabs to force reactivity
      this.allTabs.set([]);
      this.tabVideosMap.set(new Map());

      // Reload tabs with fresh data
      await this.loadTabsData();

      const videoText = videoIds.length === 1 ? '1 video' : `${videoIds.length} videos`;
      this.notificationService.success('Removed from Collection', `Removed ${videoText} from collection`);
    } catch (error: any) {
      console.error('Failed to remove videos from tab:', error);
      this.notificationService.error(
        'Failed to Remove from Collection',
        error?.message || 'An error occurred while removing videos from the collection'
      );
    }
  }

  /**
   * Handle videos moved between tabs via drag-and-drop
   */
  async handleVideoMovedToTab(event: { videoIds: string[]; sourceTabName: string; targetTabName: string }) {
    const { videoIds, sourceTabName, targetTabName } = event;

    try {
      // Find the source and target tabs by name
      const sourceTab = this.allTabs().find(t => t.name === sourceTabName);
      const targetTab = this.allTabs().find(t => t.name === targetTabName);

      if (!sourceTab || !targetTab) {
        this.notificationService.error('Error', 'Could not find source or target tab');
        return;
      }

      // Add to the target FIRST — if this fails the videos are still safe in the
      // source. Only once the add succeeds do we remove them from the source, so
      // a partial failure can never drop the videos from both collections.
      await firstValueFrom(this.tabsService.addVideosToTab(targetTab.id, videoIds));

      // Remove videos from source tab
      for (const videoId of videoIds) {
        await firstValueFrom(this.tabsService.removeVideoFromTab(sourceTab.id, videoId));
      }

      // Reload tabs data
      await this.loadTabsData();

      // Show success notification
      const videoText = videoIds.length === 1 ? '1 video' : `${videoIds.length} videos`;
      this.notificationService.success(
        'Videos Moved',
        `Moved ${videoText} from "${sourceTabName}" to "${targetTabName}"`
      );
    } catch (error: any) {
      console.error('Failed to move videos between tabs:', error);
      this.notificationService.error(
        'Failed to Move Videos',
        error?.message || 'An error occurred while moving videos'
      );
      // Reload to ensure UI is in sync
      await this.loadTabsData();
    }
  }

  /**
   * Add videos to an existing tab
   */
  async addVideosToTab(tabId: string, videoIds: string[]) {
    try {
      const result = await firstValueFrom(this.tabsService.addVideosToTab(tabId, videoIds));

      // Get tab info to show in notification
      const tab = await firstValueFrom(this.tabsService.getTabById(tabId));

      // Show success notification
      const addedCount = result.addedCount || 0;
      const totalCount = result.totalCount || videoIds.length;
      const alreadyInTab = totalCount - addedCount;

      let message = '';
      if (addedCount > 0 && alreadyInTab > 0) {
        message = `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}". ${alreadyInTab} already in it.`;
      } else if (addedCount > 0) {
        message = `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}"`;
      } else {
        message = `All videos already in "${tab.name}"`;
      }

      this.notificationService.success('Added to Collection', message);
    } catch (error: any) {
      console.error('Failed to add videos to tab:', error);
      this.notificationService.error(
        'Failed to Add to Collection',
        error?.message || 'An error occurred while adding videos to the collection'
      );
    }
  }

  /**
   * Open new tab dialog with pending videos
   */
  openNewTabDialog(videoIds: string[]) {
    this.tabDialogMode.set('create');
    this.renamingTabName.set('');
    this.renamingTabId.set('');
    this.pendingTabVideos.set(videoIds);
    this.newTabDialogOpen.set(true);
  }

  /**
   * Handle creating a new tab and adding pending videos to it
   */
  async onTabCreated(tabName: string) {
    try {
      const videoIds = this.pendingTabVideos();

      // Create the tab
      const result = await firstValueFrom(this.tabsService.createTab(tabName));

      // If there are videos to add, add them to the tab
      if (videoIds.length > 0) {
        await firstValueFrom(this.tabsService.addVideosToTab(result.id, videoIds));

        // Show success notification with video count
        const videoCount = videoIds.length;
        const videoText = videoCount === 1 ? '1 video' : `${videoCount} videos`;
        this.notificationService.success(
          'Collection Created',
          `Created "${tabName}" with ${videoText}`
        );
      } else {
        // Show success notification for empty tab
        this.notificationService.success(
          'Collection Created',
          `Created empty collection "${tabName}"`
        );
      }

      // Clear pending videos
      this.pendingTabVideos.set([]);

      // Reload tabs
      await this.loadTabsData();
    } catch (error: any) {
      console.error('Failed to create tab:', error);
      this.notificationService.error(
        'Failed to Create Collection',
        error?.message || 'An error occurred while creating the collection'
      );
    }
  }
}
