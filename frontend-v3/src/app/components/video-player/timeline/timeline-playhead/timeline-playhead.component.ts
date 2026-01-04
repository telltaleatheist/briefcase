import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState } from '../../../../models/video-editor.model';

@Component({
  selector: 'app-timeline-playhead',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-playhead.component.html',
  styleUrls: ['./timeline-playhead.component.scss']
})
export class TimelinePlayheadComponent {
  @Input() currentTime: number = 0;
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Output() seek = new EventEmitter<number>();

  get playheadPosition(): number {
    if (this.duration <= 0) return 0;

    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;

    // Guard against invalid visibleDuration
    if (!isFinite(visibleDuration) || visibleDuration <= 0) return 0;

    const position = ((this.currentTime - visibleStart) / visibleDuration) * 100;
    return Math.max(0, Math.min(100, position));
  }

  get isVisible(): boolean {
    const visibleStart = this.zoomState.offset;
    const visibleEnd = visibleStart + (this.duration / this.zoomState.level);
    return this.currentTime >= visibleStart && this.currentTime <= visibleEnd;
  }

  onDragStart(event: MouseEvent): void {
    event.preventDefault();
    const container = (event.target as HTMLElement).closest('.timeline-playhead-container');
    if (!container) return;

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const percentage = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

      const visibleStart = this.zoomState.offset;
      const visibleDuration = this.duration / this.zoomState.level;

      // Guard against invalid visibleDuration
      if (!isFinite(visibleDuration) || visibleDuration <= 0) return;

      const newTime = visibleStart + (percentage * visibleDuration);

      this.seek.emit(Math.max(0, Math.min(this.duration, newTime)));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }
}
