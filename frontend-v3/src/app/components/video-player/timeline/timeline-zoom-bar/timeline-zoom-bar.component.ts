import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState } from '../../../../models/video-editor.model';

@Component({
  selector: 'app-timeline-zoom-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-zoom-bar.component.html',
  styleUrls: ['./timeline-zoom-bar.component.scss']
})
export class TimelineZoomBarComponent {
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Output() zoomChange = new EventEmitter<ZoomState>();

  get thumbWidth(): number {
    return Math.min(100, 100 / this.zoomState.level);
  }

  get thumbLeft(): number {
    if (this.duration <= 0) return 0;
    const maxOffset = this.duration - (this.duration / this.zoomState.level);
    if (maxOffset <= 0) return 0;
    return (this.zoomState.offset / maxOffset) * (100 - this.thumbWidth);
  }

  onTrackClick(event: MouseEvent): void {
    const track = event.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    const percentage = (event.clientX - rect.left) / rect.width;

    const visibleDuration = this.duration / this.zoomState.level;
    const maxOffset = this.duration - visibleDuration;
    const newOffset = Math.max(0, Math.min(maxOffset, percentage * this.duration - visibleDuration / 2));

    this.zoomChange.emit({
      ...this.zoomState,
      offset: newOffset
    });
  }

  onThumbDragStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const track = (event.target as HTMLElement).closest('.zoom-track') as HTMLElement;
    if (!track) return;

    const startX = event.clientX;
    const startOffset = this.zoomState.offset;

    const onMouseMove = (e: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const deltaX = e.clientX - startX;
      const deltaPercentage = deltaX / rect.width;

      const visibleDuration = this.duration / this.zoomState.level;
      const maxOffset = this.duration - visibleDuration;
      const newOffset = Math.max(0, Math.min(maxOffset, startOffset + deltaPercentage * this.duration));

      this.zoomChange.emit({
        ...this.zoomState,
        offset: newOffset
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  onLeftHandleDrag(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const track = (event.target as HTMLElement).closest('.zoom-track') as HTMLElement;
    if (!track) return;

    const startX = event.clientX;
    const startOffset = this.zoomState.offset;
    const startVisibleDuration = this.duration / this.zoomState.level;
    // Right edge stays fixed
    const rightEdge = startOffset + startVisibleDuration;

    const onMouseMove = (e: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const deltaX = e.clientX - startX;
      const deltaTime = (deltaX / rect.width) * this.duration;

      // New left edge (offset) moves with drag
      const newOffset = Math.max(0, Math.min(rightEdge - 0.1, startOffset + deltaTime));
      // New visible duration is from new offset to fixed right edge
      const newVisibleDuration = rightEdge - newOffset;
      // Calculate new zoom level - max zoom allows 5 seconds visible
      const maxZoom = this.duration / 5;
      const newLevel = Math.max(1, Math.min(maxZoom, this.duration / newVisibleDuration));

      this.zoomChange.emit({
        level: newLevel,
        offset: newOffset
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  onRightHandleDrag(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const track = (event.target as HTMLElement).closest('.zoom-track') as HTMLElement;
    if (!track) return;

    const startX = event.clientX;
    const startOffset = this.zoomState.offset;
    const startVisibleDuration = this.duration / this.zoomState.level;
    const startRightEdge = startOffset + startVisibleDuration;

    const onMouseMove = (e: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const deltaX = e.clientX - startX;
      const deltaTime = (deltaX / rect.width) * this.duration;

      // Right edge moves with drag, left edge (offset) stays fixed
      const newRightEdge = Math.max(startOffset + 0.1, Math.min(this.duration, startRightEdge + deltaTime));
      // New visible duration
      const newVisibleDuration = newRightEdge - startOffset;
      // Calculate new zoom level - max zoom allows 5 seconds visible
      const maxZoom = this.duration / 5;
      const newLevel = Math.max(1, Math.min(maxZoom, this.duration / newVisibleDuration));

      this.zoomChange.emit({
        level: newLevel,
        offset: startOffset
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  zoomIn(): void {
    // Calculate max zoom: should be able to fit 5 seconds on screen
    const maxZoom = this.duration / 5;
    const newLevel = Math.min(maxZoom, this.zoomState.level * 1.2);
    const visibleDuration = this.duration / newLevel;
    const maxOffset = this.duration - visibleDuration;

    this.zoomChange.emit({
      level: newLevel,
      offset: Math.min(this.zoomState.offset, maxOffset)
    });
  }

  zoomOut(): void {
    const newLevel = Math.max(1, this.zoomState.level / 1.2);
    const visibleDuration = this.duration / newLevel;
    const maxOffset = this.duration - visibleDuration;

    this.zoomChange.emit({
      level: newLevel,
      offset: Math.min(this.zoomState.offset, Math.max(0, maxOffset))
    });
  }

  resetZoom(): void {
    this.zoomChange.emit({
      level: 1,
      offset: 0
    });
  }

  onWheel(event: WheelEvent): void {
    // Only handle horizontal panning (no zoom modifiers)
    if (event.metaKey || event.ctrlKey) {
      return; // Let parent handle zoom
    }

    event.preventDefault();

    const visibleDuration = this.duration / this.zoomState.level;
    const maxOffset = this.duration - visibleDuration;

    if (maxOffset <= 0) return; // Can't scroll if not zoomed

    // Scroll amount: use deltaX for horizontal scroll, deltaY for vertical wheel
    const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;

    // Scroll by a percentage of visible duration (5% per wheel tick)
    const scrollAmount = (delta / 100) * visibleDuration * 0.5;
    const newOffset = Math.max(0, Math.min(maxOffset, this.zoomState.offset + scrollAmount));

    this.zoomChange.emit({
      ...this.zoomState,
      offset: newOffset
    });
  }
}
