import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineSection, ZoomState } from '../../../../models/video-editor.model';
import { VERIFIER_REJECTION_LABEL, ghostLabel, isGhosted } from '../../../../models/flag-filter';

export interface SectionResizeEvent {
  section: TimelineSection;
  handle: 'left' | 'right';
  event: MouseEvent;
}

interface SectionStyle {
  left: string;
  width: string;
  backgroundColor: string;
  borderColor: string;
  display: string;
  /** The section runs past the visible window on this side (zoomed in): the
   *  drawn edge isn't its real edge, so it gets no resize handle. */
  clippedLeft?: boolean;
  clippedRight?: boolean;
}

@Component({
  selector: 'app-timeline-sections-layer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-sections-layer.component.html',
  styleUrls: ['./timeline-sections-layer.component.scss']
})
export class TimelineSectionsLayerComponent implements OnChanges {
  @Input() sections: TimelineSection[] = [];

  readonly verifierRejectionLabel = VERIFIER_REJECTION_LABEL;

  /**
   * True for a marker the verifier REJECTED. Only ever present in `sections` at
   * the LOOSE filter position; it renders ghosted and behind the solid markers
   * rather than being dropped, so the timeline shows what was considered as well
   * as what was kept.
   */
  isGhostSection(section: TimelineSection): boolean {
    return isGhosted(section);
  }

  /** The rejection caption, or "not verified" on a snap candidate row. */
  ghostCaption(section: TimelineSection): string {
    return ghostLabel(section);
  }
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() selectedSection?: TimelineSection;
  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() sectionHover = new EventEmitter<TimelineSection | null>();
  @Output() sectionResizeStart = new EventEmitter<SectionResizeEvent>();

  /**
   * Set when an edge drag begins and cleared just after the mouse comes back
   * up: the click that ends a drag must not count as a click on the section
   * (which would jump the playhead to its start).
   */
  private resizing = false;

  sectionStyles: Map<string, SectionStyle> = new Map();

  private readonly SECTION_BACKGROUND_OPACITY = 0.4;
  private readonly SECTION_BORDER_OPACITY = 0.9;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sections'] || changes['duration'] || changes['zoomState']) {
      this.updateSectionStyles();
    }
  }

  private updateSectionStyles(): void {
    this.sectionStyles.clear();

    if (this.duration <= 0) return;

    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;
    const visibleEnd = visibleStart + visibleDuration;

    // Guard against invalid visibleDuration
    if (visibleDuration <= 0 || !isFinite(visibleDuration)) {
      return;
    }

    for (const section of this.sections) {
      // If section is completely outside visible range, hide it
      if (section.endTime < visibleStart || section.startTime > visibleEnd) {
        this.sectionStyles.set(section.id, {
          left: '0',
          width: '0',
          backgroundColor: this.adjustColorOpacity(section.color, this.SECTION_BACKGROUND_OPACITY),
          borderColor: this.adjustColorOpacity(section.color, this.SECTION_BORDER_OPACITY),
          display: 'none'
        });
        continue;
      }

      // Calculate visible portion of section
      const sectionStart = Math.max(section.startTime, visibleStart);
      const sectionEnd = Math.min(section.endTime, visibleEnd);

      const startPercentage = ((sectionStart - visibleStart) / visibleDuration) * 100;
      const endPercentage = ((sectionEnd - visibleStart) / visibleDuration) * 100;

      this.sectionStyles.set(section.id, {
        left: `${startPercentage}%`,
        width: `${endPercentage - startPercentage}%`,
        backgroundColor: this.adjustColorOpacity(section.color, this.SECTION_BACKGROUND_OPACITY),
        borderColor: this.adjustColorOpacity(section.color, this.SECTION_BORDER_OPACITY),
        display: 'block',
        clippedLeft: section.startTime < visibleStart,
        clippedRight: section.endTime > visibleEnd
      });
    }
  }

  private adjustColorOpacity(color: string, opacity: number): string {
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
    return color;
  }

  getSectionStyle(section: TimelineSection): SectionStyle {
    return this.sectionStyles.get(section.id) || {
      left: '0',
      width: '0',
      backgroundColor: section.color,
      borderColor: section.color,
      display: 'none'
    };
  }

  onSectionClick(section: TimelineSection, event: MouseEvent): void {
    event.stopPropagation();
    if (this.resizing) return;
    this.sectionClick.emit(section);
  }

  onSectionMouseEnter(section: TimelineSection): void {
    this.sectionHover.emit(section);
  }

  onSectionMouseLeave(): void {
    this.sectionHover.emit(null);
  }

  onResizeHandleMouseDown(section: TimelineSection, handle: 'left' | 'right', event: MouseEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.resizing = true;
    // The click (if any) fires right after mouseup in the same task; clear the
    // flag after it so the next real click on a section works.
    document.addEventListener('mouseup', () => setTimeout(() => { this.resizing = false; }), { once: true, capture: true });
    this.sectionResizeStart.emit({ section, handle, event });
  }
}
