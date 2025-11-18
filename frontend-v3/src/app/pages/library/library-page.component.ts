import { Component, OnInit, signal, inject, ChangeDetectionStrategy, computed, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { LibrarySearchFiltersComponent, LibraryFilters } from '../../components/library-search-filters/library-search-filters.component';
import { VideoLibraryComponent } from '../../components/video-library/video-library.component';
import { ProcessingQueueComponent } from '../../components/processing-queue/processing-queue.component';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { VideoWeek, VideoItem } from '../../models/video.model';
import { QueueItem } from '../../models/queue.model';
import { JobRequest, TaskType } from '../../models/task.model';
import { Library, NewLibrary, RelinkLibrary } from '../../models/library.model';
import { LibraryService } from '../../services/library.service';

@Component({
  selector: 'app-library-page',
  standalone: true,
  imports: [
    CommonModule,
    LibrarySearchFiltersComponent,
    VideoLibraryComponent,
    ProcessingQueueComponent,
    LibraryManagerModalComponent
  ],
  templateUrl: './library-page.component.html',
  styleUrls: ['./library-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LibraryPageComponent implements OnInit {
  private libraryService = inject(LibraryService);
  private router = inject(Router);

  @ViewChild(VideoLibraryComponent) private videoLibraryComponent?: VideoLibraryComponent;
  @ViewChild(ProcessingQueueComponent) private processingQueueComponent?: ProcessingQueueComponent;

  videoWeeks = signal<VideoWeek[]>([]);
  filteredWeeks = signal<VideoWeek[]>([]);

  // Queue state
  queueItems = signal<QueueItem[]>([]);
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
    // Mock queue items removed - queue starts empty
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

    let filtered = this.videoWeeks();

    // Apply search query filter
    if (this.currentFilters.searchQuery) {
      const query = this.currentFilters.searchQuery.toLowerCase();
      filtered = filtered.map(week => ({
        ...week,
        videos: week.videos.filter(video =>
          video.name.toLowerCase().includes(query) ||
          video.suggestedFilename.toLowerCase().includes(query)
        )
      })).filter(week => week.videos.length > 0);
    }

    // TODO: Apply other filters (date range, has transcript, etc.)
    // These would need data from the backend

    this.filteredWeeks.set(filtered);
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

      case 'editSuggestedTitle':
        // TODO: Open suggested title editor modal
        console.log('Edit suggested title for:', videos[0]?.name);
        alert(`Edit suggested title: ${videos[0]?.suggestedTitle || videos[0]?.name}\n\nThis feature will open a dialog to edit the AI-suggested title.`);
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

  private analyzeVideos(videos: VideoItem[]) {
    if (videos.length === 0) return;

    const confirm = window.confirm(
      `Run analysis on ${videos.length} video(s)?\n\nThis will transcribe and analyze the selected videos.`
    );

    if (!confirm) return;

    // Add videos to queue with transcribe + analyze tasks
    const newQueueItems: QueueItem[] = videos.map(video => ({
      id: `queue-${Date.now()}-${Math.random()}`,
      source: 'library' as const,
      video,
      tasks: [
        { type: 'transcribe' as any, status: 'pending', progress: 0 },
        { type: 'analyze' as any, status: 'pending', progress: 0 }
      ],
      status: 'pending',
      overallProgress: 0
    }));

    this.queueItems.set([...this.queueItems(), ...newQueueItems]);
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
    // selectedVideoIds contains itemIds in format "weekLabel|videoId"
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

    const newQueueItems: QueueItem[] = [];
    uniqueVideoIds.forEach(videoId => {
      const video = allVideos.find(v => v.id === videoId);
      if (video) {
        newQueueItems.push({
          id: `queue-${Date.now()}-${Math.random()}`,
          source: 'library',
          video,
          tasks: [], // Start with no tasks - user configures them
          status: 'pending',
          overallProgress: 0
        });
      }
    });

    // Add to queue and expand
    this.queueItems.set([...this.queueItems(), ...newQueueItems]);
    this.queueExpanded.set(true);

    // Clear selection
    if (this.videoLibraryComponent) {
      this.videoLibraryComponent.clearSelection();
    }
  }

  onItemTasksUpdated(event: { itemId: string, tasks: any[] }) {
    const items = this.queueItems();
    const updatedItems = items.map(item => {
      if (item.id === event.itemId) {
        return { ...item, tasks: event.tasks };
      }
      return item;
    });
    this.queueItems.set(updatedItems);
  }

  onUrlAdded(url: string) {
    // Add URL to queue with default download task
    const newItem: QueueItem = {
      id: `queue-${Date.now()}-${Math.random()}`,
      source: 'url',
      url,
      urlTitle: new URL(url).hostname,
      tasks: [
        { type: 'download-import', status: 'pending', progress: 0 }
      ],
      status: 'pending',
      overallProgress: 0
    };

    this.queueItems.set([...this.queueItems(), newItem]);
    this.queueExpanded.set(true);
  }

  onRemoveQueueItem(itemId: string) {
    this.queueItems.set(this.queueItems().filter(item => item.id !== itemId));
  }

  onClearQueue() {
    if (confirm('Clear all items from the queue?')) {
      this.queueItems.set([]);
      this.queueExpanded.set(false);
    }
  }

  onProcessQueue() {
    const items = this.queueItems();
    if (items.length === 0) return;

    // Group items by type and create job requests
    const urlItems = items.filter(i => i.source === 'url');
    const libraryItems = items.filter(i => i.source === 'library');

    let jobsCreated = 0;
    const totalJobs = urlItems.length + (libraryItems.length > 0 ? 1 : 0);

    // Process URL items (each gets its own job with download task)
    urlItems.forEach(item => {
      if (item.url) {
        const request: JobRequest = {
          inputType: 'url',
          url: item.url,
          tasks: item.tasks.map(t => t.type)
        };

        this.libraryService.createJob(request).subscribe({
          next: (response) => {
            if (response.success) {
              jobsCreated++;
              if (jobsCreated === totalJobs) {
                this.onJobsComplete(totalJobs);
              }
            }
          },
          error: (error) => {
            console.error('Failed to create job:', error);
          }
        });
      }
    });

    // Process library items (batch into one job)
    if (libraryItems.length > 0) {
      const fileIds = libraryItems
        .filter(item => item.video)
        .map(item => item.video!.id);

      // Collect all unique tasks
      const allTasks = new Set<TaskType>();
      libraryItems.forEach(item => {
        item.tasks.forEach(task => allTasks.add(task.type));
      });

      const request: JobRequest = {
        inputType: 'files',
        fileIds,
        tasks: Array.from(allTasks)
      };

      this.libraryService.createJob(request).subscribe({
        next: (response) => {
          if (response.success) {
            jobsCreated++;
            if (jobsCreated === totalJobs) {
              this.onJobsComplete(totalJobs);
            }
          }
        },
        error: (error) => {
          console.error('Failed to create job:', error);
        }
      });
    }
  }

  onJobsComplete(count: number) {
    alert(`${count} ${count === 1 ? 'job' : 'jobs'} created successfully!`);
    this.queueItems.set([]);
    this.queueExpanded.set(false);
    this.loadLibrary(); // Refresh library
  }

  onToggleQueue() {
    this.queueExpanded.set(!this.queueExpanded());
  }

  onPasteUrls() {
    this.queueExpanded.set(true);
    // Wait for queue to expand, then focus URL input
    setTimeout(() => {
      this.processingQueueComponent?.focusUrlInput();
    }, 100);
  }

  onCloseQueue() {
    if (this.queueItems().length > 0) {
      if (confirm('Close queue? Items will be cleared.')) {
        this.queueItems.set([]);
        this.queueExpanded.set(false);
      }
    } else {
      this.queueExpanded.set(false);
    }
  }

  hasQueueItems = computed(() => {
    return this.queueItems().length > 0;
  });
}
