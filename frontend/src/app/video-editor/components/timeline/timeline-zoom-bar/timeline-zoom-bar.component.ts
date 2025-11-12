import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState } from '../../../models';

export interface ZoomBarDragEvent {
  event: MouseEvent;
  type: 'viewport' | 'left-handle' | 'right-handle';
}

@Component({
  selector: 'app-timeline-zoom-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-zoom-bar.component.html',
  styleUrls: ['./timeline-zoom-bar.component.scss']
})
export class TimelineZoomBarComponent implements OnChanges {
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };

  @Output() viewportDragStart = new EventEmitter<MouseEvent>();
  @Output() leftHandleDragStart = new EventEmitter<MouseEvent>();
  @Output() rightHandleDragStart = new EventEmitter<MouseEvent>();

  viewportStyle: any = { left: '0%', width: '100%' };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['duration'] || changes['zoomState']) {
      this.updateViewportStyle();
    }
  }

  private updateViewportStyle(): void {
    const visibleDuration = this.getVisibleDuration();
    const startPercentage = (this.zoomState.offset / this.duration) * 100;
    const widthPercentage = (visibleDuration / this.duration) * 100;

    // Ensure minimum width for handles to be visible and clickable
    const minWidthPercentage = 3; // Minimum 3% width
    const actualWidthPercentage = Math.max(widthPercentage, minWidthPercentage);

    this.viewportStyle = {
      left: `${startPercentage}%`,
      width: `${actualWidthPercentage}%`
    };
  }

  private getVisibleDuration(): number {
    return this.duration / this.zoomState.level;
  }

  onViewportMouseDown(event: MouseEvent): void {
    this.viewportDragStart.emit(event);
  }

  onLeftHandleMouseDown(event: MouseEvent): void {
    event.stopPropagation(); // Prevent viewport drag from triggering
    this.leftHandleDragStart.emit(event);
  }

  onRightHandleMouseDown(event: MouseEvent): void {
    event.stopPropagation(); // Prevent viewport drag from triggering
    this.rightHandleDragStart.emit(event);
  }
}
