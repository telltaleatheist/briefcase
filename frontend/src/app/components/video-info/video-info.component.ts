import { Component, OnInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  DatabaseLibraryService,
  DatabaseVideo,
  DatabaseTranscript,
  DatabaseAnalysis,
  DatabaseAnalysisSection,
  DatabaseTag
} from '../../services/database-library.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { VideoAnalysisDialogComponent } from '../video-analysis-dialog/video-analysis-dialog.component';
import { TranscriptSearchComponent } from '../transcript-search/transcript-search.component';
import { ItemListComponent } from '../shared/item-list/item-list.component';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import {
  ListItem,
  ItemDisplayConfig,
  SelectionMode,
  ContextMenuAction
} from '../../libs/cascade/src/lib/types/cascade.types';

interface TranscriptEntry {
  timestamp: string;
  text: string;
  timestampSeconds?: number;
}

@Component({
  selector: 'app-video-info',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatDividerModule,
    MatChipsModule,
    MatInputModule,
    MatFormFieldModule,
    MatDialogModule,
    TranscriptSearchComponent,
    ItemListComponent,
    CascadeListComponent
  ],
  templateUrl: './video-info.component.html',
  styleUrl: './video-info.component.scss'
})
export class VideoInfoComponent implements OnInit {
  @ViewChild('transcriptContainer') transcriptContainer?: ElementRef<HTMLDivElement>;
  @ViewChild('analysisSection') analysisSection?: ElementRef<HTMLDivElement>;
  @ViewChild('transcriptSection') transcriptSection?: ElementRef<HTMLDivElement>;

  video: DatabaseVideo | null = null;
  transcript: DatabaseTranscript | null = null;
  analysis: DatabaseAnalysis | null = null;
  analysisSections: DatabaseAnalysisSection[] = [];
  tags: DatabaseTag[] = [];
  isLoading = true;
  videoUrl: string = '';
  videoError: string = '';
  parsedTranscript: TranscriptEntry[] = [];
  isEditingTitle = false;
  editedTitle = '';
  isAddingTag = false;
  newTagName = '';
  newTagType = 'manual';

  // Linked files (parent-child relationships)
  childVideos: DatabaseVideo[] = [];
  isDraggingFiles = false;
  private dragCounter = 0;

  // Library picker modal
  isLibraryPickerOpen = false;
  availableLibraryVideos: DatabaseVideo[] = [];
  selectedLibraryVideos = new Set<string>();

  // Item list configuration for linked children
  SelectionMode = SelectionMode;
  childListDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'media_type',
    metadataField: 'duration_seconds',
    iconField: 'media_type',
    renderPrimary: (item) => item['filename'] || '',
    renderSecondary: (item) => this.getMediaTypeLabel(item['media_type'] || 'video'),
    renderMetadata: (item) => item['duration_seconds'] ? this.formatDuration(item['duration_seconds']) : '',
    renderIcon: (item) => this.getMediaTypeIcon(item['media_type'] || 'video')
  };

  childListContextMenuActions: ContextMenuAction[] = [
    {
      id: 'unlink',
      label: 'Unlink File',
      icon: 'link_off'
    }
  ];

  // Library picker display config
  libraryPickerDisplayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'media_type',
    metadataField: 'duration_seconds',
    iconField: 'media_type',
    renderPrimary: (item) => item['filename'] || '',
    renderSecondary: (item) => {
      const mediaType = this.getMediaTypeLabel(item['media_type'] || 'video');
      const date = item['upload_date'] ? new Date(item['upload_date']).toLocaleDateString() : '';
      return date ? `${mediaType} • ${date}` : mediaType;
    },
    renderMetadata: (item) => item['duration_seconds'] ? this.formatDuration(item['duration_seconds']) : '',
    renderIcon: (item) => this.getMediaTypeIcon(item['media_type'] || 'video')
  };

  // Search panel state
  isSearchPanelOpen = false;
  searchPanelWidth = 400; // default width in pixels
  minSearchPanelWidth = 300;
  maxSearchPanelWidth = 600;
  isResizingSearchPanel = false;
  isDraggingSearchPanel = false;
  searchPanelX = 100; // position from left
  searchPanelY = 100; // position from top

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private databaseLibraryService: DatabaseLibraryService,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService,
    private http: HttpClient,
    private dialog: MatDialog
  ) {}

  async ngOnInit() {
    // Get video data from router state
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state ||
      (history.state?.navigationId ? history.state : null);

    if (state && state['videoData']) {
      this.video = state['videoData'];
      await this.loadVideoMetadata();
    } else {
      // If no state, try to get video ID from route params
      const videoId = this.route.snapshot.paramMap.get('id');
      if (videoId) {
        await this.loadVideoById(videoId);
      } else {
        this.notificationService.error('No Video', 'No video data provided');
        this.router.navigate(['/library']);
      }
    }
  }

  async loadVideoById(videoId: string) {
    try {
      // Get all videos and find the one we need
      // Use useCache=false to ensure we get fresh data from the database
      // This is especially important after a video has been renamed
      const result = await this.databaseLibraryService.getVideos(1000, 0, false);
      this.video = result.videos.find(v => v.id === videoId) || null;

      if (!this.video) {
        this.notificationService.error('Video Not Found', 'The requested video could not be found');
        this.router.navigate(['/library']);
        return;
      }
      await this.loadVideoMetadata();
    } catch (error) {
      console.error('Error loading video:', error);
      this.notificationService.error('Load Error', 'Failed to load video');
      this.router.navigate(['/library']);
    }
  }

  async loadVideoMetadata() {
    if (!this.video) return;

    try {
      // Load transcript if available
      const hasTranscript = await this.databaseLibraryService.hasTranscript(this.video.id);
      if (hasTranscript) {
        this.transcript = await this.databaseLibraryService.getTranscript(this.video.id);
        this.updateParsedTranscript();
      }

      // Load analysis if available
      const hasAnalysis = await this.databaseLibraryService.hasAnalysis(this.video.id);
      if (hasAnalysis) {
        this.analysis = await this.databaseLibraryService.getAnalysis(this.video.id);
      }

      // Always load analysis sections (includes both AI sections and user markers)
      this.analysisSections = await this.databaseLibraryService.getAnalysisSections(this.video.id);

      // Load tags
      this.tags = await this.databaseLibraryService.getVideoTags(this.video.id);

      // Load child videos (linked files)
      await this.loadChildVideos();

      // Generate video URL
      this.videoUrl = await this.getVideoUrl();
    } catch (error) {
      console.error('Error loading metadata:', error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Load child videos (files linked to this video)
   */
  async loadChildVideos() {
    if (!this.video) return;

    try {
      this.childVideos = await this.databaseLibraryService.getChildVideos(this.video.id);
    } catch (error) {
      console.error('Error loading child videos:', error);
      this.childVideos = [];
    }
  }

  async getVideoUrl(): Promise<string> {
    if (!this.video) return '';

    try {
      const backendUrl = await this.backendUrlService.getBackendUrl();
      // Use the custom path endpoint with proper encoding (same as video-player component)
      const encodedPath = btoa(unescape(encodeURIComponent(this.video.current_path)));
      return `${backendUrl}/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
    } catch (error) {
      console.error('Error generating video URL:', error);
      return '';
    }
  }

  formatDuration(seconds: number | null): string {
    if (!seconds) return 'Unknown';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    }
    return `${minutes}m ${secs}s`;
  }

  formatFileSize(bytes: number | null): string {
    if (!bytes) return 'Unknown';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  formatDate(dateString: string | null): string {
    if (!dateString) return 'Unknown';
    return new Date(dateString).toLocaleString();
  }

  formatTimestamp(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Check if the current media can be analyzed (video or audio only)
   */
  canAnalyzeMedia(): boolean {
    if (!this.video) return false;
    return this.video.media_type === 'video' || this.video.media_type === 'audio';
  }

  async deleteAnalysisSection(section: DatabaseAnalysisSection): Promise<void> {
    if (!this.video || !section.id) return;

    const result = await this.databaseLibraryService.deleteAnalysisSection(this.video.id, section.id);

    if (result.success) {
      // Remove from local array
      this.analysisSections = this.analysisSections.filter(s => s.id !== section.id);
    } else {
      this.notificationService.error('Delete Failed', result.error || 'Failed to delete section');
    }
  }

  getCategoryColor(category: string): string {
    if (!category) return '#ff6b35';

    const normalizedCategory = category.toLowerCase().trim();

    const categoryColors: { [key: string]: string } = {
      'routine': '#a855f7',
      'extremism': '#ef4444',
      'hate': '#f97316',
      'violence': '#dc2626',
      'conspiracy': '#eab308',
      'misinformation': '#f59e0b',
      'interesting': '#3b82f6',
      'notable': '#06b6d4',
      'important': '#10b981',
      'controversial': '#ec4899',
      'custom': '#22c55e', // Bright green for user-created markers
    };

    return categoryColors[normalizedCategory] || '#ff6b35';
  }

  async runAnalysis() {
    if (!this.video) return;

    const dialogRef = this.dialog.open(VideoAnalysisDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      panelClass: 'video-analysis-dialog-panel',
      data: {
        videoPath: this.video.current_path,
        videoTitle: this.video.filename,
        selectedVideos: [this.video]
      },
      disableClose: false
    });

    dialogRef.afterClosed().subscribe(async result => {
      if (result && result.success) {
        console.log('Video analysis added to queue');
        // Reload video data from database to get any updates (e.g., if filename was changed during analysis)
        if (this.video?.id) {
          await this.loadVideoById(this.video.id);
        }
      }
    });
  }

  private async pollForTranscript() {
    if (!this.video) return;

    const maxAttempts = 60;
    const pollInterval = 2000;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const hasTranscript = await this.databaseLibraryService.hasTranscript(this.video.id);
      if (hasTranscript) {
        this.transcript = await this.databaseLibraryService.getTranscript(this.video.id);
        this.updateParsedTranscript();
        this.notificationService.success('Transcription Complete', 'Video has been transcribed successfully');
        return;
      }
    }

    this.notificationService.warning('Still Processing', 'Transcription is taking longer than expected');
  }

  private async pollForAnalysis() {
    if (!this.video) return;

    const maxAttempts = 60;
    const pollInterval = 2000;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const hasAnalysis = await this.databaseLibraryService.hasAnalysis(this.video.id);
      if (hasAnalysis) {
        this.analysis = await this.databaseLibraryService.getAnalysis(this.video.id);
        this.analysisSections = await this.databaseLibraryService.getAnalysisSections(this.video.id);

        // Clear cache to ensure fresh data when navigating between videos
        this.databaseLibraryService.clearCache();

        this.notificationService.success('Analysis Complete', 'Analysis has been completed successfully');
        return;
      }
    }

    this.notificationService.warning('Still Processing', 'Analysis is taking longer than expected');
  }

  openClipCreator() {
    if (!this.video) return;

    this.router.navigate(['/video-editor'], {
      state: {
        videoEditorData: {
          videoId: this.video.id,
          videoPath: this.video.current_path,
          videoTitle: this.video.filename,
          startTime: 0,
          endTime: this.video.duration_seconds || 0
        }
      }
    });
  }

  async openBulkExportDialog() {
    if (!this.video || this.analysisSections.length === 0) return;

    const { BulkExportDialogComponent } = await import('../bulk-export-dialog/bulk-export-dialog.component');

    const dialogRef = this.dialog.open(BulkExportDialogComponent, {
      width: '600px',
      data: {
        videoId: this.video.id,
        videoPath: this.video.current_path,
        sections: this.analysisSections
      }
    });

    const result = await firstValueFrom(dialogRef.afterClosed());

    if (result?.exported) {
      this.notificationService.success('Export Complete', 'Clips have been exported successfully');
    }
  }

  goBack() {
    this.router.navigate(['/library']);
  }

  /**
   * Scroll to the AI Analysis section
   */
  scrollToAnalysis() {
    if (this.analysisSection) {
      this.analysisSection.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }

  /**
   * Scroll to the Transcript section
   */
  scrollToTranscript() {
    if (this.transcriptSection) {
      this.transcriptSection.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }

  onVideoError(event: any) {
    console.error('Video error:', event);
    const videoElement = event.target as HTMLVideoElement;
    if (videoElement.error) {
      const errorMessages: { [key: number]: string } = {
        1: 'Video loading was aborted',
        2: 'Network error while loading video',
        3: 'Video decoding failed',
        4: 'Video format not supported'
      };
      this.videoError = errorMessages[videoElement.error.code] || 'Unknown video error';
      console.error('Video error code:', videoElement.error.code, 'URL:', this.videoUrl);
    }
  }

  onVideoLoaded() {
    console.log('Video loaded successfully');
    this.videoError = '';
  }

  /**
   * Format analysis text to HTML with better formatting
   */
  formatAnalysisText(text: string): string {
    if (!text) return '';

    // Convert markdown-style formatting to HTML
    let formatted = text
      // Convert headers (## Header -> <h4>)
      .replace(/^### (.+)$/gm, '<h5>$1</h5>')
      .replace(/^## (.+)$/gm, '<h4>$1</h4>')
      .replace(/^# (.+)$/gm, '<h3>$1</h3>')
      // Convert bold (**text** -> <strong>)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Convert italic (*text* -> <em>)
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Convert bullet points (- item or * item)
      .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
      // Convert line breaks to <br>
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    // Wrap list items in <ul>
    formatted = formatted.replace(/(<li>.*<\/li>)/gs, (match) => {
      return '<ul>' + match + '</ul>';
    });

    // Wrap in paragraph tags
    if (!formatted.startsWith('<h') && !formatted.startsWith('<ul')) {
      formatted = '<p>' + formatted + '</p>';
    }

    return formatted;
  }

  /**
   * Parse SRT format transcript into entries with timestamps
   */
  private parseTranscript(srtText: string): TranscriptEntry[] {
    if (!srtText) return [];

    const entries: TranscriptEntry[] = [];
    const blocks = srtText.split('\n\n').filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length >= 3) {
        const timestamp = lines[1].split(' --> ')[0].trim();
        const text = lines.slice(2).join(' ').trim();

        // Parse timestamp to seconds for scrolling
        const timestampSeconds = this.parseTimestampToSeconds(timestamp);

        entries.push({ timestamp, text, timestampSeconds });
      }
    }

    return entries;
  }

  /**
   * Parse SRT timestamp (HH:MM:SS,mmm) to seconds
   */
  private parseTimestampToSeconds(timestamp: string): number {
    const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) return 0;

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const milliseconds = parseInt(match[4], 10);

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }

  /**
   * Update parsed transcript when transcript data changes
   */
  private updateParsedTranscript() {
    if (this.transcript?.srt_format) {
      this.parsedTranscript = this.parseTranscript(this.transcript.srt_format);
    } else {
      this.parsedTranscript = [];
    }
  }

  /**
   * Copy transcript to clipboard
   */
  async copyTranscript(withTimestamps: boolean) {
    if (!this.transcript) return;

    let textToCopy = '';

    if (withTimestamps) {
      // Copy SRT format
      textToCopy = this.transcript.srt_format;
    } else {
      // Copy plain text without timestamps
      textToCopy = this.transcript.plain_text;
    }

    try {
      await navigator.clipboard.writeText(textToCopy);
      this.notificationService.success(
        'Copied',
        `Transcript copied ${withTimestamps ? 'with' : 'without'} timestamps`
      );
    } catch (error) {
      console.error('Failed to copy transcript:', error);
      this.notificationService.error('Copy Failed', 'Failed to copy transcript to clipboard');
    }
  }

  /**
   * Start editing the video title
   */
  startEditingTitle() {
    if (!this.video) return;
    this.isEditingTitle = true;
    this.editedTitle = this.video.filename;
  }

  /**
   * Cancel editing the title
   */
  cancelEditingTitle() {
    this.isEditingTitle = false;
    this.editedTitle = '';
  }

  /**
   * Save the edited title
   */
  async saveTitle() {
    if (!this.video || !this.editedTitle.trim()) {
      this.cancelEditingTitle();
      return;
    }

    const newTitle = this.editedTitle.trim();

    // If title hasn't changed, just cancel
    if (newTitle === this.video.filename) {
      this.cancelEditingTitle();
      return;
    }

    try {
      const url = await this.backendUrlService.getApiUrl(`/database/videos/${this.video.id}/filename`);
      const result = await firstValueFrom(
        this.http.patch<{ success: boolean; message?: string; error?: string; newPath?: string }>(url, {
          filename: newTitle
        })
      );

      if (result.success) {
        // Update local video object with new filename and path
        this.video.filename = newTitle;
        if (result.newPath) {
          this.video.current_path = result.newPath;
          // Also regenerate the video URL since the path changed
          this.videoUrl = await this.getVideoUrl();
        }
        this.notificationService.success('Title Updated', 'Video title has been updated successfully');
        this.isEditingTitle = false;
        this.editedTitle = '';
      } else {
        this.notificationService.error('Update Failed', result.error || 'Failed to update video title');
      }
    } catch (error) {
      console.error('Error updating title:', error);
      this.notificationService.error('Update Failed', 'Failed to update video title');
    }
  }

  /**
   * Handle Enter key in title input
   */
  onTitleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.saveTitle();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEditingTitle();
    }
  }

  /**
   * Start adding a new tag
   */
  startAddingTag() {
    this.isAddingTag = true;
    this.newTagName = '';
    this.newTagType = 'manual';
  }

  /**
   * Cancel adding a tag
   */
  cancelAddingTag() {
    this.isAddingTag = false;
    this.newTagName = '';
    this.newTagType = 'manual';
  }

  /**
   * Save a new tag (legacy method for single tag)
   */
  async saveTag() {
    await this.saveTags();
  }

  /**
   * Save new tags (supports comma-separated values)
   */
  async saveTags() {
    if (!this.video || !this.newTagName.trim()) {
      this.cancelAddingTag();
      return;
    }

    // Split by commas and trim each tag
    const tagNames = this.newTagName
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);

    if (tagNames.length === 0) {
      this.cancelAddingTag();
      return;
    }

    try {
      let successCount = 0;
      let failedTags: string[] = [];

      // Add each tag
      for (const tagName of tagNames) {
        const result = await this.databaseLibraryService.addVideoTag(
          this.video.id,
          tagName,
          this.newTagType,
          undefined,
          'user'
        );

        if (result.success) {
          successCount++;
        } else {
          failedTags.push(tagName);
        }
      }

      // Reload tags to get updated list
      this.tags = await this.databaseLibraryService.getVideoTags(this.video.id);

      // Show appropriate notification
      if (successCount === tagNames.length) {
        const message = tagNames.length === 1
          ? `Tag "${tagNames[0]}" has been added`
          : `${successCount} tags have been added`;
        this.notificationService.success('Tags Added', message);
      } else if (successCount > 0) {
        this.notificationService.warning(
          'Partially Added',
          `${successCount} tag(s) added, ${failedTags.length} failed`
        );
      } else {
        this.notificationService.error('Failed to Add Tags', 'All tags failed to add');
      }

      this.cancelAddingTag();
    } catch (error) {
      console.error('Error adding tags:', error);
      this.notificationService.error('Failed to Add Tags', 'An error occurred');
    }
  }

  /**
   * Delete a tag
   */
  async deleteTag(tag: DatabaseTag) {
    if (!this.video) return;

    try {
      const result = await this.databaseLibraryService.deleteVideoTag(this.video.id, tag.id);

      if (result.success) {
        // Remove from local array
        this.tags = this.tags.filter(t => t.id !== tag.id);
        this.notificationService.success('Tag Removed', `Tag "${tag.tag_name}" has been removed`);
      } else {
        this.notificationService.error('Failed to Remove Tag', result.error || 'Unknown error');
      }
    } catch (error) {
      console.error('Error deleting tag:', error);
      this.notificationService.error('Failed to Remove Tag', 'An error occurred');
    }
  }

  /**
   * Handle Enter key in tag input
   */
  onTagKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.saveTags();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelAddingTag();
    }
  }

  /**
   * Get color for tag type
   */
  getTagTypeColor(tagType: string | null): string {
    const type = tagType?.toLowerCase() || 'manual';
    const colors: { [key: string]: string } = {
      'person': '#3b82f6',
      'people': '#3b82f6',
      'topic': '#10b981',
      'manual': '#6b7280',
      'ai': '#a855f7',
      'other': '#6b7280'
    };
    return colors[type] || colors['manual'];
  }

  /**
   * Toggle search panel open/closed
   */
  toggleSearchPanel(event?: MouseEvent) {
    this.isSearchPanelOpen = !this.isSearchPanelOpen;

    // Position the panel near the button when opening
    if (this.isSearchPanelOpen && event) {
      const button = event.currentTarget as HTMLElement;
      const rect = button.getBoundingClientRect();

      // Position panel below and to the left of the button
      this.searchPanelX = Math.max(10, rect.left - this.searchPanelWidth + rect.width);
      this.searchPanelY = Math.min(
        window.innerHeight - 400, // Keep panel visible (approximate panel height)
        rect.bottom + 10
      );

      // Ensure panel stays within viewport
      const maxX = window.innerWidth - this.searchPanelWidth - 20;
      this.searchPanelX = Math.max(10, Math.min(maxX, this.searchPanelX));
    }
  }

  /**
   * Prevent keyboard events in the search panel from propagating to parent components
   * This ensures typing in the search box works without interference
   */
  onSearchPanelKeyDown(event: KeyboardEvent) {
    // Stop all keyboard events from bubbling up to the video player
    event.stopPropagation();
  }

  /**
   * Handle seeking to a timestamp from search results
   */
  onSeekToTimestamp(timestampSeconds: number) {
    if (!this.transcriptContainer) return;

    // Find the transcript entry closest to this timestamp
    const targetEntry = this.parsedTranscript.find(
      entry => entry.timestampSeconds !== undefined && entry.timestampSeconds >= timestampSeconds
    );

    if (!targetEntry) return;

    // Find the DOM element for this transcript entry
    const container = this.transcriptContainer.nativeElement;
    const entries = container.querySelectorAll('.transcript-entry');
    const targetIndex = this.parsedTranscript.indexOf(targetEntry);

    if (targetIndex >= 0 && targetIndex < entries.length) {
      const targetElement = entries[targetIndex] as HTMLElement;

      // Scroll to the element with smooth behavior
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Highlight the element briefly
      targetElement.classList.add('highlighted');
      setTimeout(() => {
        targetElement.classList.remove('highlighted');
      }, 2000);
    }
  }

  /**
   * Start dragging the search panel to reposition it
   */
  startDragSearchPanel(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingSearchPanel = true;

    const startX = event.clientX;
    const startY = event.clientY;
    const startPanelX = this.searchPanelX;
    const startPanelY = this.searchPanelY;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDraggingSearchPanel) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      // Keep panel within viewport bounds
      const maxX = window.innerWidth - this.searchPanelWidth - 20;
      const maxY = window.innerHeight - 200; // approximate panel height

      this.searchPanelX = Math.max(10, Math.min(maxX, startPanelX + deltaX));
      this.searchPanelY = Math.max(10, Math.min(maxY, startPanelY + deltaY));
    };

    const onMouseUp = () => {
      this.isDraggingSearchPanel = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Start resizing the search panel
   */
  startResizeSearchPanel(event: MouseEvent) {
    event.preventDefault();
    this.isResizingSearchPanel = true;

    const startX = event.clientX;
    const startWidth = this.searchPanelWidth;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizingSearchPanel) return;

      const delta = startX - e.clientX;
      const newWidth = Math.max(
        this.minSearchPanelWidth,
        Math.min(this.maxSearchPanelWidth, startWidth + delta)
      );

      this.searchPanelWidth = newWidth;
    };

    const onMouseUp = () => {
      this.isResizingSearchPanel = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Get media type icon for a media item
   */
  getMediaTypeIcon(mediaType: string): string {
    switch (mediaType) {
      case 'video':
        return 'videocam';
      case 'audio':
        return 'audiotrack';
      case 'document':
        return 'description';
      case 'image':
        return 'image';
      case 'webpage':
        return 'public';
      default:
        return 'insert_drive_file';
    }
  }

  /**
   * Get media type label for a media item
   */
  getMediaTypeLabel(mediaType: string): string {
    switch (mediaType) {
      case 'video':
        return 'Video';
      case 'audio':
        return 'Audio';
      case 'document':
        return 'Document';
      case 'image':
        return 'Image';
      case 'webpage':
        return 'Web Page';
      default:
        return 'File';
    }
  }

  /**
   * Open the file location in Finder/Explorer
   */
  async openFileLocation() {
    if (!this.video?.current_path) {
      this.notificationService.error('Error', 'No file path available');
      return;
    }

    try {
      const backendUrl = this.backendUrlService.getBackendUrl();
      await firstValueFrom(
        this.http.post(`${backendUrl}/api/database/open-file-location`, {
          filePath: this.video.current_path
        })
      );
    } catch (error) {
      console.error('Error opening file location:', error);
      this.notificationService.error('Error', 'Failed to open file location');
    }
  }

  // ============================================================================
  // LINKED FILES / PARENT-CHILD OPERATIONS
  // ============================================================================

  /**
   * Check if this video can be a parent (not already a child)
   */
  canBeParent(): boolean {
    return !this.video?.parent_id;
  }

  /**
   * Handle drag enter event (for file drop zone)
   */
  onDragEnter(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter++;

    if (this.dragCounter === 1) {
      this.isDraggingFiles = true;
    }
  }

  /**
   * Handle drag over event (required to allow drop)
   */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Handle drag leave event
   */
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter--;

    if (this.dragCounter === 0) {
      this.isDraggingFiles = false;
    }
  }

  /**
   * Handle file drop event
   * Uses Electron's webUtils.getPathForFile to extract real file paths from dropped files
   */
  async onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter = 0;
    this.isDraggingFiles = false;

    if (!this.video || !this.canBeParent()) {
      this.notificationService.error(
        'Cannot Link Files',
        'Only root-level items can have linked files. This item is already linked to another item.'
      );
      return;
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }

    // Check for Electron API
    const electron = (window as any).electron;
    if (!electron || !electron.getFilePathFromFile) {
      this.notificationService.error(
        'Not Available',
        'Drag and drop only works in Electron app'
      );
      return;
    }

    // Extract file paths using Electron API
    const filePaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        // Use Electron's webUtils to get the real file path
        const filePath = electron.getFilePathFromFile(file);
        filePaths.push(filePath);
      } catch (error) {
        console.error('[VideoInfo] Failed to get file path for:', file.name, error);
      }
    }

    if (filePaths.length === 0) {
      this.notificationService.warning('No Files', 'No valid files were dropped. Make sure you\'re dragging actual files.');
      return;
    }

    await this.linkFilesToParent(filePaths);
  }

  /**
   * Link multiple files to this video as children
   */
  async linkFilesToParent(filePaths: string[]) {
    if (!this.video) return;

    try {
      console.log('[VideoInfo] Linking files:', filePaths);
      this.notificationService.info('Linking Files', `Processing ${filePaths.length} file(s)...`);

      const result = await this.databaseLibraryService.linkFilesToParent(this.video.id, filePaths);
      console.log('[VideoInfo] Link result:', result);

      if (result.success) {
        // Reload child videos
        await this.loadChildVideos();

        const message = result.results && result.results.length > 0
          ? `Successfully linked ${result.results.length} file(s)`
          : 'Files linked successfully';

        this.notificationService.success('Files Linked', message);

        // Show any errors
        if (result.errors && result.errors.length > 0) {
          console.error('[VideoInfo] Errors while linking:', result.errors);
          const errorMsg = result.errors.map(e => `${e.filePath}: ${e.error}`).join('\n');
          this.notificationService.warning('Some Files Failed', errorMsg);
        }
      } else {
        const errorMsg = result.error || 'Failed to link files';
        console.error('[VideoInfo] Link failed:', errorMsg);

        // Show errors if available
        if (result.errors && result.errors.length > 0) {
          const detailedErrors = result.errors.map(e => `${e.filePath}: ${e.error}`).join('\n');
          this.notificationService.error('Link Failed', detailedErrors);
        } else {
          this.notificationService.error('Link Failed', errorMsg);
        }
      }
    } catch (error: any) {
      console.error('[VideoInfo] Error linking files:', error);
      const errorMsg = error?.message || error?.error?.error || 'An error occurred while linking files';
      this.notificationService.error('Link Failed', errorMsg);
    }
  }

  /**
   * Remove a child from this parent
   */
  async removeChild(child: DatabaseVideo) {
    if (!this.video) return;

    try {
      const result = await this.databaseLibraryService.removeVideoParent(child.id);

      if (result.success) {
        // Remove from local array
        this.childVideos = this.childVideos.filter(c => c.id !== child.id);
        this.notificationService.success('File Unlinked', `${child.filename} is now a standalone item`);
      } else {
        this.notificationService.error('Unlink Failed', result.error || 'Failed to unlink file');
      }
    } catch (error) {
      console.error('Error removing child:', error);
      this.notificationService.error('Unlink Failed', 'An error occurred');
    }
  }

  /**
   * Navigate to a child video's detail page
   */
  viewChildVideo(child: DatabaseVideo) {
    this.router.navigate(['/video-info', child.id], {
      state: { videoData: child }
    });
  }

  /**
   * Open library picker modal to select videos from library
   */
  async openLibraryPicker() {
    if (!this.video || !this.canBeParent()) {
      this.notificationService.error(
        'Cannot Link Files',
        'Only root-level items can have linked files'
      );
      return;
    }

    try {
      // Fetch all videos from the library (using a high limit to get all)
      const response = await this.databaseLibraryService.getVideos(10000, 0, true, false);
      const allVideos = response.videos;

      // Filter out:
      // 1. The current video itself
      // 2. Videos that are already linked as children
      // 3. Videos that have this video as a parent (already linked)
      // 4. Videos that are already children of another parent
      const childIds = new Set(this.childVideos.map(c => c.id));
      this.availableLibraryVideos = allVideos.filter((v: DatabaseVideo) =>
        v.id !== this.video!.id &&           // Not the current video
        !childIds.has(v.id) &&               // Not already a child
        v.parent_id !== this.video!.id &&    // Not already linked to this parent
        !v.parent_id                          // Not a child of another parent
      );

      this.selectedLibraryVideos.clear();
      this.isLibraryPickerOpen = true;
    } catch (error) {
      console.error('Error loading library videos:', error);
      this.notificationService.error('Error', 'Failed to load library videos');
    }
  }

  /**
   * Close library picker modal
   */
  closeLibraryPicker() {
    this.isLibraryPickerOpen = false;
    this.selectedLibraryVideos.clear();
    this.availableLibraryVideos = [];
  }

  /**
   * Link selected videos from library to this parent
   */
  async linkSelectedLibraryVideos(videos?: DatabaseVideo[]) {
    if (!this.video) return;

    // If videos are provided (from double-click), use those
    // Otherwise use the selected videos from the item-list
    const videosToLink = videos || Array.from(this.selectedLibraryVideos)
      .map(id => this.availableLibraryVideos.find(v => v.id === id))
      .filter(v => v !== undefined) as DatabaseVideo[];

    if (videosToLink.length === 0) {
      return;
    }

    try {
      this.notificationService.info('Linking Videos', `Linking ${videosToLink.length} video(s)...`);

      // Use the existing linkFilesToParent method which accepts file paths
      // We need to extract the current_path from each video
      const filePaths = videosToLink.map(v => v.current_path);
      const result = await this.databaseLibraryService.linkFilesToParent(this.video.id, filePaths);

      if (result.success) {
        // Reload child videos
        await this.loadChildVideos();

        const message = result.results && result.results.length > 0
          ? `Successfully linked ${result.results.length} video(s)`
          : 'Videos linked successfully';

        this.notificationService.success('Videos Linked', message);

        // Close the modal
        this.closeLibraryPicker();

        // Show any errors
        if (result.errors && result.errors.length > 0) {
          console.error('[VideoInfo] Errors while linking:', result.errors);
          const errorMsg = result.errors.map(e => `${e.filePath}: ${e.error}`).join('\n');
          this.notificationService.warning('Some Videos Failed', errorMsg);
        }
      } else {
        const errorMsg = result.error || 'Failed to link videos';
        console.error('[VideoInfo] Link failed:', errorMsg);

        if (result.errors && result.errors.length > 0) {
          const detailedErrors = result.errors.map(e => `${e.filePath}: ${e.error}`).join('\n');
          this.notificationService.error('Link Failed', detailedErrors);
        } else {
          this.notificationService.error('Link Failed', errorMsg);
        }
      }
    } catch (error: any) {
      console.error('[VideoInfo] Error linking library videos:', error);
      const errorMsg = error?.message || error?.error?.error || 'An error occurred while linking videos';
      this.notificationService.error('Link Failed', errorMsg);
    }
  }

  /**
   * Open file picker to select files to link
   */
  async openFilePicker() {
    if (!this.video || !this.canBeParent()) {
      this.notificationService.error(
        'Cannot Link Files',
        'Only root-level items can have linked files'
      );
      return;
    }

    // Check for Electron API
    const electron = (window as any).electron;
    if (!electron || !electron.getFilePathFromFile) {
      this.notificationService.error(
        'Not Available',
        'File picker only works in Electron app'
      );
      return;
    }

    // Create a hidden file input element
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';

    input.onchange = async (e: any) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const filePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          // Use Electron's webUtils to get the real file path
          const filePath = electron.getFilePathFromFile(file);
          filePaths.push(filePath);
        } catch (error) {
          console.error('[VideoInfo] Failed to get file path for:', file.name, error);
        }
      }

      if (filePaths.length > 0) {
        await this.linkFilesToParent(filePaths);
      }

      // Cleanup
      document.body.removeChild(input);
    };

    document.body.appendChild(input);
    input.click();
  }

  // ============================================================================
  // ITEM LIST CONFIGURATION FOR CHILDREN
  // ============================================================================

  /**
   * Handle item click in children list
   */
  onChildItemClick(child: DatabaseVideo) {
    this.viewChildVideo(child);
  }

  /**
   * Handle item double click in children list
   */
  onChildItemDoubleClick(child: DatabaseVideo) {
    this.viewChildVideo(child);
  }

  /**
   * Handle context menu action in children list
   */
  onChildContextMenuAction(event: { action: string; items: DatabaseVideo[] }) {
    if (event.action === 'unlink' && event.items.length > 0) {
      // Unlink all selected children (usually just one from context menu)
      event.items.forEach(child => this.removeChild(child));
    }
  }

  // ============================================================================
  // LIBRARY PICKER SELECTION HANDLERS
  // ============================================================================

  /**
   * Handle library videos being selected
   */
  onLibraryVideosSelected(videos: DatabaseVideo[]) {
    videos.forEach(v => this.selectedLibraryVideos.add(v.id));
  }

  /**
   * Handle library videos being deselected
   */
  onLibraryVideosDeselected(videos: DatabaseVideo[]) {
    videos.forEach(v => this.selectedLibraryVideos.delete(v.id));
  }
}
