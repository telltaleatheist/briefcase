import { Component, Input, Output, EventEmitter, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineSection, CategoryFilter, AnalysisData } from '../../../models/video-editor.model';

@Component({
  selector: 'app-analysis-panel',
  standalone: true,
  imports: [CommonModule],
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
  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() filterToggle = new EventEmitter<string>();
  @Output() generateAnalysis = new EventEmitter<string>();

  onGenerateAnalysis(): void {
    if (this.videoId) {
      this.generateAnalysis.emit(this.videoId);
    }
  }

  // Group sections by category
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

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  formatTimeRange(start: number, end: number): string {
    return `${this.formatTime(start)} - ${this.formatTime(end)}`;
  }
}
