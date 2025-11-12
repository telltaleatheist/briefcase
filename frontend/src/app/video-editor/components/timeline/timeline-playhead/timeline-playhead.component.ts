import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState } from '../../../models';

@Component({
  selector: 'app-timeline-playhead',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-playhead.component.html',
  styleUrls: ['./timeline-playhead.component.scss']
})
export class TimelinePlayheadComponent implements OnChanges {
  @Input() currentTime: number = 0;
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() isDraggable: boolean = true;

  @Output() playheadDragStart = new EventEmitter<MouseEvent>();

  playheadStyle: any = { left: '0%', display: 'none' };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['currentTime'] || changes['duration'] || changes['zoomState']) {
      this.updatePlayheadStyle();
    }
  }

  private updatePlayheadStyle(): void {
    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;
    const visibleEnd = visibleStart + visibleDuration;

    // Only show if within visible range
    if (this.currentTime < visibleStart || this.currentTime > visibleEnd) {
      this.playheadStyle = { left: '-100px', display: 'none' };
      return;
    }

    const percentage = ((this.currentTime - visibleStart) / visibleDuration) * 100;
    this.playheadStyle = {
      left: `${percentage}%`,
      display: 'block'
    };
  }

  onMouseDown(event: MouseEvent): void {
    if (this.isDraggable) {
      this.playheadDragStart.emit(event);
    }
  }
}
