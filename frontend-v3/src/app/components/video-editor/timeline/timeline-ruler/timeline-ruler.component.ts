import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState } from '../../../../models/video-editor.model';

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
  @Output() seek = new EventEmitter<number>();

  markers: TimeMarker[] = [];

  onRulerClick(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const paddingLeft = 24; // Must match CSS padding
    const clickX = event.clientX - rect.left - paddingLeft;
    const rulerWidth = rect.width - paddingLeft;

    if (clickX < 0 || rulerWidth <= 0 || this.duration <= 0) return;

    const percentage = clickX / rulerWidth;
    const visibleDuration = this.duration / this.zoomState.level;

    // Guard against invalid visibleDuration
    if (!isFinite(visibleDuration) || visibleDuration <= 0) return;

    const time = this.zoomState.offset + (percentage * visibleDuration);

    this.seek.emit(Math.max(0, Math.min(time, this.duration)));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['duration'] || changes['zoomState']) {
      this.generateMarkers();
    }
  }

  private generateMarkers(): void {
    this.markers = [];

    if (this.duration <= 0) return;

    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;
    const visibleEnd = visibleStart + visibleDuration;

    // Guard against invalid visibleDuration
    if (!isFinite(visibleDuration) || visibleDuration <= 0) {
      return;
    }

    // Determine appropriate interval based on zoom level and duration
    let majorInterval = this.calculateMajorInterval(visibleDuration);
    let minorInterval = majorInterval / 5;

    // Generate markers
    const startTime = Math.floor(visibleStart / minorInterval) * minorInterval;

    for (let time = startTime; time <= visibleEnd; time += minorInterval) {
      if (time < 0) continue;

      const isMajor = time % majorInterval === 0;
      const position = ((time - visibleStart) / visibleDuration) * 100;

      if (position >= 0 && position <= 100) {
        this.markers.push({
          position,
          label: this.formatTime(time),
          isMajor,
          showLabel: isMajor
        });
      }
    }
  }

  private calculateMajorInterval(visibleDuration: number): number {
    // Choose interval based on visible duration
    if (visibleDuration <= 10) return 1;      // 1 second
    if (visibleDuration <= 30) return 5;      // 5 seconds
    if (visibleDuration <= 60) return 10;     // 10 seconds
    if (visibleDuration <= 300) return 30;    // 30 seconds
    if (visibleDuration <= 600) return 60;    // 1 minute
    if (visibleDuration <= 1800) return 300;  // 5 minutes
    return 600;                               // 10 minutes
  }

  private formatTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
