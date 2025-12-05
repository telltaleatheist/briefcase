import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, takeUntil, firstValueFrom } from 'rxjs';
import { SavedLinksService, SavedLink } from '../../services/saved-links.service';
import { LibraryService } from '../../services/library.service';
import { ElectronService } from '../../services/electron.service';
import { NotificationService } from '../../services/notification.service';
import { TabsService } from '../../services/tabs.service';
import { CascadeComponent } from '../cascade/cascade.component';
import { AddToTabsDialogComponent, AddToTabsResult } from '../add-to-tabs-dialog/add-to-tabs-dialog.component';
import { VideoItem, VideoWeek, ChildrenConfig, VideoChild } from '../../models/video.model';

@Component({
  selector: 'app-save-for-later-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, CascadeComponent, AddToTabsDialogComponent],
  templateUrl: './save-for-later-tab.component.html',
  styleUrls: ['./save-for-later-tab.component.scss']
})
export class SaveForLaterTabComponent implements OnInit, OnDestroy {
  private savedLinksService = inject(SavedLinksService);
  private libraryService = inject(LibraryService);
  private electronService = inject(ElectronService);
  private notificationService = inject(NotificationService);
  private tabsService = inject(TabsService);

  private destroy$ = new Subject<void>();

  // Expose Array for template
  Array = Array;

  // State
  savedLinks = signal<SavedLink[]>([]);
  urlInput = signal('');
  shouldDownload = signal(true);
  isLoading = signal(false);

  // Selection state
  selectedItems = signal<Set<string>>(new Set());
  highlightedItemId = signal<string | null>(null);

  // Dialog state
  addToTabsDialogOpen = signal(false);
  pendingItemIds = signal<string[]>([]);

  // Children config for showing download task
  childrenConfig: ChildrenConfig = {
    enabled: true,
    expandable: true,
    defaultExpanded: false,
    showMasterProgress: false,
    showStatus: true,
    clickable: false,
    generator: (video: VideoItem) => this.generateDownloadChild(video)
  };

  // Convert saved links to VideoWeek format for cascade
  savedWeeks = computed(() => {
    const links = this.savedLinks();
    console.log('[SaveForLater] savedWeeks computed - links:', links.length, links);

    if (links.length === 0) {
      console.log('[SaveForLater] No links, returning empty array');
      return [];
    }

    // Group by status
    const pending = links.filter(l => l.status === 'pending' || l.status === 'downloading');
    const completed = links.filter(l => l.status === 'completed');
    const failed = links.filter(l => l.status === 'failed');

    console.log('[SaveForLater] Status groups - pending:', pending.length, 'completed:', completed.length, 'failed:', failed.length);

    const weeks: VideoWeek[] = [];

    if (pending.length > 0) {
      const videos = pending.map(l => this.linkToVideoItem(l));
      console.log('[SaveForLater] Adding Downloading week with', videos.length, 'videos:', videos);
      weeks.push({
        weekLabel: 'Downloading',
        videos: videos
      });
    }

    if (completed.length > 0) {
      const videos = completed.map(l => this.linkToVideoItem(l));
      console.log('[SaveForLater] Adding Ready to Add week with', videos.length, 'videos:', videos);
      weeks.push({
        weekLabel: 'Ready to Add',
        videos: videos
      });
    }

    if (failed.length > 0) {
      const videos = failed.map(l => this.linkToVideoItem(l));
      console.log('[SaveForLater] Adding Failed week with', videos.length, 'videos:', videos);
      weeks.push({
        weekLabel: 'Failed',
        videos: videos
      });
    }

    console.log('[SaveForLater] Returning weeks:', weeks.length, weeks);
    return weeks;
  });

  // Stats
  stats = computed(() => {
    const links = this.savedLinks();
    return {
      total: links.length,
      pending: links.filter(l => l.status === 'pending').length,
      downloading: links.filter(l => l.status === 'downloading').length,
      completed: links.filter(l => l.status === 'completed').length,
      failed: links.filter(l => l.status === 'failed').length
    };
  });

  ngOnInit(): void {
    this.loadSavedLinks();

    // Subscribe to real-time updates
    this.savedLinksService.savedLinks$.pipe(
      takeUntil(this.destroy$)
    ).subscribe(links => {
      this.savedLinks.set(links);
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Load all saved links from the backend
   */
  private loadSavedLinks(): void {
    this.isLoading.set(true);
    this.savedLinksService.getAllLinks().subscribe({
      next: (links) => {
        this.savedLinks.set(links);
        this.isLoading.set(false);
      },
      error: (error) => {
        console.error('Failed to load saved links:', error);
        this.notificationService.error('Error', 'Failed to load saved links');
        this.isLoading.set(false);
      }
    });
  }

  /**
   * Convert SavedLink to VideoItem for display in cascade
   */
  private linkToVideoItem(link: SavedLink): VideoItem {
    // Build a proper display name
    const displayName = this.buildDisplayName(link);

    // Build tags based on status
    const tags: string[] = ['saved-link'];

    // Add status-based tags
    if (link.status === 'downloading') {
      tags.push('downloading');
    } else if (link.status === 'completed') {
      tags.push('download-complete');
    } else if (link.status === 'failed') {
      tags.push('download-failed');
    } else if (link.status === 'pending') {
      tags.push('pending');
    }

    // Add webpage tag if it's a reference link (has title but no download)
    if (link.metadata?.is_webpage) {
      tags.push('webpage');
    }

    const baseItem: VideoItem = {
      id: link.id,
      name: displayName,
      duration: undefined,
      filePath: link.download_path || undefined,
      uploadDate: link.date_added ? new Date(link.date_added) : undefined,
      tags: tags,
      hasTranscript: false,
      hasAnalysis: false,
      thumbnailUrl: link.thumbnail_path || undefined,
      suggestedTitle: undefined,
      aiDescription: undefined,
      fileExtension: link.download_path ? this.getFileExtension(link.download_path) : undefined,
      mediaType: link.metadata?.is_webpage ? 'text/html' : 'video/mp4',
      // Store the original URL for context menu "Open URL" action
      sourceUrl: link.url
    };

    return baseItem;
  }

  /**
   * Build a display name for a saved link
   * - If user provided a title, use it as-is (for reference links)
   * - Otherwise generate a hash-based filename (for downloads)
   */
  private buildDisplayName(link: SavedLink): string {
    // If user provided a title, use it directly (don't sanitize - it's for display)
    if (link.title) {
      return link.title;
    }

    // Generate a hash-based name from URL for downloads without titles
    const hash = this.generateHash(link.url + (link.date_added || ''));
    return `download-${hash}`;
  }

  /**
   * Generate download child item for cascade expansion
   */
  private generateDownloadChild(video: VideoItem): VideoChild[] {
    // Only show download child for items that are downloading or have completed/failed
    const isDownloading = video.tags?.includes('downloading');
    const isComplete = video.tags?.includes('download-complete');
    const isFailed = video.tags?.includes('download-failed');
    const isPending = video.tags?.includes('pending');

    // Don't show child for webpage-only items
    if (video.tags?.includes('webpage') && !isDownloading && !isComplete && !isFailed) {
      return [];
    }

    // Determine status
    let status: 'pending' | 'active' | 'completed' | 'failed' = 'pending';
    if (isDownloading) status = 'active';
    else if (isComplete) status = 'completed';
    else if (isFailed) status = 'failed';
    else if (isPending) status = 'pending';

    // Create download child
    const downloadChild: VideoChild = {
      id: `${video.id}-download`,
      parentId: video.id,
      label: 'Download',
      icon: '⬇️',
      status: status,
      progress: isDownloading ? { value: 0, indeterminate: true } : undefined
    };

    return [downloadChild];
  }

  /**
   * Generate a short hash from a string
   */
  private generateHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to hex and take first 12 chars
    return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 12);
  }

  /**
   * Get file extension from path
   */
  private getFileExtension(path: string): string {
    const lastDot = path.lastIndexOf('.');
    return lastDot > 0 ? path.substring(lastDot) : '';
  }

  /**
   * Submit URL to save
   */
  onUrlSubmit(): void {
    const url = this.urlInput().trim();
    if (!url) return;

    const currentLibrary = this.libraryService.currentLibrary();
    if (!currentLibrary) {
      this.notificationService.error('Error', 'No library selected');
      return;
    }

    this.savedLinksService.addLink(
      url,
      undefined, // Let backend extract title
      currentLibrary.id,
      this.shouldDownload()
    ).subscribe({
      next: (link) => {
        this.notificationService.success('Success', `Added: ${link.title || link.url}`);
        this.urlInput.set('');
      },
      error: (error) => {
        console.error('Failed to add link:', error);
        this.notificationService.error('Error', 'Failed to add link');
      }
    });
  }

  /**
   * Add a saved link to the library (move from _pending to date folder)
   */
  addToLibrary(linkId: string): void {
    this.savedLinksService.addToLibrary(linkId).subscribe({
      next: (result) => {
        if (result.success) {
          this.notificationService.success('Success', result.message || 'Added to library');
          // Link will be removed from list via WebSocket event
        } else {
          this.notificationService.error('Error', result.error || 'Failed to add to library');
        }
      },
      error: (error) => {
        console.error('Failed to add to library:', error);
        this.notificationService.error('Error', 'Failed to add to library');
      }
    });
  }

  /**
   * Delete a saved link
   */
  deleteLink(linkId: string): void {
    this.savedLinksService.deleteLink(linkId).subscribe({
      next: () => {
        this.notificationService.success('Success', 'Link deleted');
        // Link will be removed from list via WebSocket event
      },
      error: (error) => {
        console.error('Failed to delete link:', error);
        this.notificationService.error('Error', 'Failed to delete link');
      }
    });
  }

  /**
   * Open link in browser
   */
  async openInBrowser(url: string): Promise<void> {
    try {
      await this.electronService.openExternal(url);
    } catch (error) {
      console.error('Failed to open URL:', error);
      this.notificationService.error('Error', 'Failed to open URL');
    }
  }

  /**
   * Retry a failed download
   */
  retryDownload(linkId: string): void {
    this.savedLinksService.retryLink(linkId).subscribe({
      next: () => {
        this.notificationService.success('Success', 'Download restarted');
      },
      error: (error) => {
        console.error('Failed to retry download:', error);
        this.notificationService.error('Error', 'Failed to retry download');
      }
    });
  }

  /**
   * Handle cascade selection changes
   */
  onSelectionChanged(event: { count: number; ids: Set<string> }): void {
    this.selectedItems.set(event.ids);
  }

  /**
   * Handle video action from cascade (used for context menu)
   */
  onVideoAction(event: { action: string; videos: VideoItem[] }): void {
    const videoIds = event.videos.map(v => v.id);

    switch (event.action) {
      case 'add-to-library':
        // Add to library only
        this.addMultipleToLibrary(videoIds);
        break;
      case 'add-to-library-and-tabs':
        // Open dialog for adding to library and/or tabs
        this.openAddToTabsDialog(videoIds);
        break;
      case 'open':
        event.videos.forEach(video => {
          const link = this.savedLinks().find(l => l.id === video.id);
          if (link) this.openInBrowser(link.url);
        });
        break;
      case 'retry':
        event.videos.forEach(video => {
          const link = this.savedLinks().find(l => l.id === video.id);
          if (link) this.retryDownload(link.id);
        });
        break;
      case 'delete':
        event.videos.forEach(video => {
          const link = this.savedLinks().find(l => l.id === video.id);
          if (link) this.deleteLink(link.id);
        });
        break;
    }
  }

  /**
   * Get context menu actions for an item
   */
  getContextMenuActions(link: SavedLink): string[] {
    const actions: string[] = [];

    if (link.status === 'completed' && link.download_path) {
      actions.push('add-to-library');
      actions.push('add-to-library-and-tabs');
    }

    actions.push('open'); // Always allow opening URL

    if (link.status === 'failed') {
      actions.push('retry');
    }

    actions.push('delete');

    return actions;
  }

  /**
   * Clear all completed links
   */
  clearCompleted(): void {
    const completed = this.savedLinks().filter(l => l.status === 'completed');
    completed.forEach(link => {
      this.deleteLink(link.id);
    });
  }

  /**
   * Clear all failed links
   */
  clearFailed(): void {
    const failed = this.savedLinks().filter(l => l.status === 'failed');
    failed.forEach(link => {
      this.deleteLink(link.id);
    });
  }

  /**
   * Add multiple saved links to library
   */
  async addMultipleToLibrary(linkIds: string[]): Promise<void> {
    let successCount = 0;
    let errorCount = 0;

    for (const linkId of linkIds) {
      try {
        const result = await firstValueFrom(this.savedLinksService.addToLibrary(linkId));
        if (result.success) {
          successCount++;
        } else {
          errorCount++;
        }
      } catch (error) {
        console.error(`Failed to add link ${linkId} to library:`, error);
        errorCount++;
      }
    }

    // Show notification
    if (successCount > 0 && errorCount === 0) {
      this.notificationService.success('Success', `Added ${successCount} item${successCount > 1 ? 's' : ''} to library`);
    } else if (successCount > 0 && errorCount > 0) {
      this.notificationService.warning('Partial Success', `Added ${successCount} item${successCount > 1 ? 's' : ''}, ${errorCount} failed`);
    } else {
      this.notificationService.error('Error', 'Failed to add items to library');
    }
  }

  /**
   * Open the add to tabs dialog
   */
  openAddToTabsDialog(linkIds: string[]): void {
    if (linkIds.length === 0) {
      return;
    }

    // Debug: log the IDs and check if they exist in savedLinks
    console.log('[AddToTabs] Opening dialog with IDs:', linkIds);
    console.log('[AddToTabs] Current savedLinks:', this.savedLinks().map(l => ({ id: l.id, title: l.title, status: l.status })));

    // Store all selected IDs - filtering happens on confirm
    this.pendingItemIds.set(linkIds);
    this.addToTabsDialogOpen.set(true);
  }

  /**
   * Handle adding selected items to library and tabs
   */
  onAddSelectedToLibraryAndTabs(): void {
    const selectedIds = Array.from(this.selectedItems());
    // Strip week label prefix if present (e.g., "Ready to Add|abc-123" -> "abc-123")
    const cleanIds = selectedIds.map(id => {
      const pipeIndex = id.indexOf('|');
      return pipeIndex !== -1 ? id.substring(pipeIndex + 1) : id;
    });
    this.openAddToTabsDialog(cleanIds);
  }

  /**
   * Handle add to tabs dialog confirmation
   */
  async onAddToTabsConfirm(result: AddToTabsResult): Promise<void> {
    console.log('[AddToTabs] onAddToTabsConfirm called with:', result);
    const linkIds = this.pendingItemIds();
    console.log('[AddToTabs] pendingItemIds:', linkIds);

    // Filter to only IDs that still exist in our saved links
    const currentLinks = this.savedLinks();
    console.log('[AddToTabs] currentLinks count:', currentLinks.length);
    const validLinkIds = linkIds.filter(id => currentLinks.some(l => l.id === id));
    console.log('[AddToTabs] validLinkIds:', validLinkIds);

    if (validLinkIds.length === 0) {
      this.notificationService.warning('Items Not Found', 'The selected items may have already been processed');
      this.pendingItemIds.set([]);
      return;
    }

    try {
      // Track video IDs for items added to library
      const importedVideoIds: string[] = [];

      // Step 1: Add to library if requested (only for completed downloads)
      if (result.addToLibrary) {
        const completedLinkIds = validLinkIds.filter(id => {
          const link = currentLinks.find(l => l.id === id);
          return link && link.status === 'completed';
        });

        let librarySuccessCount = 0;
        let libraryFailCount = 0;

        for (const linkId of completedLinkIds) {
          try {
            const addResult = await firstValueFrom(this.savedLinksService.addToLibrary(linkId));
            if (addResult.success) {
              librarySuccessCount++;
              // Track the video ID for adding to tabs
              if (addResult.videoId) {
                importedVideoIds.push(addResult.videoId);
              }
            } else {
              libraryFailCount++;
            }
          } catch (error) {
            console.error(`Failed to add link ${linkId} to library:`, error);
            libraryFailCount++;
          }
        }

        // Show library result notification
        const skippedCount = validLinkIds.length - completedLinkIds.length;
        if (librarySuccessCount > 0) {
          let message = `${librarySuccessCount} item${librarySuccessCount > 1 ? 's' : ''} added to library`;
          if (skippedCount > 0) {
            message += ` (${skippedCount} still downloading)`;
          }
          this.notificationService.success('Added to Library', message);
        } else if (completedLinkIds.length === 0) {
          this.notificationService.info('Skipped Library', 'No completed downloads to add to library');
        } else if (libraryFailCount > 0) {
          this.notificationService.error('Failed', 'Could not add items to library');
        }
      }

      // Step 2: Add to tabs
      if (result.addToTabs) {
        console.log('[AddToTabs] Adding to tabs, tabIds from result:', result.tabIds);
        let tabIds = [...result.tabIds];

        // Create new tab if specified
        if (result.createNewTab) {
          console.log('[AddToTabs] Creating new tab:', result.createNewTab);
          try {
            const newTab = await firstValueFrom(this.tabsService.createTab(result.createNewTab));
            console.log('[AddToTabs] New tab created:', newTab);
            tabIds.push(newTab.id);
          } catch (error) {
            console.error('Failed to create new tab:', error);
            this.notificationService.error('Error', 'Failed to create new tab');
          }
        }

        console.log('[AddToTabs] Final tabIds to add to:', tabIds);
        console.log('[AddToTabs] Imported video IDs:', importedVideoIds);

        if (tabIds.length > 0) {
          let tabSuccessCount = 0;

          // If we imported to library, add the VIDEO IDs to tabs
          if (importedVideoIds.length > 0) {
            for (const tabId of tabIds) {
              try {
                console.log(`[AddToTabs] Adding videos to tab ${tabId}:`, importedVideoIds);
                const addResult = await firstValueFrom(this.tabsService.addVideosToTab(tabId, importedVideoIds));
                console.log(`[AddToTabs] Result for tab ${tabId}:`, addResult);
                if (addResult.success) {
                  tabSuccessCount++;
                }
              } catch (error) {
                console.error(`Failed to add videos to tab ${tabId}:`, error);
              }
            }
          } else {
            // Not adding to library - add saved links directly to tabs
            for (const tabId of tabIds) {
              try {
                console.log(`[AddToTabs] Adding saved links to tab ${tabId}:`, validLinkIds);
                const addResult = await firstValueFrom(this.tabsService.addSavedLinksToTab(tabId, validLinkIds));
                console.log(`[AddToTabs] Result for tab ${tabId}:`, addResult);
                if (addResult.success) {
                  tabSuccessCount++;
                }
              } catch (error) {
                console.error(`Failed to add links to tab ${tabId}:`, error);
              }
            }
          }

          if (tabSuccessCount > 0) {
            const itemCount = importedVideoIds.length > 0 ? importedVideoIds.length : validLinkIds.length;
            this.notificationService.success(
              'Added to Tabs',
              `${itemCount} item${itemCount > 1 ? 's' : ''} added to ${tabSuccessCount} tab${tabSuccessCount > 1 ? 's' : ''}`
            );
          }
        } else {
          console.log('[AddToTabs] No tabs to add to!');
        }
      } else {
        console.log('[AddToTabs] addToTabs is false, skipping tabs');
      }
    } catch (error) {
      console.error('Failed to process:', error);
      this.notificationService.error('Error', 'An error occurred');
    }

    // Clear pending items
    this.pendingItemIds.set([]);
  }

  /**
   * Handle dialog close
   */
  onAddToTabsDialogClosed(): void {
    this.addToTabsDialogOpen.set(false);
    this.pendingItemIds.set([]);
  }
}
