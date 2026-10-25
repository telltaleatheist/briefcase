import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ZoomState } from '../../../../models/video-editor.model';
import { ChatMarker, formatChatRange } from '../../../../models/video-chat.model';

/**
 * ASK PROPOSALS on the timeline: the open chat's proposed markers, drawn as a
 * dashed, translucent lane of their own (not over the waveform), so a
 * proposal is never mistaken for a flag or a flag's verifier ghost. Nothing
 * here is saved: applying in the Ask tab turns a proposal into a real marker.
 */
@Component({
  selector: 'app-timeline-proposals-layer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="proposals-layer">
      @for (marker of markers; track marker.id) {
        @if (place(marker); as at) {
          <div class="proposal-block"
            [style.left.%]="at.left"
            [style.width.%]="at.width"
            [title]="'Proposed (Ask): ' + marker.title + ' ' + range(marker) + (marker.note ? ' - ' + marker.note : '')"
            (mousedown)="$event.stopPropagation()"
            (click)="onClick(marker, $event)">
            <span class="proposal-label">{{ marker.title }}</span>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .proposals-layer { position: relative; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
    .proposal-block {
      position: absolute;
      top: 3px;
      bottom: 3px;
      min-width: 4px;
      box-sizing: border-box;
      border: 1px dashed var(--ask-proposal, #38bdf8);
      border-radius: 3px;
      background: rgba(56, 189, 248, 0.16);
      cursor: pointer;
      pointer-events: auto;
      overflow: hidden;
      display: flex;
      align-items: center;
      transition: background-color 0.15s ease;
    }
    .proposal-block:hover { background: rgba(56, 189, 248, 0.32); z-index: 2; }
    .proposal-label {
      padding: 0 4px;
      font-size: 10px;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-secondary);
    }
  `],
})
export class TimelineProposalsLayerComponent {
  @Input() markers: ChatMarker[] = [];
  @Input() duration = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Output() markerClick = new EventEmitter<ChatMarker>();

  /** Where a proposal sits in the visible window (percent), or null when it is out of view. */
  place(marker: ChatMarker): { left: number; width: number } | null {
    if (this.duration <= 0) return null;
    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;
    if (!isFinite(visibleDuration) || visibleDuration <= 0) return null;
    const visibleEnd = visibleStart + visibleDuration;
    const end = Math.max(marker.endSeconds, marker.startSeconds);
    if (end < visibleStart || marker.startSeconds > visibleEnd) return null;
    const a = Math.max(marker.startSeconds, visibleStart);
    const b = Math.min(end, visibleEnd);
    return {
      left: ((a - visibleStart) / visibleDuration) * 100,
      width: ((b - a) / visibleDuration) * 100,
    };
  }

  range(marker: ChatMarker): string {
    return formatChatRange(marker.startSeconds, marker.endSeconds);
  }

  onClick(marker: ChatMarker, event: MouseEvent): void {
    event.stopPropagation();
    this.markerClick.emit(marker);
  }
}
