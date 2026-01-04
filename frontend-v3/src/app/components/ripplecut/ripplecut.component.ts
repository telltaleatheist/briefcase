import {
  Component,
  signal,
  computed,
  HostListener,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  NgZone,
  inject,
  Input,
  Output,
  EventEmitter,
  effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// Import models from separate file for clean exports
import {
  EditorTab,
  TimelineSection,
  TimelineChapter,
  CustomMarker,
  TimelineClip,
  TranscriptSegment,
  Selection,
  RipplecutConfig,
  PlayheadChangeEvent,
  SelectionChangeEvent,
  ClipChangeEvent,
  MarkerChangeEvent,
  ExportRequestEvent
} from './ripplecut.models';

// Re-export models so consumers can import from the component
export * from './ripplecut.models';

// ============================================================================
// COMPONENT
// ============================================================================

@Component({
  selector: 'app-ripplecut',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ripplecut.component.html',
  styleUrls: ['./ripplecut.component.scss']
})
export class RipplecutComponent implements AfterViewInit, OnDestroy, OnChanges {
  @ViewChild('timelineTrack') timelineTrack!: ElementRef<HTMLDivElement>;
  @ViewChild('rulerTrack') rulerTrack!: ElementRef<HTMLDivElement>;
  @ViewChild('lanesContainer') lanesContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('videoPlayer') videoPlayer?: ElementRef<HTMLVideoElement>;

  // =========================================================================
  // INPUTS - Data binding for backend integration
  // =========================================================================

  /** Configuration options for the editor */
  @Input() config: RipplecutConfig = {};

  /** Initial clips data - when provided, replaces demo data */
  @Input() initialClips?: TimelineClip[];

  /** Initial markers data - when provided, replaces demo data */
  @Input() initialMarkers?: CustomMarker[];

  /** Initial chapters data - when provided, replaces demo data */
  @Input() initialChapters?: TimelineChapter[];

  /** Initial transcript data - when provided, replaces demo data */
  @Input() initialTranscript?: TranscriptSegment[];

  /** Initial tabs data - when provided, replaces demo data */
  @Input() initialTabs?: EditorTab[];

  /** External playhead position control */
  @Input() externalTime?: number;

  // =========================================================================
  // OUTPUTS - Events for backend integration
  // =========================================================================

  /** Emits when playhead position changes */
  @Output() playheadChange = new EventEmitter<PlayheadChangeEvent>();

  /** Emits when selection changes */
  @Output() selectionChange = new EventEmitter<SelectionChangeEvent>();

  /** Emits when a clip is modified (moved, trimmed, added, deleted) */
  @Output() clipChange = new EventEmitter<ClipChangeEvent>();

  /** Emits when a marker is modified */
  @Output() markerChange = new EventEmitter<MarkerChangeEvent>();

  /** Emits when export is requested */
  @Output() exportRequest = new EventEmitter<ExportRequestEvent>();

  /** Emits when play state changes */
  @Output() playStateChange = new EventEmitter<boolean>();

  private ngZone = inject(NgZone);
  private wheelListenerBound = this.onTimelineWheel.bind(this);

  constructor() {
    // Set up effect to emit playhead changes
    effect(() => {
      const time = this.currentTime();
      this.playheadChange.emit({
        time,
        formattedTime: this.formatTimecode(time)
      });
    });

    // Set up effect to emit selection changes
    effect(() => {
      const selection = this.selection();
      this.selectionChange.emit({
        selection,
        clips: selection ? this.clips().filter(c =>
          c.startTime >= selection.start && c.endTime <= selection.end
        ) : undefined
      });
    });
  }

  // -------------------------------------------------------------------------
  // STATE - Tabs
  // -------------------------------------------------------------------------
  tabs = signal<EditorTab[]>([
    { id: '1', title: 'kent_hovind_open_letter_trump.mp4', duration: 2373, isActive: true },
    { id: '2', title: 'alex_jones_sandy_hook.mp4', duration: 1856, isActive: false },
    { id: '3', title: 'tucker_carlson_interview.mp4', duration: 4523, isActive: false }
  ]);

  activeTab = computed(() => this.tabs().find(t => t.isActive) || this.tabs()[0]);

  // -------------------------------------------------------------------------
  // STATE - Playback
  // -------------------------------------------------------------------------
  isPlaying = signal(false);
  currentTime = signal(245.5);
  duration = computed(() => this.activeTab().duration);
  volume = signal(0.75);
  isMuted = signal(false);
  frameRate = signal(30); // Frames per second for snapping
  playbackRate = signal(1);
  playbackRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

  // -------------------------------------------------------------------------
  // STATE - Timeline & Zoom
  // -------------------------------------------------------------------------
  zoomLevel = signal(1);
  zoomOffset = signal(0);

  // Timeline extends 50% past the video duration (like FCPX)
  timelineLength = computed(() => this.duration() * 1.5);

  visibleDuration = computed(() => this.timelineLength() / this.zoomLevel());
  visibleStart = computed(() => this.zoomOffset());
  visibleEnd = computed(() => this.zoomOffset() + this.visibleDuration());

  // -------------------------------------------------------------------------
  // STATE - Dragging
  // -------------------------------------------------------------------------
  isDraggingPlayhead = signal(false);
  isDraggingTimeline = signal(false);

  // Clip dragging (custom mouse-based for FCPX precision)
  draggedClip = signal<TimelineClip | null>(null);
  draggedClipOriginalLane = signal<number | null>(null);
  dragOverLane = signal<number | null>(null);
  clipDragStart = signal<{ mouseX: number; clipStartTime: number; trackEl: HTMLElement | null }>({
    mouseX: 0,
    clipStartTime: 0,
    trackEl: null
  });
  clipDragPreviewTime = signal<number>(0); // Preview position during drag

  // Marker dragging
  draggedMarker = signal<CustomMarker | null>(null);
  isExtendingMarker = signal(false);

  // -------------------------------------------------------------------------
  // STATE - Tools & Selection
  // -------------------------------------------------------------------------
  activeTool = signal<'select' | 'blade' | 'trim' | 'range' | 'highlight'>('select');
  selection = signal<Selection | null>(null);
  isHighlighting = signal(false);
  highlightStart = signal<number | null>(null);

  // Clip selection and trimming
  selectedClip = signal<TimelineClip | null>(null);
  isTrimmingClip = signal(false);
  trimEdge = signal<'start' | 'end' | null>(null);
  trimStartState = signal<{ clipId: string; startTime: number; endTime: number; mouseX: number } | null>(null);

  // -------------------------------------------------------------------------
  // STATE - View
  // -------------------------------------------------------------------------
  isFullscreen = signal(false);
  showInspector = signal(true);
  inspectorTab = signal<'analysis' | 'chapters' | 'transcript'>('analysis');
  showBrowser = signal(true);
  browserTab = signal<'media' | 'settings'>('media');

  // Timeline height for resizing (can be dragged to adjust)
  timelineHeight = signal(300); // Default height in pixels
  isResizingTimeline = signal(false); // Public for template binding
  private resizeStartY = signal(0);
  private resizeStartHeight = signal(0);

  // Timeline UI scale (magnification) - 1.0 = default, 0.5 = half size, 2.0 = double size
  // Slider at 50% = scale 1.0, 0% = scale 0.5, 100% = scale 1.5
  timelineScale = signal(1.0);

  // Panel widths for resizing
  browserPanelWidth = signal(240);
  inspectorPanelWidth = signal(320);
  isResizingBrowser = signal(false);
  isResizingInspector = signal(false);
  private panelResizeStartX = signal(0);
  private panelResizeStartWidth = signal(0);

  // -------------------------------------------------------------------------
  // STATE - Selected Marker (for showing details)
  // -------------------------------------------------------------------------
  selectedMarker = signal<CustomMarker | null>(null);

  // -------------------------------------------------------------------------
  // STATE - Transcript Search
  // -------------------------------------------------------------------------
  transcriptSearch = signal('');
  useSoundex = signal(false);
  usePhraseSearch = signal(false);

  // -------------------------------------------------------------------------
  // STATE - Dialogs
  // -------------------------------------------------------------------------
  showMarkerDialog = signal(false);
  showExportDialog = signal(false);
  showShortcutsDialog = signal(false);
  showContextMenu = signal(false);
  contextMenuPosition = signal({ x: 0, y: 0 });

  // -------------------------------------------------------------------------
  // STATE - Skimming (shadow playhead)
  // -------------------------------------------------------------------------
  skimTime = signal<number | null>(null);
  isSkimming = signal(false);

  // (AI Sections are now markers on the video clips, not a separate track)

  // -------------------------------------------------------------------------
  // DEMO DATA - Chapters (realistic based on real video data)
  // -------------------------------------------------------------------------
  chapters = signal<TimelineChapter[]>([
    { id: '1', startTime: 0, endTime: 137, title: 'Introduction & Dinosaur Adventure Land Promotion' },
    { id: '2', startTime: 137, endTime: 361, title: 'Open Letter to President Trump - Weaponization Claims' },
    { id: '3', startTime: 361, endTime: 509, title: 'Boston Tea Party Comparison & Tax Protester Label' },
    { id: '4', startTime: 509, endTime: 700, title: 'Response to Mischaracterizations' },
    { id: '5', startTime: 700, endTime: 886, title: 'SWAT Raid Account & Allegations Against Prosecutors' },
    { id: '6', startTime: 886, endTime: 1038, title: 'Claims About Evolution, Judges & Structuring' },
    { id: '7', startTime: 1038, endTime: 1308, title: 'Judicial Misconduct Allegations' },
    { id: '8', startTime: 1308, endTime: 1697, title: 'Defense Against Structuring Charges' },
    { id: '9', startTime: 1697, endTime: 1973, title: 'IRS Agent Allegations & Case Summary' },
    { id: '10', startTime: 1973, endTime: 2215, title: 'Appeal to Trump & Biblical Parallels' },
    { id: '11', startTime: 2215, endTime: 2373, title: 'Call to Action & Closing' }
  ]);

  // -------------------------------------------------------------------------
  // DEMO DATA - Timeline Clips (based on 39min video)
  // -------------------------------------------------------------------------
  // Standard clip colors - CSS handles these via .video-clip and .audio-clip classes
  // These are just fallback values if needed
  private readonly VIDEO_COLOR = '#d45a2a';  // Creamsicle orange
  private readonly AUDIO_COLOR = '#4a9068';  // Green
  private readonly TITLE_COLOR = '#ff9f5a';  // Light orange

  clips = signal<TimelineClip[]>([
    { id: 'v1', name: 'Kent Hovind - Open Letter', startTime: 0, endTime: 2373, lane: 0, type: 'video', linkedAudioId: 'a1' },
    { id: 't1', name: 'Title Card', startTime: 0, endTime: 8, lane: 1, type: 'title' },
    { id: 't2', name: 'Lower Third - Kent Hovind', startTime: 137, endTime: 180, lane: 1, type: 'title' },
    { id: 't3', name: 'Chapter Title', startTime: 361, endTime: 375, lane: 1, type: 'title' },
    { id: 'a1', name: 'Room Tone + Voice', startTime: 0, endTime: 2373, lane: -1, type: 'audio', linkedVideoId: 'v1' },
  ]);

  // Helper: Check if a clip has linked audio
  hasLinkedAudio(clip: TimelineClip): boolean {
    if (!clip.linkedAudioId) return false;
    return this.clips().some(c => c.id === clip.linkedAudioId);
  }

  // Helper: Get linked audio clip
  getLinkedAudio(clip: TimelineClip): TimelineClip | undefined {
    if (!clip.linkedAudioId) return undefined;
    return this.clips().find(c => c.id === clip.linkedAudioId);
  }

  // Helper: Get the effective clip type
  getClipType(clip: TimelineClip): 'video' | 'audio' | 'title' {
    if (clip.type) return clip.type;
    if (clip.lane < 0) return 'audio';
    if (clip.lane > 0) return 'title';
    return 'video';
  }

  // Helper: Check if clip can be placed in a lane
  canPlaceInLane(clip: TimelineClip, targetLane: number): boolean {
    const clipType = this.getClipType(clip);
    // Video and title clips cannot go to audio lanes (negative)
    if ((clipType === 'video' || clipType === 'title') && targetLane < 0) {
      return false;
    }
    // Audio clips should stay in audio lanes (negative) - but allow master (0) too
    if (clipType === 'audio' && targetLane > 0) {
      return false;
    }
    return true;
  }

  // Helper: Find non-overlapping position for a clip in a lane
  findNonOverlappingPosition(clip: TimelineClip, targetLane: number, desiredStart: number): number {
    const clipDuration = clip.endTime - clip.startTime;
    const clipsInLane = this.clips().filter(c => c.lane === targetLane && c.id !== clip.id);

    if (clipsInLane.length === 0) {
      return Math.max(0, desiredStart);
    }

    // Sort clips by start time
    clipsInLane.sort((a, b) => a.startTime - b.startTime);

    // Check if desired position overlaps with any clip
    const desiredEnd = desiredStart + clipDuration;
    let newStart = desiredStart;

    for (const existingClip of clipsInLane) {
      // Check for overlap
      if (newStart < existingClip.endTime && (newStart + clipDuration) > existingClip.startTime) {
        // Overlap detected - snap to end of this clip
        newStart = existingClip.endTime;
      }
    }

    return Math.max(0, newStart);
  }

  // Detach audio from video clip
  detachAudio(videoClip: TimelineClip) {
    if (!videoClip.linkedAudioId) return;

    const audioClipId = videoClip.linkedAudioId;

    this.clips.update(clips =>
      clips.map(c => {
        if (c.id === videoClip.id) {
          return { ...c, linkedAudioId: undefined };
        }
        if (c.id === audioClipId) {
          return { ...c, linkedVideoId: undefined };
        }
        return c;
      })
    );
  }

  // -------------------------------------------------------------------------
  // DEMO DATA - Markers (FCP style + AI Analysis from real video)
  // -------------------------------------------------------------------------
  markers = signal<CustomMarker[]>([
    // Regular editing markers
    { id: 'm1', time: 8, message: 'Good intro point', type: 'standard', clipId: 'v1' },
    { id: 'm2', time: 137, message: 'Add lower third here', type: 'todo', clipId: 'v1' },
    // AI Analysis markers (from real video analysis)
    { id: 'ai1', time: 255, endTime: 285, message: '"There can people have witnessed the previous administration engage in a systematic campaign against its perceived political opponents." — Frames his legal case as part of a broader \'weaponization\' campaign by previous administration targeting political opponents, aligning with broader weaponization conspiracy narrative', type: 'analysis', clipId: 'v1', category: 'conspiracy', severity: 'medium' },
    { id: 'ai2', time: 334, endTime: 361, message: '"Atheists and God haters have run with this tax protester claim against me for 19 years now. They cannot win a debate defending their dumb evolution religion." — Uses dehumanizing language and mockery toward those who accept evolutionary theory', type: 'analysis', clipId: 'v1', category: 'hate', severity: 'high' },
    { id: 'ai3', time: 361, endTime: 391, message: '"December 16, 1773, American patriots dumped 342 just some black tea off British moats into the Boston Harbor. Thank you for what you did, guys, okay." — Invokes Boston Tea Party as parallel to own legal case, potentially framing government actions as illegitimate oppression worthy of resistance', type: 'analysis', clipId: 'v1', category: 'political-violence', severity: 'medium' },
    { id: 'ai4', time: 453, endTime: 483, message: '"He said, can\'t you didn\'t break a single law. The government broke 100 laws to put you in prison." — Makes unverified claim that government broke 100 laws without presenting evidence', type: 'analysis', clipId: 'v1', category: 'misinformation', severity: 'medium' },
    { id: 'ai5', time: 637, endTime: 667, message: '"She\'s biased against Christians and in favor of evil doers as her record shows." — Claims judge is biased against Christians as a systemic pattern, implying religious persecution in judicial system', type: 'analysis', clipId: 'v1', category: 'christian-nationalism', severity: 'medium' },
    { id: 'ai6', time: 833, endTime: 863, message: '"Judge Richard Criter committed suicide when he was caught in charge with the crime of purchasing illegal pornographic materials." — Factually unverified claim about judge\'s death', type: 'analysis', clipId: 'v1', category: 'misinformation', severity: 'high' },
    { id: 'ai7', time: 886, endTime: 912, message: '"This evolution theory is the foundation philosophy behind communism, socialism, Marxism" — Factually incorrect historical claim', type: 'analysis', clipId: 'v1', category: 'misinformation', severity: 'high' },
    { id: 'ai8', time: 981, endTime: 1011, message: '"The judge of statements about rape got removed from the court transcript." — Alleges coordinated judicial conspiracy involving transcript tampering and jury manipulation', type: 'analysis', clipId: 'v1', category: 'conspiracy', severity: 'high' },
    { id: 'ai9', time: 1282, endTime: 1308, message: '"IRS DOJ and public school system do not have a problem hiring mentally unstable sexual deviants" — Dehumanizing language toward LGBTQ+ individuals, conflating them with pedophilia', type: 'analysis', clipId: 'v1', category: 'hate', severity: 'high' },
    { id: 'ai10', time: 1862, endTime: 1892, message: '"Scott Schneider, who works for the private company IRS... It\'s not part of the government. It\'s a private company." — Claims IRS is a private company, a common anti-government conspiracy theory', type: 'analysis', clipId: 'v1', category: 'conspiracy', severity: 'medium' },
    { id: 'ai11', time: 2215, endTime: 2245, message: '"Petophile U.S. attorney, Atchison and Christian hating judge Rogers" — Inflammatory language and personal attacks on named federal officials', type: 'analysis', clipId: 'v1', category: 'political-violence', severity: 'high' },
    { id: 'ai12', time: 2282, endTime: 2312, message: '"I want you to impeach or jail the judge and others involved, if need be" — Calls for imprisonment of sitting judge based on unverified claims', type: 'analysis', clipId: 'v1', category: 'extremism', severity: 'high' },
  ]);

  // -------------------------------------------------------------------------
  // DEMO DATA - Chapter Markers (for timeline navigation)
  // -------------------------------------------------------------------------
  chapterMarkers = signal<CustomMarker[]>([
    { id: 'ch1', time: 0, message: 'Introduction', type: 'chapter' },
    { id: 'ch2', time: 137, message: 'Open Letter to Trump', type: 'chapter' },
    { id: 'ch3', time: 361, message: 'Boston Tea Party', type: 'chapter' },
    { id: 'ch4', time: 700, message: 'SWAT Raid', type: 'chapter' },
    { id: 'ch5', time: 1038, message: 'Judicial Claims', type: 'chapter' },
    { id: 'ch6', time: 1697, message: 'IRS Allegations', type: 'chapter' },
    { id: 'ch7', time: 1973, message: 'Appeal to Trump', type: 'chapter' },
    { id: 'ch8', time: 2215, message: 'Call to Action', type: 'chapter' },
  ]);

  // -------------------------------------------------------------------------
  // DEMO DATA - Transcript (based on real video)
  // -------------------------------------------------------------------------
  transcript = signal<TranscriptSegment[]>([
    { id: '1', startTime: 0, endTime: 1, text: "Good evening, folks." },
    { id: '2', startTime: 1, endTime: 6, text: "Can't hold in here in the crew at Dinosaur Adventure Land and Genesis Baptist Church and Lovely Lennox, Alabama." },
    { id: '3', startTime: 6, endTime: 10.5, text: "It is February 1st, 2025. Tonight, I know you scriptics and scoffers have been waiting" },
    { id: '4', startTime: 10.5, endTime: 14.2, text: "to call in and make your stupid comments about evolution being true, you know." },
    { id: '5', startTime: 14.2, endTime: 20.3, text: "But tonight, I'm going to do an open letter to President Trump and to all the conservative freedom-loving Americans." },
    { id: '6', startTime: 20.3, endTime: 27.6, text: "I would ask you if you watch this and copy it, since post it on every channel you can think of," },
    { id: '7', startTime: 27.6, endTime: 33.0, text: "and send it to anybody you know that loves the Lord and might be on step in." },
    { id: '8', startTime: 33.0, endTime: 39.0, text: "We've got some serious question we want to talk about tonight. Okay, we'll talk in just a minute." },
    { id: '9', startTime: 39.0, endTime: 46.0, text: "So here we are, we're on a bunch of channels. We're on Facebook and let's see, I don't know what they're all listed right there, okay." },
    { id: '10', startTime: 46.0, endTime: 54.0, text: "Rumble, TikTok, all kinds of stuff. Go to drdino.com, our website, and you can see everything right there." },
    { id: '11', startTime: 54.0, endTime: 62.0, text: "We are straight north of Pensacola, 70 miles, a little town of Lennox, Alabama, where God gets the glory for His creation." },
    { id: '12', startTime: 137.0, endTime: 145.0, text: "Tonight I'm doing an open letter to President Trump and all conservative freedom-loving Americans." },
    { id: '13', startTime: 145.0, endTime: 155.0, text: "The issues we'll cover require careful consideration. I've been labeled a tax protester for 19 years now." },
    { id: '14', startTime: 255.0, endTime: 265.0, text: "There can people have witnessed the previous administration engage in a systematic campaign against its perceived political opponents." },
    { id: '15', startTime: 334.0, endTime: 345.0, text: "Atheists and God haters have run with this tax protester claim against me for 19 years now." },
    { id: '16', startTime: 361.0, endTime: 375.0, text: "December 16, 1773, American patriots dumped 342 just some black tea off British moats into the Boston Harbor." },
  ]);

  // -------------------------------------------------------------------------
  // COMPUTED - Ruler ticks
  // -------------------------------------------------------------------------
  rulerTicks = computed(() => {
    const start = this.visibleStart();
    const end = this.visibleEnd();
    const duration = end - start;

    // Determine tick interval based on zoom
    let majorInterval: number;
    let minorCount: number;

    if (duration <= 30) {
      majorInterval = 5;
      minorCount = 5;
    } else if (duration <= 60) {
      majorInterval = 10;
      minorCount = 5;
    } else if (duration <= 300) {
      majorInterval = 30;
      minorCount = 6;
    } else if (duration <= 600) {
      majorInterval = 60;
      minorCount = 6;
    } else if (duration <= 1800) {
      majorInterval = 300;
      minorCount = 5;
    } else {
      majorInterval = 600;
      minorCount = 6;
    }

    const ticks: { time: number; isMajor: boolean; label?: string }[] = [];
    const minorInterval = majorInterval / minorCount;

    // Start from the nearest major tick before visible start
    const firstMajor = Math.floor(start / majorInterval) * majorInterval;

    for (let time = firstMajor; time <= end + majorInterval; time += minorInterval) {
      if (time < start - minorInterval) continue;
      if (time > end + minorInterval) break;

      const isMajor = Math.abs(time % majorInterval) < 0.001;
      ticks.push({
        time,
        isMajor,
        label: isMajor ? this.formatTimeCompact(time) : undefined
      });
    }

    return ticks;
  });

  // -------------------------------------------------------------------------
  // COMPUTED - Visible elements in timeline
  // -------------------------------------------------------------------------
  visibleChapters = computed(() => {
    const start = this.visibleStart();
    const end = this.visibleEnd();
    return this.chapters().filter(c => c.endTime > start && c.startTime < end);
  });

  currentChapter = computed(() => {
    const time = this.currentTime();
    return this.chapters().find(c => time >= c.startTime && time < c.endTime);
  });

  visibleClips = computed(() => {
    const start = this.visibleStart();
    const end = this.visibleEnd();
    return this.clips().filter(c => c.endTime > start && c.startTime < end);
  });

  // Get clips for a specific lane
  getClipsForLane(lane: number) {
    return this.visibleClips().filter(c => c.lane === lane);
  }

  // Get all unique lane numbers, sorted (positive descending, then 0, then negative ascending)
  activeLanes = computed(() => {
    const clipLanes = [...new Set(this.clips().map(c => c.lane))];

    // Find the highest video lane and lowest audio lane
    const videoLanes = clipLanes.filter(l => l > 0);
    const audioLanes = clipLanes.filter(l => l < 0);

    const highestVideo = videoLanes.length > 0 ? Math.max(...videoLanes) : 0;
    const lowestAudio = audioLanes.length > 0 ? Math.min(...audioLanes) : -1;

    // Build the lane list - minimal buffer for balanced layout
    const lanes: number[] = [];

    // Add 1 empty video lane above for dragging
    lanes.push(highestVideo + 1);

    // Add all video overlay lanes down to 1
    for (let i = highestVideo; i >= 1; i--) {
      lanes.push(i);
    }

    // Always include master lane (0)
    lanes.push(0);

    // Add ALL audio lanes from -1 down to the lowest (not just lanes with clips)
    // This allows dragging clips to empty audio lanes
    for (let i = -1; i >= lowestAudio; i--) {
      lanes.push(i);
    }

    // Add 1 empty audio lane below for dragging
    lanes.push(lowestAudio - 1);

    return lanes;
  });

  // Separate video lanes (>= 0) and audio lanes (< 0)
  videoLanes = computed(() => this.activeLanes().filter(l => l >= 0));
  audioLanes = computed(() => this.activeLanes().filter(l => l < 0));

  // Lane label helper
  getLaneLabel(lane: number): string {
    if (lane === 0) return 'M'; // Master
    if (lane > 0) return `V${lane}`;
    return `A${Math.abs(lane)}`;
  }

  // Legacy computed for backward compatibility during transition
  videoClips = computed(() => this.visibleClips().filter(c => c.lane === 0));
  titleClips = computed(() => this.visibleClips().filter(c => c.lane > 0));
  audioClips = computed(() => this.visibleClips().filter(c => c.lane < 0));

  visibleChapterMarkers = computed(() => {
    const start = this.visibleStart();
    const end = this.visibleEnd();
    return this.chapterMarkers().filter(m => m.time >= start && m.time <= end);
  });

  getMarkersForClip(clipId: string) {
    return this.markers().filter(m => m.clipId === clipId);
  }

  // Analysis markers only
  analysisMarkers = computed(() =>
    this.markers().filter(m => m.type === 'analysis')
  );

  // Analysis severity counts
  highSeverityCount = computed(() =>
    this.analysisMarkers().filter(m => m.severity === 'high').length
  );

  mediumSeverityCount = computed(() =>
    this.analysisMarkers().filter(m => m.severity === 'medium').length
  );

  // Filtered transcript based on search
  filteredTranscript = computed(() => {
    const search = this.transcriptSearch().toLowerCase().trim();
    if (!search) return this.transcript();

    return this.transcript().filter(segment =>
      segment.text.toLowerCase().includes(search)
    );
  });

  // Get severity color for AI analysis
  getSeverityColor(severity?: string): string {
    switch (severity) {
      case 'high': return '#ef4444';
      case 'medium': return '#f59e0b';
      case 'low': return '#3b82f6';
      default: return '#8b5cf6';
    }
  }

  // Get category icon/color
  getCategoryColor(category?: string): string {
    const colors: Record<string, string> = {
      'violence': '#ef4444',
      'misinformation': '#eab308',
      'political': '#b91c1c',
      'conspiracy': '#a855f7',
      'hate': '#dc2626',
      'extremism': '#f97316',
      'shocking': '#f59e0b',
      'false-info': '#8b5cf6',
      'christian-nationalism': '#ec4899',
      'political-violence': '#ef4444',
      'false-prophecy': '#06b6d4'
    };
    return colors[category || ''] || '#666';
  }

  // Get readable category label
  getCategoryLabel(category?: string): string {
    const labels: Record<string, string> = {
      'violence': 'Violence',
      'misinformation': 'Misinformation',
      'political': 'Political',
      'conspiracy': 'Conspiracy',
      'hate': 'Hate Speech',
      'extremism': 'Extremism',
      'shocking': 'Shocking Content',
      'false-info': 'False Information',
      'christian-nationalism': 'Christian Nationalism',
      'political-violence': 'Political Violence',
      'false-prophecy': 'False Prophecy'
    };
    return labels[category || ''] || category || 'Unknown';
  }

  // -------------------------------------------------------------------------
  // COMPUTED - Time formatting
  // -------------------------------------------------------------------------
  formattedCurrentTime = computed(() => this.formatTimecode(this.currentTime()));
  formattedDuration = computed(() => this.formatTimecode(this.duration()));

  // Selection info (from, to, duration)
  selectionInfo = computed(() => {
    const sel = this.selection();
    if (!sel) return null;
    return {
      from: this.formatTimecode(sel.start),
      to: this.formatTimecode(sel.end),
      duration: this.formatTimecode(sel.end - sel.start)
    };
  });

  // Legacy - keep for backward compatibility
  formattedSelection = computed(() => {
    const info = this.selectionInfo();
    return info ? info.duration : null;
  });

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------

  ngOnChanges(changes: SimpleChanges) {
    console.log('[RipplecutComponent] ngOnChanges called with:', Object.keys(changes));

    // Handle initial data from inputs - only update if array has items
    if (changes['initialClips']?.currentValue?.length > 0) {
      console.log('[RipplecutComponent] Setting clips:', changes['initialClips'].currentValue?.length);
      this.clips.set(changes['initialClips'].currentValue);
    }
    if (changes['initialMarkers']?.currentValue?.length > 0) {
      console.log('[RipplecutComponent] Setting markers:', changes['initialMarkers'].currentValue?.length);
      this.markers.set(changes['initialMarkers'].currentValue);
    }
    if (changes['initialChapters']?.currentValue?.length > 0) {
      console.log('[RipplecutComponent] Setting chapters:', changes['initialChapters'].currentValue?.length);
      this.chapters.set(changes['initialChapters'].currentValue);
    }
    if (changes['initialTranscript']?.currentValue?.length > 0) {
      console.log('[RipplecutComponent] Setting transcript:', changes['initialTranscript'].currentValue?.length);
      this.transcript.set(changes['initialTranscript'].currentValue);
    }
    if (changes['initialTabs']?.currentValue?.length > 0) {
      this.tabs.set(changes['initialTabs'].currentValue);
    }
    if (changes['externalTime']?.currentValue !== undefined) {
      this.currentTime.set(changes['externalTime'].currentValue);
    }
    // Apply config
    if (changes['config']?.currentValue) {
      this.applyConfig(changes['config'].currentValue);
    }
  }

  private applyConfig(config: RipplecutConfig) {
    if (config.frameRate !== undefined) {
      this.frameRate.set(config.frameRate);
    }
    if (config.showBrowser !== undefined) {
      this.showBrowser.set(config.showBrowser);
    }
    if (config.showInspector !== undefined) {
      this.showInspector.set(config.showInspector);
    }
    if (config.defaultInspectorTab) {
      this.inspectorTab.set(config.defaultInspectorTab);
    }
    if (config.playbackRates) {
      this.playbackRates = config.playbackRates;
    }
  }

  ngAfterViewInit() {
    // Attach wheel listener with passive: false to allow preventDefault()
    // This prevents browser back/forward navigation on horizontal scroll
    this.ngZone.runOutsideAngular(() => {
      if (this.timelineTrack?.nativeElement) {
        this.timelineTrack.nativeElement.addEventListener('wheel', this.wheelListenerBound, { passive: false });
      }
      if (this.rulerTrack?.nativeElement) {
        this.rulerTrack.nativeElement.addEventListener('wheel', this.wheelListenerBound, { passive: false });
      }
    });
  }

  ngOnDestroy() {
    // Clean up wheel listeners
    if (this.timelineTrack?.nativeElement) {
      this.timelineTrack.nativeElement.removeEventListener('wheel', this.wheelListenerBound);
    }
    if (this.rulerTrack?.nativeElement) {
      this.rulerTrack.nativeElement.removeEventListener('wheel', this.wheelListenerBound);
    }
  }

  // -------------------------------------------------------------------------
  // KEYBOARD SHORTCUTS
  // -------------------------------------------------------------------------
  @HostListener('window:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;

    const key = event.key.toLowerCase();
    const cmd = event.metaKey || event.ctrlKey;

    switch (true) {
      case key === ' ':
        event.preventDefault();
        this.togglePlay();
        break;
      case key === 'k':
        this.isPlaying.set(false);
        break;
      case key === 'j':
        this.skipBackward();
        break;
      case key === 'l':
        this.skipForward();
        break;
      case key === 'arrowleft':
        event.preventDefault();
        this.frameBackward();
        break;
      case key === 'arrowright':
        event.preventDefault();
        this.frameForward();
        break;
      case key === 'a':
        this.activeTool.set('select');
        break;
      case key === 'b':
        this.activeTool.set('blade');
        break;
      case key === 't':
        this.activeTool.set('trim');
        break;
      case key === 'r':
        this.activeTool.set('range');
        break;
      case key === 'h':
        this.toggleHighlight();
        break;
      case key === 'i':
        this.setInPoint();
        break;
      case key === 'o':
        this.setOutPoint();
        break;
      case key === 'x':
        this.selectClipAtPlayhead();
        break;
      case key === 'escape':
        this.clearSelection();
        this.selectedClip.set(null);
        this.closeAllDialogs();
        break;
      case key === ',':
        event.preventDefault();
        this.nudgeSelectedClip(-1); // Move left one frame
        break;
      case key === '.':
        event.preventDefault();
        this.nudgeSelectedClip(1); // Move right one frame
        break;
      case key === '[':
        event.preventDefault();
        this.trimSelectedClip('start', -1); // Trim in point left one frame
        break;
      case key === ']':
        event.preventDefault();
        this.trimSelectedClip('end', 1); // Trim out point right one frame
        break;
      case key === 'm' && !event.shiftKey:
        this.addMarker();
        break;
      case key === 'f' && cmd:
        event.preventDefault();
        this.toggleFullscreen();
        break;
      case key === '?' || (key === '/' && event.shiftKey):
        this.showShortcutsDialog.set(true);
        break;
      case cmd && key === '=':
      case cmd && key === '+':
        event.preventDefault();
        this.zoomIn();
        break;
      case cmd && key === '-':
        event.preventDefault();
        this.zoomOut();
        break;
      case cmd && key === '0':
        event.preventDefault();
        this.fitToWindow();
        break;
      case cmd && key === 'e':
        event.preventDefault();
        this.showExportDialog.set(true);
        break;
      case key === 'home':
        event.preventDefault();
        this.goToStart();
        break;
      case key === 'end':
        event.preventDefault();
        this.goToEnd();
        break;
    }
  }

  @HostListener('window:mouseup')
  onMouseUp() {
    this.isDraggingPlayhead.set(false);
    this.isDraggingTimeline.set(false);
  }

  @HostListener('window:mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    if (this.isDraggingPlayhead() && this.timelineTrack) {
      const rect = this.timelineTrack.nativeElement.getBoundingClientRect();
      const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
      const percent = x / rect.width;
      const time = this.visibleStart() + percent * this.visibleDuration();
      this.currentTime.set(Math.max(0, Math.min(this.duration(), time)));
    }
  }

  // -------------------------------------------------------------------------
  // METHODS - Timeline interactions
  // -------------------------------------------------------------------------
  onTimelineClick(event: MouseEvent) {
    if (this.isDraggingPlayhead()) return;

    // Deselect clip when clicking on empty timeline area
    // (clip clicks stop propagation, so this only fires for empty areas)
    this.selectedClip.set(null);

    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = x / rect.width;
    const time = this.visibleStart() + percent * this.visibleDuration();
    this.currentTime.set(Math.max(0, Math.min(this.duration(), time)));
  }

  // Skimming (shadow playhead follows mouse)
  onTimelineMouseEnter() {
    this.isSkimming.set(true);
  }

  onTimelineMouseLeave() {
    this.isSkimming.set(false);
    this.skimTime.set(null);
  }

  onTimelineMouseMove(event: MouseEvent) {
    if (this.draggedClip() || this.isDraggingPlayhead()) return;

    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = x / rect.width;
    const time = this.visibleStart() + percent * this.visibleDuration();
    this.skimTime.set(Math.max(0, Math.min(this.duration(), time)));
  }

  onRulerClick(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = x / rect.width;
    const time = this.visibleStart() + percent * this.visibleDuration();
    this.currentTime.set(Math.max(0, Math.min(this.duration(), time)));
  }

  onPlayheadMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingPlayhead.set(true);
  }

  onTimelineWheel(event: WheelEvent) {
    // Always prevent default to block browser back/forward navigation
    event.preventDefault();

    // Cmd+scroll to zoom
    if (event.metaKey || event.ctrlKey) {
      const maxZoom = this.getMaxZoom();
      const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1; // Scroll down = zoom out, up = zoom in
      const newZoom = Math.max(1, Math.min(maxZoom, this.zoomLevel() * zoomFactor));

      // Zoom centered on mouse position
      const target = event.currentTarget as HTMLElement || event.target as HTMLElement;
      const rect = target.getBoundingClientRect();
      const mousePercent = (event.clientX - rect.left) / rect.width;
      const mouseTime = this.visibleStart() + mousePercent * this.visibleDuration();

      // Calculate new offset to keep mouse position stable
      const newVisibleDuration = this.timelineLength() / newZoom;
      const newOffset = mouseTime - mousePercent * newVisibleDuration;
      const maxOffset = this.timelineLength() - newVisibleDuration;

      // Run inside zone to trigger change detection
      this.ngZone.run(() => {
        this.zoomLevel.set(newZoom);
        this.zoomOffset.set(Math.max(0, Math.min(maxOffset, newOffset)));
      });
    } else {
      // Horizontal scroll to navigate timeline
      const deltaX = event.deltaX || event.deltaY; // Use deltaY if no horizontal scroll
      if (deltaX !== 0) {
        const scrollAmount = (deltaX / 500) * this.visibleDuration();
        const maxOffset = this.timelineLength() - this.visibleDuration();
        const newOffset = this.zoomOffset() + scrollAmount;

        // Run inside zone to trigger change detection
        this.ngZone.run(() => {
          this.zoomOffset.set(Math.max(0, Math.min(maxOffset, newOffset)));
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // METHODS - Zoom Scrollbar
  // -------------------------------------------------------------------------
  isDraggingZoombar = signal(false);
  zoombarDragType = signal<'left' | 'right' | 'middle' | null>(null);
  zoombarDragStart = signal({ x: 0, startOffset: 0, startZoom: 1 });

  // Computed values for the zoombar thumb position/size
  zoombarThumbLeft = computed(() => (this.zoomOffset() / this.timelineLength()) * 100);
  zoombarThumbWidth = computed(() => (this.visibleDuration() / this.timelineLength()) * 100);

  onZoombarMouseDown(event: MouseEvent, type: 'left' | 'right' | 'middle') {
    event.preventDefault();
    this.isDraggingZoombar.set(true);
    this.zoombarDragType.set(type);
    this.zoombarDragStart.set({
      x: event.clientX,
      startOffset: this.zoomOffset(),
      startZoom: this.zoomLevel()
    });

    const onMouseMove = (e: MouseEvent) => {
      const bar = (event.target as HTMLElement).closest('.zoom-scrollbar');
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const deltaX = e.clientX - this.zoombarDragStart().x;
      const deltaPercent = deltaX / rect.width;
      const deltaTime = deltaPercent * this.timelineLength();

      const dragType = this.zoombarDragType();
      const maxZoom = this.getMaxZoom();

      if (dragType === 'middle') {
        // Scroll the timeline
        const maxOffset = this.timelineLength() - this.visibleDuration();
        const newOffset = this.zoombarDragStart().startOffset + deltaTime;
        this.zoomOffset.set(Math.max(0, Math.min(maxOffset, newOffset)));
      } else if (dragType === 'left') {
        // Adjust start (zoom + scroll)
        const currentEnd = this.zoombarDragStart().startOffset + (this.timelineLength() / this.zoombarDragStart().startZoom);
        const newStart = Math.max(0, Math.min(currentEnd - 10, this.zoombarDragStart().startOffset + deltaTime));
        const newDuration = currentEnd - newStart;
        const newZoom = Math.max(1, Math.min(maxZoom, this.timelineLength() / newDuration));
        this.zoomLevel.set(newZoom);
        this.zoomOffset.set(newStart);
      } else if (dragType === 'right') {
        // Adjust end (zoom only)
        const currentStart = this.zoombarDragStart().startOffset;
        const originalEnd = currentStart + (this.timelineLength() / this.zoombarDragStart().startZoom);
        const newEnd = Math.max(currentStart + 10, Math.min(this.timelineLength(), originalEnd + deltaTime));
        const newDuration = newEnd - currentStart;
        const newZoom = Math.max(1, Math.min(maxZoom, this.timelineLength() / newDuration));
        this.zoomLevel.set(newZoom);
      }
    };

    const onMouseUp = () => {
      this.isDraggingZoombar.set(false);
      this.zoombarDragType.set(null);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // -------------------------------------------------------------------------
  // METHODS - Playback
  // -------------------------------------------------------------------------
  togglePlay() {
    this.isPlaying.update(v => !v);
    // Sync video playback after state change
    setTimeout(() => this.syncVideoPlayback(), 0);
  }

  skipForward() {
    this.currentTime.update(t => Math.min(this.duration(), t + 10));
    this.seekVideo(this.currentTime());
  }

  skipBackward() {
    this.currentTime.update(t => Math.max(0, t - 10));
    this.seekVideo(this.currentTime());
  }

  frameForward() {
    this.currentTime.update(t => Math.min(this.duration(), t + (1/30)));
    this.seekVideo(this.currentTime());
  }

  frameBackward() {
    this.currentTime.update(t => Math.max(0, t - (1/30)));
    this.seekVideo(this.currentTime());
  }

  goToStart() {
    this.currentTime.set(0);
    this.seekVideo(0);
  }

  goToEnd() {
    this.currentTime.set(this.duration());
    this.seekVideo(this.duration());
  }

  seekTo(time: number) {
    const clampedTime = Math.max(0, Math.min(this.duration(), time));
    this.currentTime.set(clampedTime);
    this.seekVideo(clampedTime);
  }

  setPlaybackRate(rate: number) {
    this.playbackRate.set(rate);
  }

  toggleMute() {
    this.isMuted.update(v => !v);
  }

  // -------------------------------------------------------------------------
  // METHODS - Video Playback
  // -------------------------------------------------------------------------

  /** Get the media URL for the main clip (first clip) */
  getMainClipUrl(): string | null {
    const clips = this.clips();
    if (clips.length > 0 && clips[0].mediaUrl) {
      return clips[0].mediaUrl;
    }
    return null;
  }

  /** Handle video metadata loaded */
  onVideoLoaded(event: Event) {
    const video = event.target as HTMLVideoElement;
    if (video.duration && !isNaN(video.duration)) {
      // Update clip endTime if needed (for cases where duration wasn't known)
      const clips = this.clips();
      if (clips.length > 0 && clips[0].endTime === 0) {
        const updatedClips = [...clips];
        updatedClips[0] = { ...updatedClips[0], endTime: video.duration };
        this.clips.set(updatedClips);
        // Also update the active tab duration
        const activeTab = this.activeTab();
        if (activeTab.duration === 0) {
          this.tabs.update(tabs => tabs.map(t =>
            t.id === activeTab.id ? { ...t, duration: video.duration } : t
          ));
        }
      }
    }
  }

  /** Handle video time updates - keep timeline in sync */
  onVideoTimeUpdate(event: Event) {
    if (!this.isPlaying()) return;
    const video = event.target as HTMLVideoElement;
    this.currentTime.set(video.currentTime);
  }

  /** Handle video ended */
  onVideoEnded() {
    this.isPlaying.set(false);
    this.currentTime.set(0);
  }

  /** Sync video element with play state */
  private syncVideoPlayback() {
    const video = this.videoPlayer?.nativeElement;
    if (!video) return;

    if (this.isPlaying()) {
      // Sync video time before playing
      if (Math.abs(video.currentTime - this.currentTime()) > 0.1) {
        video.currentTime = this.currentTime();
      }
      video.play().catch(err => console.warn('Video play failed:', err));
    } else {
      video.pause();
    }
  }

  /** Seek video to specific time */
  private seekVideo(time: number) {
    const video = this.videoPlayer?.nativeElement;
    if (video) {
      video.currentTime = time;
    }
  }

  // -------------------------------------------------------------------------
  // METHODS - Zoom
  // -------------------------------------------------------------------------

  // Max zoom allows viewing ~10 frames at a time (frame-level editing like FCPX)
  // At max zoom, visible duration = 10 frames = 10/fps seconds
  getMaxZoom(): number {
    const fps = this.frameRate();
    const framesVisible = 10; // Show about 10 frames at max zoom
    const minVisibleDuration = framesVisible / fps; // e.g., 10/30 = 0.333 seconds
    return this.timelineLength() / minVisibleDuration;
  }

  // Timeline zoom (what time range is visible) - controlled by scrollbar and Cmd+scroll
  zoomIn() {
    const maxZoom = this.getMaxZoom();
    this.zoomLevel.update(z => Math.min(maxZoom, z * 1.5));
  }

  zoomOut() {
    this.zoomLevel.update(z => Math.max(1, z / 1.5));
  }

  fitToWindow() {
    this.zoomLevel.set(1);
    this.zoomOffset.set(0);
  }

  // UI Scale (magnification) - controlled by slider in header
  // Scale range: 0.5 (50% size) to 1.5 (150% size), default 1.0
  scaleUp() {
    this.timelineScale.update(s => Math.min(1.5, s + 0.1));
  }

  scaleDown() {
    this.timelineScale.update(s => Math.max(0.5, s - 0.1));
  }

  resetScale() {
    this.timelineScale.set(1.0);
  }

  onScaleSliderChange(value: number) {
    // Slider 0-100 maps to scale 0.5-1.5
    // 0 = 0.5, 50 = 1.0, 100 = 1.5
    const scale = 0.5 + (value / 100);
    this.timelineScale.set(scale);
  }

  getScaleSliderValue(): number {
    // Inverse: scale 0.5-1.5 maps to slider 0-100
    return (this.timelineScale() - 0.5) * 100;
  }

  // -------------------------------------------------------------------------
  // METHODS - Selection
  // -------------------------------------------------------------------------
  setInPoint() {
    const current = this.currentTime();
    const sel = this.selection();
    if (sel) {
      this.selection.set({ start: current, end: Math.max(current, sel.end) });
    } else {
      this.selection.set({ start: current, end: this.duration() });
    }
  }

  setOutPoint() {
    const current = this.currentTime();
    const sel = this.selection();
    if (sel) {
      this.selection.set({ start: Math.min(current, sel.start), end: current });
    } else {
      this.selection.set({ start: 0, end: current });
    }
  }

  clearSelection() {
    this.selection.set(null);
    this.selectionLane.set(null);
    this.isHighlighting.set(false);
    this.highlightStart.set(null);
  }

  // Selection drag state
  private selectionDragType = signal<'start' | 'end' | 'move' | null>(null);
  private selectionDragStartX = signal(0);
  private selectionDragStartState = signal<Selection | null>(null);
  private selectionClipBounds = signal<{ start: number; end: number } | null>(null);

  // Track which lane the selection is on
  selectionLane = signal<number | null>(null);

  // Start a new selection by dragging (constrained to the clip under the mouse)
  startSelectionDrag(event: MouseEvent, clip?: TimelineClip) {
    // Use the track-content element for accurate position calculation
    const trackContent = (event.target as HTMLElement).closest('.track-content') as HTMLElement;
    if (!trackContent) return;

    const rect = trackContent.getBoundingClientRect();
    const clickPercent = (event.clientX - rect.left) / rect.width;
    const clickTime = this.snapToFrame(this.visibleStart() + clickPercent * this.visibleDuration());

    // If no clip provided, find the clip at the click position
    let targetClip = clip;
    if (!targetClip) {
      // Find clip that contains this time (on any lane)
      targetClip = this.clips().find(c => clickTime >= c.startTime && clickTime <= c.endTime);
    }

    // If no clip found at this position, don't start selection
    if (!targetClip) return;

    // Constrain selection to the clip bounds
    const clipBounds = { start: targetClip.startTime, end: targetClip.endTime };
    this.selectionClipBounds.set(clipBounds);

    // Track which lane this selection is on
    this.selectionLane.set(targetClip.lane);

    // Start new selection from click point (clamped to clip)
    const clampedClickTime = Math.max(clipBounds.start, Math.min(clipBounds.end, clickTime));
    this.selection.set({ start: clampedClickTime, end: clampedClickTime });
    this.selectionDragType.set('end'); // Dragging the end
    this.selectionDragStartX.set(event.clientX);
    this.selectionDragStartState.set({ start: clampedClickTime, end: clampedClickTime });

    const onMouseMove = (e: MouseEvent) => {
      const startState = this.selectionDragStartState();
      const bounds = this.selectionClipBounds();
      if (!startState || !bounds) return;

      const currentRect = trackContent.getBoundingClientRect();
      const currentPercent = (e.clientX - currentRect.left) / currentRect.width;
      let currentTime = this.snapToFrame(this.visibleStart() + currentPercent * this.visibleDuration());

      // Clamp to clip bounds
      currentTime = Math.max(bounds.start, Math.min(bounds.end, currentTime));

      // Update selection based on drag direction
      const start = Math.min(startState.start, currentTime);
      const end = Math.max(startState.start, currentTime);
      this.selection.set({ start, end });
    };

    const onMouseUp = () => {
      this.selectionDragType.set(null);
      this.selectionDragStartState.set(null);
      this.selectionClipBounds.set(null);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Start dragging a selection edge
  startSelectionEdgeDrag(event: MouseEvent, edge: 'start' | 'end') {
    event.preventDefault();
    event.stopPropagation();

    const sel = this.selection();
    if (!sel) return;

    // Use the track-content element for accurate position calculation (same as startSelectionDrag)
    const trackContent = (event.target as HTMLElement).closest('.track-content') as HTMLElement;
    if (!trackContent) return;

    this.selectionDragType.set(edge);
    this.selectionDragStartX.set(event.clientX);
    this.selectionDragStartState.set({ ...sel });

    const onMouseMove = (e: MouseEvent) => {
      const startState = this.selectionDragStartState();
      if (!startState) return;

      const rect = trackContent.getBoundingClientRect();
      const currentPercent = (e.clientX - rect.left) / rect.width;
      const currentTime = this.snapToFrame(this.visibleStart() + currentPercent * this.visibleDuration());

      if (edge === 'start') {
        // Only move the start edge, clamp to not exceed end
        const newStart = Math.min(currentTime, startState.end - (1 / this.frameRate()));
        this.selection.set({ start: Math.max(0, newStart), end: startState.end });
      } else {
        // Only move the end edge, clamp to not exceed start
        const newEnd = Math.max(currentTime, startState.start + (1 / this.frameRate()));
        this.selection.set({ start: startState.start, end: Math.min(this.timelineLength(), newEnd) });
      }
    };

    const onMouseUp = () => {
      this.selectionDragType.set(null);
      this.selectionDragStartState.set(null);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Start moving the entire selection
  startSelectionMoveDrag(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const sel = this.selection();
    if (!sel) return;

    // Use the track-content element for accurate position calculation
    const trackContent = (event.target as HTMLElement).closest('.track-content') as HTMLElement;
    if (!trackContent) return;

    this.selectionDragType.set('move');
    this.selectionDragStartX.set(event.clientX);
    this.selectionDragStartState.set({ ...sel });

    const onMouseMove = (e: MouseEvent) => {
      const startState = this.selectionDragStartState();
      if (!startState) return;

      const rect = trackContent.getBoundingClientRect();
      const deltaX = e.clientX - this.selectionDragStartX();
      const deltaTime = (deltaX / rect.width) * this.visibleDuration();
      const duration = startState.end - startState.start;

      let newStart = this.snapToFrame(startState.start + deltaTime);
      newStart = Math.max(0, Math.min(this.timelineLength() - duration, newStart));

      this.selection.set({ start: newStart, end: newStart + duration });
    };

    const onMouseUp = () => {
      this.selectionDragType.set(null);
      this.selectionDragStartState.set(null);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Toggle highlight mode - press H to start, H again to finish
  toggleHighlight() {
    if (this.isHighlighting()) {
      // Finish highlighting - create selection from start to current
      const start = this.highlightStart();
      if (start !== null) {
        const end = this.currentTime();
        this.selection.set({
          start: Math.min(start, end),
          end: Math.max(start, end)
        });
      }
      this.isHighlighting.set(false);
      this.highlightStart.set(null);
    } else {
      // Start highlighting from current playhead
      this.highlightStart.set(this.currentTime());
      this.isHighlighting.set(true);
      this.selection.set(null); // Clear any existing selection
    }
  }

  selectClipAtPlayhead() {
    // Select the chapter/section at current playhead
    const chapter = this.currentChapter();
    if (chapter) {
      this.selection.set({ start: chapter.startTime, end: chapter.endTime });
    }
  }

  // -------------------------------------------------------------------------
  // METHODS - Markers
  // -------------------------------------------------------------------------
  addMarker() {
    this.showMarkerDialog.set(true);
  }

  // -------------------------------------------------------------------------
  // METHODS - Tabs
  // -------------------------------------------------------------------------
  selectTab(tabId: string) {
    this.tabs.update(tabs => tabs.map(t => ({ ...t, isActive: t.id === tabId })));
    this.currentTime.set(0);
    this.selection.set(null);
    this.fitToWindow();
  }

  closeTab(tabId: string, event: Event) {
    event.stopPropagation();
    const tabs = this.tabs();
    if (tabs.length <= 1) return;

    const idx = tabs.findIndex(t => t.id === tabId);
    const wasActive = tabs[idx].isActive;
    const newTabs = tabs.filter(t => t.id !== tabId);

    if (wasActive && newTabs.length > 0) {
      newTabs[Math.min(idx, newTabs.length - 1)].isActive = true;
    }

    this.tabs.set(newTabs);
  }

  // -------------------------------------------------------------------------
  // METHODS - View
  // -------------------------------------------------------------------------
  toggleFullscreen() {
    this.isFullscreen.update(v => !v);
  }

  toggleInspector() {
    this.showInspector.update(v => !v);
  }

  toggleBrowser() {
    this.showBrowser.update(v => !v);
  }

  // Timeline resize by dragging
  startTimelineResize(event: MouseEvent) {
    event.preventDefault();
    this.isResizingTimeline.set(true);
    this.resizeStartY.set(event.clientY);
    this.resizeStartHeight.set(this.timelineHeight());

    const onMouseMove = (e: MouseEvent) => {
      const deltaY = this.resizeStartY() - e.clientY; // Moving up = increase height
      const newHeight = Math.max(150, Math.min(800, this.resizeStartHeight() + deltaY));
      this.timelineHeight.set(newHeight);
      // Center master lane in real-time during resize
      requestAnimationFrame(() => this.centerMasterLane());
    };

    const onMouseUp = () => {
      this.isResizingTimeline.set(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // Final center on release
      this.centerMasterLane();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Browser panel resize by dragging
  startBrowserResize(event: MouseEvent) {
    event.preventDefault();
    this.isResizingBrowser.set(true);
    this.panelResizeStartX.set(event.clientX);
    this.panelResizeStartWidth.set(this.browserPanelWidth());

    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - this.panelResizeStartX();
      const newWidth = Math.max(180, Math.min(400, this.panelResizeStartWidth() + deltaX));
      this.browserPanelWidth.set(newWidth);
    };

    const onMouseUp = () => {
      this.isResizingBrowser.set(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Inspector panel resize by dragging
  startInspectorResize(event: MouseEvent) {
    event.preventDefault();
    this.isResizingInspector.set(true);
    this.panelResizeStartX.set(event.clientX);
    this.panelResizeStartWidth.set(this.inspectorPanelWidth());

    const onMouseMove = (e: MouseEvent) => {
      const deltaX = this.panelResizeStartX() - e.clientX; // Opposite direction
      const newWidth = Math.max(180, Math.min(400, this.panelResizeStartWidth() + deltaX));
      this.inspectorPanelWidth.set(newWidth);
    };

    const onMouseUp = () => {
      this.isResizingInspector.set(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Center the master lane (lane 0) in the visible area
  centerMasterLane() {
    const container = this.lanesContainer?.nativeElement;
    if (!container) return;

    // Find the master lane element
    const masterLane = container.querySelector('.master-lane') as HTMLElement;
    if (!masterLane) return;

    // Calculate scroll position to center master lane
    const containerHeight = container.clientHeight;
    const masterTop = masterLane.offsetTop;
    const masterHeight = masterLane.offsetHeight;
    const targetScroll = masterTop - (containerHeight / 2) + (masterHeight / 2);

    container.scrollTop = Math.max(0, targetScroll);
  }

  // Handle mouse wheel for vertical scrolling in lanes area
  onLanesWheel(event: WheelEvent) {
    // If Cmd/Ctrl is held, let the horizontal zoom handler take over
    if (event.metaKey || event.ctrlKey) {
      return; // Let onTimelineWheel handle zoom
    }

    // Vertical scrolling through lanes
    const container = this.lanesContainer?.nativeElement;
    if (!container) return;

    // Use deltaY for vertical scroll (natural scrolling)
    container.scrollTop += event.deltaY;
  }

  closeAllDialogs() {
    this.showContextMenu.set(false);
    this.showMarkerDialog.set(false);
    this.showExportDialog.set(false);
    this.showShortcutsDialog.set(false);
  }

  // -------------------------------------------------------------------------
  // METHODS - Context Menu
  // -------------------------------------------------------------------------
  onTimelineContextMenu(event: MouseEvent) {
    event.preventDefault();
    this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
    this.showContextMenu.set(true);
  }

  // -------------------------------------------------------------------------
  // METHODS - Clip Drag & Drop (Custom mouse-based for FCPX precision)
  // -------------------------------------------------------------------------
  onClipMouseDown(event: MouseEvent, clip: TimelineClip) {
    // Only handle left click
    if (event.button !== 0) return;

    // DEBUG: Log to see if this is being triggered when clicking markers
    console.log('[CLIP MOUSEDOWN] target:', (event.target as HTMLElement).className, 'clip:', clip.name);

    // Don't handle if clicking on analysis strip or markers
    const target = event.target as HTMLElement;
    if (target.closest('.analysis-strip') || target.closest('.marker-highlight') || target.closest('.markers-layer')) {
      console.log('[CLIP MOUSEDOWN] Blocked - clicked on marker/overlay');
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    // Always select the clip on click
    this.selectClip(clip);

    // Option+click to detach audio from video
    if (event.altKey && (clip.linkedAudioId || clip.linkedVideoId)) {
      // Detach the link
      if (clip.linkedAudioId) {
        this.detachAudio(clip);
      } else if (clip.linkedVideoId) {
        // Find the video clip and detach from there
        const videoClip = this.clips().find(c => c.id === clip.linkedVideoId);
        if (videoClip) {
          this.detachAudio(videoClip);
        }
      }
      return;
    }

    // If in range/highlight mode, start a selection drag instead of clip drag
    if (this.activeTool() === 'range') {
      this.startSelectionDrag(event, clip);
      return;
    }

    // Get the track content element for calculations
    const trackContent = (event.target as HTMLElement).closest('.track-content') as HTMLElement;
    if (!trackContent) return;

    this.draggedClip.set(clip);
    this.draggedClipOriginalLane.set(clip.lane);
    this.clipDragStart.set({
      mouseX: event.clientX,
      clipStartTime: clip.startTime,
      trackEl: trackContent
    });
    this.clipDragPreviewTime.set(clip.startTime);

    // Add document-level listeners for drag
    const onMouseMove = (e: MouseEvent) => {
      const dragStart = this.clipDragStart();
      if (!dragStart.trackEl) return;

      const rect = dragStart.trackEl.getBoundingClientRect();
      const deltaX = e.clientX - dragStart.mouseX;
      const deltaTime = (deltaX / rect.width) * this.visibleDuration();

      // Calculate new start time with frame snapping
      const newStartTime = dragStart.clipStartTime + deltaTime;
      const clipDuration = clip.endTime - clip.startTime;
      const clampedStart = Math.max(0, Math.min(this.timelineLength() - clipDuration, newStartTime));
      const snappedStart = this.snapToFrame(clampedStart);

      this.clipDragPreviewTime.set(snappedStart);

      // Determine which lane we're over
      const lanes = document.querySelectorAll('.lane');
      lanes.forEach(laneEl => {
        const laneRect = laneEl.getBoundingClientRect();
        if (e.clientY >= laneRect.top && e.clientY <= laneRect.bottom) {
          const laneNum = parseInt(laneEl.getAttribute('data-lane') || '0', 10);
          this.dragOverLane.set(laneNum);
        }
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      const draggedClip = this.draggedClip();
      if (!draggedClip) return;

      let targetLane = this.dragOverLane() ?? draggedClip.lane;
      const desiredStartTime = this.clipDragPreviewTime();
      const clipDuration = draggedClip.endTime - draggedClip.startTime;

      // Check lane restrictions - video/title clips cannot go to audio lanes
      if (!this.canPlaceInLane(draggedClip, targetLane)) {
        // Revert to original lane
        targetLane = draggedClip.lane;
      }

      // Find non-overlapping position
      const finalStartTime = this.findNonOverlappingPosition(draggedClip, targetLane, desiredStartTime);
      const timeDelta = finalStartTime - draggedClip.startTime;

      // Update the clip position
      this.clips.update(clips =>
        clips.map(c =>
          c.id === draggedClip.id
            ? {
                ...c,
                lane: targetLane,
                startTime: finalStartTime,
                endTime: finalStartTime + clipDuration
              }
            : c
        )
      );

      // Update marker times to follow the clip
      if (timeDelta !== 0) {
        this.markers.update(markers =>
          markers.map(m =>
            m.clipId === draggedClip.id
              ? {
                  ...m,
                  time: m.time + timeDelta,
                  endTime: m.endTime ? m.endTime + timeDelta : undefined
                }
              : m
          )
        );
      }

      // Reset drag state
      this.draggedClip.set(null);
      this.draggedClipOriginalLane.set(null);
      this.dragOverLane.set(null);
      this.clipDragStart.set({ mouseX: 0, clipStartTime: 0, trackEl: null });

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Snap time to nearest frame boundary when zoomed in enough
  snapToFrame(time: number): number {
    const fps = this.frameRate();
    const frameDuration = 1 / fps;
    // Only snap when zoomed in enough that frames are visually distinct
    // (when visible duration is less than ~30 seconds)
    if (this.visibleDuration() < 30) {
      return Math.round(time * fps) / fps;
    }
    return time;
  }

  // Get preview position for dragged clip
  getDragPreviewLeft(): number {
    return this.timeToPercent(this.clipDragPreviewTime());
  }

  getDragPreviewWidth(): number {
    const clip = this.draggedClip();
    if (!clip) return 0;
    const duration = clip.endTime - clip.startTime;
    return (duration / this.visibleDuration()) * 100;
  }

  // -------------------------------------------------------------------------
  // METHODS - Clip Selection & Editing (FCPX-style)
  // -------------------------------------------------------------------------

  // Select a clip
  selectClip(clip: TimelineClip) {
    this.selectedClip.set(clip);
    // Clear range selection and marker selection when selecting a clip
    this.selection.set(null);
    this.selectionLane.set(null);
    this.selectedMarker.set(null);
  }

  // Deselect clip
  deselectClip() {
    this.selectedClip.set(null);
  }

  // Check if a clip is selected
  isClipSelected(clip: TimelineClip): boolean {
    return this.selectedClip()?.id === clip.id;
  }

  // Nudge selected clip by frames (positive = right, negative = left)
  nudgeSelectedClip(frames: number) {
    const clip = this.selectedClip();
    if (!clip) return;

    const frameDuration = 1 / this.frameRate();
    const nudgeAmount = frames * frameDuration;
    const clipDuration = clip.endTime - clip.startTime;

    // Calculate new position
    let newStart = clip.startTime + nudgeAmount;

    // Clamp to timeline bounds
    newStart = Math.max(0, newStart);
    if (newStart + clipDuration > this.timelineLength()) {
      newStart = this.timelineLength() - clipDuration;
    }

    // Check for overlaps and find valid position
    newStart = this.findNonOverlappingPosition(clip, clip.lane, newStart);

    // Update the clip
    this.clips.update(clips =>
      clips.map(c =>
        c.id === clip.id
          ? { ...c, startTime: newStart, endTime: newStart + clipDuration }
          : c
      )
    );

    // Update the selected clip reference
    const updatedClip = this.clips().find(c => c.id === clip.id);
    if (updatedClip) {
      this.selectedClip.set(updatedClip);
    }

    // Move linked audio if this is a video clip
    if (clip.linkedAudioId) {
      this.clips.update(clips =>
        clips.map(c =>
          c.id === clip.linkedAudioId
            ? { ...c, startTime: newStart, endTime: newStart + clipDuration }
            : c
        )
      );
    }
  }

  // Trim selected clip edge by frames
  trimSelectedClip(edge: 'start' | 'end', frames: number) {
    const clip = this.selectedClip();
    if (!clip) return;

    const frameDuration = 1 / this.frameRate();
    const trimAmount = frames * frameDuration;
    const minDuration = frameDuration; // Minimum 1 frame

    let newStart = clip.startTime;
    let newEnd = clip.endTime;

    if (edge === 'start') {
      newStart = clip.startTime + trimAmount;
      // Don't let start go past end - minDuration
      newStart = Math.min(newStart, clip.endTime - minDuration);
      // Don't let start go before 0
      newStart = Math.max(0, newStart);
    } else {
      newEnd = clip.endTime + trimAmount;
      // Don't let end go before start + minDuration
      newEnd = Math.max(newEnd, clip.startTime + minDuration);
      // Don't let end go past timeline
      newEnd = Math.min(newEnd, this.timelineLength());
    }

    // Update the clip
    this.clips.update(clips =>
      clips.map(c =>
        c.id === clip.id
          ? { ...c, startTime: newStart, endTime: newEnd }
          : c
      )
    );

    // Update the selected clip reference
    const updatedClip = this.clips().find(c => c.id === clip.id);
    if (updatedClip) {
      this.selectedClip.set(updatedClip);
    }
  }

  // Start trimming a clip edge with mouse
  onClipTrimStart(event: MouseEvent, clip: TimelineClip, edge: 'start' | 'end') {
    event.preventDefault();
    event.stopPropagation();

    // Select the clip
    this.selectClip(clip);

    this.isTrimmingClip.set(true);
    this.trimEdge.set(edge);
    this.trimStartState.set({
      clipId: clip.id,
      startTime: clip.startTime,
      endTime: clip.endTime,
      mouseX: event.clientX
    });

    const trackContent = (event.target as HTMLElement).closest('.track-content') as HTMLElement;
    if (!trackContent) return;

    const onMouseMove = (e: MouseEvent) => {
      const state = this.trimStartState();
      if (!state) return;

      const rect = trackContent.getBoundingClientRect();
      const deltaX = e.clientX - state.mouseX;
      const deltaTime = (deltaX / rect.width) * this.visibleDuration();

      const frameDuration = 1 / this.frameRate();
      const minDuration = frameDuration;

      let newStart = state.startTime;
      let newEnd = state.endTime;

      if (edge === 'start') {
        newStart = this.snapToFrame(state.startTime + deltaTime);
        newStart = Math.max(0, newStart);
        newStart = Math.min(newStart, state.endTime - minDuration);
      } else {
        newEnd = this.snapToFrame(state.endTime + deltaTime);
        newEnd = Math.min(this.timelineLength(), newEnd);
        newEnd = Math.max(newEnd, state.startTime + minDuration);
      }

      // Update clip in real-time
      this.clips.update(clips =>
        clips.map(c =>
          c.id === state.clipId
            ? { ...c, startTime: newStart, endTime: newEnd }
            : c
        )
      );

      // Update selected clip reference
      const updatedClip = this.clips().find(c => c.id === state.clipId);
      if (updatedClip) {
        this.selectedClip.set(updatedClip);
      }
    };

    const onMouseUp = () => {
      this.isTrimmingClip.set(false);
      this.trimEdge.set(null);
      this.trimStartState.set(null);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // -------------------------------------------------------------------------
  // METHODS - Marker Drag
  // -------------------------------------------------------------------------

  // Drag marker start or end point
  onMarkerDragStart(event: MouseEvent, marker: CustomMarker, clip: TimelineClip, edge: 'start' | 'end') {
    event.preventDefault();
    event.stopPropagation();

    // Select the marker and show in inspector
    this.selectedMarker.set(marker);
    this.selectedClip.set(null); // Clear clip selection when dragging marker
    if (marker.type === 'analysis') {
      this.inspectorTab.set('analysis');
    }

    this.draggedMarker.set(marker);
    this.isExtendingMarker.set(true);

    const startX = event.clientX;
    const originalStartTime = marker.time;
    const originalEndTime = marker.endTime || marker.time;
    // Capture clip bounds at drag start - these are the hard limits
    const clipStartBound = clip.startTime;
    const clipEndBound = clip.endTime;
    const clipDuration = clipEndBound - clipStartBound;

    // Get the clip element for width calculations (not the track)
    const clipElement = (event.target as HTMLElement).closest('.clip');
    const clipWidth = clipElement?.clientWidth || 100;

    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startX;
      // Convert pixel delta to time delta based on clip width
      const deltaTime = (deltaX / clipWidth) * clipDuration;

      if (edge === 'start') {
        // Moving the start point - end stays fixed at originalEndTime
        // Clamp: can't go before clip start, can't go past (endTime - 0.1)
        let newStartTime = originalStartTime + deltaTime;
        newStartTime = Math.max(clipStartBound, newStartTime); // Don't go before clip start
        newStartTime = Math.min(originalEndTime - 0.1, newStartTime); // Don't go past marker end

        const updatedMarker = { ...marker, time: newStartTime, endTime: originalEndTime };
        this.markers.update(markers =>
          markers.map(m => m.id === marker.id ? updatedMarker : m)
        );
        this.draggedMarker.set(updatedMarker);
      } else {
        // Moving the end point - start stays fixed at originalStartTime
        // Clamp: can't go past clip end, can't go before (startTime + 0.1)
        let newEndTime = originalEndTime + deltaTime;
        newEndTime = Math.min(clipEndBound, newEndTime); // Don't go past clip end
        newEndTime = Math.max(originalStartTime + 0.1, newEndTime); // Don't go before marker start

        const updatedMarker = { ...marker, time: originalStartTime, endTime: newEndTime };
        this.markers.update(markers =>
          markers.map(m => m.id === marker.id ? updatedMarker : m)
        );
        this.draggedMarker.set(updatedMarker);
      }
    };

    const onMouseUp = () => {
      this.draggedMarker.set(null);
      this.isExtendingMarker.set(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  getMarkerTypeColor(type: string, category?: string): string {
    switch (type) {
      case 'standard': return '#ff6b35'; // Creamsicle orange
      case 'todo': return '#ef4444'; // Red
      case 'completed': return '#5aab78'; // Green
      case 'chapter': return '#ffa366'; // Secondary orange
      case 'analysis': return this.getCategoryColor(category); // Category-based
      default: return '#ff6b35';
    }
  }

  // Select a marker to show its details (with click cycling for overlaps)
  selectMarker(marker: CustomMarker) {
    console.log('[SELECT MARKER] marker:', marker.id, marker.category);
    const currentSelected = this.selectedMarker();

    // Get all markers that overlap with the clicked marker
    const overlappingMarkers = this.getOverlappingMarkersAt(marker);

    // If there are multiple overlapping markers and one is selected, cycle through them
    if (overlappingMarkers.length > 1 && currentSelected) {
      const currentInOverlap = overlappingMarkers.find(m => m.id === currentSelected.id);
      if (currentInOverlap) {
        // Find current index and cycle to next
        const currentIndex = overlappingMarkers.findIndex(m => m.id === currentSelected.id);
        const nextIndex = (currentIndex + 1) % overlappingMarkers.length;
        const nextMarker = overlappingMarkers[nextIndex];
        this.selectedMarker.set(nextMarker);
        this.selectedClip.set(null); // Clear clip selection
        if (nextMarker.type === 'analysis') {
          this.inspectorTab.set('analysis');
          this.scrollToAnalysisItem(nextMarker.id);
        }
        return;
      }
    }

    // If clicking the same marker (no overlaps), deselect
    if (currentSelected?.id === marker.id) {
      this.selectedMarker.set(null);
      return;
    }

    // Normal selection
    this.selectedMarker.set(marker);
    // Clear clip selection when selecting a marker
    this.selectedClip.set(null);
    if (marker.type === 'analysis') {
      this.inspectorTab.set('analysis');
      this.scrollToAnalysisItem(marker.id);
    }
  }

  // Scroll to a specific analysis item in the sidebar
  private scrollToAnalysisItem(markerId: string) {
    // Use setTimeout to allow DOM to update after tab switch
    setTimeout(() => {
      const element = document.getElementById(`analysis-item-${markerId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }

  // Check if two markers overlap in time
  markersOverlap(m1: CustomMarker, m2: CustomMarker): boolean {
    const m1Start = m1.time;
    const m1End = m1.endTime || m1.time + 0.5; // Give point markers a small width
    const m2Start = m2.time;
    const m2End = m2.endTime || m2.time + 0.5;

    return m1Start < m2End && m1End > m2Start;
  }

  // Get all markers that overlap with a given marker (including itself)
  getOverlappingMarkersAt(marker: CustomMarker): CustomMarker[] {
    const clipMarkers = this.markers().filter(m => m.clipId === marker.clipId && m.type !== 'chapter');
    return clipMarkers.filter(m => this.markersOverlap(marker, m));
  }

  // Check if a marker overlaps with the currently selected marker (for styling)
  isOverlappingWithSelected(marker: CustomMarker): boolean {
    const selected = this.selectedMarker();
    if (!selected || selected.id === marker.id) return false;
    if (selected.clipId !== marker.clipId) return false;
    return this.markersOverlap(selected, marker);
  }

  // Toggle transcript search options
  toggleSoundex() {
    this.useSoundex.update(v => !v);
  }

  togglePhraseSearch() {
    this.usePhraseSearch.update(v => !v);
  }

  // -------------------------------------------------------------------------
  // UTILITIES
  // -------------------------------------------------------------------------
  formatTimecode(seconds: number): string {
    const fps = this.frameRate();
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * fps);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${f.toString().padStart(2, '0')}`;
  }

  formatTimeCompact(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  formatDurationShort(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  timeToPercent(time: number): number {
    const start = this.visibleStart();
    const duration = this.visibleDuration();
    return ((time - start) / duration) * 100;
  }

  // Get the top offset for a lane (for positioning overlays)
  getLaneTopOffset(lane: number): number {
    try {
      const baseHeight = 64; // Base track height
      const audioHeight = 32; // Audio track height
      const scale = this.timelineScale() || 1;
      const lanes = this.activeLanes() || [];

      let offset = 0;
      for (const l of lanes) {
        if (l === lane) break;
        // Video/master lanes are full height, audio lanes are half
        offset += (l < 0 ? audioHeight : baseHeight) * scale;
      }
      return offset;
    } catch (e) {
      console.error('getLaneTopOffset error:', e);
      return 0;
    }
  }

  // Get the height for a lane
  getLaneHeight(lane: number): number {
    try {
      const baseHeight = 64;
      const audioHeight = 32;
      const scale = this.timelineScale() || 1;
      return (lane < 0 ? audioHeight : baseHeight) * scale;
    } catch (e) {
      console.error('getLaneHeight error:', e);
      return 64;
    }
  }

  getMarkerColor(category: string): string {
    const colors: Record<string, string> = {
      'marker': '#ff6b35',
      'highlight': '#ffa366',
      'note': '#ffb380',
      'todo': '#ef4444',
      'important': '#5aab78'
    };
    return colors[category] || '#ff6b35';
  }

  // Generate demo waveform data
  getWaveformBars(): number[] {
    const bars: number[] = [];
    for (let i = 0; i < 300; i++) {
      bars.push(0.15 + Math.random() * 0.5 + Math.sin(i * 0.08) * 0.15);
    }
    return bars;
  }

  waveformBars = this.getWaveformBars();
}
