import { Component, signal, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { CascadeComponent } from '../cascade/cascade.component';
import { NewTabDialogComponent } from '../new-tab-dialog/new-tab-dialog.component';
import { VideoWeek, VideoItem } from '../../models/video.model';
import { TabsService } from '../../services/tabs.service';
import { NotificationService } from '../../services/notification.service';

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

  // Input: callbacks for parent coordination
  onSelectionChanged = input<(event: { count: number; ids: Set<string> }) => void>();
  onVideoAction = input<(event: { action: string; videos: VideoItem[] }) => void>();
  onPreviewRequested = input<(video: VideoItem) => void>();

  // Tabs state
  allTabs = signal<any[]>([]);
  tabVideosMap = signal<Map<string, VideoItem[]>>(new Map());

  // New tab dialog
  newTabDialogOpen = signal(false);
  pendingTabVideos = signal<string[]>([]);

  // Computed property for tab weeks
  tabWeeks = computed<VideoWeek[]>(() => {
    const tabs = this.allTabs();
    const videosMap = this.tabVideosMap();

    return tabs.map(tab => ({
      weekLabel: tab.name,
      videos: videosMap.get(tab.id) || []
    }));
  });

  /**
   * Initialize and load tabs data
   */
  async ngOnInit() {
    await this.loadTabsData();
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
            duration: v.duration_seconds ? `${Math.floor(v.duration_seconds / 3600)}:${String(Math.floor((v.duration_seconds % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(v.duration_seconds % 60)).padStart(2, '0')}` : undefined,
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
    } catch (error) {
      console.error('Failed to load tabs:', error);
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
   * Handle tab header context menu actions (e.g., delete tab)
   */
  handleHeaderAction(event: { action: string; weekLabel: string }) {
    const { action, weekLabel } = event;

    switch (action) {
      case 'deleteTab':
        this.deleteTabByName(weekLabel);
        break;
      default:
        console.warn('Unknown tab header action:', action);
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
        this.notificationService.error('Tab Not Found', `Could not find tab "${tabName}"`);
        return;
      }

      // Confirm deletion
      if (!confirm(`Are you sure you want to delete the tab "${tabName}"? Videos will remain in your library.`)) {
        return;
      }

      // Delete the tab
      await firstValueFrom(this.tabsService.deleteTab(tab.id));

      // Clear the current tabs to force reactivity
      this.allTabs.set([]);
      this.tabVideosMap.set(new Map());

      // Reload tabs with fresh data
      await this.loadTabsData();

      this.notificationService.success('Tab Deleted', `Tab "${tabName}" has been deleted`);
    } catch (error: any) {
      console.error('Failed to delete tab:', error);
      this.notificationService.error(
        'Failed to Delete Tab',
        error?.message || 'An error occurred while deleting the tab'
      );
    }
  }

  /**
   * Remove videos from the current tab
   */
  async removeVideosFromCurrentTab(videoIds: string[]) {
    try {
      if (videoIds.length === 0) return;

      // Find which tab(s) these videos belong to by checking the tabWeeks
      const weeks = this.tabWeeks();
      const videoTabMap = new Map<string, string[]>(); // videoId -> tabIds

      weeks.forEach(week => {
        const tab = this.allTabs().find(t => t.name === week.weekLabel);
        if (tab) {
          week.videos.forEach(video => {
            if (videoIds.includes(video.id)) {
              if (!videoTabMap.has(video.id)) {
                videoTabMap.set(video.id, []);
              }
              videoTabMap.get(video.id)!.push(tab.id);
            }
          });
        }
      });

      // Remove videos from their tabs
      for (const [videoId, tabIds] of videoTabMap.entries()) {
        for (const tabId of tabIds) {
          await firstValueFrom(this.tabsService.removeVideoFromTab(tabId, videoId));
        }
      }

      // Clear the current tabs to force reactivity
      this.allTabs.set([]);
      this.tabVideosMap.set(new Map());

      // Reload tabs with fresh data
      await this.loadTabsData();

      const videoText = videoIds.length === 1 ? '1 video' : `${videoIds.length} videos`;
      this.notificationService.success('Removed from Tab', `Removed ${videoText} from tab`);
    } catch (error: any) {
      console.error('Failed to remove videos from tab:', error);
      this.notificationService.error(
        'Failed to Remove from Tab',
        error?.message || 'An error occurred while removing videos from the tab'
      );
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
        message = `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}". ${alreadyInTab} already in tab.`;
      } else if (addedCount > 0) {
        message = `Added ${addedCount} video${addedCount !== 1 ? 's' : ''} to "${tab.name}"`;
      } else {
        message = `All videos already in "${tab.name}"`;
      }

      this.notificationService.success('Videos Added to Tab', message);
    } catch (error: any) {
      console.error('Failed to add videos to tab:', error);
      this.notificationService.error(
        'Failed to Add to Tab',
        error?.message || 'An error occurred while adding videos to the tab'
      );
    }
  }

  /**
   * Open new tab dialog with pending videos
   */
  openNewTabDialog(videoIds: string[]) {
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
          'Tab Created',
          `Created "${tabName}" with ${videoText}`
        );
      } else {
        // Show success notification for empty tab
        this.notificationService.success(
          'Tab Created',
          `Created empty tab "${tabName}"`
        );
      }

      // Clear pending videos
      this.pendingTabVideos.set([]);

      // Reload tabs
      await this.loadTabsData();
    } catch (error: any) {
      console.error('Failed to create tab:', error);
      this.notificationService.error(
        'Failed to Create Tab',
        error?.message || 'An error occurred while creating the tab'
      );
    }
  }
}
