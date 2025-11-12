import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState } from '../../../models';

export interface TimeMarker {
  position: number;
  label: string;
  isMajor: boolean;
  showLabel: boolean;
}

@Component({
  selector: 'app-timeline-ruler',
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

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['duration'] || changes['zoomState']) {
      // Markers will be recalculated on next call to getTimeMarkers()
      // due to cache key change
    }
  }

  getTimeMarkers(): TimeMarker[] {
    const visibleStart = this.getVisibleStartTime();
    const visibleDuration = this.getVisibleDuration();

    // Create a cache key based on values that affect marker calculation
    const cacheKey = `${visibleStart.toFixed(2)}_${visibleDuration.toFixed(2)}_${this.duration}`;

    // Return cached markers if the view hasn't changed
    if (cacheKey === this.lastMarkerCacheKey && this.cachedTimeMarkers.length > 0) {
      return this.cachedTimeMarkers;
    }

    this.lastMarkerCacheKey = cacheKey;
    const markers: TimeMarker[] = [];

    // Calculate optimal intervals based on visible duration
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

  onMouseDown(event: MouseEvent): void {
    this.markerMouseDown.emit(event);
  }

  private getVisibleStartTime(): number {
    return this.zoomState.offset;
  }

  private getVisibleDuration(): number {
    return this.duration / this.zoomState.level;
  }

  /**
   * Calculate optimal marker intervals based on visible duration
   */
  private calculateOptimalIntervals(visibleDuration: number): { majorInterval: number, minorInterval: number } {
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
  private formatDetailedTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const frames = Math.floor((seconds % 1) * 30); // Assuming 30fps

    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  }
}
