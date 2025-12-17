import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, OnChanges, SimpleChanges, ViewChild, ElementRef, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  TimelineWaveformComponent,
  TimelinePlayheadComponent,
  TimelineRulerComponent,
  TimelineZoomBarComponent,
  TimelineSectionsLayerComponent,
  TimelineSelectionComponent,
  ZoomState,
  TimelineSection,
  TimelineSelection,
  TimelineTool,
  CategoryFilter
} from 'ngx-video-timeline-editor';

@Component({
  selector: 'app-video-timeline',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatButtonModule, MatTooltipModule, TimelineWaveformComponent, TimelinePlayheadComponent, TimelineRulerComponent, TimelineZoomBarComponent, TimelineSectionsLayerComponent, TimelineSelectionComponent],
  templateUrl: './video-timeline.component.html',
  styleUrls: ['./video-timeline.component.scss']
})
export class VideoTimelineComponent implements OnInit, OnDestroy, OnChanges {
  @Input() duration = 0; // Total video duration in seconds
  @Input() currentTime = 0; // Current playback time
  @Input() sections: TimelineSection[] = [];
  @Input() isPlaying = false; // Playback state
  @Input() mediaElement?: HTMLVideoElement | HTMLAudioElement; // Media element for waveform generation
  @Output() seek = new EventEmitter<number>();
  @Output() selectionChange = new EventEmitter<TimelineSelection>();
  @Output() playPause = new EventEmitter<void>();
  @Output() playbackSpeed = new EventEmitter<number>(); // Emit playback speed changes
  @Output() contextMenu = new EventEmitter<{ event: MouseEvent, time: number }>(); // Emit context menu events

  @ViewChild('timeline', { static: false }) timelineElement!: ElementRef<HTMLDivElement>;
  @ViewChild('selectionWindow', { static: false }) selectionWindowElement!: ElementRef<HTMLDivElement>;
  @ViewChild(TimelineWaveformComponent, { static: false }) waveformComponent?: TimelineWaveformComponent;

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
  currentPlaybackSpeed = 1; // Public so it can be displayed in template
  private lastKeyPressed: 'j' | 'k' | 'l' | null = null;

  // Store bound event listeners for cleanup
  private boundMouseMove?: (e: MouseEvent) => void;
  private boundMouseUp?: (e: MouseEvent) => void;
  private boundWheel?: (e: WheelEvent) => void;
  private boundKeyDown?: (e: KeyboardEvent) => void;

  // Time markers now handled by TimelineRulerComponent

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

  // Waveform state (now handled by TimelineWaveformComponent)
  waveformData: number[] = []; // Keep for passing to component

  // Throttle mouse move updates using requestAnimationFrame
  private rafPending = false;
  private pendingZoomLevel: number | null = null;
  private pendingZoomOffset: number | null = null;
  private updateRafId: number | null = null; // Track RAF ID to cancel it

  constructor(private ngZone: NgZone, private cdr: ChangeDetectorRef) {}

  ngOnChanges(changes: SimpleChanges) {
    // When sections change, update category filters
    if (changes['sections'] && !changes['sections'].firstChange) {
      this.updateCategoryFilters();
    }

    // Waveform generation/rendering is now handled by TimelineWaveformComponent

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
        const visibleStart = this.getVisibleStartTime();
        const visibleEnd = this.getVisibleEndTime();

        // Only center if playhead goes outside visible range
        if (this.currentTime < visibleStart || this.currentTime > visibleEnd) {
          this.centerPlayheadInViewport();
        }
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

    // Cancel any pending RAF updates
    if (this.updateRafId !== null) {
      cancelAnimationFrame(this.updateRafId);
      this.updateRafId = null;
    }

    // Clear any pending RAF updates
    this.rafPending = false;
    this.pendingZoomLevel = null;
    this.pendingZoomOffset = null;
  }

  /**
   * Schedule a zoom/pan update using requestAnimationFrame for better performance
   * This prevents triggering change detection on every mousemove event
   */
  private scheduleUpdate(newZoomLevel?: number, newZoomOffset?: number): void {
    // Store the most recent values
    if (newZoomLevel !== undefined) {
      this.pendingZoomLevel = newZoomLevel;
    }
    if (newZoomOffset !== undefined) {
      this.pendingZoomOffset = newZoomOffset;
    }

    // If we already have a frame pending, don't schedule another
    if (this.rafPending) {
      return;
    }

    this.rafPending = true;

    // Cancel any existing RAF before scheduling new one
    if (this.updateRafId !== null) {
      cancelAnimationFrame(this.updateRafId);
    }

    this.updateRafId = requestAnimationFrame(() => {
      this.rafPending = false;
      this.updateRafId = null;

      // Apply the pending updates inside Angular zone for change detection
      this.ngZone.run(() => {
        if (this.pendingZoomLevel !== null) {
          this.zoomLevel = this.pendingZoomLevel;
          this.pendingZoomLevel = null;
        }
        if (this.pendingZoomOffset !== null) {
          this.zoomOffset = this.pendingZoomOffset;
          this.pendingZoomOffset = null;
        }
      });
    });
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
   * Handle right-click context menu on timeline
   */
  onTimelineContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const rect = this.timelineElement.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = this.pixelsToTime(x);

    // Emit context menu event to parent component
    this.contextMenu.emit({ event, time });
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

      let newOffset = this.scrollbarDragStartOffset + deltaTime;

      // Clamp offset to valid range
      const visibleDuration = this.duration / this.zoomLevel;
      newOffset = Math.max(0, Math.min(this.duration - visibleDuration, newOffset));

      // Schedule update using RAF (no manual waveform update needed - ngOnChanges handles it)
      this.scheduleUpdate(undefined, newOffset);
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
        let newZoomLevel = this.duration / newVisibleDuration;
        newZoomLevel = Math.max(1, Math.min(200, newZoomLevel));

        let newOffset = newVisibleStart;
        // Clamp offset
        const visibleDuration = this.duration / newZoomLevel;
        newOffset = Math.max(0, Math.min(this.duration - visibleDuration, newOffset));

        // Schedule update using RAF (no manual waveform update needed)
        this.scheduleUpdate(newZoomLevel, newOffset);
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
        let newZoomLevel = this.duration / newVisibleDuration;
        newZoomLevel = Math.max(1, Math.min(200, newZoomLevel));

        // Keep the left side fixed, only adjust based on new zoom
        const actualVisibleDuration = this.duration / newZoomLevel;
        const newOffset = Math.max(0, Math.min(this.duration - actualVisibleDuration, this.zoomOffset));

        // Schedule update using RAF (no manual waveform update needed)
        this.scheduleUpdate(newZoomLevel, newOffset);
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
        const visibleDuration = this.duration / this.zoomLevel;
        const deltaTime = (deltaX / rect.width) * visibleDuration;

        // Pan in opposite direction of mouse movement
        let newOffset = this.panStartOffset - deltaTime;

        // Clamp offset to valid range
        newOffset = Math.max(0, Math.min(this.duration - visibleDuration, newOffset));

        // Schedule update using RAF (no manual waveform update needed)
        this.scheduleUpdate(undefined, newOffset);
      }
      return;
    }

    if (this.isDraggingRange) {
      const rect = this.timelineElement.nativeElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const time = Math.max(0, Math.min(this.duration, this.pixelsToTime(x)));

      // Update selection range (event emission triggers change detection in parent)
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
      // Move playhead to follow the left handle
      this.emitSeek(this.selectionStart);
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
      // Move playhead to follow the right handle
      this.emitSeek(this.selectionEnd);
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
        const visibleDuration = this.duration / this.zoomLevel;
        // Pan by 10% of visible duration per scroll tick
        const panAmount = (visibleDuration * 0.1) * (event.deltaY > 0 || event.deltaX > 0 ? 1 : -1);
        let newOffset = this.zoomOffset + panAmount;

        // Clamp offset to valid range
        newOffset = Math.max(0, Math.min(this.duration - visibleDuration, newOffset));

        // Schedule update using RAF
        this.scheduleUpdate(undefined, newOffset);
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
      const oldVisibleStart = this.zoomOffset;
      const oldVisibleDuration = this.duration / this.zoomLevel;

      // Calculate what time the mouse is pointing at in the OLD zoom level
      const mouseX = event.clientX - rect.left;
      const mouseRatio = mouseX / rect.width;  // 0 to 1, where mouse is in the timeline
      const timeAtMouse = oldVisibleStart + (mouseRatio * oldVisibleDuration);

      // Calculate new visible duration after zoom
      const newVisibleDuration = this.duration / newZoomLevel;

      // Keep the same time under the mouse cursor at the same pixel position
      // We want: newVisibleStart + (mouseRatio * newVisibleDuration) = timeAtMouse
      // So: newVisibleStart = timeAtMouse - (mouseRatio * newVisibleDuration)
      let newOffset = timeAtMouse - (mouseRatio * newVisibleDuration);

      // Clamp offset to valid range
      newOffset = Math.max(0, Math.min(this.duration - newVisibleDuration, newOffset));

      // Schedule update using RAF (no manual waveform update needed)
      this.scheduleUpdate(newZoomLevel, newOffset);
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

          // Waveform will update automatically via ngOnChanges
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
    this.seek.emit(Math.max(0, Math.min(this.duration, time)));
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
   * Format time as HH:MM:SS
   */
  formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
    // Waveform will update automatically via ngOnChanges
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
   * Select a tool
   */
  selectTool(tool: TimelineTool) {
    this.selectedTool = tool;
  }

  /**
   * Speed progression for J/L keys
   */
  private readonly speedProgression = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];

  /**
   * Find closest speed in progression to current speed
   */
  private findClosestSpeedIndex(currentSpeed: number): number {
    // Find the closest speed in our progression
    let closestIndex = 0;
    let minDiff = Math.abs(this.speedProgression[0] - currentSpeed);

    for (let i = 1; i < this.speedProgression.length; i++) {
      const diff = Math.abs(this.speedProgression[i] - currentSpeed);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  /**
   * Handle J key press - Decrease playback speed
   * If not playing: start playing at 1x
   * If playing: move down one step in speed progression
   */
  handleJKey() {
    if (this.currentPlaybackSpeed === 0) {
      // Not playing - start playing at 1x
      this.currentPlaybackSpeed = 1;
    } else {
      // Find current speed in progression and move down one step
      const currentIndex = this.findClosestSpeedIndex(this.currentPlaybackSpeed);
      const newIndex = Math.max(0, currentIndex - 1); // Don't go below minimum
      this.currentPlaybackSpeed = this.speedProgression[newIndex];
    }
    this.lastKeyPressed = 'j';
    this.emitPlaybackSpeed(this.currentPlaybackSpeed);
  }

  /**
   * Handle K key press - Pause/Play toggle
   */
  handleKKey() {
    if (this.currentPlaybackSpeed === 0) {
      // Paused - resume at 1x
      this.currentPlaybackSpeed = 1;
      this.emitPlaybackSpeed(1);
    } else {
      // Playing - pause and reset speed to 0
      this.currentPlaybackSpeed = 0;
      this.emitPlaybackSpeed(0); // 0 means pause
    }
    this.lastKeyPressed = 'k';
  }

  /**
   * Handle L key press - Increase playback speed
   * If not playing: start playing at 1x
   * If playing: move up one step in speed progression
   */
  handleLKey() {
    if (this.currentPlaybackSpeed === 0) {
      // Not playing - start playing at 1x
      this.currentPlaybackSpeed = 1;
    } else {
      // Find current speed in progression and move up one step
      const currentIndex = this.findClosestSpeedIndex(this.currentPlaybackSpeed);
      const newIndex = Math.min(this.speedProgression.length - 1, currentIndex + 1); // Don't go above maximum
      this.currentPlaybackSpeed = this.speedProgression[newIndex];
    }
    this.lastKeyPressed = 'l';
    this.emitPlaybackSpeed(this.currentPlaybackSpeed);
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
   * Waveform generation and rendering is now handled by TimelineWaveformComponent
   */

  /**
   * Trigger waveform re-render (call this when zoom/pan changes)
   * Now delegates to TimelineWaveformComponent
   */
  updateWaveformDisplay() {
    if (this.waveformComponent) {
      this.waveformComponent.updateDisplay();
    }
  }

  /**
   * Get current zoom state for passing to child components
   */
  getZoomState(): ZoomState {
    return {
      level: this.zoomLevel,
      offset: this.zoomOffset
    };
  }
}
