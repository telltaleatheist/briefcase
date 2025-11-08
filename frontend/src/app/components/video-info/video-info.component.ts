import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  DatabaseLibraryService,
  DatabaseVideo,
  DatabaseTranscript,
  DatabaseAnalysis,
  DatabaseAnalysisSection
} from '../../services/database-library.service';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import {
  AnalyzeSelectedDialogComponent
} from '../library/analyze-selected-dialog.component';

interface TranscriptEntry {
  timestamp: string;
  text: string;
}

@Component({
  selector: 'app-video-info',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatDividerModule,
    MatChipsModule
  ],
  templateUrl: './video-info.component.html',
  styleUrl: './video-info.component.scss'
})
export class VideoInfoComponent implements OnInit {
  video: DatabaseVideo | null = null;
  transcript: DatabaseTranscript | null = null;
  analysis: DatabaseAnalysis | null = null;
  analysisSections: DatabaseAnalysisSection[] = [];
  isLoading = true;
  isProcessing = false;
  processingType: 'transcript' | 'analysis' | null = null;
  videoUrl: string = '';
  videoError: string = '';
  parsedTranscript: TranscriptEntry[] = [];

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
        // Load analysis sections
        this.analysisSections = await this.databaseLibraryService.getAnalysisSections(this.video.id);
      }

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
    };

    return categoryColors[normalizedCategory] || '#ff6b35';
  }

  async runTranscription() {
    if (!this.video || this.isProcessing) return;

    this.isProcessing = true;
    this.processingType = 'transcript';

    try {
      // If transcript exists, delete it first
      if (this.transcript) {
        await this.databaseLibraryService.deleteTranscript(this.video.id);
        this.transcript = null;
        this.parsedTranscript = [];
      }

      const url = await this.backendUrlService.getApiUrl('/analysis/transcribe');
      await firstValueFrom(
        this.http.post(url, { videoId: this.video.id })
      );

      this.notificationService.success('Transcription Started', 'Video transcription has been queued');

      // Poll for completion
      await this.pollForTranscript();
    } catch (error) {
      console.error('Error starting transcription:', error);
      this.notificationService.error('Transcription Error', 'Failed to start transcription');
    } finally {
      this.isProcessing = false;
      this.processingType = null;
    }
  }

  async runAnalysis() {
    if (!this.video || this.isProcessing) return;

    // Open dialog to select AI provider and model
    const dialogRef = this.dialog.open(AnalyzeSelectedDialogComponent, {
      width: '700px',
      data: {
        selectedCount: 1,
        videosWithExistingAnalysis: this.analysis ? 1 : 0
      }
    });

    const result = await firstValueFrom(dialogRef.afterClosed());
    if (!result) return;

    this.isProcessing = true;
    this.processingType = 'analysis';

    try {
      // If analysis exists, delete it first
      if (this.analysis) {
        await this.databaseLibraryService.deleteAnalysis(this.video.id);
        this.analysis = null;
        this.analysisSections = [];
      }

      const url = await this.backendUrlService.getApiUrl('/analysis/analyze');
      await firstValueFrom(
        this.http.post(url, {
          videoId: this.video.id,
          videoTitle: this.video.filename,
          aiProvider: result.aiProvider,
          aiModel: result.aiModel,
          claudeApiKey: result.claudeApiKey,
          openaiApiKey: result.openaiApiKey,
          forceReanalyze: result.forceReanalyze
        })
      );

      this.notificationService.success('Analysis Started', 'AI analysis has been queued');

      // Poll for completion
      await this.pollForAnalysis();
    } catch (error) {
      console.error('Error starting analysis:', error);
      this.notificationService.error('Analysis Error', 'Failed to start AI analysis');
    } finally {
      this.isProcessing = false;
      this.processingType = null;
    }
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
        this.notificationService.success('Analysis Complete', 'AI analysis has been completed successfully');
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
   * Format AI analysis text to HTML with better formatting
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
}
