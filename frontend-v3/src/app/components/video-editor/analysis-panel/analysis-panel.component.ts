import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TimelineSection, CategoryFilter, AnalysisData } from '../../../models/video-editor.model';
import { TranscriptionSegment } from '../../../models/video-info.model';

@Component({
  selector: 'app-analysis-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './analysis-panel.component.html',
  styleUrls: ['./analysis-panel.component.scss']
})
export class AnalysisPanelComponent {
  @Input() sections: TimelineSection[] = [];
  @Input() categoryFilters: CategoryFilter[] = [];
  @Input() selectedSection?: TimelineSection;
  @Input() analysisData?: AnalysisData;
  @Input() hasAnalysis = false;
  @Input() videoId?: string;
  @Input() transcript: TranscriptionSegment[] = [];
  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() sectionDelete = new EventEmitter<string>(); // section id
  @Output() filterToggle = new EventEmitter<string>();
  @Output() generateAnalysis = new EventEmitter<string>();
  @Output() transcriptSeek = new EventEmitter<number>();

  // Tab state
  activeTab = signal<'analysis' | 'transcript'>('analysis');

  // Transcript search
  transcriptSearch = signal('');

  get filteredTranscript(): TranscriptionSegment[] {
    const query = this.transcriptSearch().toLowerCase().trim();
    if (!query) return this.transcript;

    return this.transcript.filter(segment =>
      segment.text.toLowerCase().includes(query)
    );
  }

  get transcriptResultCount(): number {
    return this.filteredTranscript.length;
  }

  setActiveTab(tab: 'analysis' | 'transcript'): void {
    this.activeTab.set(tab);
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
