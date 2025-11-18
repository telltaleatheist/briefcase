/**
 * Timeline calculation service
 *
 * Provides shared calculation utilities for timeline components,
 * including time-to-pixel conversions, marker generation, and time formatting.
 */

import { Injectable } from '@angular/core';
import { TimelineConfigService } from './timeline-config.service';
import { ZoomState, TimeMarker } from '../models';

@Injectable({
  providedIn: 'root'
})
export class TimelineCalculatorService {
  constructor(private configService: TimelineConfigService) {}

  /**
   * Convert time (seconds) to percentage position
   */
  timeToPercentage(time: number, duration: number, zoomState: ZoomState): number {
    const visibleStart = zoomState.offset;
    const visibleDuration = duration / zoomState.level;
    return ((time - visibleStart) / visibleDuration) * 100;
  }

  /**
   * Convert percentage position to time (seconds)
   */
  percentageToTime(percentage: number, duration: number, zoomState: ZoomState): number {
    const visibleStart = zoomState.offset;
    const visibleDuration = duration / zoomState.level;
    return (percentage / 100) * visibleDuration + visibleStart;
  }

  /**
   * Get visible time range
   */
  getVisibleTimeRange(duration: number, zoomState: ZoomState): { start: number; end: number; duration: number } {
    const start = zoomState.offset;
    const visibleDuration = duration / zoomState.level;
    const end = start + visibleDuration;
    return { start, end, duration: visibleDuration };
  }

  /**
   * Check if time is within visible range
   */
  isTimeVisible(time: number, duration: number, zoomState: ZoomState): boolean {
    const { start, end } = this.getVisibleTimeRange(duration, zoomState);
    return time >= start && time <= end;
  }

  /**
   * Clamp time range to visible boundaries
   */
  clampToVisible(
    startTime: number,
    endTime: number,
    duration: number,
    zoomState: ZoomState
  ): { start: number; end: number; isVisible: boolean } {
    const { start: visibleStart, end: visibleEnd } = this.getVisibleTimeRange(duration, zoomState);

    const clampedStart = Math.max(startTime, visibleStart);
    const clampedEnd = Math.min(endTime, visibleEnd);
    const isVisible = endTime >= visibleStart && startTime <= visibleEnd;

    return { start: clampedStart, end: clampedEnd, isVisible };
  }

  /**
   * Generate time markers for timeline ruler
   */
  generateTimeMarkers(duration: number, zoomState: ZoomState): TimeMarker[] {
    const config = this.configService.getPerformance();
    const { start: visibleStart, duration: visibleDuration } = this.getVisibleTimeRange(duration, zoomState);
    const visibleEnd = visibleStart + visibleDuration;

    const markers: TimeMarker[] = [];
    const { majorInterval, minorInterval } = this.calculateOptimalIntervals(visibleDuration);

    // Generate major markers
    const startMajor = Math.ceil(visibleStart / majorInterval) * majorInterval;
    let majorCount = 0;

    for (let time = startMajor; time <= visibleEnd && majorCount < config.maxMajorMarkers; time += majorInterval) {
      const position = this.timeToPercentage(time, duration, zoomState);
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

    // Generate minor markers
    if (minorInterval > 0 && visibleDuration / minorInterval < config.maxMinorMarkers) {
      const startMinor = Math.ceil(visibleStart / minorInterval) * minorInterval;
      let minorCount = 0;

      for (let time = startMinor; time <= visibleEnd && minorCount < config.maxMinorMarkers; time += minorInterval) {
        // Skip if close to a major marker
        const nearestMajor = Math.round(time / majorInterval) * majorInterval;
        if (Math.abs(time - nearestMajor) < majorInterval * 0.01) continue;

        const position = this.timeToPercentage(time, duration, zoomState);
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

    return markers;
  }

  /**
   * Calculate optimal time intervals for markers based on visible duration
   */
  calculateOptimalIntervals(visibleDuration: number): { majorInterval: number; minorInterval: number } {
    let majorInterval: number;
    let minorInterval: number;

    if (visibleDuration <= 10) {
      majorInterval = 1;
      minorInterval = 0.2;
    } else if (visibleDuration <= 30) {
      majorInterval = 2;
      minorInterval = 0.5;
    } else if (visibleDuration <= 60) {
      majorInterval = 5;
      minorInterval = 1;
    } else if (visibleDuration <= 300) {
      majorInterval = 10;
      minorInterval = 2;
    } else if (visibleDuration <= 600) {
      majorInterval = 30;
      minorInterval = 10;
    } else if (visibleDuration <= 1800) {
      majorInterval = 60;
      minorInterval = 30;
    } else if (visibleDuration <= 3600) {
      majorInterval = 300;
      minorInterval = 60;
    } else {
      majorInterval = 600;
      minorInterval = 300;
    }

    return { majorInterval, minorInterval };
  }

  /**
   * Format time with frames: HH:MM:SS:FF or MM:SS:FF
   */
  formatDetailedTime(seconds: number, showHours: boolean = true): string {
    const config = this.configService.getPerformance();
    const fps = config.fps;

    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const frames = Math.floor((seconds % 1) * fps);

    if (h > 0 || showHours) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
  }

  /**
   * Format simple time: HH:MM:SS or MM:SS
   */
  formatSimpleTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}
