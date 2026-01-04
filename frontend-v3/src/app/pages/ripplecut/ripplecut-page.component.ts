import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  RipplecutComponent,
  TimelineClip,
  CustomMarker,
  TimelineChapter,
  TranscriptSegment,
  TimelineSection,
  RipplecutConfig,
  ClipChangeEvent,
  MarkerChangeEvent,
  ExportRequestEvent
} from '../../components/ripplecut';
import { ExportDialogComponent, ExportDialogData } from '../../components/export-dialog/export-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { LibraryService } from '../../services/library.service';
import { BackendUrlService } from '../../services/backend-url.service';

@Component({
  selector: 'app-ripplecut-page',
  standalone: true,
  imports: [CommonModule, RipplecutComponent, ExportDialogComponent],
  template: `
    <div class="ripplecut-container">
      @if (isLoading()) {
        <div class="loading">Loading video...</div>
      } @else if (error()) {
        <div class="error">{{ error() }}</div>
      } @else {
        <app-ripplecut
          [config]="config"
          [initialClips]="clips()"
          [initialMarkers]="markers()"
          [initialChapters]="chapters()"
          [initialTranscript]="transcript()"
          (clipChange)="onClipChange($event)"
          (markerChange)="onMarkerChange($event)"
          (exportRequest)="onExportRequest($event)"
        />
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100vh;
      overflow: hidden;
    }
    .ripplecut-container {
      height: 100%;
      width: 100%;
    }
    .loading, .error {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #fff;
      background: #1a1a1a;
    }
    .error {
      color: #ef4444;
    }
  `]
})
export class RipplecutPageComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private http = inject(HttpClient);
  private dialog = inject(MatDialog);
  private libraryService = inject(LibraryService);
  private backendUrl = inject(BackendUrlService);

  private API_BASE = '';

  // State
  isLoading = signal(true);
  error = signal<string | null>(null);
  videoId = signal<string | null>(null);
  videoPath = signal<string | null>(null);
  videoTitle = signal<string>('Untitled');
  videoUrl = signal<string>('');
  duration = signal(0);

  // Data for RippleCut
  clips = signal<TimelineClip[]>([]);
  markers = signal<CustomMarker[]>([]);
  chapters = signal<TimelineChapter[]>([]);
  transcript = signal<TranscriptSegment[]>([]);

  // Configuration
  config: RipplecutConfig = {
    frameRate: 30,
    showBrowser: false,
    showInspector: true,
    defaultInspectorTab: 'analysis',
    enableAnalysis: true,
    enableChapters: true,
    enableTranscript: true
  };

  async ngOnInit() {
    // Must await the async getBackendUrl() before using it
    this.API_BASE = await this.backendUrl.getBackendUrl() + '/api';
    console.log('[RippleCut] API_BASE set to:', this.API_BASE);

    // Get video info from route params
    this.route.queryParams.subscribe(async params => {
      const videoId = params['videoId'];
      const videoPath = params['videoPath'];
      const videoTitle = params['videoTitle'] || 'Untitled';

      if (videoId) {
        this.videoId.set(videoId);
        this.videoPath.set(videoPath || null);
        this.videoTitle.set(videoTitle);
        await this.loadVideoData(videoId);
      } else if (videoPath) {
        // Custom video path mode
        this.videoPath.set(videoPath);
        this.videoTitle.set(videoTitle);
        const encodedPath = btoa(videoPath);
        this.videoUrl.set(`${this.API_BASE}/library/videos/custom?path=${encodedPath}`);
        this.isLoading.set(false);
      } else {
        this.error.set('No video specified');
        this.isLoading.set(false);
      }
    });
  }

  ngOnDestroy() {
    // Cleanup
  }

  private async loadVideoData(videoId: string) {
    try {
      console.log('[RippleCut] Loading video data for:', videoId);

      // Set video URL
      this.videoUrl.set(`${this.API_BASE}/database/videos/${videoId}/stream`);

      // Load video metadata to get duration, and other data in parallel
      const [videoInfo] = await Promise.all([
        this.loadVideoInfo(videoId),
        this.loadSections(videoId),
        this.loadTranscript(videoId),
        this.loadChapters(videoId)
      ]);

      // Create a main clip for the video with actual duration
      const videoDuration = videoInfo?.duration || 0;
      console.log('[RippleCut] Video duration:', videoDuration);
      this.duration.set(videoDuration);

      const mainClip: TimelineClip = {
        id: 'main-clip',
        name: this.videoTitle(),
        startTime: 0,
        endTime: videoDuration,
        lane: 0,
        type: 'video',  // CSS handles the creamsicle orange color
        mediaUrl: this.videoUrl()
      };
      this.clips.set([mainClip]);
      console.log('[RippleCut] Set clips:', [mainClip]);

      console.log('[RippleCut] Final state - markers:', this.markers().length, 'transcript:', this.transcript().length, 'chapters:', this.chapters().length);
      this.isLoading.set(false);
    } catch (err: any) {
      console.error('Failed to load video data:', err);
      this.error.set(err.message || 'Failed to load video data');
      this.isLoading.set(false);
    }
  }

  private async loadVideoInfo(videoId: string): Promise<{ duration: number } | null> {
    try {
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}`)
      );
      console.log('[RippleCut] Video info response:', response);
      // Backend returns duration_seconds, not duration
      const duration = response?.duration_seconds || response?.data?.duration_seconds || 0;
      console.log('[RippleCut] Extracted duration:', duration);
      return { duration };
    } catch (err) {
      console.warn('Failed to load video info:', err);
      return null;
    }
  }

  private async loadSections(videoId: string) {
    try {
      console.log('[RippleCut] Loading sections for:', videoId);
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/sections`)
      );
      console.log('[RippleCut] Sections response:', response);

      // Backend returns { sections: [...], count: N }
      const sections = response?.sections || [];
      if (sections.length > 0) {
        const markers: CustomMarker[] = sections.map((section: any) => {
          // Description contains the full analysis text, title is usually short/empty
          const message = section.description || section.title || 'Marker';
          console.log('[RippleCut] Section:', section.id, 'category:', section.category, 'message length:', message?.length);
          return {
            id: section.id,
            time: section.start_seconds,  // snake_case from database
            endTime: section.end_seconds,
            message,
            type: section.source === 'ai' ? 'analysis' as const : 'standard' as const,
            category: section.category,
            severity: this.getSeverityFromCategory(section.category),
            clipId: 'main-clip'  // Link markers to the main clip for timeline display
          };
        });
        console.log('[RippleCut] Parsed markers:', markers.length);
        this.markers.set(markers);
      }
    } catch (err) {
      console.warn('Failed to load sections:', err);
    }
  }

  private async loadTranscript(videoId: string) {
    try {
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/transcript`)
      );
      console.log('[RippleCut] Transcript response:', response);

      // Backend returns transcript object directly with srt_format field
      if (response?.srt_format) {
        const segments = this.parseSrtToSegments(response.srt_format);
        console.log('[RippleCut] Parsed transcript segments:', segments.length);
        this.transcript.set(segments);
      }
    } catch (err) {
      console.warn('Failed to load transcript:', err);
    }
  }

  private async loadChapters(videoId: string) {
    try {
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/chapters`)
      );
      console.log('[RippleCut] Chapters response:', response);

      // Backend returns { chapters: [...], count: N }
      const chapters = response?.chapters || [];
      if (chapters.length > 0) {
        const parsedChapters: TimelineChapter[] = chapters.map((chapter: any) => ({
          id: chapter.id,
          startTime: chapter.start_seconds,  // snake_case from database
          endTime: chapter.end_seconds,
          title: chapter.title
        }));
        console.log('[RippleCut] Parsed chapters:', parsedChapters.length);
        this.chapters.set(parsedChapters);
      }
    } catch (err) {
      console.warn('Failed to load chapters:', err);
    }
  }

  private parseSrtToSegments(srt: string): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    const blocks = srt.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length >= 3) {
        const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (timeMatch) {
          const startTime = this.timeToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
          const endTime = this.timeToSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
          const text = lines.slice(2).join(' ').trim();

          segments.push({
            id: `seg-${segments.length}`,
            startTime,
            endTime,
            text
          });
        }
      }
    }

    return segments;
  }

  private timeToSeconds(h: string, m: string, s: string, ms: string): number {
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
  }

  private getSeverityFromCategory(category: string): 'low' | 'medium' | 'high' {
    const highSeverity = ['hate', 'violence', 'political-violence', 'extremism'];
    const mediumSeverity = ['misinformation', 'conspiracy', 'propaganda'];

    if (highSeverity.includes(category?.toLowerCase())) return 'high';
    if (mediumSeverity.includes(category?.toLowerCase())) return 'medium';
    return 'low';
  }

  // Event handlers
  onClipChange(event: ClipChangeEvent) {
    console.log('Clip changed:', event);
    // Handle clip changes - save to backend if needed
  }

  async onMarkerChange(event: MarkerChangeEvent) {
    console.log('Marker changed:', event);
    const videoId = this.videoId();
    if (!videoId) return;

    try {
      if (event.type === 'add') {
        await firstValueFrom(
          this.http.post(`${this.API_BASE}/database/analysis-sections`, {
            videoId,
            startSeconds: event.marker.time,
            endSeconds: event.marker.endTime || event.marker.time,
            title: event.marker.message,
            category: event.marker.category || 'custom',
            source: 'user'
          })
        );
        // Reload markers
        await this.loadSections(videoId);
      } else if (event.type === 'update') {
        await firstValueFrom(
          this.http.put(`${this.API_BASE}/database/markers/${event.marker.id}`, {
            startSeconds: event.marker.time,
            endSeconds: event.marker.endTime,
            title: event.marker.message,
            category: event.marker.category
          })
        );
      } else if (event.type === 'delete') {
        await firstValueFrom(
          this.http.delete(`${this.API_BASE}/database/videos/${videoId}/sections/${event.marker.id}`)
        );
        // Remove from local state
        this.markers.set(this.markers().filter(m => m.id !== event.marker.id));
      }
    } catch (err) {
      console.error('Failed to update marker:', err);
    }
  }

  onExportRequest(event: ExportRequestEvent) {
    console.log('Export requested:', event);
    const videoId = this.videoId();
    const videoPath = this.videoPath();

    if (!videoId && !videoPath) {
      console.error('No video ID or path for export');
      return;
    }

    const dialogData: ExportDialogData = {
      sections: [],
      videoId: videoId || '',
      videoPath: videoPath,
      videoTitle: this.videoTitle(),
      selectionStart: event.selection?.start,
      selectionEnd: event.selection?.end
    };

    this.dialog.open(ExportDialogComponent, {
      data: dialogData,
      width: '500px',
      panelClass: 'export-dialog-panel'
    });
  }
}
