import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TabsService, VideoTab } from '../../services/tabs.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import {
  ListItem,
  ItemDisplayConfig,
  GroupConfig,
  ContextMenuAction,
  SelectionMode,
} from '../../libs/cascade/src/lib/types/cascade.types';

interface VideoWithListItem extends ListItem {
  id: string;
  filename: string;
  duration_seconds?: number;
  media_type?: string;
  added_at: string;
  tab_added_at?: string;
  current_path?: string;
}

@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatDialogModule,
    MatSnackBarModule,
    MatDividerModule,
    MatTooltipModule,
    CascadeListComponent,
  ],
  templateUrl: './tabs.component.html',
  styleUrl: './tabs.component.scss'
})
export class TabsComponent implements OnInit, OnDestroy {
  loading = true;
  tabs: VideoTab[] = [];
  allVideos: VideoWithListItem[] = [];
  backendUrl = '';
  selectionMode = SelectionMode.Multiple;

  // Cascade configuration
  listDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'added_at',
    metadataField: 'duration_seconds',
    iconField: 'media_type',
    renderPrimary: (item) => this.getVideoDisplayName(item as any),
    renderSecondary: (item) => this.formatVideoSecondaryText(item as any),
    renderMetadata: (item) => this.formatVideoDuration(item as any),
    renderIcon: (item) => this.getMediaIcon(item as any)
  };

  listGroupConfig: GroupConfig<VideoWithListItem> = {
    enabled: true,
    groupBy: (item) => this.getVideoTabName(item),
    groupLabel: (key) => key,
    sortDescending: false
  };

  listContextMenuActions: ContextMenuAction[] = [
    { id: 'open', label: 'Open in Video Editor', icon: 'play_arrow' },
    { id: 'openQuickTime', label: 'Open in QuickTime Player', icon: 'play_circle' },
    { id: 'openLocation', label: 'Open File Location', icon: 'folder_open' },
    { id: 'divider1', label: '', divider: true },
    { id: 'removeFromTab', label: 'Remove from Tab', icon: 'remove_circle_outline' }
  ];

  // Map video IDs to tab IDs for grouping
  private videoTabMap = new Map<string, string>();
  private tabNameMap = new Map<string, string>();

  constructor(
    private tabsService: TabsService,
    private backendUrlService: BackendUrlService,
    private router: Router,
    private dialog: MatDialog,
    private snackBar: MatSnackBar
  ) {}

  async ngOnInit() {
    this.backendUrl = await this.backendUrlService.getBackendUrl();
    await this.loadTabsAndVideos();
  }

  ngOnDestroy() {}

  async loadTabsAndVideos() {
    this.loading = true;
    try {
      // Load all tabs
      this.tabs = await this.tabsService.loadTabs();

      // Load videos for each tab
      this.allVideos = [];
      this.videoTabMap.clear();
      this.tabNameMap.clear();

      for (const tab of this.tabs) {
        this.tabNameMap.set(tab.id, tab.name);
        const videos = await this.tabsService.getTabVideos(tab.id);

        for (const video of videos) {
          // Convert to ListItem format
          const videoWithListItem: VideoWithListItem = {
            ...video,
            _itemId: video.id,
          };
          this.allVideos.push(videoWithListItem);
          this.videoTabMap.set(video.id, tab.id);
        }
      }

    } catch (error) {
      console.error('Failed to load tabs and videos:', error);
      this.snackBar.open('Failed to load tabs', 'Close', { duration: 3000 });
    } finally {
      this.loading = false;
    }
  }

  getVideoTabName(video: VideoWithListItem): string {
    const tabId = this.videoTabMap.get(video.id);
    return tabId ? this.tabNameMap.get(tabId) || 'Unknown Tab' : 'Unknown Tab';
  }

  getVideoDisplayName(video: any): string {
    return video.filename || 'Unknown';
  }

  formatVideoSecondaryText(video: any): string {
    if (video.tab_added_at) {
      const date = new Date(video.tab_added_at);
      return `Added ${date.toLocaleDateString()}`;
    }
    return '';
  }

  formatVideoDuration(video: any): string {
    if (!video.duration_seconds) return '';

    const hours = Math.floor(video.duration_seconds / 3600);
    const minutes = Math.floor((video.duration_seconds % 3600) / 60);
    const seconds = Math.floor(video.duration_seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  getMediaIcon(video: any): string {
    if (video.media_type === 'audio') return 'audiotrack';
    if (video.media_type === 'video') return 'videocam';
    if (video.media_type === 'image') return 'image';
    if (video.media_type === 'document') return 'description';
    return 'insert_drive_file';
  }

  onListContextMenuAction(event: { action: string; items: VideoWithListItem[] }) {
    switch (event.action) {
      case 'open':
        if (event.items.length > 0) {
          this.openVideoPlayer(event.items[0]);
        }
        break;
      case 'openQuickTime':
        if (event.items.length > 0) {
          this.openInQuickTime(event.items[0]);
        }
        break;
      case 'openLocation':
        if (event.items.length > 0) {
          this.openFileLocation(event.items[0]);
        }
        break;
      case 'removeFromTab':
        if (event.items.length > 0) {
          this.removeVideoFromTab(event.items[0]);
        }
        break;
    }
  }


  async openVideoPlayer(video: VideoWithListItem) {
    this.router.navigate(['/video-editor'], {
      queryParams: { videoId: video.id }
    });
  }

  async openFileLocation(video: VideoWithListItem) {
    if (video.current_path) {
      try {
        const response = await fetch(`${this.backendUrl}/api/path/open-location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: video.current_path })
        });

        if (!response.ok) {
          throw new Error('Failed to open file location');
        }
      } catch (error) {
        console.error('Error opening file location:', error);
        this.snackBar.open('Failed to open file location', 'Close', { duration: 3000 });
      }
    }
  }

  async removeVideoFromTab(video: VideoWithListItem) {
    const tabId = this.videoTabMap.get(video.id);
    if (!tabId) return;

    try {
      await this.tabsService.removeVideoFromTab(tabId, video.id);
      this.snackBar.open('Video removed from tab', 'Close', { duration: 2000 });
      await this.loadTabsAndVideos();
    } catch (error) {
      console.error('Failed to remove video from tab:', error);
      this.snackBar.open('Failed to remove video from tab', 'Close', { duration: 3000 });
    }
  }

  async openInQuickTime(video: VideoWithListItem) {
    if (!video.current_path) {
      this.snackBar.open('File path not available', 'Close', { duration: 3000 });
      return;
    }

    try {
      const result = await (window as any).electron?.openInQuickTime(video.current_path);
      if (result && !result.success) {
        throw new Error(result.error || 'Failed to open in QuickTime');
      }
    } catch (error) {
      console.error('Error opening in QuickTime:', error);
      this.snackBar.open('Failed to open in QuickTime Player', 'Close', { duration: 3000 });
    }
  }

  async createNewTab() {
    const name = prompt('Enter tab name:');
    if (!name || name.trim() === '') return;

    try {
      await this.tabsService.createTab(name.trim());
      this.snackBar.open(`Created tab "${name.trim()}"`, 'Close', { duration: 2000 });
      await this.loadTabsAndVideos();
    } catch (error) {
      console.error('Failed to create tab:', error);
      this.snackBar.open('Failed to create tab', 'Close', { duration: 3000 });
    }
  }

  async renameTab(tab: VideoTab) {
    const name = prompt('Enter new tab name:', tab.name);
    if (!name || name.trim() === '' || name.trim() === tab.name) return;

    try {
      await this.tabsService.updateTab(tab.id, name.trim());
      this.snackBar.open('Tab renamed', 'Close', { duration: 2000 });
      await this.loadTabsAndVideos();
    } catch (error) {
      console.error('Failed to rename tab:', error);
      this.snackBar.open('Failed to rename tab', 'Close', { duration: 3000 });
    }
  }

  async deleteTab(tab: VideoTab) {
    if (!confirm(`Are you sure you want to delete the tab "${tab.name}"? This will not delete the videos themselves.`)) {
      return;
    }

    try {
      await this.tabsService.deleteTab(tab.id);
      this.snackBar.open('Tab deleted', 'Close', { duration: 2000 });
      await this.loadTabsAndVideos();
    } catch (error) {
      console.error('Failed to delete tab:', error);
      this.snackBar.open('Failed to delete tab', 'Close', { duration: 3000 });
    }
  }
}
