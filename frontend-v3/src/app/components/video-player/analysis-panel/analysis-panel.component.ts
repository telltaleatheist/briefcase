import { Component, Input, Output, EventEmitter, signal, computed, inject, OnChanges, SimpleChanges, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TimelineSection, TimelineChapter, CategoryFilter, AnalysisData } from '../../../models/video-editor.model';
import {
  FlagFilter,
  FLAG_FILTERS,
  FLAG_FILTER_DESCRIPTION,
  FLAG_FILTER_LABEL,
  VERIFIER_REJECTION_LABEL,
  isGhosted,
  ghostLabel,
} from '../../../models/flag-filter';
import { TranscriptionSegment } from '../../../models/video-info.model';
import { closeMatches } from '@search/close-match';
import { LibraryService } from '../../../services/library.service';
import { highlightPieces } from '../../../models/library-search.model';
import { ChapterRow, chapterRows, leafChapters } from './chapter-outline';

const EXPANDED_KEY = 'briefcase-transcript-expanded-search';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** The segment playing at `time` (a meaning hit's start), or the nearest one after it. */
function segmentAt(segments: TranscriptionSegment[], time: number): TranscriptionSegment | undefined {
  return segments.find(s => s.startTime <= time + 0.5 && time < s.endTime) ?? segments.find(s => s.startTime >= time);
}

/** A transcript row: its (first) segment, and its text cut into matched and plain pieces. */
export interface TranscriptRow {
  segment: TranscriptionSegment;
  pieces: Array<{ text: string; hit: boolean }>;
}

@Component({
  selector: 'app-analysis-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './analysis-panel.component.html',
  styleUrls: ['./analysis-panel.component.scss']
})
export class AnalysisPanelComponent implements OnChanges {
  private host = inject(ElementRef) as ElementRef<HTMLElement>;
  private libraryService = inject(LibraryService);
  @Input() sections: TimelineSection[] = [];
  @Input() chapters: TimelineChapter[] = [];
  @Input() categoryFilters: CategoryFilter[] = [];
  @Input() selectedSection?: TimelineSection;
  @Input() selectedChapterId?: string;
  @Input() currentTime: number = 0;
  @Input() analysisData?: AnalysisData;
  @Input() hasAnalysis = false;
  @Input() videoId?: string;
  @Input() transcript: TranscriptionSegment[] = [];
  /**
   * The flag filter's current position, owned by the player (which does the
   * actual filtering) and rendered here. `sections` above ALREADY has this
   * filter applied — the control is here because this is where a user looks at
   * findings, not because this component decides what is visible.
   */
  @Input() flagFilter: FlagFilter = 'confirmed';
  /** Per-position counts, so the control says what pressing it will do. */
  @Input() flagFilterCounts: Record<FlagFilter, number> = { confirmed: 0, all: 0 };
  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() sectionDelete = new EventEmitter<string>(); // section id
  @Output() chapterClick = new EventEmitter<TimelineChapter>();
  @Output() chapterDelete = new EventEmitter<string>(); // chapter id
  /**
   * Run the flag analysis on just this chapter's stretch of the video (a job
   * that ranks and checks only its transcript, and replaces only its flags).
   */
  @Output() chapterAnalyze = new EventEmitter<TimelineChapter>();
  /** The chapter whose analysis request is on its way (its button waits). */
  @Input() chapterAnalyzeBusyId: string | null = null;
  /** Why a chapter can't be analyzed now (Crucible is not ready), or null. AI actions wait for Crucible. */
  @Input() chapterAnalyzeLocked: string | null = null;
  @Output() flagFilterChange = new EventEmitter<FlagFilter>();
  @Output() filterToggle = new EventEmitter<string>();
  @Output() filterSelectAll = new EventEmitter<void>();
  @Output() filterDeselectAll = new EventEmitter<void>();
  @Output() filterSelectMarkers = new EventEmitter<void>();
  @Output() generateAnalysis = new EventEmitter<string>();
  @Output() transcriptSeek = new EventEmitter<number>();

  // "Follow cursor": when enabled, the list scrolls to (and highlights) the
  // item containing the current playback position — chapter, category section,
  // or transcript segment, depending on the open view. Persisted across runs.
  followCursor = signal<boolean>(
    !(typeof localStorage !== 'undefined' && localStorage.getItem('briefcase-follow-cursor') === 'false')
  );

  // Id of the item containing currentTime, per view (recomputed on input changes)
  currentChapterId: string | null = null;
  currentSectionId: string | null = null;
  currentSegmentId: string | null = null;
  private lastFollowId: string | null = null;

  // Nested chapters: rows the user opened with the chevron. Nothing opens by
  // itself (not on load, not by following the cursor).
  expandedChapterIds = signal<ReadonlySet<string>>(new Set());
  chapterRows: ChapterRow[] = [];
  /** Chapters (the outline's leaves: on a stories outline, the chapters inside the stories). */
  chapterCount = 0;

  // Primary tabs
  activeTab = signal<'analysis' | 'chapters' | 'transcript'>('analysis');

  // Filter accordion state
  filtersExpanded = signal(true);

  // Transcript sub-view: segments (timestamped) or plain (continuous text)
  transcriptView = signal<'segments' | 'plain'>('segments');

  // Brief "Copied" feedback for the transcript copy button
  transcriptCopied = signal(false);

  // Transcript search: what is typed, and the query it settles on (after a
  // pause in typing, so a long transcript is not searched on every key).
  transcriptSearch = signal('');
  private readonly searchQuery = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** The transcript input as a signal, so the search reruns only when it changes. */
  private readonly transcriptSegments = signal<TranscriptionSegment[]>([]);

  /**
   * Expanded search: also find what was MEANT (the backend's meaning search,
   * search/meaning-search.ts), listed after the word matches. Remembered.
   */
  readonly expandedSearch = signal(readExpanded());
  readonly meaningHits = signal<Array<{ start: number; score: number }>>([]);
  readonly meaningState = signal<'idle' | 'searching' | 'error'>('idle');
  readonly meaningError = signal('');
  private meaningSeq = 0;

  // Computed plain text transcript
  plainTranscript = computed(() => this.transcriptSegments().map(s => s.text).join(' ').trim());

  /**
   * The transcript rows to list: every segment, or, while searching, the
   * places closest to the query (search/close-match.ts, the same rules as the
   * library search, scored so a misremembered quote still finds its line),
   * each with the words that matched marked.
   */
  readonly transcriptRows = computed<TranscriptRow[]>(() => {
    const segments = this.transcriptSegments();
    const query = this.searchQuery().trim();
    if (!query) return segments.map(segment => ({ segment, pieces: [{ text: segment.text, hit: false }] }));
    return closeMatches(segments.map(s => ({ start: s.startTime, end: s.endTime, text: s.text })), query).map(hit => {
      const shown = segments.slice(hit.first, hit.last + 1);
      const ranges: Array<[number, number]> = [];
      let offset = 0;
      shown.forEach((s, k) => {
        for (const [segment, a, b] of hit.highlights) if (segment === hit.first + k) ranges.push([offset + a, offset + b]);
        offset += s.text.length + 1;
      });
      ranges.sort((x, y) => x[0] - y[0]);
      return { segment: shown[0], pieces: highlightPieces(shown.map(s => s.text).join(' '), ranges) };
    });
  });

  /**
   * Meaning matches the word search did not list: each at the transcript
   * segment it starts in, best first, under a "Similar in meaning" divider.
   */
  readonly relatedRows = computed<TranscriptRow[]>(() => {
    if (!this.expandedSearch() || !this.searchQuery().trim()) return [];
    const segments = this.transcriptSegments();
    const listed = new Set(this.transcriptRows().map(r => r.segment.id));
    const rows: TranscriptRow[] = [];
    for (const hit of this.meaningHits()) {
      const segment = segmentAt(segments, hit.start);
      if (!segment || listed.has(segment.id)) continue;
      listed.add(segment.id);
      rows.push({ segment, pieces: [{ text: segment.text, hit: false }] });
    }
    return rows;
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['transcript']) this.transcriptSegments.set(this.transcript ?? []);
    // Another video (or its new transcript): meaning results belong to the old one.
    if (changes['videoId'] || changes['transcript']) this.runMeaningSearch();
    if (changes['chapters']) this.refreshChapterRows();
    if (changes['currentTime'] || changes['chapters'] || changes['sections'] ||
        changes['transcript'] || changes['categoryFilters']) {
      this.updateCurrentIds();
      if (changes['currentTime'] && this.followCursor()) {
        this.scrollToCurrent();
      }
    }
  }

  toggleFollowCursor(): void {
    const enabled = !this.followCursor();
    this.followCursor.set(enabled);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('briefcase-follow-cursor', String(enabled));
    }
    if (enabled) {
      this.scrollToCurrent(true); // jump to the current item right away
    }
  }

  // Recompute which item (per view) contains the current playback position.
  private updateCurrentIds(): void {
    const t = this.currentTime;
    const within = (start: number, end: number) => t >= start && t < end;
    // The deepest VISIBLE row at the playhead: a collapsed story, or the
    // chapter inside an opened one (rows are in outline order, so the last).
    const visible = this.chapterRows.filter(r => within(r.chapter.startTime, r.chapter.endTime));
    this.currentChapterId = visible.length ? visible[visible.length - 1].chapter.id : null;
    this.currentSectionId = this.filteredSections.find(s => within(s.startTime, s.endTime))?.id ?? null;
    this.currentSegmentId = this.transcript.find(s => within(s.startTime, s.endTime))?.id ?? null;
  }

  // The id to follow for whichever tab is currently open.
  private get currentFollowId(): string | null {
    switch (this.activeTab()) {
      case 'transcript': return this.currentSegmentId;
      case 'chapters': return this.currentChapterId;
      default: return this.currentSectionId; // analysis (categories)
    }
  }

  // Scroll the highlighted (.follow-current) item into view. Skips work when
  // the target hasn't changed, unless `force` is set (e.g. on toggle/view switch).
  private scrollToCurrent(force = false): void {
    if (!this.followCursor()) return;
    const id = this.currentFollowId;
    if (!id || (!force && id === this.lastFollowId)) return;
    this.lastFollowId = id;
    // Wait for the view to render the .follow-current class before scrolling.
    requestAnimationFrame(() => {
      const el = this.host.nativeElement.querySelector('.follow-current') as HTMLElement | null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  setActiveTab(tab: 'analysis' | 'chapters' | 'transcript'): void {
    this.activeTab.set(tab);
    this.scrollToCurrent(true);
  }

  toggleFilters(): void {
    this.filtersExpanded.set(!this.filtersExpanded());
  }

  setTranscriptView(view: 'segments' | 'plain'): void {
    this.transcriptView.set(view);
    this.scrollToCurrent(true);
  }

  private refreshChapterRows(): void {
    this.chapterRows = chapterRows(this.chapters, this.expandedChapterIds());
    this.chapterCount = leafChapters(this.chapters).length;
  }

  toggleChapterExpanded(chapter: TimelineChapter, event: Event): void {
    event.stopPropagation();
    const next = new Set(this.expandedChapterIds());
    if (next.has(chapter.id)) next.delete(chapter.id);
    else next.add(chapter.id);
    this.expandedChapterIds.set(next);
    this.refreshChapterRows();
    this.updateCurrentIds();
  }

  /** A story row's meta: HH:MM:SS start – end, and how many chapters it holds. */
  storyMeta(row: ChapterRow): string {
    return `${this.formatTime(row.chapter.startTime)} – ${this.formatTime(row.chapter.endTime)} · ` +
      `${row.childCount} chapter${row.childCount === 1 ? '' : 's'}`;
  }

  // Check if a chapter is currently playing
  isCurrentChapter(chapter: TimelineChapter): boolean {
    return this.currentTime >= chapter.startTime && this.currentTime < chapter.endTime;
  }

  onChapterClick(chapter: TimelineChapter): void {
    this.chapterClick.emit(chapter);
  }

  onChapterDelete(chapter: TimelineChapter): void {
    this.chapterDelete.emit(chapter.id);
  }

  onChapterAnalyze(chapter: TimelineChapter): void {
    this.chapterAnalyze.emit(chapter);
  }

  chapterAnalyzeTitle(chapter: TimelineChapter): string {
    if (this.chapterAnalyzeLocked) return this.chapterAnalyzeLocked;
    const what = this.chapters.some(c => c.parentId === chapter.id) ? 'story' : 'chapter';
    return `Analyze this ${what}: find and check flags in ${this.formatTimeRange(chapter.startTime, chapter.endTime)} only ` +
      `(replaces this ${what}'s flags; the rest of the video is kept)`;
  }

  formatChapterDuration(chapter: TimelineChapter): string {
    const duration = chapter.endTime - chapter.startTime;
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  onTranscriptSearchChange(value: string): void {
    this.transcriptSearch.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchQuery.set(value);
      this.runMeaningSearch();
    }, 200);
  }

  clearTranscriptSearch(): void {
    clearTimeout(this.searchTimer);
    this.transcriptSearch.set('');
    this.searchQuery.set('');
    this.runMeaningSearch();
  }

  setExpandedSearch(on: boolean): void {
    this.expandedSearch.set(on);
    try {
      localStorage.setItem(EXPANDED_KEY, String(on));
    } catch {
      // Remembering the choice is a convenience; the search works without it.
    }
    this.runMeaningSearch();
  }

  /** Ask the backend what the query means here; only the latest answer is kept. */
  private runMeaningSearch(): void {
    const seq = ++this.meaningSeq;
    const query = this.searchQuery().trim();
    this.meaningHits.set([]);
    this.meaningError.set('');
    if (!this.expandedSearch() || !query || !this.videoId) {
      this.meaningState.set('idle');
      return;
    }
    this.meaningState.set('searching');
    this.libraryService.transcriptMeaning(this.videoId, query).subscribe({
      next: (res) => {
        if (seq !== this.meaningSeq) return;
        this.meaningHits.set(res.hits);
        this.meaningState.set('idle');
      },
      error: (err) => {
        if (seq !== this.meaningSeq) return;
        this.meaningState.set('error');
        this.meaningError.set(err?.error?.message || err?.message || 'unknown error');
      },
    });
  }

  onTranscriptSegmentClick(segment: TranscriptionSegment): void {
    this.transcriptSeek.emit(segment.startTime);
  }

  // Copy the full transcript to the clipboard as plain text (no timestamps/segments)
  async copyTranscript(): Promise<void> {
    const text = this.plainTranscript();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.transcriptCopied.set(true);
      setTimeout(() => this.transcriptCopied.set(false), 1500);
    } catch (err) {
      console.error('Failed to copy transcript:', err);
    }
  }

  onGenerateAnalysis(): void {
    if (this.videoId) {
      this.generateAnalysis.emit(this.videoId);
    }
  }

  // Get sections sorted chronologically and filtered by enabled categories
  get filteredSections(): TimelineSection[] {
    return this.sections
      .filter(section => this.isCategoryEnabled(section.category))
      .sort((a, b) => a.startTime - b.startTime);
  }

  // Group sections by category (kept for category filter chips)
  get sectionsByCategory(): Map<string, TimelineSection[]> {
    const grouped = new Map<string, TimelineSection[]>();

    for (const section of this.sections) {
      const category = section.category.toLowerCase();
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }
      grouped.get(category)!.push(section);
    }

    // Sort sections within each category by start time
    grouped.forEach((sections, key) => {
      sections.sort((a, b) => a.startTime - b.startTime);
    });

    return grouped;
  }

  get categories(): string[] {
    return Array.from(this.sectionsByCategory.keys()).sort();
  }

  getCategoryColor(category: string): string {
    const filter = this.categoryFilters.find(f => f.category.toLowerCase() === category.toLowerCase());
    return filter?.color || '#6c757d';
  }

  // ---- flag filter -------------------------------------------------------
  readonly flagFilterPositions = FLAG_FILTERS;
  readonly flagFilterLabel = FLAG_FILTER_LABEL;
  readonly flagFilterDescription = FLAG_FILTER_DESCRIPTION;
  readonly verifierRejectionLabel = VERIFIER_REJECTION_LABEL;

  onFlagFilterSelect(filter: FlagFilter): void {
    if (filter !== this.flagFilter) this.flagFilterChange.emit(filter);
  }

  /**
   * True for a passage the verifier REJECTED — one it read as reported, quoted,
   * questioned or opposed rather than asserted. Only ever reaches this component
   * at the LOOSE position, where it renders ghosted and captioned instead of
   * being silently absent.
   */
  isGhostSection(section: TimelineSection): boolean {
    return isGhosted(section);
  }

  /** The rejection caption, or "not verified" on a snap candidate row. */
  ghostCaption(section: TimelineSection): string {
    return ghostLabel(section);
  }

  isCategoryEnabled(category: string): boolean {
    const filter = this.categoryFilters.find(f => f.category.toLowerCase() === category.toLowerCase());
    return filter?.enabled ?? true;
  }

  getSectionsForCategory(category: string): TimelineSection[] {
    return this.sectionsByCategory.get(category) || [];
  }

  onSectionClick(section: TimelineSection): void {
    this.sectionClick.emit(section);
  }

  onFilterToggle(category: string): void {
    this.filterToggle.emit(category);
  }

  onSelectAllFilters(): void {
    this.filterSelectAll.emit();
  }

  onDeselectAllFilters(): void {
    this.filterDeselectAll.emit();
  }

  onSelectMarkersFilters(): void {
    this.filterSelectMarkers.emit();
  }

  onSectionDelete(section: TimelineSection): void {
    this.sectionDelete.emit(section.id);
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  formatTimeRange(start: number, end: number): string {
    return `${this.formatTime(start)} - ${this.formatTime(end)}`;
  }
}
