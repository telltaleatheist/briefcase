import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ZoomState, TimelineSection } from '../../../models';

@Component({
  selector: 'ngx-vte-timeline-sections-layer',
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

  // Configurable opacity values (matches CSS variables in _timeline-theme.scss)
  private readonly SECTION_BACKGROUND_OPACITY = 0.4;
  private readonly SECTION_BORDER_OPACITY = 0.9;

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
          backgroundColor: this.adjustColorOpacity(section.color, this.SECTION_BACKGROUND_OPACITY),
          borderColor: this.adjustColorOpacity(section.color, this.SECTION_BORDER_OPACITY),
          display: 'none'
        });
        continue;
      }

      const startPercentage = ((sectionStart - visibleStart) / visibleDuration) * 100;
      const endPercentage = ((sectionEnd - visibleStart) / visibleDuration) * 100;

      this.sectionStyles.set(section, {
        left: `${startPercentage}%`,
        width: `${endPercentage - startPercentage}%`,
        backgroundColor: this.adjustColorOpacity(section.color, this.SECTION_BACKGROUND_OPACITY),
        borderColor: this.adjustColorOpacity(section.color, this.SECTION_BORDER_OPACITY),
        display: 'block'
      });
    }
  }

  private adjustColorOpacity(color: string, opacity: number): string {
    // Convert hex or rgb color to rgba with specified opacity
    // Handle hex colors like #ff6600
    if (color.startsWith('#')) {
      const hex = color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
    // Handle rgb/rgba colors
    if (color.startsWith('rgb')) {
      const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})`;
      }
    }
    // Fallback - return as is
    return color;
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
