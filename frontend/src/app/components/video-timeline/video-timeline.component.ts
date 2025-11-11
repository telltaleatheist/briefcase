import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, OnChanges, SimpleChanges, ViewChild, ElementRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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

export type TimelineTool = 'cursor' | 'highlight';

export interface CategoryFilter {
  category: string;
  label: string;
  color: string;
  enabled: boolean;
}

@Component({
  selector: 'app-video-timeline',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './video-timeline.component.html',
  styleUrls: ['./video-timeline.component.scss']
})
export class VideoTimelineComponent implements OnInit, OnDestroy, OnChanges {
  @Input() duration = 0; // Total video duration in seconds
  @Input() currentTime = 0; // Current playback time
  @Input() sections: TimelineSection[] = [];
  @Input() isPlaying = false; // Playback state
  @Output() seek = new EventEmitter<number>();
  @Output() selectionChange = new EventEmitter<TimelineSelection>();
  @Output() playPause = new EventEmitter<void>();
  @Output() playbackSpeed = new EventEmitter<number>(); // Emit playback speed changes

  @ViewChild('timeline', { static: false }) timelineElement!: ElementRef<HTMLDivElement>;
  @ViewChild('selectionWindow', { static: false }) selectionWindowElement!: ElementRef<HTMLDivElement>;

  // Tool selection state
  selectedTool: TimelineTool = 'cursor';

  // Category filter state
  categoryFilters: CategoryFilter[] = [];
  showCategoryFilters = false;

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
  isScrubbingTimeMarker = false;

  // Zoom state
  zoomLevel = 1; // 1 = 100%, 2 = 200%, etc.
  zoomOffset = 0; // Offset in seconds for panning when zoomed

  // Range selection (drag-to-select)
  isDraggingRange = false;
  rangeStartTime = 0;

  // Panning state
  isPanning = false;
  panStartX = 0;
  panStartOffset = 0;
  hasDraggedSincePanStart = false; // Track if user has actually dragged

  // Scrollbar state
  isDraggingScrollbar = false;
  isDraggingLeftZoomHandle = false;
  isDraggingRightZoomHandle = false;
  scrollbarDragStartX = 0;
  scrollbarDragStartOffset = 0;
  scrollbarDragStartZoom = 1;

  // Playback speed state for J/K/L behavior
  private currentPlaybackSpeed = 1;
  private lastKeyPressed: 'j' | 'k' | 'l' | null = null;

  // Store bound event listeners for cleanup
  private boundMouseMove?: (e: MouseEvent) => void;
  private boundMouseUp?: (e: MouseEvent) => void;
  private boundWheel?: (e: WheelEvent) => void;
  private boundKeyDown?: (e: KeyboardEvent) => void;

  // Cache time markers to avoid recalculating on every change detection
  cachedTimeMarkers: Array<{position: number, label: string, isMajor: boolean, showLabel: boolean}> = [];
  private lastMarkerCacheKey = '';

  // Auto-follow playhead state
  autoFollowPlayhead = true;
  private previousIsPlaying = false;
  private previousCurrentTime = 0;

  // Animation for smooth scrolling
  private animationFrameId: number | null = null;
  private targetZoomOffset: number | null = null;
  private animationStartTime: number | null = null;
  private animationStartOffset: number = 0;
  private readonly ANIMATION_DURATION = 300; // ms

  constructor(private ngZone: NgZone) {}

  ngOnChanges(changes: SimpleChanges) {
    // When sections change, update category filters
    if (changes['sections'] && !changes['sections'].firstChange) {
      this.updateCategoryFilters();
    }

    // Auto-follow playhead logic
    if (changes['isPlaying'] || changes['currentTime']) {
      const justPaused = this.previousIsPlaying && !this.isPlaying;
      const isPlayingAndFollowing = this.isPlaying && this.autoFollowPlayhead;

      // Always center playhead on pause
      if (justPaused) {
        this.centerPlayheadInViewport();
      }
      // Center playhead during playback if auto-follow is enabled
      else if (isPlayingAndFollowing && changes['currentTime']) {
        this.centerPlayheadInViewport();
      }

      this.previousIsPlaying = this.isPlaying;
      this.previousCurrentTime = this.currentTime;
    }
  }

  ngOnInit() {
    // Initialize category filters from sections
    this.updateCategoryFilters();

    // Initialize selection based on sections
    if (this.sections && this.sections.length > 0) {
      // Set selection to first section
      const firstSection = this.sections[0];
      this.selectionStart = firstSection.startTime;
      this.selectionEnd = firstSection.endTime;
    } else {
      // No sections - leave selection empty/minimal
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
    this.emitSelection();

    // Add global mouse event listeners for dragging
    // Run handlers OUTSIDE Angular zone for performance
    // Change detection is triggered manually inside the handlers when needed
    this.ngZone.runOutsideAngular(() => {
      this.boundMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
      this.boundMouseUp = (e: MouseEvent) => this.handleMouseUp(e);
      this.boundWheel = (e: WheelEvent) => this.handleWheel(e);
      // boundKeyDown no longer needed - handled by component element binding

      document.addEventListener('mousemove', this.boundMouseMove);
      document.addEventListener('mouseup', this.boundMouseUp);
      document.addEventListener('wheel', this.boundWheel, { passive: false });
      // Keyboard events are now handled via (keydown) binding on component root element
    });
  }

  ngOnDestroy() {
    if (this.boundMouseMove) document.removeEventListener('mousemove', this.boundMouseMove);
    if (this.boundMouseUp) document.removeEventListener('mouseup', this.boundMouseUp);
    if (this.boundWheel) document.removeEventListener('wheel', this.boundWheel);
    // boundKeyDown is no longer a global listener

    // Cancel any ongoing animation
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
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
   * Center the playhead in the viewport with smooth animation
   */
  centerPlayheadInViewport(): void {
    const visibleStart = this.getVisibleStartTime();
    const visibleEnd = this.getVisibleEndTime();

    // Only adjust if playhead is outside the visible range or close to edges
    if (this.currentTime < visibleStart || this.currentTime > visibleEnd) {
      const visibleDuration = this.getVisibleDuration();
      // Calculate target offset to center the playhead
      const targetOffset = Math.max(0,
        Math.min(
          this.duration - visibleDuration,
          this.currentTime - (visibleDuration / 2)
        )
      );

      // Animate to the target offset
      this.animateToOffset(targetOffset);
    }
  }

  /**
   * Animate zoom offset to a target value
   */
  private animateToOffset(targetOffset: number): void {
    // Cancel any ongoing animation
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.targetZoomOffset = targetOffset;
    this.animationStartTime = performance.now();
    this.animationStartOffset = this.zoomOffset;

    const animate = (currentTime: number) => {
      if (this.targetZoomOffset === null || this.animationStartTime === null) {
        return;
      }

      const elapsed = currentTime - this.animationStartTime;
      const progress = Math.min(elapsed / this.ANIMATION_DURATION, 1);

      // Ease-in-out function for smooth animation
      const easeInOut = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      this.ngZone.run(() => {
        this.zoomOffset = this.animationStartOffset +
          (this.targetZoomOffset! - this.animationStartOffset) * easeInOut;
      });

      if (progress < 1) {
        this.animationFrameId = requestAnimationFrame(animate);
      } else {
        this.animationFrameId = null;
        this.targetZoomOffset = null;
        this.animationStartTime = null;
      }
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  /**
   * Toggle auto-follow playhead feature
   */
  toggleAutoFollow(): void {
    this.autoFollowPlayhead = !this.autoFollowPlayhead;
    // If just enabled, immediately center the playhead
    if (this.autoFollowPlayhead) {
      this.centerPlayheadInViewport();
    }
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
   * Handle time marker mouse down to start scrubbing - works regardless of selected tool
   */
  onTimeMarkerMouseDown(event: MouseEvent) {
    if (!this.timelineElement?.nativeElement) return;

    event.preventDefault();
    event.stopPropagation();

    // Start scrubbing immediately
    this.isScrubbingTimeMarker = true;

    // Seek to the clicked position
    const rect = this.timelineElement.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = this.pixelsToTime(x);
    this.emitSeek(time);
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

    // Don't seek in cursor mode - only playhead dragging moves the playhead
    if (this.selectedTool === 'cursor') {
      return;
    }

    const rect = this.timelineElement.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = this.pixelsToTime(x);
    this.emitSeek(time);
  }

  /**
   * Handle timeline mouse down for range selection, panning, or cursor movement
   */
  onTimelineMouseDown(event: MouseEvent) {
    const target = event.target as HTMLElement;

    // Check if clicking on selection window or its children
    const isSelectionWindow = target.classList.contains('selection-window') ||
                               target.closest('.selection-window');

    // Check if clicking on timeline area (now includes selection window for easier interaction)
    const isTimelineArea = target.classList.contains('timeline') ||
                          target.classList.contains('sections-layer') ||
                          target.classList.contains('section-marker') ||
                          isSelectionWindow;

    if (isTimelineArea) {
      // If zoomed and shift key, start panning
      if (this.zoomLevel > 1 && event.shiftKey && !isSelectionWindow) {
        this.isPanning = true;
        this.panStartX = event.clientX;
        this.panStartOffset = this.zoomOffset;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Get click position
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);

      // CURSOR TOOL: Seek on click/drag, or allow panning with Shift key
      if (this.selectedTool === 'cursor') {
        // If clicking selection window, don't interfere
        if (isSelectionWindow) {
          return;
        }

        // If Shift key is held and zoomed, allow panning
        if (event.shiftKey && this.zoomLevel > 1) {
          this.isPanning = true;
          this.panStartX = event.clientX;
          this.panStartOffset = this.zoomOffset;
          this.hasDraggedSincePanStart = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        // Otherwise, start scrubbing (seeking)
        this.isScrubbing = true;
        this.emitSeek(time);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // HIGHLIGHT TOOL: Click inside window to drag, or outside to start new selection
      if (this.selectedTool === 'highlight') {
        // Check if click is within selection window
        const hasSelection = this.selectionStart !== this.selectionEnd;
        const clickInWindow = hasSelection && time >= this.selectionStart && time <= this.selectionEnd;

        if (clickInWindow) {
          // Click inside window - start dragging window
          this.isDraggingWindow = true;
          this.dragStartX = event.clientX;
          this.dragStartSelectionStart = this.selectionStart;
          this.dragStartSelectionEnd = this.selectionEnd;
        } else {
          // Click outside window - start new range selection (or clear on simple click)
          this.isDraggingRange = true;
          this.rangeStartTime = time;
          this.selectionStart = time;
          this.selectionEnd = time;
        }

        event.preventDefault();
        event.stopPropagation();
      }
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
   * Start dragging selection window (only works with highlight tool)
   */
  onWindowMouseDown(event: MouseEvent) {
    if (this.selectedTool !== 'highlight') return;

    event.preventDefault();
    event.stopPropagation();
    this.isDraggingWindow = true;
    this.dragStartX = event.clientX;
    this.dragStartSelectionStart = this.selectionStart;
    this.dragStartSelectionEnd = this.selectionEnd;
  }

  /**
   * Start dragging left handle (only works with highlight tool)
   */
  onLeftHandleMouseDown(event: MouseEvent) {
    if (this.selectedTool !== 'highlight') return;

    event.preventDefault();
    event.stopPropagation();
    this.isDraggingLeftHandle = true;
    this.dragStartX = event.clientX;
    // Move playhead to left handle position (selection start)
    this.emitSeek(this.selectionStart);
  }

  /**
   * Start dragging right handle (only works with highlight tool)
   */
  onRightHandleMouseDown(event: MouseEvent) {
    if (this.selectedTool !== 'highlight') return;

    event.preventDefault();
    event.stopPropagation();
    this.isDraggingRightHandle = true;
    this.dragStartX = event.clientX;
    // Move playhead to right handle position (selection end)
    this.emitSeek(this.selectionEnd);
  }

  /**
   * Handle mouse move for dragging, scrubbing, and panning
   */
  handleMouseMove = (event: MouseEvent) => {
    // Handle time marker scrubbing
    if (this.isScrubbingTimeMarker) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);
      this.seek.emit(Math.max(0, Math.min(this.duration, time)));
      return;
    }

    // Handle scrollbar middle dragging (panning)
    if (this.isDraggingScrollbar) {
      const deltaX = event.clientX - this.scrollbarDragStartX;
      // Assuming scrollbar is same width as timeline
      const scrollbarWidth = this.timelineElement?.nativeElement?.clientWidth || 1;
      const deltaTime = (deltaX / scrollbarWidth) * this.duration;

      this.ngZone.run(() => {
        this.zoomOffset = this.scrollbarDragStartOffset + deltaTime;

        // Clamp offset to valid range
        const visibleDuration = this.getVisibleDuration();
        this.zoomOffset = Math.max(0, Math.min(this.duration - visibleDuration, this.zoomOffset));
      });
      return;
    }

    // Handle left zoom handle dragging
    if (this.isDraggingLeftZoomHandle) {
      const deltaX = event.clientX - this.scrollbarDragStartX;
      const scrollbarWidth = this.timelineElement?.nativeElement?.clientWidth || 1;

      // Convert pixel delta to time delta
      const deltaTime = (deltaX / scrollbarWidth) * this.duration;

      // Moving left handle to the right zooms in (increases visible start, decreases visible duration)
      // New visible start = old offset + deltaTime
      const newVisibleStart = Math.max(0, this.scrollbarDragStartOffset + deltaTime);
      const oldVisibleEnd = this.scrollbarDragStartOffset + (this.duration / this.scrollbarDragStartZoom);
      const newVisibleDuration = oldVisibleEnd - newVisibleStart;

      // Calculate new zoom level
      if (newVisibleDuration > 0 && newVisibleDuration <= this.duration) {
        this.ngZone.run(() => {
          this.zoomLevel = this.duration / newVisibleDuration;
          this.zoomLevel = Math.max(1, Math.min(200, this.zoomLevel));
          this.zoomOffset = newVisibleStart;

          // Clamp offset
          const visibleDuration = this.getVisibleDuration();
          this.zoomOffset = Math.max(0, Math.min(this.duration - visibleDuration, this.zoomOffset));
        });
      }
      return;
    }

    // Handle right zoom handle dragging
    if (this.isDraggingRightZoomHandle) {
      const deltaX = event.clientX - this.scrollbarDragStartX;
      const scrollbarWidth = this.timelineElement?.nativeElement?.clientWidth || 1;

      // Convert pixel delta to time delta
      const deltaTime = (deltaX / scrollbarWidth) * this.duration;

      // Moving right handle to the left zooms in (decreases visible end, decreases visible duration)
      const visibleStart = this.scrollbarDragStartOffset;
      const oldVisibleEnd = this.scrollbarDragStartOffset + (this.duration / this.scrollbarDragStartZoom);
      const newVisibleEnd = Math.min(this.duration, oldVisibleEnd + deltaTime);
      const newVisibleDuration = newVisibleEnd - visibleStart;

      // Calculate new zoom level
      if (newVisibleDuration > 0 && newVisibleDuration <= this.duration) {
        this.ngZone.run(() => {
          this.zoomLevel = this.duration / newVisibleDuration;
          this.zoomLevel = Math.max(1, Math.min(200, this.zoomLevel));

          // Keep the left side fixed, only adjust based on new zoom
          const actualVisibleDuration = this.getVisibleDuration();
          this.zoomOffset = Math.max(0, Math.min(this.duration - actualVisibleDuration, this.zoomOffset));
        });
      }
      return;
    }

    // Handle panning
    if (this.isPanning) {
      const deltaX = event.clientX - this.panStartX;

      // Check if user has moved enough to be considered a drag (more than 3 pixels)
      if (Math.abs(deltaX) > 3) {
        this.hasDraggedSincePanStart = true;
      }

      // Only pan if user has actually dragged
      if (this.hasDraggedSincePanStart) {
        const rect = this.timelineElement.nativeElement.getBoundingClientRect();
        const visibleDuration = this.getVisibleDuration();
        const deltaTime = (deltaX / rect.width) * visibleDuration;

        this.ngZone.run(() => {
          // Pan in opposite direction of mouse movement
          this.zoomOffset = this.panStartOffset - deltaTime;

          // Clamp offset to valid range
          this.zoomOffset = Math.max(0, Math.min(this.duration - visibleDuration, this.zoomOffset));
        });
      }
      return;
    }

    if (this.isDraggingRange) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = Math.max(0, Math.min(this.duration, this.pixelsToTime(x)));

      this.ngZone.run(() => {
        // Update selection range
        if (time < this.rangeStartTime) {
          this.selectionStart = time;
          this.selectionEnd = this.rangeStartTime;
        } else {
          this.selectionStart = this.rangeStartTime;
          this.selectionEnd = time;
        }
        this.emitSelection();
      });
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
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const visibleDuration = this.getVisibleDuration();
      // Convert pixel delta to time delta
      const deltaTime = (deltaX / rect.width) * visibleDuration;
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

      this.ngZone.run(() => {
        this.selectionStart = newStart;
        this.selectionEnd = newEnd;
        this.emitSelection();
      });
      return;
    }

    if (this.isDraggingLeftHandle) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);

      // Minimum selection duration: 1 second
      const minDuration = 1;
      this.ngZone.run(() => {
        this.selectionStart = Math.max(0, Math.min(time, this.selectionEnd - minDuration));
        this.emitSelection();
        // Move playhead to follow the left handle
        this.emitSeek(this.selectionStart);
      });
      return;
    }

    if (this.isDraggingRightHandle) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = this.pixelsToTime(x);

      // Minimum selection duration: 1 second
      const minDuration = 1;
      this.ngZone.run(() => {
        this.selectionEnd = Math.min(this.duration, Math.max(time, this.selectionStart + minDuration));
        this.emitSelection();
        // Move playhead to follow the right handle
        this.emitSeek(this.selectionEnd);
      });
      return;
    }
  };

  /**
   * Handle mouse up to end dragging
   */
  handleMouseUp = (event: MouseEvent) => {
    // Check if range drag was a simple click (no actual selection made)
    if (this.isDraggingRange && this.selectionStart === this.selectionEnd) {
      // Simple click with highlight tool - clear selection (unhighlight)
      this.ngZone.run(() => {
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this.emitSelection();
      });
    }

    // Clear range dragging flag after a short delay to prevent immediate seek
    if (this.isDraggingRange) {
      setTimeout(() => {
        this.ngZone.run(() => {
          this.isDraggingRange = false;
        });
      }, 50);
    }

    this.ngZone.run(() => {
      this.isPanning = false;
      this.hasDraggedSincePanStart = false;
      this.isScrubbing = false;
      this.isScrubbingTimeMarker = false;
      this.isDraggingWindow = false;
      this.isDraggingLeftHandle = false;
      this.isDraggingRightHandle = false;
      this.isDraggingScrollbar = false;
      this.isDraggingLeftZoomHandle = false;
      this.isDraggingRightZoomHandle = false;
    });
  };

  /**
   * Handle mouse wheel for zooming and horizontal panning
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

    // If shift key is held, do horizontal panning instead of zooming
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      if (this.zoomLevel > 1) {
        this.ngZone.run(() => {
          const visibleDuration = this.getVisibleDuration();
          // Pan by 10% of visible duration per scroll tick
          const panAmount = (visibleDuration * 0.1) * (event.deltaY > 0 || event.deltaX > 0 ? 1 : -1);
          this.zoomOffset += panAmount;

          // Clamp offset to valid range
          this.zoomOffset = Math.max(0, Math.min(this.duration - visibleDuration, this.zoomOffset));
        });
      }
      return;
    }

    // Adjust zoom level with acceleration - zoom faster at higher zoom levels
    // deltaY < 0 = scroll up = zoom in, deltaY > 0 = scroll down = zoom out
    const baseZoomDelta = event.deltaY < 0 ? 1 : -1;
    const zoomDelta = baseZoomDelta * this.calculateZoomIncrement(this.zoomLevel);
    const newZoomLevel = Math.max(1, Math.min(200, this.zoomLevel + zoomDelta));

    if (newZoomLevel !== this.zoomLevel) {
      // Get the current visible start and duration BEFORE the zoom
      const oldVisibleStart = this.getVisibleStartTime();
      const oldVisibleDuration = this.getVisibleDuration();

      // Calculate what time the mouse is pointing at in the OLD zoom level
      const mouseX = event.clientX - rect.left;
      const mouseRatio = mouseX / rect.width;  // 0 to 1, where mouse is in the timeline
      const timeAtMouse = oldVisibleStart + (mouseRatio * oldVisibleDuration);

      this.ngZone.run(() => {
        // Update zoom level
        this.zoomLevel = newZoomLevel;

        // Calculate new visible duration after zoom
        const newVisibleDuration = this.getVisibleDuration();

        // Keep the same time under the mouse cursor at the same pixel position
        // We want: newVisibleStart + (mouseRatio * newVisibleDuration) = timeAtMouse
        // So: newVisibleStart = timeAtMouse - (mouseRatio * newVisibleDuration)
        this.zoomOffset = timeAtMouse - (mouseRatio * newVisibleDuration);

        // Clamp offset to valid range
        this.zoomOffset = Math.max(0, Math.min(this.duration - newVisibleDuration, this.zoomOffset));
      });
    }
  };

  /**
   * Handle keyboard shortcuts for zoom, panning, tools, and playback
   */
  handleKeyDown = (event: KeyboardEvent) => {
    // Only handle if not in an input field
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('.mat-mdc-input-element') ||
        target.classList.contains('mat-mdc-input-element')) {
      return;
    }

    // Tool selection shortcuts
    if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      this.ngZone.run(() => {
        this.selectedTool = 'cursor';
      });
      return;
    }

    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      this.ngZone.run(() => {
        this.selectedTool = 'highlight';
      });
      return;
    }

    // Playback control shortcuts (J/K/L)
    if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      this.ngZone.run(() => {
        // J key: Slow down playback speed
        if (this.currentPlaybackSpeed > 1) {
          // If playing faster than 1x, slow down (8x → 4x → 2x → 1x)
          this.currentPlaybackSpeed = this.currentPlaybackSpeed / 2;
        } else {
          // Already at 1x or slower, reset to 1x
          this.currentPlaybackSpeed = 1;
        }
        this.lastKeyPressed = 'j';
        this.emitPlaybackSpeed(this.currentPlaybackSpeed);
      });
      return;
    }

    if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      this.ngZone.run(() => {
        // K key: Pause and reset speed to 1x
        this.currentPlaybackSpeed = 1;
        this.lastKeyPressed = 'k';
        this.emitPlaybackSpeed(0); // 0 means pause
      });
      return;
    }

    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      this.ngZone.run(() => {
        // L key: Speed up playback (requires two presses to reach 2x)
        if (this.lastKeyPressed === 'l' && this.currentPlaybackSpeed > 0 && this.currentPlaybackSpeed < 8) {
          // Already going forward, increase speed (1x → 2x → 4x → 8x)
          this.currentPlaybackSpeed = this.currentPlaybackSpeed * 2;
        } else if (this.currentPlaybackSpeed >= 8) {
          // Already at max speed, stay at 8x
          this.currentPlaybackSpeed = 8;
        } else {
          // Start forward playback at 1x (first press)
          this.currentPlaybackSpeed = 1;
        }
        this.lastKeyPressed = 'l';
        this.emitPlaybackSpeed(this.currentPlaybackSpeed);
      });
      return;
    }

    // Arrow keys for panning when zoomed
    if (this.zoomLevel > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      this.ngZone.run(() => {
        const visibleDuration = this.getVisibleDuration();
        // Pan by 10% of visible duration
        const panAmount = visibleDuration * 0.1 * (event.key === 'ArrowRight' ? 1 : -1);
        this.zoomOffset += panAmount;

        // Clamp offset to valid range
        this.zoomOffset = Math.max(0, Math.min(this.duration - visibleDuration, this.zoomOffset));
      });
      return;
    }

    // Cmd/Ctrl + Plus/Minus for zoom
    if ((event.metaKey || event.ctrlKey) && (event.key === '+' || event.key === '=' || event.key === '-')) {
      event.preventDefault();

      // Use accelerated zoom increments for keyboard as well
      const baseZoomDelta = (event.key === '-') ? -1 : 1;
      const zoomDelta = baseZoomDelta * this.calculateZoomIncrement(this.zoomLevel);
      const newZoomLevel = Math.max(1, Math.min(200, this.zoomLevel + zoomDelta));

      if (newZoomLevel !== this.zoomLevel) {
        this.ngZone.run(() => {
          // Zoom centered on current playhead or middle of visible range
          const centerTime = this.currentTime || (this.getVisibleStartTime() + this.getVisibleDuration() / 2);
          this.zoomLevel = newZoomLevel;

          const newVisibleDuration = this.getVisibleDuration();
          this.zoomOffset = centerTime - (newVisibleDuration / 2);

          // Clamp offset to valid range
          this.zoomOffset = Math.max(0, Math.min(this.duration - newVisibleDuration, this.zoomOffset));
        });
      }
    }
  };

  /**
   * Emit selection change event
   */
  emitSelection() {
    this.ngZone.run(() => {
      this.selectionChange.emit({
        startTime: this.selectionStart,
        endTime: this.selectionEnd
      });
    });
  }

  /**
   * Emit seek event
   */
  emitSeek(time: number) {
    this.ngZone.run(() => {
      this.seek.emit(Math.max(0, Math.min(this.duration, time)));
    });
  }

  /**
   * Emit playback speed event
   */
  emitPlaybackSpeed(speed: number) {
    this.ngZone.run(() => {
      this.playbackSpeed.emit(speed);
    });
  }

  /**
   * Emit play/pause event
   */
  emitPlayPause() {
    this.ngZone.run(() => {
      this.playPause.emit();
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
   * Update category filters based on unique categories in sections
   */
  updateCategoryFilters() {
    const categoryMap = new Map<string, CategoryFilter>();

    // Define standard category labels and colors
    const categoryInfo: { [key: string]: { label: string; color: string } } = {
      'routine': { label: 'Routine', color: '#a855f7' },
      'extremism': { label: 'Extremism', color: '#ef4444' },
      'hate': { label: 'Hate', color: '#f97316' },
      'violence': { label: 'Violence', color: '#dc2626' },
      'conspiracy': { label: 'Conspiracy', color: '#eab308' },
      'misinformation': { label: 'Misinformation', color: '#f59e0b' },
      'interesting': { label: 'Interesting', color: '#3b82f6' },
      'notable': { label: 'Notable', color: '#06b6d4' },
      'important': { label: 'Important', color: '#10b981' },
      'controversial': { label: 'Controversial', color: '#ec4899' },
      'custom': { label: 'Custom Markers', color: '#22c55e' },
    };

    // Extract unique categories from sections
    this.sections.forEach(section => {
      const category = section.category?.toLowerCase() || 'other';
      if (!categoryMap.has(category)) {
        const info = categoryInfo[category] || {
          label: category.charAt(0).toUpperCase() + category.slice(1),
          color: section.color || '#757575'
        };

        categoryMap.set(category, {
          category: category,
          label: info.label,
          color: info.color,
          enabled: true // All categories enabled by default
        });
      }
    });

    this.categoryFilters = Array.from(categoryMap.values());
  }

  /**
   * Toggle visibility of a category
   */
  toggleCategoryFilter(category: string) {
    const filter = this.categoryFilters.find(f => f.category === category);
    if (filter) {
      filter.enabled = !filter.enabled;
    }
  }

  /**
   * Toggle category filter panel visibility
   */
  toggleCategoryFilters() {
    this.showCategoryFilters = !this.showCategoryFilters;
  }

  /**
   * Get filtered sections based on category filters
   */
  get filteredSections(): TimelineSection[] {
    if (this.categoryFilters.length === 0) {
      return this.sections;
    }

    const enabledCategories = new Set(
      this.categoryFilters
        .filter(f => f.enabled)
        .map(f => f.category)
    );

    return this.sections.filter(section => {
      const category = section.category?.toLowerCase() || 'other';
      return enabledCategories.has(category);
    });
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
   * Get CSS styles for playhead (accounting for zoom and pan)
   */
  getPlayheadStyle() {
    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();

    // Only show if within visible range
    if (this.currentTime < visibleStart || this.currentTime > visibleStart + visibleDuration) {
      return { left: '-100px', display: 'none' };
    }

    const percentage = ((this.currentTime - visibleStart) / visibleDuration) * 100;
    return {
      left: `${percentage}%`,
      display: 'block'
    };
  }

  /**
   * Get CSS styles for selection window (accounting for zoom and pan)
   */
  getSelectionStyle() {
    // If no selection (both start and end are 0), hide it
    if (this.selectionStart === 0 && this.selectionEnd === 0) {
      return { left: '0', width: '0', display: 'none' };
    }

    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();
    const visibleEnd = visibleStart + visibleDuration;

    // Calculate visible portion of selection
    const selStart = Math.max(this.selectionStart, visibleStart);
    const selEnd = Math.min(this.selectionEnd, visibleEnd);

    // If selection is completely outside visible range, hide it
    if (this.selectionEnd < visibleStart || this.selectionStart > visibleEnd) {
      return { left: '0', width: '0', display: 'none' };
    }

    const startPercentage = ((selStart - visibleStart) / visibleDuration) * 100;
    const endPercentage = ((selEnd - visibleStart) / visibleDuration) * 100;

    return {
      left: `${startPercentage}%`,
      width: `${endPercentage - startPercentage}%`,
      display: 'block'
    };
  }

  /**
   * Get CSS styles for a section marker (accounting for zoom and pan)
   */
  getSectionStyle(section: TimelineSection) {
    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();
    const visibleEnd = visibleStart + visibleDuration;

    // Calculate visible portion of section
    const sectionStart = Math.max(section.startTime, visibleStart);
    const sectionEnd = Math.min(section.endTime, visibleEnd);

    // If section is completely outside visible range, hide it
    if (section.endTime < visibleStart || section.startTime > visibleEnd) {
      return {
        left: '0',
        width: '0',
        backgroundColor: section.color,
        display: 'none'
      };
    }

    const startPercentage = ((sectionStart - visibleStart) / visibleDuration) * 100;
    const endPercentage = ((sectionEnd - visibleStart) / visibleDuration) * 100;

    return {
      left: `${startPercentage}%`,
      width: `${endPercentage - startPercentage}%`,
      backgroundColor: section.color,
      display: 'block'
    };
  }

  /**
   * Select a tool
   */
  selectTool(tool: TimelineTool) {
    this.selectedTool = tool;
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    this.emitPlayPause();
  }

  /**
   * Get time markers with major and minor ticks - optimized for performance with caching
   */
  getTimeMarkers(): Array<{position: number, label: string, isMajor: boolean, showLabel: boolean}> {
    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();

    // Create a cache key based on values that affect marker calculation
    const cacheKey = `${visibleStart.toFixed(2)}_${visibleDuration.toFixed(2)}_${this.duration}`;

    // Return cached markers if the view hasn't changed
    if (cacheKey === this.lastMarkerCacheKey && this.cachedTimeMarkers.length > 0) {
      return this.cachedTimeMarkers;
    }

    this.lastMarkerCacheKey = cacheKey;
    const markers: Array<{position: number, label: string, isMajor: boolean, showLabel: boolean}> = [];

    // Calculate optimal intervals based on visible duration, not just zoom level
    // This ensures we don't create too many markers regardless of video length
    const { majorInterval, minorInterval } = this.calculateOptimalIntervals(visibleDuration);

    // Limit maximum number of markers for performance
    const maxMajorMarkers = 20;
    const maxMinorMarkers = 100;

    // Generate major ticks
    const startMajor = Math.ceil(visibleStart / majorInterval) * majorInterval;
    const endMajor = visibleStart + visibleDuration;
    let majorCount = 0;

    for (let time = startMajor; time <= endMajor && majorCount < maxMajorMarkers; time += majorInterval) {
      const position = ((time - visibleStart) / visibleDuration) * 100;
      if (position >= 0 && position <= 100) {
        markers.push({
          position,
          label: this.formatDetailedTime(time),
          isMajor: true,
          showLabel: true
        });
        majorCount++;
      }
    }

    // Generate minor ticks only if we have reasonable spacing
    if (minorInterval > 0 && visibleDuration / minorInterval < maxMinorMarkers) {
      const startMinor = Math.ceil(visibleStart / minorInterval) * minorInterval;
      let minorCount = 0;

      for (let time = startMinor; time <= endMajor && minorCount < maxMinorMarkers; time += minorInterval) {
        // Skip if it's close to a major tick (within 1% of majorInterval)
        const nearestMajor = Math.round(time / majorInterval) * majorInterval;
        if (Math.abs(time - nearestMajor) < majorInterval * 0.01) continue;

        const position = ((time - visibleStart) / visibleDuration) * 100;
        if (position >= 0 && position <= 100) {
          markers.push({
            position,
            label: this.formatDetailedTime(time),
            isMajor: false,
            showLabel: false
          });
          minorCount++;
        }
      }
    }

    // Cache the markers and return
    this.cachedTimeMarkers = markers;
    return markers;
  }

  /**
   * Calculate zoom increment based on current zoom level
   * Returns larger increments at higher zoom levels for smoother zooming
   */
  private calculateZoomIncrement(currentZoom: number): number {
    if (currentZoom < 2) {
      // Low zoom: small increments
      return 0.2;
    } else if (currentZoom < 5) {
      // Low-medium zoom
      return 0.5;
    } else if (currentZoom < 10) {
      // Medium zoom
      return 1.0;
    } else if (currentZoom < 20) {
      // Medium-high zoom
      return 2.0;
    } else if (currentZoom < 40) {
      // High zoom
      return 4.0;
    } else if (currentZoom < 60) {
      // Very high zoom
      return 6.0;
    } else if (currentZoom < 100) {
      // Extremely high zoom
      return 10.0;
    } else if (currentZoom < 150) {
      // Ultra zoom
      return 15.0;
    } else {
      // Maximum zoom
      return 20.0;
    }
  }

  /**
   * Calculate optimal marker intervals based on visible duration
   */
  private calculateOptimalIntervals(visibleDuration: number): { majorInterval: number, minorInterval: number } {
    // Define interval thresholds based on visible duration
    let majorInterval: number;
    let minorInterval: number;

    if (visibleDuration <= 10) {
      // Very zoomed in: < 10 seconds visible
      majorInterval = 1;
      minorInterval = 0.2;
    } else if (visibleDuration <= 30) {
      // Zoomed in: 10-30 seconds visible
      majorInterval = 2;
      minorInterval = 0.5;
    } else if (visibleDuration <= 60) {
      // 30-60 seconds visible
      majorInterval = 5;
      minorInterval = 1;
    } else if (visibleDuration <= 300) {
      // 1-5 minutes visible
      majorInterval = 10;
      minorInterval = 2;
    } else if (visibleDuration <= 600) {
      // 5-10 minutes visible
      majorInterval = 30;
      minorInterval = 10;
    } else if (visibleDuration <= 1800) {
      // 10-30 minutes visible
      majorInterval = 60;
      minorInterval = 30;
    } else if (visibleDuration <= 3600) {
      // 30-60 minutes visible
      majorInterval = 300;
      minorInterval = 60;
    } else {
      // > 1 hour visible
      majorInterval = 600;
      minorInterval = 300;
    }

    return { majorInterval, minorInterval };
  }

  /**
   * Format time with frames: HH:MM:SS:FF
   */
  formatDetailedTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const frames = Math.floor((seconds % 1) * 30); // Assuming 30fps

    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  }

  /**
   * Handle scrollbar change
   */
  onScrollbarChange() {
    // Clamp the offset
    const visibleDuration = this.getVisibleDuration();
    this.zoomOffset = Math.max(0, Math.min(this.duration - visibleDuration, this.zoomOffset));
  }

  /**
   * Start dragging scrollbar middle section
   */
  onScrollbarMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingScrollbar = true;
    this.scrollbarDragStartX = event.clientX;
    this.scrollbarDragStartOffset = this.zoomOffset;
  }

  /**
   * Start dragging left zoom handle
   */
  onLeftZoomHandleMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingLeftZoomHandle = true;
    this.scrollbarDragStartX = event.clientX;
    this.scrollbarDragStartZoom = this.zoomLevel;
    this.scrollbarDragStartOffset = this.zoomOffset;
  }

  /**
   * Start dragging right zoom handle
   */
  onRightZoomHandleMouseDown(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingRightZoomHandle = true;
    this.scrollbarDragStartX = event.clientX;
    this.scrollbarDragStartZoom = this.zoomLevel;
    this.scrollbarDragStartOffset = this.zoomOffset;
  }

  /**
   * Get CSS styles for the custom scrollbar viewport window
   */
  getScrollbarViewportStyle() {
    const visibleDuration = this.getVisibleDuration();
    const startPercentage = (this.zoomOffset / this.duration) * 100;
    const widthPercentage = (visibleDuration / this.duration) * 100;

    // Ensure minimum width for handles to be visible and clickable
    const minWidthPercentage = 3; // Minimum 3% width
    const actualWidthPercentage = Math.max(widthPercentage, minWidthPercentage);

    return {
      left: `${startPercentage}%`,
      width: `${actualWidthPercentage}%`
    };
  }
}
