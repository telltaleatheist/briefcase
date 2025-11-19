import { Component, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy, computed, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { LibrarySearchFiltersComponent, LibraryFilters } from '../../components/library-search-filters/library-search-filters.component';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { VideoProcessingQueueComponent } from '../../components/video-processing-queue/video-processing-queue.component';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { VideoWeek, VideoItem } from '../../models/video.model';
import { Library, NewLibrary, RelinkLibrary } from '../../models/library.model';
import { LibraryService } from '../../services/library.service';
import { WebsocketService, TaskCompleted } from '../../services/websocket.service';
import { VideoProcessingService } from '../../services/video-processing.service';
import { VideoJobSettings } from '../../models/video-processing.model';

@Component({
  selector: 'app-library-page',
  standalone: true,
  imports: [
    CommonModule,
    LibrarySearchFiltersComponent,
    CascadeComponent,
    VideoProcessingQueueComponent,
    LibraryManagerModalComponent
  ],
  templateUrl: './library-page.component.html',
  styleUrls: ['./library-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LibraryPageComponent implements OnInit, OnDestroy {
  private libraryService = inject(LibraryService);
  private router = inject(Router);
  private websocketService = inject(WebsocketService);
  private videoProcessingService = inject(VideoProcessingService);

  @ViewChild(CascadeComponent) private videoLibraryComponent?: CascadeComponent;

  videoWeeks = signal<VideoWeek[]>([]);
  filteredWeeks = signal<VideoWeek[]>([]);

  // Queue state - now simplified since VideoProcessingService manages the queue
  queueExpanded = signal(false);

  // Library manager state
  libraryManagerOpen = signal(false);
  libraries = signal<Library[]>([]);
  currentLibrary = signal<Library | null>(null);

  // Selection state
  selectedCount = signal(0);
  selectedVideoIds = signal<Set<string>>(new Set());

  // Filters
  currentFilters: LibraryFilters | null = null;

  ngOnInit() {
    this.loadCurrentLibrary();
    this.loadLibraries();

    // Subscribe to task completions to refresh library when processing completes
    this.websocketService.connect();
    this.websocketService.onTaskCompleted((event: TaskCompleted) => {
      // Refresh library when a task completes
      if (event.type === 'analyze' || event.type === 'transcribe') {
        this.loadCurrentLibrary();
      }
    });

    // Check for navigation state to trigger analysis
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || history.state;

    if (state?.triggerAnalysis && state?.videoId) {
      // Wait for library to load, then add video to queue
      setTimeout(() => {
        this.addVideoToAnalysisQueue(state.videoId, state.videoName);
      }, 500);
    }
  }

  private addVideoToAnalysisQueue(videoId: string, videoName?: string) {
    // Find the video in the loaded library
    const allVideos = this.videoWeeks().flatMap(week => week.videos);
    const video = allVideos.find(v => v.id === videoId);

    if (video) {
      this.analyzeVideos([video]);
    } else {
      // Video not found in current view, create a minimal video item
      const minimalVideo: VideoItem = {
        id: videoId,
        name: videoName || 'Video',
        hasAnalysis: false
      };
      this.analyzeVideos([minimalVideo]);
    }
  }

  ngOnDestroy() {
    this.websocketService.disconnect();
  }

  loadLibrary() {
    console.log('Loading library videos...');
    this.libraryService.getVideosByWeek().subscribe({
      next: (response) => {
        console.log('Videos response:', response);
        if (response.success) {
          console.log('Setting video weeks:', response.data.length, 'weeks');
          this.videoWeeks.set(response.data);
          this.filteredWeeks.set(response.data);
        } else {
          console.warn('Response not successful:', response);
        }
      },
      error: (error) => {
        console.error('Failed to load library:', error);
        this.videoWeeks.set([]);
        this.filteredWeeks.set([]);
      }
    });
  }

  loadCurrentLibrary() {
    console.log('Loading current library...');
    this.libraryService.getCurrentLibrary().subscribe({
      next: (response) => {
        console.log('Current library response:', response);
        if (response.success && response.data) {
          this.currentLibrary.set(response.data);
          this.loadLibrary(); // Load videos for the current library
        } else {
          console.warn('No current library set, opening manager');
          this.openLibraryManager();
        }
      },
      error: (error) => {
        console.error('Failed to load current library:', error);
        // Open library manager if no library is set
        this.openLibraryManager();
      }
    });
  }

  loadLibraries() {
    this.libraryService.getLibraries().subscribe({
      next: (response) => {
        if (response.success) {
          this.libraries.set(response.data);
        }
      },
      error: (error) => {
        console.error('Failed to load libraries:', error);
      }
    });
  }

  openLibraryManager() {
    this.loadLibraries(); // Refresh libraries list
    this.libraryManagerOpen.set(true);
  }

  closeLibraryManager() {
    this.libraryManagerOpen.set(false);
  }

  onLibrarySelected(library: Library) {
    this.libraryService.switchLibrary(library.id).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Reload videos for new library
        }
      },
      error: (error) => {
        console.error('Failed to switch library:', error);
        alert('Failed to switch library. Please try again.');
      }
    });
  }

  onLibraryCreated(newLibrary: NewLibrary) {
    this.libraryService.createLibrary(newLibrary).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Load videos for new library
          this.loadLibraries(); // Refresh libraries list
        }
      },
      error: (error) => {
        console.error('Failed to create library:', error);
        alert('Failed to create library. Please try again.');
      }
    });
  }

  onLibraryRelinked(relink: RelinkLibrary) {
    this.libraryService.importLibrary(relink.path).subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
          this.closeLibraryManager();
          this.loadLibrary(); // Load videos for imported library
          this.loadLibraries(); // Refresh libraries list
        }
      },
      error: (error) => {
        console.error('Failed to import library:', error);
        const message = error.error?.error || 'Failed to import library. Make sure the folder contains a .library.db file.';
        alert(message);
      }
    });
  }

  onFiltersChanged(filters: LibraryFilters) {
    this.currentFilters = filters;
    this.applyFilters();
  }

  applyFilters() {
    if (!this.currentFilters) {
      this.filteredWeeks.set(this.videoWeeks());
      return;
    }

    // Use backend FTS search for search queries
    if (this.currentFilters.searchQuery) {
      const query = this.currentFilters.searchQuery.trim();

      if (query) {
        // Call backend FTS search
        this.libraryService.searchVideos(query).subscribe({
          next: (response) => {
            if (response.success && response.data) {
              // Group search results by week
              const searchResults = response.data;
              const weekMap = new Map<string, VideoItem[]>();

              // Get week labels from original data for grouping
              const originalWeeks = this.videoWeeks();
              const videoWeekMap = new Map<string, string>();

              originalWeeks.forEach(week => {
                week.videos.forEach(video => {
                  videoWeekMap.set(video.id, week.weekLabel);
                });
              });

              // Group search results by week
              searchResults.forEach(video => {
                const weekLabel = videoWeekMap.get(video.id) || 'Search Results';
                if (!weekMap.has(weekLabel)) {
                  weekMap.set(weekLabel, []);
                }
                weekMap.get(weekLabel)!.push(video);
              });

              // Convert map to VideoWeek array
              const filtered: VideoWeek[] = [];
              weekMap.forEach((videos, weekLabel) => {
                filtered.push({ weekLabel, videos });
              });

              // Sort by week label (most recent first)
              filtered.sort((a, b) => b.weekLabel.localeCompare(a.weekLabel));

              this.filteredWeeks.set(filtered);
            } else {
              this.filteredWeeks.set([]);
            }
          },
          error: (error) => {
            console.error('Search failed:', error);
            // Fall back to showing all videos on error
            this.filteredWeeks.set(this.videoWeeks());
          }
        });
        return;
      }
    }

    // No search query - show all videos
    this.filteredWeeks.set(this.videoWeeks());
  }

  onSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedCount.set(event.count);
    this.selectedVideoIds.set(event.ids);
  }

  onVideoAction(event: { action: string; videos: VideoItem[] }) {
    const { action, videos } = event;

    switch (action) {
      case 'viewDetails':
        // TODO: Open video details/metadata editor modal
        console.log('View details for:', videos[0]?.name);
        alert(`View details: ${videos[0]?.name}\n\nThis feature will show video metadata, transcript, and analysis.`);
        break;

      case 'addToTab':
        // TODO: Open tab selector dialog
        console.log('Add to tab:', videos.map(v => v.name));
        alert(`Add ${videos.length} video(s) to tab\n\nThis feature will open a dialog to select or create a tab.`);
        break;

      case 'analyze':
        this.analyzeVideos(videos);
        break;

      case 'moveToLibrary':
        // TODO: Open library selector dialog
        console.log('Move to library:', videos.map(v => v.name));
        alert(`Move ${videos.length} video(s) to another library\n\nThis feature will open a dialog to select a target library.`);
        break;

      case 'delete':
        this.deleteVideos(videos);
        break;

      case 'openInEditor':
        this.openInEditor(videos[0]);
        break;

      default:
        console.warn('Unknown video action:', action);
    }
  }

  openInEditor(video?: VideoItem) {
    // If no video passed, get first selected video
    if (!video) {
      const selectedItemIds = this.selectedVideoIds();

      if (selectedItemIds.size === 0) {
        alert('Please select a video first');
        return;
      }

      if (selectedItemIds.size !== 1) {
        alert('Please select exactly one video to open in editor');
        return;
      }

      // Get the video from selected ID - check both filtered and all weeks
      const allVideos: VideoItem[] = [];
      // First check filtered weeks (what's currently visible)
      this.filteredWeeks().forEach(week => {
        allVideos.push(...week.videos);
      });
      // Also add from all weeks in case selection came from unfiltered view
      this.videoWeeks().forEach(week => {
        week.videos.forEach(v => {
          if (!allVideos.find(existing => existing.id === v.id)) {
            allVideos.push(v);
          }
        });
      });

      // The itemId format is "weekLabel|videoId"
      const itemId = Array.from(selectedItemIds)[0];
      const parts = itemId.split('|');
      const videoId = parts.length > 1 ? parts[1] : itemId;

      // Try to find by extracted videoId first
      video = allVideos.find(v => v.id === videoId);

      // If not found, try matching the full itemId as videoId (in case format changed)
      if (!video) {
        video = allVideos.find(v => v.id === itemId);
      }
    }

    if (!video) {
      console.error('Could not find video. Selected IDs:', Array.from(this.selectedVideoIds()));
      alert('Could not find selected video');
      return;
    }

    // Navigate to editor with video data
    // VideoPlayerComponent expects data wrapped in 'videoEditorData'
    // videoPath is optional - the editor can stream by videoId if path is missing
    this.router.navigate(['/editor'], {
      state: {
        videoEditorData: {
          videoId: video.id,
          videoPath: video.filePath, // May be undefined, editor will use videoId to stream
          videoTitle: video.name
        }
      }
    });
  }

  viewMore() {
    const selectedItemIds = this.selectedVideoIds();

    if (selectedItemIds.size === 0) {
      alert('Please select a video first');
      return;
    }

    if (selectedItemIds.size !== 1) {
      alert('Please select exactly one video to view details');
      return;
    }

    // Get the video ID from the itemId (format: "weekLabel|videoId")
    const itemId = Array.from(selectedItemIds)[0];
    const parts = itemId.split('|');
    const videoId = parts.length > 1 ? parts[1] : itemId;

    // Navigate to video info page
    this.router.navigate(['/video', videoId]);
  }

  private analyzeVideos(videos: VideoItem[]) {
    if (videos.length === 0) return;

    // Add videos to queue with transcribe + analyze tasks via VideoProcessingService
    videos.forEach(video => {
      const settings: VideoJobSettings = {
        fixAspectRatio: false,
        normalizeAudio: false,
        transcribe: true,
        whisperModel: 'base',
        aiAnalysis: true,
        aiModel: 'gpt-4',
        outputFormat: 'mp4',
        outputQuality: 'high'
      };

      this.videoProcessingService.addJob('', video.name, settings, video.id, video.filePath);
    });

    this.queueExpanded.set(true);

    // Clear selection
    if (this.videoLibraryComponent) {
      this.videoLibraryComponent.clearSelection();
    }
  }

  private deleteVideos(videos: VideoItem[]) {
    if (videos.length === 0) return;

    const confirm = window.confirm(
      `Delete ${videos.length} video(s)?\n\nThis action cannot be undone.`
    );

    if (!confirm) return;

    // Delete each video
    let deletedCount = 0;
    const idsToRemove: string[] = [];

    videos.forEach(video => {
      this.libraryService.deleteVideo(video.id).subscribe({
        next: (response) => {
          if (response.success) {
            deletedCount++;
            idsToRemove.push(video.id);

            // When all deletions complete, update the display
            if (deletedCount === videos.length) {
              if (this.videoLibraryComponent) {
                this.videoLibraryComponent.removeVideosFromDisplay(idsToRemove);
              }
              // Also reload to ensure sync
              this.loadLibrary();
            }
          }
        },
        error: (error) => {
          console.error('Failed to delete video:', video.name, error);
          alert(`Failed to delete: ${video.name}`);
        }
      });
    });
  }

  onAddSelectedToQueue() {
    if (this.selectedCount() === 0) {
      alert('Please select at least one video');
      return;
    }

    // Get selected videos and add them to queue
    const allVideos: VideoItem[] = [];
    this.videoWeeks().forEach(week => {
      allVideos.push(...week.videos);
    });

    const selectedItemIds = this.selectedVideoIds();

    // Extract unique video IDs from itemIds (format: "weekLabel|videoId")
    const uniqueVideoIds = new Set<string>();
    selectedItemIds.forEach(itemId => {
      const parts = itemId.split('|');
      const videoId = parts.length > 1 ? parts[1] : itemId;
      uniqueVideoIds.add(videoId);
    });

    // Add to VideoProcessingService
    uniqueVideoIds.forEach(videoId => {
      const video = allVideos.find(v => v.id === videoId);
      if (video) {
        const settings: VideoJobSettings = {
          fixAspectRatio: false,
          normalizeAudio: false,
          transcribe: true,
          whisperModel: 'base',
          aiAnalysis: true,
          aiModel: 'gpt-4',
          outputFormat: 'mp4',
          outputQuality: 'high'
        };
        this.videoProcessingService.addJob('', video.name, settings, video.id, video.filePath);
      }
    });

    this.queueExpanded.set(true);

    // Clear selection
    if (this.videoLibraryComponent) {
      this.videoLibraryComponent.clearSelection();
    }
  }

  onPasteUrls() {
    // Expand queue to show it - the VideoProcessingQueueComponent handles URL input
    this.queueExpanded.set(true);
  }

  onToggleQueue() {
    this.queueExpanded.set(!this.queueExpanded());
  }

  onCloseQueue() {
    this.queueExpanded.set(false);
  }
}
