import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MuteSection, ZoomState } from '../../../../models/video-editor.model';

interface MuteSectionStyle {
  left: string;
  width: string;
  display: string;
}

export interface MuteResizeEvent {
  section: MuteSection;
  handle: 'left' | 'right';
  event: MouseEvent;
}

@Component({
  selector: 'app-timeline-mute-layer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-mute-layer.component.html',
  styleUrls: ['./timeline-mute-layer.component.scss']
})
export class TimelineMuteLayerComponent implements OnChanges {
  @Input() muteSections: MuteSection[] = [];
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() selectedSection?: MuteSection;
  @Output() sectionClick = new EventEmitter<MuteSection>();
  @Output() sectionDelete = new EventEmitter<MuteSection>();
  @Output() sectionResizeStart = new EventEmitter<MuteResizeEvent>();

  sectionStyles: Map<string, MuteSectionStyle> = new Map();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['muteSections'] || changes['duration'] || changes['zoomState']) {
      this.updateSectionStyles();
    }
  }

  private updateSectionStyles(): void {
    this.sectionStyles.clear();

    if (this.duration <= 0) return;

    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;
    const visibleEnd = visibleStart + visibleDuration;

    if (visibleDuration <= 0 || !isFinite(visibleDuration)) {
      return;
    }

    for (const section of this.muteSections) {
      // If section is completely outside visible range, hide it
      if (section.endSeconds < visibleStart || section.startSeconds > visibleEnd) {
        this.sectionStyles.set(section.id, {
          left: '0',
          width: '0',
          display: 'none'
        });
        continue;
      }

      // Calculate visible portion of section
      const sectionStart = Math.max(section.startSeconds, visibleStart);
      const sectionEnd = Math.min(section.endSeconds, visibleEnd);

      const startPercentage = ((sectionStart - visibleStart) / visibleDuration) * 100;
      const endPercentage = ((sectionEnd - visibleStart) / visibleDuration) * 100;

      this.sectionStyles.set(section.id, {
        left: `${startPercentage}%`,
        width: `${endPercentage - startPercentage}%`,
        display: 'flex'
      });
    }
  }

  getSectionStyle(section: MuteSection): MuteSectionStyle {
    return this.sectionStyles.get(section.id) || {
      left: '0',
      width: '0',
      display: 'none'
    };
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  onSectionClick(section: MuteSection, event: MouseEvent): void {
    event.stopPropagation();
    this.sectionClick.emit(section);
  }

  onDeleteClick(section: MuteSection, event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    this.sectionDelete.emit(section);
  }

  onResizeHandleMouseDown(section: MuteSection, handle: 'left' | 'right', event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    this.sectionResizeStart.emit({ section, handle, event });
  }
}
