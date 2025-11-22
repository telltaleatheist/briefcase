import { Component, signal, computed, effect, ViewChild, OnInit, OnDestroy, inject, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ExportDialogComponent, ExportDialogData } from '../export-dialog/export-dialog.component';
import { NavigationService } from '../../services/navigation.service';
import { LibraryService, LibraryAnalysis, AnalysisSection as LibAnalysisSection } from '../../services/library.service';
import {
  VideoEditorState,
  VideoClip,
  VideoMetadata,
  EditorSettings,
  TimelineSection,
  CategoryFilter,
  ZoomState,
  AnalysisData,
  WaveformData,
  TimelineSelection,
  CustomMarker
} from '../../models/video-editor.model';
import { TranscriptionSegment } from '../../models/video-info.model';

// Sub-components
import { VideoPlayerComponent } from './video-player/video-player.component';
import { AnalysisPanelComponent } from './analysis-panel/analysis-panel.component';
import { TimelineRulerComponent } from './timeline/timeline-ruler/timeline-ruler.component';
import { TimelinePlayheadComponent } from './timeline/timeline-playhead/timeline-playhead.component';
import { TimelineTrackComponent } from './timeline/timeline-track/timeline-track.component';
import { TimelineZoomBarComponent } from './timeline/timeline-zoom-bar/timeline-zoom-bar.component';
import { ContextMenuComponent, ContextMenuAction, ContextMenuPosition } from './context-menu/context-menu.component';
import { MarkerDialogComponent, MarkerDialogData } from './marker-dialog/marker-dialog.component';

// Tool types for editor
export enum EditorTool {
  CURSOR = 'cursor',
  HIGHLIGHT = 'highlight'
}

// Category colors for different analysis types
const CATEGORY_COLORS: Record<string, string> = {
  'routine': '#3b82f6',           // Blue
  'shocking': '#f59e0b',          // Amber
  'political-violence': '#b91c1c', // Dark Red
  'hate': '#dc2626',              // Red
  'violence': '#ef4444',          // Red
  'extremism': '#f97316',         // Orange
  'misinformation': '#eab308',    // Yellow
  'conspiracy': '#a855f7',        // Purple
  'christian-nationalism': '#ec4899', // Pink
  'false-prophecy': '#8b5cf6',    // Violet
  // Legacy categories
  'hate speech': '#dc2626',
  'harmful content': '#f97316',
  'political': '#0d6efd',
  'educational': '#198754',
  'entertainment': '#6610f2',
  'news': '#0dcaf0',
  'false prophecy': '#8b5cf6',
  'prophecy': '#8b5cf6',
  'spiritual': '#20c997',
  'testimony': '#0dcaf0',
  'teaching': '#198754',
  'worship': '#6610f2',
  'prayer': '#ec4899',
  'christian nationalism': '#ec4899',
  'nationalism': '#ec4899',
  'political violence': '#b91c1c',
  'rhetoric': '#fd7e14',
  'propaganda': '#ffc107',
  'fear-mongering': '#e83e8c',
  'apocalyptic': '#6f42c1',
  'end times': '#6f42c1',
  'biblical': '#0d6efd',
  'scripture': '#0dcaf0',
  'sermon': '#198754',
  'commentary': '#17a2b8',
  'interview': '#6610f2',
  'discussion': '#20c997',
  'introduction': '#adb5bd',
  'conclusion': '#adb5bd',
  'music': '#e83e8c',
  'advertisement': '#ffc107',
  'promotion': '#fd7e14',
  'default': '#6c757d'
};

@Component({
  selector: 'app-video-editor',
  standalone: true,
  imports: [
    CommonModule,
    VideoPlayerComponent,
    AnalysisPanelComponent,
    TimelineRulerComponent,
    TimelinePlayheadComponent,
    TimelineTrackComponent,
    TimelineZoomBarComponent,
    ContextMenuComponent,
    MarkerDialogComponent,
    ExportDialogComponent
  ],
  templateUrl: './video-editor.component.html',
  styleUrls: ['./video-editor.component.scss']
})
export class VideoEditorComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private navService = inject(NavigationService);
  private libraryService = inject(LibraryService);
  private http = inject(HttpClient);

  private readonly API_BASE = 'http://localhost:3000/api';

  @ViewChild(VideoPlayerComponent) videoPlayer?: VideoPlayerComponent;

  // Keyboard shortcuts
  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    // Don't trigger if user is typing in an input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      this.togglePlayPause();
    }

    // Arrow keys to seek
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.skipBackward(5);
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.skipForward(5);
    }

    // Fullscreen with F key
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      this.toggleFullscreen();
    }

    // Zoom in/out with Cmd+Plus/Minus (or Ctrl on Windows)
    // Cmd+E for export dialog
    if (event.metaKey || event.ctrlKey) {
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        this.zoomIn();
      } else if (event.key === '-') {
        event.preventDefault();
        this.zoomOut();
      } else if (event.key === '0') {
        event.preventDefault();
        this.resetZoom();
      } else if (event.key === 'e' || event.key === 'E') {
        event.preventDefault();
        this.openExportDialog();
      }
    }

    // L to increase speed (and start playing if stopped)
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      this.increasePlaybackSpeed();
    }

    // J to decrease speed
    if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      this.decreasePlaybackSpeed();
    }

    // A for cursor tool
    if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      this.setTool(EditorTool.CURSOR);
    }

    // R for highlight/range tool
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      this.setTool(EditorTool.HIGHLIGHT);
    }

    // M for marker at playhead, Shift+M for marker on selection
    if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      if (event.shiftKey && this.highlightSelection()) {
        // Shift+M: Add marker for current selection
        const selection = this.highlightSelection()!;
        this.openMarkerDialog(selection.startTime, selection.endTime);
      } else {
        // M: Add marker at playhead
        this.addMarker();
      }
    }

    // Escape to close dialogs
    if (event.key === 'Escape') {
      if (this.showContextMenu$()) {
        this.showContextMenu$.set(false);
      }
      if (this.showMarkerDialog()) {
        this.showMarkerDialog.set(false);
      }
    }
  }

  // Bound wheel handler for proper cleanup
  private wheelHandler = (event: WheelEvent) => {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();

      // Calculate mouse position relative to timeline
      const timeline = (event.target as HTMLElement).closest('.timeline-area');
      if (timeline) {
        const rect = timeline.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mousePercent = mouseX / rect.width;

        if (event.deltaY < 0) {
          this.zoomIn(mousePercent);
        } else if (event.deltaY > 0) {
          this.zoomOut(mousePercent);
        }
      } else {
        // Not over timeline, zoom on playhead
        if (event.deltaY < 0) {
          this.zoomIn();
        } else if (event.deltaY > 0) {
          this.zoomOut();
        }
      }
    }
  };

  zoomIn(targetPercent?: number) {
    const currentZoom = this.editorState().zoomState;
    const currentTime = this.editorState().currentTime;
    const duration = this.editorState().duration;

    // Calculate max zoom: should be able to fit 5 seconds on screen
    // This scales with video duration
    const maxZoom = duration / 5; // e.g., 60s video = 12x max, 104s video = 20.8x max
    const newLevel = Math.min(currentZoom.level * 1.25, maxZoom);

    // Calculate the time we want to keep centered
    let centerTime: number;
    if (targetPercent !== undefined) {
      // Mouse position in timeline
      const currentVisibleDuration = duration / currentZoom.level;
      centerTime = currentZoom.offset + (targetPercent * currentVisibleDuration);
    } else {
      // Use playhead position
      centerTime = currentTime;
    }

    // Calculate new offset to keep centerTime at the same position
    const newVisibleDuration = duration / newLevel;
    let newOffset: number;
    if (targetPercent !== undefined) {
      newOffset = centerTime - (targetPercent * newVisibleDuration);
    } else {
      // Center on playhead (middle of screen)
      newOffset = centerTime - (newVisibleDuration / 2);
    }

    // Clamp offset to valid range
    const maxOffset = Math.max(0, duration - newVisibleDuration);
    newOffset = Math.max(0, Math.min(newOffset, maxOffset));

    this.onZoomChange({
      level: newLevel,
      offset: newOffset
    });
  }

  zoomOut(targetPercent?: number) {
    const currentZoom = this.editorState().zoomState;
    const currentTime = this.editorState().currentTime;
    const duration = this.editorState().duration;

    // Min zoom is always 1x (full video visible)
    const newLevel = Math.max(currentZoom.level / 1.25, 1);

    // Calculate the time we want to keep centered
    let centerTime: number;
    if (targetPercent !== undefined) {
      // Mouse position in timeline
      const currentVisibleDuration = duration / currentZoom.level;
      centerTime = currentZoom.offset + (targetPercent * currentVisibleDuration);
    } else {
      // Use playhead position
      centerTime = currentTime;
    }

    // Calculate new offset to keep centerTime at the same position
    const newVisibleDuration = duration / newLevel;
    let newOffset: number;
    if (targetPercent !== undefined) {
      newOffset = centerTime - (targetPercent * newVisibleDuration);
    } else {
      // Center on playhead (middle of screen)
      newOffset = centerTime - (newVisibleDuration / 2);
    }

    // Clamp offset to valid range
    const maxOffset = Math.max(0, duration - newVisibleDuration);
    newOffset = Math.max(0, Math.min(newOffset, maxOffset));

    this.onZoomChange({
      level: newLevel,
      offset: newOffset
    });
  }

  resetZoom() {
    this.onZoomChange({
      level: 1,
      offset: 0
    });
  }

  // Video data from route state
  videoId = signal<string | null>(null);
  private videoPath = signal<string | null>(null);
  private videoTitle = signal<string>('Untitled Video');

  // Track if video has analysis
  hasAnalysis = signal(false);

  // Loading state
  isLoading = signal(true);
  errorMessage = signal<string | null>(null);

  // Editor state
  editorState = signal<VideoEditorState>({
    currentTime: 0,
    duration: 120,
    isPlaying: false,
    volume: 1,
    playbackRate: 1,
    zoomState: { level: 1, offset: 0 }
  });

  // Current active tool
  currentTool = signal<EditorTool>(EditorTool.CURSOR);

  // Selection state for highlighting
  highlightSelection = signal<TimelineSelection | null>(null);
  isSelecting = signal(false);
  selectionStart = signal<number | null>(null);

  // Custom markers created by user
  customMarkers = signal<CustomMarker[]>([]);

  // Context menu state
  showContextMenu$ = signal(false);
  contextMenuPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });
  contextMenuActions = signal<ContextMenuAction[]>([]);

  // Marker dialog state
  showMarkerDialog = signal(false);
  markerDialogData = signal<MarkerDialogData | null>(null);

  // Export dialog
  showExportDialog = signal(false);
  exportDialogData = signal<ExportDialogData | null>(null);

  // Video URL
  videoUrl = signal<string | undefined>(undefined);

  // Timeline sections from analysis
  sections = signal<TimelineSection[]>([]);

  // Transcript for video
  transcript = signal<TranscriptionSegment[]>([]);

  // Category filters
  categoryFilters = signal<CategoryFilter[]>([]);

  // Analysis data
  analysisData = signal<AnalysisData | undefined>(undefined);

  // Waveform data
  waveformData = signal<WaveformData>({
    samples: [],
    sampleRate: 44100,
    duration: 0
  });

  // Video metadata
  metadata = signal<VideoMetadata>({
    filename: 'Loading...',
    format: '',
    resolution: '',
    frameRate: 0,
    bitrate: '',
    codec: '',
    fileSize: 0,
    duration: 0,
    createdDate: new Date()
  });

  // Editor settings
  settings = signal<EditorSettings>({
    snapToGrid: true,
    gridSize: 1,
    autoSave: true,
    waveformColor: '#ff6b35',
    timelineHeight: 150,
    showThumbnails: true,
    audioMonitoring: false
  });

  // Computed values
  formattedCurrentTime = computed(() => this.formatTime(this.editorState().currentTime));
  formattedDuration = computed(() => this.formatTime(this.editorState().duration));
  timelineProgress = computed(() => {
    const state = this.editorState();
    return (state.currentTime / state.duration) * 100;
  });

  // Filtered sections based on category filters
  filteredSections = computed(() => {
    const filters = this.categoryFilters();
    const allSections = this.sections();

    if (filters.length === 0) return allSections;

    const enabledCategories = new Set(
      filters.filter(f => f.enabled).map(f => f.category)
    );

    return allSections.filter(s =>
      enabledCategories.has(s.category.toLowerCase())
    );
  });

  // Sidebar visibility
  showAnalysisSidebar = signal(true);

  // Timeline resizing
  timelineHeight = signal(280); // Increased default height
  isResizing = signal(false);

  // Fullscreen mode
  isFullscreen = signal(false);
  showTimelineInFullscreen = signal(true);
  private fullscreenTimeout?: any;

  private playbackInterval?: any;

  // Track playing state separately to avoid effect re-triggering
  private wasPlaying = false;

  constructor() {
    // Initialize category filters from sections with error handling
    effect(() => {
      try {
        const sections = this.sections();
        this.updateCategoryFilters(sections);
      } catch (error) {
        console.error('Error updating category filters:', error);
      }
    }, { allowSignalWrites: true });

    // Set up playback effect - only react to isPlaying changes
    effect(() => {
      try {
        const isPlaying = this.editorState().isPlaying;
        if (isPlaying !== this.wasPlaying) {
          this.wasPlaying = isPlaying;
          if (isPlaying) {
            this.startPlayback();
            // Hide timeline in fullscreen when playing
            if (this.isFullscreen()) {
              this.hideTimelineAfterDelay();
            }
          } else {
            this.stopPlayback();
            // Show timeline in fullscreen when paused
            if (this.isFullscreen()) {
              this.showTimelineInFullscreen.set(true);
              this.clearFullscreenTimeout();
            }
          }
        }
      } catch (error) {
        console.error('Error in playback effect:', error);
        this.stopPlayback();
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit() {
    // Hide the side navigation when entering the editor
    this.navService.hideNav();

    // Add wheel listener with passive: false to allow preventDefault
    window.addEventListener('wheel', this.wheelHandler, { passive: false });

    // Add fullscreen event listeners
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.addEventListener('mousemove', this.onMouseMoveInFullscreen);

    // Get video data from route state
    const navigation = this.router.getCurrentNavigation();
    const state = navigation?.extras?.state || history.state;
    const videoEditorData = state?.videoEditorData;

    if (videoEditorData) {
      this.videoId.set(videoEditorData.videoId);
      this.videoPath.set(videoEditorData.videoPath || null);
      this.videoTitle.set(videoEditorData.videoTitle || 'Untitled Video');

      // Set video URL for streaming
      if (videoEditorData.videoId) {
        this.videoUrl.set(`${this.API_BASE}/database/videos/${videoEditorData.videoId}/stream`);
      }

      // Update metadata filename
      this.metadata.update(m => ({
        ...m,
        filename: videoEditorData.videoTitle || 'Untitled Video'
      }));

      // Load video details and analysis
      this.loadVideoData(videoEditorData.videoId);
    } else {
      this.isLoading.set(false);
      this.errorMessage.set('No video data provided. Please select a video from the library.');
      this.hasAnalysis.set(false);
    }
  }

  private async loadVideoData(videoId: string) {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);

      // Load video details with timeout protection
      const timeoutId = setTimeout(() => {
        console.error('Video loading timed out');
        this.errorMessage.set('Video loading timed out. Please try again.');
        this.isLoading.set(false);
      }, 30000); // 30 second timeout

      // Load video details
      this.libraryService.getVideo(videoId).subscribe({
        next: (response) => {
          clearTimeout(timeoutId);
          if (response.success && response.data) {
            const video = response.data;
            this.metadata.update(m => ({
              ...m,
              filename: video.name,
              fileSize: video.size || 0
            }));

            // Load transcript separately (non-blocking)
            this.loadTranscriptForVideo(videoId).catch(err => {
              console.warn('Transcript loading failed, continuing without it:', err);
            });

            // If video has analysis, try to load it
            if (video.hasAnalysis) {
              this.loadAnalysisForVideo(videoId).catch(err => {
                console.warn('Analysis loading failed, continuing without it:', err);
                this.hasAnalysis.set(false);
              });
            } else {
              // No analysis - show generate button
              this.hasAnalysis.set(false);
              this.sections.set([]);
              this.analysisData.set(undefined);
            }
          } else {
            this.hasAnalysis.set(false);
          }
          this.isLoading.set(false);
        },
        error: (error) => {
          clearTimeout(timeoutId);
          console.error('Failed to load video details:', error);
          this.hasAnalysis.set(false);
          this.isLoading.set(false);
        }
      });

    } catch (error) {
      console.error('Failed to load video data:', error);
      this.errorMessage.set('Failed to load video data. Please try again.');
      this.isLoading.set(false);
    }
  }

  private async loadTranscriptForVideo(videoId: string) {
    try {
      const data = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/transcript`)
      );

      if (data && data.transcript && Array.isArray(data.transcript)) {
        this.transcript.set(data.transcript);
      } else if (data && Array.isArray(data)) {
        this.transcript.set(data);
      } else if (data && data.srt_format) {
        // Parse SRT format into segments
        const segments = this.parseSrtToSegments(data.srt_format);
        this.transcript.set(segments);
      } else {
        this.transcript.set([]);
      }
    } catch (error) {
      console.log('Failed to load transcript:', error);
      this.transcript.set([]);
    }
  }

  private parseSrtToSegments(srtContent: string): TranscriptionSegment[] {
    const segments: TranscriptionSegment[] = [];
    const blocks = srtContent.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;

      // Parse timestamp line (e.g., "00:00:00,000 --> 00:00:05,000")
      const timestampLine = lines[1];
      const timestampMatch = timestampLine.match(
        /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
      );

      if (!timestampMatch) continue;

      const startTime =
        parseInt(timestampMatch[1]) * 3600 +
        parseInt(timestampMatch[2]) * 60 +
        parseInt(timestampMatch[3]) +
        parseInt(timestampMatch[4]) / 1000;

      const endTime =
        parseInt(timestampMatch[5]) * 3600 +
        parseInt(timestampMatch[6]) * 60 +
        parseInt(timestampMatch[7]) +
        parseInt(timestampMatch[8]) / 1000;

      // Text is everything after the timestamp line
      const text = lines.slice(2).join(' ').trim();

      segments.push({
        id: `segment-${segments.length}`,
        startTime,
        endTime,
        text
      });
    }

    return segments;
  }

  private async loadAnalysisForVideo(videoId: string) {
    try {
      // Fetch analysis from correct endpoint
      const analysisData = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/analysis`)
      );

      if (analysisData && !analysisData.error) {
        // Also fetch sections
        const sectionsData = await firstValueFrom(
          this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/sections`)
        );

        this.processAnalysisFromDatabase(analysisData, sectionsData?.sections || []);
      } else {
        console.log('No analysis found for video');
      }
    } catch (error: any) {
      console.log('Failed to load analysis:', error);
    }
  }

  private processAnalysisFromDatabase(analysis: any, sections: any[]) {
    // Convert database sections to timeline sections
    const timelineSections: TimelineSection[] = sections.map((section: any, index: number) => ({
      id: section.id || `section-${index}`,
      startTime: section.start_seconds || 0,
      endTime: section.end_seconds || section.start_seconds + 10,
      category: section.category || 'unknown',
      description: section.description || section.content || '',
      color: CATEGORY_COLORS[section.category?.toLowerCase()] || CATEGORY_COLORS['default']
    }));

    this.sections.set(timelineSections);
    this.hasAnalysis.set(true);

    // Set analysis data for sidebar
    this.analysisData.set({
      id: analysis.id || 'analysis',
      title: analysis.suggested_title || analysis.title || this.videoTitle(),
      summary: analysis.description || analysis.summary || '',
      sections: timelineSections.map(s => ({
        timeRange: `${this.formatTime(s.startTime)} - ${this.formatTime(s.endTime)}`,
        startSeconds: s.startTime,
        endSeconds: s.endTime,
        category: s.category,
        description: s.description
      })),
      quotes: analysis.quotes || []
    });

    // Update metadata
    if (analysis.suggested_title) {
      this.metadata.update(m => ({
        ...m,
        filename: analysis.suggested_title
      }));
    }
  }

  private setDemoSections() {
    // Set demo sections for visualization
    const demoSections: TimelineSection[] = [
      {
        id: '1',
        startTime: 5,
        endTime: 15,
        category: 'violence',
        description: 'Scene contains violent imagery',
        color: CATEGORY_COLORS['violence']
      },
      {
        id: '2',
        startTime: 30,
        endTime: 45,
        category: 'misinformation',
        description: 'Claims without factual basis',
        color: CATEGORY_COLORS['misinformation']
      },
      {
        id: '3',
        startTime: 60,
        endTime: 80,
        category: 'educational',
        description: 'Educational content',
        color: CATEGORY_COLORS['educational']
      }
    ];
    this.sections.set(demoSections);

    // Set demo analysis data
    this.analysisData.set({
      id: 'demo',
      title: 'Demo Analysis',
      summary: 'This is demo data. Run analysis to see actual results.',
      sections: demoSections.map(s => ({
        timeRange: `${this.formatTime(s.startTime)} - ${this.formatTime(s.endTime)}`,
        startSeconds: s.startTime,
        endSeconds: s.endTime,
        category: s.category,
        description: s.description
      })),
      quotes: []
    });
  }

  private processAnalysisData(analysis: LibraryAnalysis) {
    // Parse the analysis file if it exists
    if (analysis.files?.analysis) {
      // The analysis file path needs to be fetched and parsed
      this.fetchAndParseAnalysis(analysis);
    }

    // Set metadata
    this.metadata.update(m => ({
      ...m,
      filename: analysis.title || m.filename,
      duration: analysis.video?.durationSeconds || m.duration
    }));

    // Update duration in editor state
    if (analysis.video?.durationSeconds) {
      this.editorState.update(state => ({
        ...state,
        duration: analysis.video.durationSeconds!
      }));

      // Waveform will be generated when video loads via onVideoDurationChange
    }
  }

  private async fetchAndParseAnalysis(analysis: LibraryAnalysis) {
    try {
      // Fetch the analysis JSON file
      const analysisUrl = `${this.API_BASE}/library/analyses/${analysis.id}/analysis`;
      const analysisJson = await firstValueFrom(
        this.http.get<any>(analysisUrl)
      );

      // Convert to timeline sections
      const timelineSections: TimelineSection[] = [];

      if (analysisJson.analysis?.sections) {
        analysisJson.analysis.sections.forEach((section: any, index: number) => {
          const startSeconds = this.parseTimeToSeconds(section.timeRange?.split(' - ')[0] || '0:00');
          const endSeconds = this.parseTimeToSeconds(section.timeRange?.split(' - ')[1] || '0:00') || startSeconds + 10;

          timelineSections.push({
            id: `section-${index}`,
            startTime: startSeconds,
            endTime: endSeconds,
            category: section.category || 'unknown',
            description: section.description || '',
            color: CATEGORY_COLORS[section.category?.toLowerCase()] || CATEGORY_COLORS['default']
          });
        });
      }

      this.sections.set(timelineSections);

      // Set analysis data for sidebar
      this.analysisData.set({
        id: analysis.id,
        title: analysisJson.analysis?.title || analysis.title,
        summary: analysisJson.analysis?.summary,
        sections: analysisJson.analysis?.sections || [],
        quotes: analysisJson.analysis?.quotes || []
      });
    } catch (error) {
      console.error('Failed to fetch analysis:', error);
    }
  }

  private parseTimeToSeconds(timeStr: string): number {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(p => parseInt(p, 10));
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
  }

  ngOnDestroy() {
    // Show the side navigation when leaving the editor
    this.navService.showNav();
    this.stopPlayback();

    // Remove event listeners
    window.removeEventListener('wheel', this.wheelHandler);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange);
    document.removeEventListener('mousemove', this.onMouseMoveInFullscreen);

    // Clean up timeline dragging listeners
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);

    this.clearFullscreenTimeout();
  }

  // Navigate back to library
  goBack() {
    this.router.navigate(['/']);
  }

  private updateCategoryFilters(sections: TimelineSection[]): void {
    const categories = new Map<string, CategoryFilter>();

    sections.forEach(section => {
      const category = section.category.toLowerCase();
      if (!categories.has(category)) {
        categories.set(category, {
          category,
          label: section.category,
          color: section.color,
          enabled: true
        });
      }
    });

    const filters = Array.from(categories.values())
      .sort((a, b) => a.label.localeCompare(b.label));

    this.categoryFilters.set(filters);
  }

  private startPlayback() {
    this.stopPlayback();
    // Add safety check to prevent runaway intervals
    let intervalCount = 0;
    this.playbackInterval = setInterval(() => {
      intervalCount++;

      // Safety: stop after 1 hour of continuous playback
      if (intervalCount > 36000) {
        console.warn('Playback interval safety limit reached, stopping');
        this.stopPlayback();
        this.togglePlayPause();
        return;
      }

      const state = this.editorState();
      let newTime = state.currentTime + (0.1 * state.playbackRate);

      if (newTime >= state.duration) {
        newTime = state.duration;
        this.togglePlayPause();
      }

      this.updateCurrentTime(newTime);
    }, 100);
  }

  private stopPlayback() {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = undefined;
    }
  }

  // Playback controls
  togglePlayPause() {
    this.editorState.update(state => ({
      ...state,
      isPlaying: !state.isPlaying
    }));
  }

  updateCurrentTime(time: number) {
    this.editorState.update(state => ({
      ...state,
      currentTime: Math.max(0, Math.min(time, state.duration))
    }));
  }

  seekTo(time: number) {
    this.updateCurrentTime(time);
    if (this.videoPlayer) {
      this.videoPlayer.seekTo(time);
    }
  }

  skipBackward(seconds: number = 5) {
    const state = this.editorState();
    this.seekTo(state.currentTime - seconds);
  }

  skipForward(seconds: number = 5) {
    const state = this.editorState();
    this.seekTo(state.currentTime + seconds);
  }

  setPlaybackRate(rate: number) {
    this.editorState.update(state => ({
      ...state,
      playbackRate: rate
    }));
  }

  // Increase playback speed with L key
  increasePlaybackSpeed() {
    const currentRate = this.editorState().playbackRate;
    const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

    // If not playing, start playing first
    if (!this.editorState().isPlaying) {
      this.startPlayback();
      return;
    }

    // Find next higher speed
    let nextSpeed = currentRate;
    for (const speed of speeds) {
      if (speed > currentRate) {
        nextSpeed = speed;
        break;
      }
    }

    // Max out at 4x
    if (currentRate >= 4) {
      nextSpeed = 4;
    }

    this.setPlaybackRate(nextSpeed);
  }

  // Decrease playback speed with J key
  decreasePlaybackSpeed() {
    const currentRate = this.editorState().playbackRate;
    const speeds = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

    // Find next lower speed
    let nextSpeed = currentRate;
    for (let i = speeds.length - 1; i >= 0; i--) {
      if (speeds[i] < currentRate) {
        nextSpeed = speeds[i];
        break;
      }
    }

    // Min out at 0.25x
    if (currentRate <= 0.25) {
      nextSpeed = 0.25;
    }

    this.setPlaybackRate(nextSpeed);
  }

  setVolume(volume: number) {
    this.editorState.update(state => ({
      ...state,
      volume: Math.max(0, Math.min(1, volume))
    }));
  }

  // Tool management
  setTool(tool: EditorTool) {
    this.currentTool.set(tool);
    console.log('Switched to tool:', tool);
  }

  setToolCursor() {
    this.setTool(EditorTool.CURSOR);
  }

  setToolHighlight() {
    this.setTool(EditorTool.HIGHLIGHT);
  }

  // Get time from mouse position on timeline
  private getTimeFromMousePosition(event: MouseEvent): number | null {
    const target = event.currentTarget as HTMLElement;
    // Look for the timeline track container which has the margins
    const trackContainer = target.querySelector('.timeline-track-container') ||
                          target.querySelector('app-timeline-track');
    if (!trackContainer) return null;

    const containerRect = trackContainer.getBoundingClientRect();
    const clickX = event.clientX - containerRect.left;
    const trackWidth = containerRect.width;

    if (clickX < 0 || clickX > trackWidth || trackWidth <= 0) return null;

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;
    const percentage = clickX / trackWidth;

    return state.zoomState.offset + (percentage * visibleDuration);
  }

  // Get time from mouse position for document-level events
  private getTimeFromMousePositionDocument(event: MouseEvent): number | null {
    const timelineElement = document.querySelector('.track-content') as HTMLElement;
    if (!timelineElement) return null;

    // Look for the timeline track container which has the margins
    const trackContainer = timelineElement.querySelector('.timeline-track-container') ||
                          timelineElement.querySelector('app-timeline-track');
    if (!trackContainer) return null;

    const containerRect = trackContainer.getBoundingClientRect();
    const clickX = event.clientX - containerRect.left;
    const trackWidth = containerRect.width;

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;
    const percentage = Math.max(0, Math.min(1, clickX / trackWidth));

    return state.zoomState.offset + (percentage * visibleDuration);
  }

  // Show context menu for highlighted selection
  private showContextMenu(event: MouseEvent) {
    const actions: ContextMenuAction[] = [
      {
        id: 'export',
        label: 'Export Selection',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'
      },
      {
        id: 'add-marker',
        label: 'Add Marker',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L12 22"/><path d="M17 7L12 2 7 7"/></svg>'
      },
      { id: 'divider', label: '', divider: true },
      {
        id: 'clear',
        label: 'Clear Selection',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
      }
    ];

    this.contextMenuActions.set(actions);
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.showContextMenu$.set(true);
  }

  // Handle context menu action
  onContextMenuAction(actionId: string) {
    this.showContextMenu$.set(false);

    switch (actionId) {
      case 'export':
        this.openExportDialog();
        break;
      case 'add-marker':
        this.addMarker();
        break;
      case 'clear':
        this.clearSelection();
        break;
    }
  }

  // Close context menu
  onContextMenuClose() {
    this.showContextMenu$.set(false);
  }

  // Set in-point at current playhead position
  setInPoint() {
    const currentTime = this.editorState().currentTime;
    const selection = this.highlightSelection();

    if (selection) {
      // Update existing selection start
      this.highlightSelection.set({
        startTime: currentTime,
        endTime: Math.max(currentTime, selection.endTime)
      });
    } else {
      // Create new selection starting at current time
      this.highlightSelection.set({
        startTime: currentTime,
        endTime: currentTime
      });
    }
  }

  // Set out-point at current playhead position
  setOutPoint() {
    const currentTime = this.editorState().currentTime;
    const selection = this.highlightSelection();

    if (selection) {
      // Update existing selection end
      this.highlightSelection.set({
        startTime: Math.min(selection.startTime, currentTime),
        endTime: currentTime
      });
    } else {
      // Create new selection ending at current time
      this.highlightSelection.set({
        startTime: currentTime,
        endTime: currentTime
      });
    }
  }

  // Clear current selection
  clearSelection() {
    this.highlightSelection.set(null);
    this.selectionStart.set(null);
    this.isSelecting.set(false);
  }

  // Track which selection handle is being dragged
  private draggingHandle: 'left' | 'right' | null = null;

  // Start dragging a selection handle
  onSelectionHandleStart(event: MouseEvent, handle: 'left' | 'right') {
    event.preventDefault();
    event.stopPropagation();

    this.draggingHandle = handle;
    document.body.style.cursor = 'ew-resize';

    const onMouseMove = (e: MouseEvent) => {
      const time = this.getTimeFromMousePositionDocument(e);
      if (time === null) return;

      const selection = this.highlightSelection();
      if (!selection) return;

      if (this.draggingHandle === 'left') {
        // Dragging left handle - update start time
        const newStart = Math.min(time, selection.endTime - 0.1);
        this.highlightSelection.set({
          startTime: Math.max(0, newStart),
          endTime: selection.endTime
        });
        // Make playhead follow the handle
        this.seekTo(Math.max(0, newStart));
      } else if (this.draggingHandle === 'right') {
        // Dragging right handle - update end time
        const newEnd = Math.max(time, selection.startTime + 0.1);
        this.highlightSelection.set({
          startTime: selection.startTime,
          endTime: Math.min(this.editorState().duration, newEnd)
        });
        // Make playhead follow the handle
        this.seekTo(Math.min(this.editorState().duration, newEnd));
      }
    };

    const onMouseUp = () => {
      this.draggingHandle = null;
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Handle dragging the entire selection to move it
  onSelectionDragStart(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const selection = this.highlightSelection();
    if (!selection) return;

    const startTime = this.getTimeFromMousePositionDocument(event);
    if (startTime === null) return;

    const selectionDuration = selection.endTime - selection.startTime;
    const initialOffset = startTime - selection.startTime;

    document.body.style.cursor = 'move';

    const onMouseMove = (e: MouseEvent) => {
      const time = this.getTimeFromMousePositionDocument(e);
      if (time === null) return;

      // Calculate new position based on where we grabbed
      const newStart = time - initialOffset;
      const clampedStart = Math.max(0, Math.min(this.editorState().duration - selectionDuration, newStart));
      const clampedEnd = clampedStart + selectionDuration;

      this.highlightSelection.set({
        startTime: clampedStart,
        endTime: clampedEnd
      });
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Add a marker to the current selection or current time
  addMarker() {
    const selection = this.highlightSelection();
    const videoId = this.videoId();

    if (!videoId) {
      console.error('No video ID available');
      return;
    }

    if (selection) {
      // Add marker for selected range
      this.openMarkerDialog(selection.startTime, selection.endTime);
    } else {
      // Add marker at current playhead position
      const currentTime = this.editorState().currentTime;
      this.openMarkerDialog(currentTime);
    }
  }

  // Open the marker dialog
  private openMarkerDialog(startTime: number, endTime?: number) {
    const videoId = this.videoId();
    if (!videoId) return;

    this.markerDialogData.set({
      videoId,
      startTime,
      endTime
    });
    this.showMarkerDialog.set(true);
  }

  // Handle marker dialog save
  async onMarkerSave(marker: Partial<CustomMarker>) {
    this.showMarkerDialog.set(false);

    try {
      const result = await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/database/analysis-sections`, {
          videoId: marker.videoId,
          startSeconds: marker.startTime,
          endSeconds: marker.endTime || marker.startTime,
          title: marker.message,
          description: marker.message,
          category: marker.category || 'marker'
        })
      );

      if (result.success) {
        // Refresh sections to include new marker
        await this.loadAnalysisForVideo(this.videoId()!);
        // Clear selection after adding marker
        this.clearSelection();
      } else {
        console.error('Failed to save marker:', result.error);
      }
    } catch (error) {
      console.error('Error saving marker:', error);
    }
  }

  // Handle marker dialog cancel
  onMarkerCancel() {
    this.showMarkerDialog.set(false);
  }

  // Handle marker delete
  async onMarkerDelete(markerId: string) {
    this.showMarkerDialog.set(false);

    const videoId = this.videoId();
    if (!videoId) return;

    try {
      const result = await firstValueFrom(
        this.http.delete<any>(`${this.API_BASE}/database/videos/${videoId}/sections/${markerId}`)
      );

      if (result.success) {
        // Refresh sections
        await this.loadAnalysisForVideo(this.videoId()!);
      } else {
        console.error('Failed to delete marker:', result.error);
      }
    } catch (error) {
      console.error('Error deleting marker:', error);
    }
  }

  // Open export dialog
  openExportDialog() {
    const videoId = this.videoId();
    const videoPath = this.videoPath();
    const videoTitle = this.metadata().filename;

    if (!videoId || !videoPath) {
      console.error('Cannot open export dialog: missing video info');
      return;
    }

    // Prepare sections for export
    const sections = this.filteredSections().map(section => ({
      id: section.id,
      category: section.category,
      description: section.description,
      startSeconds: section.startTime,
      endSeconds: section.endTime,
      timeRange: `${this.formatTime(section.startTime)} - ${this.formatTime(section.endTime)}`
    }));

    // Get current selection if any
    const selection = this.highlightSelection();

    this.exportDialogData.set({
      sections,
      selectionStart: selection?.startTime,
      selectionEnd: selection?.endTime,
      videoId,
      videoPath,
      videoTitle
    });
    this.showExportDialog.set(true);
  }

  onExportDialogClose() {
    this.showExportDialog.set(false);
    this.exportDialogData.set(null);
  }

  // Calculate selection overlay left position
  getSelectionLeft(): number {
    const selection = this.highlightSelection();
    if (!selection) return 0;

    const state = this.editorState();
    const visibleStart = state.zoomState.offset;
    const visibleDuration = state.duration / state.zoomState.level;

    const relativeStart = selection.startTime - visibleStart;
    return (relativeStart / visibleDuration) * 100;
  }

  // Calculate selection overlay width
  getSelectionWidth(): number {
    const selection = this.highlightSelection();
    if (!selection) return 0;

    const state = this.editorState();
    const visibleDuration = state.duration / state.zoomState.level;

    const duration = selection.endTime - selection.startTime;
    return (duration / visibleDuration) * 100;
  }

  // Zoom controls
  onZoomChange(zoomState: ZoomState) {
    this.editorState.update(state => ({
      ...state,
      zoomState
    }));
  }

  // Section interaction
  onSectionClick(section: TimelineSection) {
    this.editorState.update(state => ({
      ...state,
      selectedSection: section
    }));
    // Seek to section start
    this.seekTo(section.startTime);
  }

  onSectionHover(section: TimelineSection | null) {
    // Could show tooltip or highlight
  }

  // Delete section from analysis panel
  onSectionDeleteFromPanel(sectionId: string) {
    this.onMarkerDelete(sectionId);
  }

  // Category filter toggle
  onFilterToggle(category: string) {
    this.categoryFilters.update(filters =>
      filters.map(f =>
        f.category === category
          ? { ...f, enabled: !f.enabled }
          : f
      )
    );
  }

  // Sidebar toggle
  toggleAnalysisSidebar() {
    this.showAnalysisSidebar.update(v => !v);
  }

  // Fullscreen toggle
  async toggleFullscreen() {
    const element = document.documentElement;

    if (!this.isFullscreen()) {
      try {
        if (element.requestFullscreen) {
          await element.requestFullscreen();
        } else if ((element as any).webkitRequestFullscreen) {
          await (element as any).webkitRequestFullscreen();
        }
      } catch (err) {
        console.error('Failed to enter fullscreen:', err);
      }
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
      } catch (err) {
        console.error('Failed to exit fullscreen:', err);
      }
    }
  }

  // Handle fullscreen change events
  private onFullscreenChange = () => {
    const isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
    this.isFullscreen.set(isFs);

    if (isFs) {
      // In fullscreen, hide timeline when playing
      if (this.editorState().isPlaying) {
        this.hideTimelineAfterDelay();
      }
    } else {
      // Exiting fullscreen, always show timeline
      this.showTimelineInFullscreen.set(true);
      this.clearFullscreenTimeout();
    }
  };

  // Handle mouse movement in fullscreen to show timeline
  private onMouseMoveInFullscreen = () => {
    if (!this.isFullscreen()) return;

    this.showTimelineInFullscreen.set(true);

    // Hide after delay if playing
    if (this.editorState().isPlaying) {
      this.hideTimelineAfterDelay();
    }
  };

  private hideTimelineAfterDelay() {
    this.clearFullscreenTimeout();
    this.fullscreenTimeout = setTimeout(() => {
      if (this.isFullscreen() && this.editorState().isPlaying) {
        this.showTimelineInFullscreen.set(false);
      }
    }, 2000);
  }

  private clearFullscreenTimeout() {
    if (this.fullscreenTimeout) {
      clearTimeout(this.fullscreenTimeout);
      this.fullscreenTimeout = undefined;
    }
  }

  // Dragging state
  private isDraggingTimeline = false;

  // Timeline mouse down to start seeking or selection
  onTimelineMouseDown(event: MouseEvent) {
    event.preventDefault(); // Prevent text selection

    if (this.currentTool() === EditorTool.HIGHLIGHT) {
      // Start selection for highlight tool
      const time = this.getTimeFromMousePosition(event);
      if (time !== null) {
        this.selectionStart.set(time);
        this.isSelecting.set(true);
        this.highlightSelection.set({ startTime: time, endTime: time });

        document.body.style.cursor = 'crosshair';
        document.addEventListener('mousemove', this.onDocumentMouseMove);
        document.addEventListener('mouseup', this.onDocumentMouseUp);
      }
    } else {
      // Cursor tool - seek to position
      this.isDraggingTimeline = true;
      this.seekToMousePosition(event);

      document.body.style.cursor = 'ew-resize';
      document.addEventListener('mousemove', this.onDocumentMouseMove);
      document.addEventListener('mouseup', this.onDocumentMouseUp);
    }
  }

  // Document mouse move while dragging
  private onDocumentMouseMove = (event: MouseEvent) => {
    if (this.isSelecting()) {
      // Update selection for highlight tool
      const time = this.getTimeFromMousePositionDocument(event);
      if (time !== null && this.selectionStart() !== null) {
        const startTime = Math.min(this.selectionStart()!, time);
        const endTime = Math.max(this.selectionStart()!, time);
        this.highlightSelection.set({ startTime, endTime });
      }
    } else if (this.isDraggingTimeline) {
      // Find the timeline element
      const timelineElement = document.querySelector('.track-content') as HTMLElement;
      if (timelineElement) {
        this.seekToMousePosition(event, timelineElement);
      }
    }
  }

  // Document mouse up to stop dragging
  private onDocumentMouseUp = () => {
    if (this.isSelecting()) {
      this.isSelecting.set(false);

      // If selection is too small, clear it
      const selection = this.highlightSelection();
      if (selection && Math.abs(selection.endTime - selection.startTime) < 0.1) {
        this.highlightSelection.set(null);
      }
    }

    this.isDraggingTimeline = false;
    document.body.style.cursor = ''; // Reset cursor
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
  }

  // Timeline click to seek (now calls the common seek method)
  onTimelineClick(event: MouseEvent) {
    // Handle right-click for context menu
    if (event.button === 2 && this.highlightSelection()) {
      event.preventDefault();
      this.showContextMenu(event);
      return;
    }

    // Only seek if not dragging and using cursor tool
    if (!this.isDraggingTimeline && this.currentTool() === EditorTool.CURSOR) {
      this.seekToMousePosition(event);
    }
  }

  // Common method to seek based on mouse position
  private seekToMousePosition(event: MouseEvent, element?: HTMLElement) {
    const target = element || event.currentTarget as HTMLElement;

    // Look for the timeline track container which has the actual margins
    const trackContainer = target.querySelector('.timeline-track-container') ||
                          target.querySelector('app-timeline-track');
    if (!trackContainer) return;

    const containerRect = trackContainer.getBoundingClientRect();
    const clickX = event.clientX - containerRect.left;
    const trackWidth = containerRect.width;

    if (clickX < 0 || clickX > trackWidth || trackWidth <= 0) return;

    const percentage = clickX / trackWidth;
    const zoomState = this.editorState().zoomState;
    const visibleDuration = this.editorState().duration / zoomState.level;
    const time = zoomState.offset + (percentage * visibleDuration);

    this.seekTo(Math.max(0, Math.min(time, this.editorState().duration)));
  }

  // Timeline resize
  onResizeStart(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isResizing.set(true);

    // Add visual feedback
    document.body.style.cursor = 'ns-resize';

    const startY = event.clientY;
    const startHeight = this.timelineHeight();

    const onMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const deltaY = startY - e.clientY;
      const newHeight = Math.max(150, Math.min(600, startHeight + deltaY));
      this.timelineHeight.set(newHeight);
    };

    const onMouseUp = () => {
      this.isResizing.set(false);
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Video player events
  onVideoTimeUpdate(time: number) {
    this.updateCurrentTime(time);
  }

  async onVideoDurationChange(duration: number) {
    // Don't set duration to 0 - keep default if video fails to load
    if (duration <= 0) return;

    this.editorState.update(state => ({
      ...state,
      duration
    }));
    this.metadata.update(m => ({
      ...m,
      duration
    }));

    // Phase 1: Show demo waveform immediately for instant feedback
    this.waveformData.set({
      samples: this.generateDemoWaveform(duration),
      sampleRate: 44100,
      duration
    });

    // Phase 2: Generate quick low-res waveform from client-side (real audio data)
    const url = this.videoUrl();
    if (url) {
      this.generateQuickClientWaveform(url, duration);
    }

    // Phase 3: Load high-quality waveform from server in background
    const videoId = this.videoId();
    if (videoId) {
      this.loadWaveformFromServer(videoId, duration);
    }
  }

  onVideoPlayStateChange(isPlaying: boolean) {
    this.editorState.update(state => ({
      ...state,
      isPlaying
    }));
  }

  onVideoEnded() {
    this.editorState.update(state => ({
      ...state,
      isPlaying: false,
      currentTime: 0
    }));
  }

  // Utilities
  formatTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  // Phase 2: Generate quick low-resolution waveform from client-side
  // Only samples every N seconds to avoid memory issues
  private async generateQuickClientWaveform(videoUrl: string, duration: number): Promise<void> {
    try {
      // Skip client-side generation for very large files (>3 hours)
      if (duration > 10800) { // > 3 hours
        console.log('Skipping client-side waveform for long video, waiting for server...');
        return;
      }

      console.log('Generating quick client-side waveform...');

      // Fetch only the first 3MB of the video to generate initial waveform
      const response = await fetch(videoUrl, {
        headers: {
          'Range': `bytes=0-${3 * 1024 * 1024}` // First 3MB
        }
      });

      if (!response.ok || response.status === 416) {
        console.log('Range requests not supported, skipping client-side waveform');
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      try {
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const rawData = audioBuffer.getChannelData(0);

        // Generate initial waveform - much higher resolution than before
        // Aim for ~10 samples per second for good initial detail
        const targetSamples = Math.min(Math.floor(duration * 10), 5000); // Up to 5000 samples
        const blockSize = Math.floor(rawData.length / targetSamples);

        const samples: number[] = [];
        for (let i = 0; i < targetSamples; i++) {
          const blockStart = blockSize * i;
          let sum = 0;
          const actualBlockSize = Math.min(blockSize, rawData.length - blockStart);

          for (let j = 0; j < actualBlockSize; j++) {
            sum += Math.abs(rawData[blockStart + j]);
          }
          samples.push(sum / actualBlockSize);
        }

        // Normalize
        const max = Math.max(...samples, 0.01);
        const normalizedSamples = samples.map(s => s / max);

        console.log(`✓ Generated ${normalizedSamples.length} client-side samples from partial audio`);

        // Update waveform with real (but low-res) data
        this.waveformData.set({
          samples: normalizedSamples,
          sampleRate: 44100,
          duration
        });

        await audioContext.close();
      } catch (decodeError) {
        // Expected for formats that don't support partial decoding
        console.log('Partial decode not supported for this format, waiting for server waveform...');
        await audioContext.close();
      }
    } catch (error) {
      // Silently fail - server waveform will handle it
      console.log('Client-side waveform skipped, using server waveform');
    }
  }

  // Phase 3: Load high-quality waveform from server with progressive updates
  private async loadWaveformFromServer(videoId: string, duration: number): Promise<void> {
    try {
      console.log(`🎵 Starting progressive waveform generation...`);

      // Start generation with progressive mode - request samples based on duration
      // Target: 2000 samples per 60 seconds for maximum granularity
      const samplesPerMinute = 2000;
      const targetSamples = Math.ceil((duration / 60) * samplesPerMinute);
      console.log(`Requesting ${targetSamples} samples (${samplesPerMinute} per minute for ${duration.toFixed(1)}s video)`);

      const generationPromise = firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/waveform?samples=${targetSamples}&progressive=true`)
      );

      // Poll for progress updates every 1 second
      const pollInterval = setInterval(async () => {
        try {
          const progressResponse = await firstValueFrom(
            this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/waveform/progress`)
          );

          if (progressResponse.success && progressResponse.data) {
            const { progress, status, partial } = progressResponse.data;
            console.log(`📊 Waveform progress: ${progress}% - ${status}`);

            // Update with partial waveform if available
            if (partial && partial.samples && partial.samples.length > 0) {
              console.log(`✓ Updating with ${partial.samples.length} samples (${progress}%)`);
              // Create a completely new object to trigger change detection
              this.waveformData.set({
                samples: [...partial.samples], // Create new array
                sampleRate: partial.sampleRate || 44100,
                duration: partial.duration || duration
              });
            }

            // Stop polling when complete
            if (progress >= 100) {
              clearInterval(pollInterval);
            }
          }
        } catch (err) {
          // Progress endpoint might not be ready yet, continue polling
        }
      }, 1000);

      // Wait for final result
      const response = await generationPromise;
      clearInterval(pollInterval);

      console.log('Server waveform response:', response);

      if (response.success && response.data && response.data.samples && response.data.samples.length > 0) {
        console.log(`✅ Final waveform: ${response.data.samples.length} samples`);

        // Replace with final high-quality waveform
        this.waveformData.set({
          samples: response.data.samples,
          sampleRate: response.data.sampleRate || 44100,
          duration: response.data.duration || duration
        });
      } else {
        console.warn('Server waveform not available, keeping current version');
      }
    } catch (error) {
      console.warn('Server waveform loading failed, keeping current version:', error);
    }
  }

  // Generate demo waveform data (fallback)
  private generateDemoWaveform(duration: number): number[] {
    const samples: number[] = [];
    const sampleCount = Math.max(100, duration * 10);

    for (let i = 0; i < sampleCount; i++) {
      const baseAmplitude = 0.3 + Math.random() * 0.4;
      const variation = Math.sin(i / 10) * 0.2;
      samples.push(Math.max(0, Math.min(1, baseAmplitude + variation)));
    }

    return samples;
  }

  // Get category color
  getCategoryColor(category: string): string {
    return CATEGORY_COLORS[category.toLowerCase()] || CATEGORY_COLORS['default'];
  }

  // Handle generate analysis button click
  onGenerateAnalysis(videoId: string) {
    // Navigate to library page with state to trigger analysis
    this.router.navigate(['/'], {
      state: {
        triggerAnalysis: true,
        videoId: videoId,
        videoName: this.metadata().filename
      }
    });
  }
}
