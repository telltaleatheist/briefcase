import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatListModule } from '@angular/material/list';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { VideoPreviewDialogComponent } from '../video-preview-dialog/video-preview-dialog.component';

import { BulkAnalysisService, UnprocessedVideo, BulkAnalysisProgress, BulkAnalysisConfig } from '../../services/bulk-analysis.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { environment } from '../../../environment/environment';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import { ListItem, ItemDisplayConfig, SelectionMode, ContextMenuAction } from '../../libs/cascade/src/lib/types/cascade.types';
import { VideoPreviewData } from '../video-preview-dialog/video-preview-dialog.component';

interface VideoListItem extends ListItem {
  filename: string;
  current_path: string;
  upload_date?: string;
  download_date?: string;
  duration_seconds?: number;
  needs_transcript: number;
  needs_analysis: number;
}

@Component({
  selector: 'app-bulk-analysis',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatTooltipModule,
    MatDividerModule,
    MatChipsModule,
    MatListModule,
    MatDialogModule,
    CascadeListComponent
  ],
  templateUrl: './bulk-analysis.component.html',
  styleUrls: ['./bulk-analysis.component.scss']
})
export class BulkAnalysisComponent implements OnInit, OnDestroy {
  // Configuration
  operationType: 'transcribe' | 'analyze' = 'analyze';
  aiModel: string = 'qwen2.5:7b';
  whisperModel: string = 'base';
  maxConcurrent: number = 1;
  sortOrder: 'oldest' | 'newest' | 'shortest' | 'longest' = 'oldest';

  // Available models
  availableModels: string[] = [];
  availableWhisperModels: string[] = ['tiny', 'base', 'small', 'medium', 'large'];

  // Queue state
  queuedVideos: UnprocessedVideo[] = [];
  progress: BulkAnalysisProgress | null = null;
  isProcessing: boolean = false;
  isLoading: boolean = false;

  // Cascade list configuration
  videoListItems: VideoListItem[] = [];
  selectedVideoIds = new Set<string>();
  displayConfig: ItemDisplayConfig = {
    primaryField: 'filename',
    secondaryField: 'upload_date',
    metadataField: 'duration_seconds',
    iconField: 'icon',
    renderMetadata: (item: any) => this.formatDuration(item.duration_seconds)
  };
  SelectionMode = SelectionMode;

  // Context menu actions
  contextMenuActions: ContextMenuAction[] = [
    {
      id: 'preview',
      label: 'Quick Look',
      icon: 'visibility',
      disabled: false
    },
    {
      id: 'open-info',
      label: 'Open Video Info',
      icon: 'info',
      disabled: false
    },
    {
      id: 'divider-1',
      label: '',
      divider: true
    },
    {
      id: 'remove',
      label: 'Remove from Queue',
      icon: 'delete',
      disabled: false
    }
  ];

  // Subscriptions
  private subscriptions: Subscription[] = [];

  // Dialog reference for preview
  private currentPreviewDialogRef: any = null;

  // Backend URL for video streaming
  private backendUrl: string = '';

  constructor(
    private bulkAnalysisService: BulkAnalysisService,
    private http: HttpClient,
    private dialog: MatDialog,
    private router: Router,
    private backendUrlService: BackendUrlService
  ) {}

  async ngOnInit() {
    // Load backend URL first
    this.backendUrl = await this.backendUrlService.getBackendUrl();

    // Subscribe to queue updates
    this.subscriptions.push(
      this.bulkAnalysisService.getQueuedVideos().subscribe(videos => {
        this.queuedVideos = videos;
        this.videoListItems = this.convertToListItems(videos);
        this.updateProgress();
      })
    );

    this.subscriptions.push(
      this.bulkAnalysisService.getIsProcessing().subscribe(processing => {
        this.isProcessing = processing;
        this.updateProgress();
      })
    );

    // Load available AI models
    await this.loadAvailableModels();

    // Load existing queue from localStorage if any
    this.updateProgress();

    // If queue is empty, initialize with unprocessed videos
    if (this.queuedVideos.length === 0) {
      await this.initializeQueue();
    }
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  /**
   * Load available AI models from backend
   */
  async loadAvailableModels() {
    try {
      const response = await this.http.get<{ success: boolean; models: any[] }>(
        `${environment.apiBaseUrl}/analysis/models`
      ).toPromise();

      if (response?.models) {
        this.availableModels = response.models.map((m: any) => m.name);
      }

      // Fallback to defaults if no models returned
      if (this.availableModels.length === 0) {
        this.availableModels = ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.2:3b'];
      }
    } catch (error) {
      console.error('Failed to load models:', error);
      this.availableModels = ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.2:3b'];
    }
  }

  /**
   * Initialize queue with unprocessed videos
   */
  async initializeQueue() {
    this.isLoading = true;

    try {
      await this.bulkAnalysisService.initializeQueue(this.sortOrder);
    } catch (error: any) {
      console.error('Failed to initialize queue:', error);
      alert(`Failed to load videos: ${error.message}`);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Rescan for unprocessed videos
   */
  async rescanVideos() {
    this.isLoading = true;

    try {
      await this.bulkAnalysisService.initializeQueue(this.sortOrder);
    } catch (error: any) {
      console.error('Failed to rescan:', error);
      alert(`Failed to rescan: ${error.message}`);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Convert UnprocessedVideo to VideoListItem
   */
  private convertToListItems(videos: UnprocessedVideo[]): VideoListItem[] {
    return videos.map(v => ({
      id: v.id,
      filename: v.filename,
      current_path: v.current_path,
      upload_date: v.upload_date,
      download_date: v.download_date,
      duration_seconds: v.duration_seconds,
      needs_transcript: v.needs_transcript,
      needs_analysis: v.needs_analysis,
      icon: 'movie'
    }));
  }

  /**
   * Handle video selection
   */
  onVideosSelected(items: VideoListItem[]) {
    items.forEach(item => this.selectedVideoIds.add(item.id));
  }

  /**
   * Handle video deselection
   */
  onVideosDeselected(items: VideoListItem[]) {
    items.forEach(item => this.selectedVideoIds.delete(item.id));
  }

  /**
   * Remove selected videos from queue
   */
  removeSelectedVideos() {
    if (this.selectedVideoIds.size === 0) {
      alert('No videos selected');
      return;
    }

    if (confirm(`Remove ${this.selectedVideoIds.size} video(s) from queue?`)) {
      this.selectedVideoIds.forEach(id => {
        this.bulkAnalysisService.removeFromQueue(id);
      });
      this.selectedVideoIds.clear();
    }
  }

  /**
   * Select all videos
   */
  selectAllVideos() {
    this.selectedVideoIds = new Set(this.videoListItems.map(v => v.id));
  }

  /**
   * Deselect all videos
   */
  deselectAllVideos() {
    this.selectedVideoIds.clear();
  }

  /**
   * Remove a single video from queue
   */
  removeVideo(videoId: string) {
    this.bulkAnalysisService.removeFromQueue(videoId);
    this.selectedVideoIds.delete(videoId);
  }

  /**
   * Handle context menu action
   */
  onContextMenuAction(event: { action: string; items: VideoListItem[] }) {
    switch (event.action) {
      case 'preview':
        if (event.items.length > 0) {
          this.showPreview(event.items[0]);
        }
        break;
      case 'open-info':
        if (event.items.length > 0) {
          this.openVideoInfo(event.items[0]);
        }
        break;
      case 'remove':
        event.items.forEach(item => {
          this.bulkAnalysisService.removeFromQueue(item.id);
          this.selectedVideoIds.delete(item.id);
        });
        break;
    }
  }

  /**
   * Handle spacebar action - toggle preview
   */
  onSpaceAction(item: VideoListItem | null) {
    // If dialog is open, close it
    if (this.currentPreviewDialogRef) {
      this.currentPreviewDialogRef.close();
      this.currentPreviewDialogRef = null;
      return;
    }

    // Otherwise open preview for the item
    if (item) {
      this.showPreview(item);
    }
  }

  /**
   * Show preview dialog for a video
   */
  showPreview(item: VideoListItem) {
    const dialogData: VideoPreviewData = {
      id: item.id,
      filename: item.filename,
      current_path: item.current_path,
      upload_date: item.upload_date,
      download_date: item.download_date,
      duration_seconds: item.duration_seconds,
      needs_transcript: item.needs_transcript,
      needs_analysis: item.needs_analysis,
      videoStreamUrl: this.getVideoStreamUrl(item.current_path)
    };

    this.currentPreviewDialogRef = this.dialog.open(VideoPreviewDialogComponent, {
      data: dialogData,
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '90vh',
      panelClass: 'video-preview-dialog-panel',
      hasBackdrop: false,  // No backdrop
      disableClose: false,
      autoFocus: false,    // Don't steal focus from list
      restoreFocus: false  // Don't restore focus on close
    });

    // Clear reference when dialog closes
    this.currentPreviewDialogRef.afterClosed().subscribe(() => {
      this.currentPreviewDialogRef = null;
    });
  }

  /**
   * Get streaming URL for a video (base64 encoded path)
   */
  getVideoStreamUrl(path: string): string {
    // Properly encode Unicode path to base64
    const utf8Bytes = new TextEncoder().encode(path);
    const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('');
    const encodedPath = btoa(binaryString);

    // Use the same endpoint as library component
    const url = `${this.backendUrl}/api/library/videos/custom?path=${encodeURIComponent(encodedPath)}`;
    console.log('[Bulk Analysis] Generated video URL:', url);
    return url;
  }

  /**
   * Handle item highlight change - update preview if open
   */
  onItemHighlighted(item: VideoListItem | null) {
    // If preview dialog is open and a video is highlighted, update it
    if (this.currentPreviewDialogRef && item) {
      const dialogData: VideoPreviewData = {
        id: item.id,
        filename: item.filename,
        current_path: item.current_path,
        upload_date: item.upload_date,
        download_date: item.download_date,
        duration_seconds: item.duration_seconds,
        needs_transcript: item.needs_transcript,
        needs_analysis: item.needs_analysis,
        videoStreamUrl: this.getVideoStreamUrl(item.current_path)
      };

      const componentInstance = this.currentPreviewDialogRef.componentInstance;
      componentInstance.updateVideoData(dialogData);
    }
  }

  /**
   * Open video info page
   */
  openVideoInfo(item: VideoListItem) {
    this.router.navigate(['/video-info', item.id]);
  }

  /**
   * Handle delete action (from keyboard or other source)
   */
  onDeleteAction(items: VideoListItem[]) {
    if (items.length === 0) return;

    const message = items.length === 1
      ? `Remove "${items[0].filename}" from queue?`
      : `Remove ${items.length} videos from queue?`;

    if (confirm(message)) {
      items.forEach(item => {
        this.bulkAnalysisService.removeFromQueue(item.id);
        this.selectedVideoIds.delete(item.id);
      });
    }
  }

  /**
   * Start processing
   */
  async startProcessing() {
    if (this.queuedVideos.length === 0) {
      alert('No videos in queue to process');
      return;
    }

    // Get selected videos
    const selectedIds = Array.from(this.selectedVideoIds);

    // If no videos are selected, prompt user
    if (selectedIds.length === 0) {
      alert('Please select videos to process. Use "Select All" to process all videos in the queue.');
      return;
    }

    const config: BulkAnalysisConfig = {
      operationType: this.operationType,
      aiModel: this.aiModel,
      whisperModel: this.whisperModel,
      maxConcurrent: this.maxConcurrent,
      sortOrder: this.sortOrder
    };

    try {
      // Pass selected video IDs to service
      await this.bulkAnalysisService.startProcessing(config, selectedIds);
      // Clear selection after starting
      this.selectedVideoIds.clear();
    } catch (error: any) {
      console.error('Failed to start processing:', error);
      alert(`Failed to start: ${error.message}`);
    }
  }

  /**
   * Pause processing
   */
  pauseProcessing() {
    this.bulkAnalysisService.pauseProcessing();
  }

  /**
   * Resume processing
   */
  async resumeProcessing() {
    try {
      await this.bulkAnalysisService.resumeProcessing();
    } catch (error: any) {
      console.error('Failed to resume processing:', error);
      alert(`Failed to resume: ${error.message}`);
    }
  }

  /**
   * Stop processing completely
   */
  stopProcessing() {
    if (confirm('Are you sure you want to stop processing? Progress will be saved.')) {
      this.bulkAnalysisService.stopProcessing();
    }
  }

  /**
   * Clear queue and reset
   */
  clearQueue() {
    if (confirm('Are you sure you want to clear the entire queue? This cannot be undone.')) {
      this.bulkAnalysisService.clearQueue();
    }
  }

  /**
   * Update progress statistics
   */
  private updateProgress() {
    this.progress = this.bulkAnalysisService.getProgress();
  }

  /**
   * Format duration for display
   */
  formatDuration(seconds: number | undefined): string {
    if (!seconds) return 'Unknown';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Calculate total duration of queued videos
   */
  getTotalDuration(): number {
    return this.queuedVideos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0);
  }

  /**
   * Get progress percentage
   */
  getProgressPercentage(): number {
    if (!this.progress || this.progress.total === 0) return 0;
    return Math.round((this.progress.processed / this.progress.total) * 100);
  }
}
