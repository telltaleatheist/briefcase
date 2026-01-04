import { Component, Input, Output, EventEmitter, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TimelineSection, TimelineChapter, CategoryFilter, AnalysisData } from '../../../models/video-editor.model';
import { TranscriptionSegment } from '../../../models/video-info.model';
import { TranscriptSearchService, TranscriptSearchOptions } from '../../../services/transcript-search.service';

@Component({
  selector: 'app-analysis-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './analysis-panel.component.html',
  styleUrls: ['./analysis-panel.component.scss']
})
export class AnalysisPanelComponent {
  private transcriptSearchService = inject(TranscriptSearchService);
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
  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() sectionDelete = new EventEmitter<string>(); // section id
  @Output() chapterClick = new EventEmitter<TimelineChapter>();
  @Output() chapterDelete = new EventEmitter<string>(); // chapter id
  @Output() filterToggle = new EventEmitter<string>();
  @Output() filterSelectAll = new EventEmitter<void>();
  @Output() filterDeselectAll = new EventEmitter<void>();
  @Output() filterSelectMarkers = new EventEmitter<void>();
  @Output() generateAnalysis = new EventEmitter<string>();
  @Output() transcriptSeek = new EventEmitter<number>();

  // Tab state - only 2 tabs now
  activeTab = signal<'analysis' | 'transcript'>('analysis');

  // Analysis sub-view: categories (sections) or chapters
  analysisView = signal<'categories' | 'chapters'>('categories');

  // Filter accordion state
  filtersExpanded = signal(true);

  // Transcript sub-view: segments (timestamped) or plain (continuous text)
  transcriptView = signal<'segments' | 'plain'>('segments');

  // Transcript search
  transcriptSearch = signal('');

  // Transcript search options
  searchOptions: TranscriptSearchOptions = {
    useSoundex: false,
    usePhraseSearch: false
  };

  // Computed plain text transcript
  plainTranscript = computed(() => {
    return this.transcript.map(s => s.text).join(' ').trim();
  });

  // Filtered plain text (for search)
  get filteredPlainTranscript(): string {
    const query = this.transcriptSearch().toLowerCase().trim();
    if (!query) return this.plainTranscript();

    // For plain view, just return the full text (highlighting handled in template)
    return this.plainTranscript();
  }

  // Check if search matches plain text
  get plainTextHasMatch(): boolean {
    const query = this.transcriptSearch().toLowerCase().trim();
    if (!query) return true;
    return this.plainTranscript().toLowerCase().includes(query);
  }

  get filteredTranscript(): TranscriptionSegment[] {
    const query = this.transcriptSearch().trim();
    if (!query) return this.transcript;

    return this.transcript.filter(segment =>
      this.transcriptSearchService.matchesQuery(query, segment.text, this.searchOptions)
    );
  }

  get transcriptResultCount(): number {
    if (this.transcriptView() === 'plain') {
      const query = this.transcriptSearch().toLowerCase().trim();
      if (!query) return 0;
      // Count occurrences in plain text
      const text = this.plainTranscript().toLowerCase();
      let count = 0;
      let pos = 0;
      while ((pos = text.indexOf(query, pos)) !== -1) {
        count++;
        pos += query.length;
      }
      return count;
    }
    return this.filteredTranscript.length;
  }

  setActiveTab(tab: 'analysis' | 'transcript'): void {
    this.activeTab.set(tab);
  }

  setAnalysisView(view: 'categories' | 'chapters'): void {
    this.analysisView.set(view);
  }

  toggleFilters(): void {
    this.filtersExpanded.set(!this.filtersExpanded());
  }

  setTranscriptView(view: 'segments' | 'plain'): void {
    this.transcriptView.set(view);
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

  formatChapterDuration(chapter: TimelineChapter): string {
    const duration = chapter.endTime - chapter.startTime;
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  onTranscriptSearchChange(value: string): void {
    this.transcriptSearch.set(value);
  }

  clearTranscriptSearch(): void {
    this.transcriptSearch.set('');
  }

  onTranscriptSegmentClick(segment: TranscriptionSegment): void {
    this.transcriptSeek.emit(segment.startTime);
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
