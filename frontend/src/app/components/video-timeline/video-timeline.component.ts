import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

export interface TimelineSection {
  startTime: number;
  endTime: number;
  category: string;
  description: string;
  color: string;
}

export interface TimelineSelection {
  startTime: number;
  endTime: number;
}

@Component({
  selector: 'app-video-timeline',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './video-timeline.component.html',
  styleUrls: ['./video-timeline.component.scss']
})
export class VideoTimelineComponent implements OnInit, OnDestroy {
  @Input() duration = 0; // Total video duration in seconds
  @Input() currentTime = 0; // Current playback time
  @Input() sections: TimelineSection[] = [];
  @Output() seek = new EventEmitter<number>();
  @Output() selectionChange = new EventEmitter<TimelineSelection>();

  @ViewChild('timeline', { static: false }) timelineElement!: ElementRef<HTMLDivElement>;
  @ViewChild('selectionWindow', { static: false }) selectionWindowElement!: ElementRef<HTMLDivElement>;

  // Selection state
  selectionStart = 0;
  selectionEnd = 0;
  isDraggingWindow = false;
  isDraggingLeftHandle = false;
  isDraggingRightHandle = false;
  dragStartX = 0;
  dragStartSelectionStart = 0;
  dragStartSelectionEnd = 0;

  // Scrubbing state
  isScrubbing = false;

  // Zoom state
  zoomLevel = 1; // 1 = 100%, 2 = 200%, etc.
  zoomOffset = 0; // Offset in seconds for panning when zoomed

  // Range selection (drag-to-select)
  isDraggingRange = false;
  rangeStartTime = 0;

  ngOnInit() {
    // Initialize selection to full duration
    this.selectionEnd = this.duration;
    this.emitSelection();

    // Add global mouse event listeners for dragging
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('wheel', this.handleWheel, { passive: false });
    document.addEventListener('keydown', this.handleKeyDown);
  }

  ngOnDestroy() {
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  /**
   * Get visible duration based on zoom level
   */
  getVisibleDuration(): number {
    return this.duration / this.zoomLevel;
  }

  /**
   * Get visible start time based on zoom and offset
   */
  getVisibleStartTime(): number {
    return this.zoomOffset;
  }

  /**
   * Get visible end time based on zoom and offset
   */
  getVisibleEndTime(): number {
    return Math.min(this.zoomOffset + this.getVisibleDuration(), this.duration);
  }

  /**
   * Get pixel position from time (accounting for zoom)
   */
  timeToPixels(time: number): number {
    if (!this.timelineElement?.nativeElement) return 0;
    const width = this.timelineElement.nativeElement.clientWidth;
    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();
    return ((time - visibleStart) / visibleDuration) * width;
  }

  /**
   * Get time from pixel position (accounting for zoom)
   */
  pixelsToTime(pixels: number): number {
    if (!this.timelineElement?.nativeElement) return 0;
    const width = this.timelineElement.nativeElement.clientWidth;
    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();
    return visibleStart + (pixels / width) * visibleDuration;
  }

  /**
   * Handle timeline click to seek or start range selection
   */
  onTimelineClick(event: MouseEvent) {
    // Don't seek if we just finished a range drag
    if (this.isDraggingRange) {
      return;
    }

    if (this.isScrubbing || this.isDraggingWindow || this.isDraggingLeftHandle || this.isDraggingRightHandle) {
      return;
    }

    const rect = this.timelineElement.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = this.pixelsToTime(x);
    this.seek.emit(Math.max(0, Math.min(this.duration, time)));
  }

  /**
   * Handle timeline mouse down for range selection
   */
  onTimelineMouseDown(event: MouseEvent) {
    // Check if clicking on empty timeline (not on handles or selection window)
    const target = event.target as HTMLElement;
    if (target.classList.contains('timeline') || target.classList.contains('sections-layer') || target.classList.contains('section-marker')) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);

      this.isDraggingRange = true;
      this.rangeStartTime = time;
      this.selectionStart = time;
      this.selectionEnd = time;

      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * Start scrubbing playhead
   */
  onPlayheadMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isScrubbing = true;
  }

  /**
   * Start dragging selection window
   */
  onWindowMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingWindow = true;
    this.dragStartX = event.clientX;
    this.dragStartSelectionStart = this.selectionStart;
    this.dragStartSelectionEnd = this.selectionEnd;
  }

  /**
   * Start dragging left handle
   */
  onLeftHandleMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingLeftHandle = true;
    this.dragStartX = event.clientX;
  }

  /**
   * Start dragging right handle
   */
  onRightHandleMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingRightHandle = true;
    this.dragStartX = event.clientX;
  }

  /**
   * Handle mouse move for dragging and scrubbing
   */
  handleMouseMove = (event: MouseEvent) => {
    if (this.isDraggingRange) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = Math.max(0, Math.min(this.duration, this.pixelsToTime(x)));

      // Update selection range
      if (time < this.rangeStartTime) {
        this.selectionStart = time;
        this.selectionEnd = this.rangeStartTime;
      } else {
        this.selectionStart = this.rangeStartTime;
        this.selectionEnd = time;
      }
      this.emitSelection();
      return;
    }

    if (this.isScrubbing) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);
      this.seek.emit(Math.max(0, Math.min(this.duration, time)));
      return;
    }

    if (this.isDraggingWindow) {
      const deltaX = event.clientX - this.dragStartX;
      const deltaTime = this.pixelsToTime(deltaX);
      const windowDuration = this.dragStartSelectionEnd - this.dragStartSelectionStart;

      let newStart = this.dragStartSelectionStart + deltaTime;
      let newEnd = this.dragStartSelectionEnd + deltaTime;

      // Clamp to bounds
      if (newStart < 0) {
        newStart = 0;
        newEnd = windowDuration;
      }
      if (newEnd > this.duration) {
        newEnd = this.duration;
        newStart = this.duration - windowDuration;
      }

      this.selectionStart = newStart;
      this.selectionEnd = newEnd;
      this.emitSelection();
      return;
    }

    if (this.isDraggingLeftHandle) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);

      // Minimum selection duration: 1 second
      const minDuration = 1;
      this.selectionStart = Math.max(0, Math.min(time, this.selectionEnd - minDuration));
      this.emitSelection();
      return;
    }

    if (this.isDraggingRightHandle) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);

      // Minimum selection duration: 1 second
      const minDuration = 1;
      this.selectionEnd = Math.min(this.duration, Math.max(time, this.selectionStart + minDuration));
      this.emitSelection();
      return;
    }
  };

  /**
   * Handle mouse up to end dragging
   */
  handleMouseUp = (event: MouseEvent) => {
    // Clear range dragging flag after a short delay to prevent immediate seek
    if (this.isDraggingRange) {
      setTimeout(() => {
        this.isDraggingRange = false;
      }, 50);
    }

    this.isScrubbing = false;
    this.isDraggingWindow = false;
    this.isDraggingLeftHandle = false;
    this.isDraggingRightHandle = false;
  };

  /**
   * Handle mouse wheel for zooming
   */
  handleWheel = (event: WheelEvent) => {
    // Only zoom if hovering over timeline
    if (!this.timelineElement?.nativeElement) return;
    const rect = this.timelineElement.nativeElement.getBoundingClientRect();
    const isOverTimeline =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    if (!isOverTimeline) return;

    event.preventDefault();

    // Get mouse position in timeline before zoom
    const mouseX = event.clientX - rect.left;
    const timeAtMouse = this.pixelsToTime(mouseX);

    // Adjust zoom level
    const zoomDelta = event.deltaY > 0 ? -0.2 : 0.2;
    const newZoomLevel = Math.max(1, Math.min(10, this.zoomLevel + zoomDelta));

    if (newZoomLevel !== this.zoomLevel) {
      this.zoomLevel = newZoomLevel;

      // Adjust offset to keep the time under the mouse in the same position
      const newVisibleDuration = this.getVisibleDuration();
      const mousePositionRatio = mouseX / rect.width;
      this.zoomOffset = timeAtMouse - (newVisibleDuration * mousePositionRatio);

      // Clamp offset to valid range
      this.zoomOffset = Math.max(0, Math.min(this.duration - newVisibleDuration, this.zoomOffset));
    }
  };

  /**
   * Handle keyboard shortcuts for zoom
   */
  handleKeyDown = (event: KeyboardEvent) => {
    // Cmd/Ctrl + Plus/Minus for zoom
    if ((event.metaKey || event.ctrlKey) && (event.key === '+' || event.key === '=' || event.key === '-')) {
      event.preventDefault();

      const zoomDelta = (event.key === '-') ? -0.5 : 0.5;
      const newZoomLevel = Math.max(1, Math.min(10, this.zoomLevel + zoomDelta));

      if (newZoomLevel !== this.zoomLevel) {
        // Zoom centered on current playhead or middle of visible range
        const centerTime = this.currentTime || (this.getVisibleStartTime() + this.getVisibleDuration() / 2);
        this.zoomLevel = newZoomLevel;

        const newVisibleDuration = this.getVisibleDuration();
        this.zoomOffset = centerTime - (newVisibleDuration / 2);

        // Clamp offset to valid range
        this.zoomOffset = Math.max(0, Math.min(this.duration - newVisibleDuration, this.zoomOffset));
      }
    }
  };

  /**
   * Emit selection change event
   */
  emitSelection() {
    this.selectionChange.emit({
      startTime: this.selectionStart,
      endTime: this.selectionEnd
    });
  }

  /**
   * Format time as MM:SS or HH:MM:SS
   */
  formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Get selection duration
   */
  getSelectionDuration(): string {
    return this.formatTime(this.selectionEnd - this.selectionStart);
  }

  /**
   * Reset selection to full duration
   */
  resetSelection() {
    this.selectionStart = 0;
    this.selectionEnd = this.duration;
    this.emitSelection();
  }

  /**
   * Reset zoom to 100%
   */
  resetZoom() {
    this.zoomLevel = 1;
    this.zoomOffset = 0;
  }

  /**
   * Set selection from current playhead position to end
   */
  setSelectionFromPlayhead() {
    this.selectionStart = this.currentTime;
    if (this.selectionEnd <= this.selectionStart) {
      this.selectionEnd = this.duration;
    }
    this.emitSelection();
  }

  /**
   * Set selection from start to current playhead position
   */
  setSelectionToPlayhead() {
    this.selectionEnd = this.currentTime;
    if (this.selectionStart >= this.selectionEnd) {
      this.selectionStart = 0;
    }
    this.emitSelection();
  }

  /**
   * Get CSS styles for playhead
   */
  getPlayheadStyle() {
    const percentage = (this.currentTime / this.duration) * 100;
    return {
      left: `${percentage}%`
    };
  }

  /**
   * Get CSS styles for selection window
   */
  getSelectionStyle() {
    const startPercentage = (this.selectionStart / this.duration) * 100;
    const endPercentage = (this.selectionEnd / this.duration) * 100;
    return {
      left: `${startPercentage}%`,
      width: `${endPercentage - startPercentage}%`
    };
  }

  /**
   * Get CSS styles for a section marker
   */
  getSectionStyle(section: TimelineSection) {
    const startPercentage = (section.startTime / this.duration) * 100;
    const endPercentage = (section.endTime / this.duration) * 100;
    return {
      left: `${startPercentage}%`,
      width: `${endPercentage - startPercentage}%`,
      backgroundColor: section.color
    };
  }
}
