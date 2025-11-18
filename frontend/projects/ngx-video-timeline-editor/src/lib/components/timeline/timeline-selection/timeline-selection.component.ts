import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState, TimelineSelection } from '../../../models';

@Component({
  selector: 'ngx-vte-timeline-selection',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-selection.component.html',
  styleUrls: ['./timeline-selection.component.scss']
})
export class TimelineSelectionComponent implements OnChanges {
  @Input() selection: TimelineSelection = { startTime: 0, endTime: 0 };
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() selectedTool: 'cursor' | 'highlight' = 'cursor';

  @Output() windowDragStart = new EventEmitter<MouseEvent>();
  @Output() leftHandleDragStart = new EventEmitter<MouseEvent>();
  @Output() rightHandleDragStart = new EventEmitter<MouseEvent>();

  selectionStyle: any = { left: '0', width: '0', display: 'none' };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selection'] || changes['duration'] || changes['zoomState']) {
      this.updateSelectionStyle();
    }
  }

  private updateSelectionStyle(): void {
    // If no selection (both start and end are 0), hide it
    if (this.selection.startTime === 0 && this.selection.endTime === 0) {
      this.selectionStyle = { left: '0', width: '0', display: 'none' };
      return;
    }

    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();
    const visibleEnd = visibleStart + visibleDuration;

    // Calculate visible portion of selection
    const selStart = Math.max(this.selection.startTime, visibleStart);
    const selEnd = Math.min(this.selection.endTime, visibleEnd);

    // If selection is completely outside visible range, hide it
    if (this.selection.endTime < visibleStart || this.selection.startTime > visibleEnd) {
      this.selectionStyle = { left: '0', width: '0', display: 'none' };
      return;
    }

    const startPercentage = ((selStart - visibleStart) / visibleDuration) * 100;
    const endPercentage = ((selEnd - visibleStart) / visibleDuration) * 100;

    this.selectionStyle = {
      left: `${startPercentage}%`,
      width: `${endPercentage - startPercentage}%`,
      display: 'block'
    };
  }

  private getVisibleStartTime(): number {
    return this.zoomState.offset;
  }

  private getVisibleDuration(): number {
    return this.duration / this.zoomState.level;
  }

  onWindowMouseDown(event: MouseEvent): void {
    if (this.selectedTool === 'highlight') {
      this.windowDragStart.emit(event);
    }
  }

  onLeftHandleMouseDown(event: MouseEvent): void {
    if (this.selectedTool === 'highlight') {
      event.stopPropagation(); // Prevent window drag from triggering
      this.leftHandleDragStart.emit(event);
    }
  }

  onRightHandleMouseDown(event: MouseEvent): void {
    if (this.selectedTool === 'highlight') {
      event.stopPropagation(); // Prevent window drag from triggering
      this.rightHandleDragStart.emit(event);
    }
  }
}
