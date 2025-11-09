import { Component, OnInit } from '@angular/core';
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

interface TranscriptEntry {
  timestamp: string;
  text: string;
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
    MatDialogModule
  ],
  templateUrl: './video-info.component.html',
  styleUrl: './video-info.component.scss'
})
export class VideoInfoComponent implements OnInit {
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
      const result = await this.databaseLibraryService.getVideos(1000, 0);
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

      // Generate video URL
      this.videoUrl = await this.getVideoUrl();
    } catch (error) {
      console.error('Error loading metadata:', error);
    } finally {
      this.isLoading = false;
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

    dialogRef.afterClosed().subscribe(result => {
      if (result && result.success) {
        console.log('Video analysis added to queue');
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
        entries.push({ timestamp, text });
      }
    }

    return entries;
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
        this.http.patch<{ success: boolean; message?: string; error?: string }>(url, {
          filename: newTitle
        })
      );

      if (result.success) {
        // Update local video object
        this.video.filename = newTitle;
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
   * Save a new tag
   */
  async saveTag() {
    if (!this.video || !this.newTagName.trim()) {
      this.cancelAddingTag();
      return;
    }

    const tagName = this.newTagName.trim();

    try {
      const result = await this.databaseLibraryService.addVideoTag(
        this.video.id,
        tagName,
        this.newTagType,
        undefined,
        'user'
      );

      if (result.success) {
        // Reload tags
        this.tags = await this.databaseLibraryService.getVideoTags(this.video.id);
        this.notificationService.success('Tag Added', `Tag "${tagName}" has been added`);
        this.cancelAddingTag();
      } else {
        this.notificationService.error('Failed to Add Tag', result.error || 'Unknown error');
      }
    } catch (error) {
      console.error('Error adding tag:', error);
      this.notificationService.error('Failed to Add Tag', 'An error occurred');
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
      this.saveTag();
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
}
