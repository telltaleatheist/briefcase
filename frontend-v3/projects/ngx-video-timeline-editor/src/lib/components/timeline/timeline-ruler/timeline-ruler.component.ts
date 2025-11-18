import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState, TimeMarker } from '../../../models';
import { TimelineCalculatorService } from '../../../services/timeline-calculator.service';

@Component({
  selector: 'ngx-vte-timeline-ruler',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-ruler.component.html',
  styleUrls: ['./timeline-ruler.component.scss']
})
export class TimelineRulerComponent implements OnChanges {
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };

  @Output() markerMouseDown = new EventEmitter<MouseEvent>();

  // Cache time markers to avoid recalculating on every change detection
  cachedTimeMarkers: TimeMarker[] = [];
  private lastMarkerCacheKey = '';

  constructor(private calculator: TimelineCalculatorService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['duration'] || changes['zoomState']) {
      // Markers will be recalculated on next call to getTimeMarkers()
      // due to cache key change
    }
  }

  getTimeMarkers(): TimeMarker[] {
    const { start: visibleStart, duration: visibleDuration } =
      this.calculator.getVisibleTimeRange(this.duration, this.zoomState);

    // Create a cache key based on values that affect marker calculation
    const cacheKey = `${visibleStart.toFixed(2)}_${visibleDuration.toFixed(2)}_${this.duration}`;

    // Return cached markers if the view hasn't changed
    if (cacheKey === this.lastMarkerCacheKey && this.cachedTimeMarkers.length > 0) {
      return this.cachedTimeMarkers;
    }

    this.lastMarkerCacheKey = cacheKey;

    // Use calculator service to generate markers
    this.cachedTimeMarkers = this.calculator.generateTimeMarkers(this.duration, this.zoomState);
    return this.cachedTimeMarkers;
  }

  onMouseDown(event: MouseEvent): void {
    this.markerMouseDown.emit(event);
  }
}
