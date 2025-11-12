import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ZoomState } from '../../../models';

export interface TimelineSection {
  startTime: number;
  endTime: number;
  category: string;
  description: string;
  color: string;
}

@Component({
  selector: 'app-timeline-sections-layer',
  standalone: true,
  imports: [CommonModule, MatTooltipModule],
  templateUrl: './timeline-sections-layer.component.html',
  styleUrls: ['./timeline-sections-layer.component.scss']
})
export class TimelineSectionsLayerComponent implements OnChanges {
  @Input() sections: TimelineSection[] = [];
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };

  // Cached section styles for performance
  sectionStyles: Map<TimelineSection, any> = new Map();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sections'] || changes['duration'] || changes['zoomState']) {
      this.updateSectionStyles();
    }
  }

  private updateSectionStyles(): void {
    this.sectionStyles.clear();

    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();
    const visibleEnd = visibleStart + visibleDuration;

    for (const section of this.sections) {
      // Calculate visible portion of section
      const sectionStart = Math.max(section.startTime, visibleStart);
      const sectionEnd = Math.min(section.endTime, visibleEnd);

      // If section is completely outside visible range, hide it
      if (section.endTime < visibleStart || section.startTime > visibleEnd) {
        this.sectionStyles.set(section, {
          left: '0',
          width: '0',
          backgroundColor: section.color,
          display: 'none'
        });
        continue;
      }

      const startPercentage = ((sectionStart - visibleStart) / visibleDuration) * 100;
      const endPercentage = ((sectionEnd - visibleStart) / visibleDuration) * 100;

      this.sectionStyles.set(section, {
        left: `${startPercentage}%`,
        width: `${endPercentage - startPercentage}%`,
        backgroundColor: section.color,
        display: 'block'
      });
    }
  }

  getSectionStyle(section: TimelineSection): any {
    return this.sectionStyles.get(section) || {};
  }

  private getVisibleStartTime(): number {
    return this.zoomState.offset;
  }

  private getVisibleDuration(): number {
    return this.duration / this.zoomState.level;
  }
}
