import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { QueueService } from '../../services/queue.service';
import { ErrorSurface } from '../../core/error-surface.service';
import { LaneView } from '../../models/queue-lanes.model';
import {
  laneIsProblem,
  laneOccupancy,
  laneStateLine,
  laneSwitchWord,
  laneWaiting,
} from '../crucible-doors/crucible-words';

/**
 * The queue tab's header strip (Crucible migration §7.6): one compact card per
 * admission lane. GPU cards are whole-card Running/Paused toggles (orange
 * border while Running); the Cloud card only reports occupancy. Draws nothing
 * in direct mode — the parent only mounts it when there are lanes.
 */
@Component({
  selector: 'app-queue-lanes',
  standalone: true,
  templateUrl: './queue-lanes.component.html',
  styleUrls: ['./queue-lanes.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QueueLanesComponent {
  private queueService = inject(QueueService);
  private errorSurface = inject(ErrorSurface);

  readonly lanes = computed<LaneView[]>(() => {
    const status = this.queueService.lanes();
    return status?.mode === 'crucible' ? status.lanes : [];
  });

  /** The server whose switch is mid-request (ignore further clicks on it). */
  readonly switching = signal<string | null>(null);

  readonly stateLine = laneStateLine;
  readonly isProblem = laneIsProblem;
  readonly occupancy = laneOccupancy;
  readonly waitingLine = laneWaiting;
  readonly switchWord = laneSwitchWord;

  isPaused(lane: LaneView): boolean {
    return lane.state === 'paused';
  }

  toggle(lane: LaneView): void {
    const server = lane.server;
    if (lane.kind !== 'gpu' || !server || this.switching() === server) return;
    const paused = !this.isPaused(lane);
    this.switching.set(server);
    this.queueService.setServerPaused(server, paused).subscribe({
      next: () => this.switching.set(null),
      error: err => {
        this.switching.set(null);
        this.errorSurface.surfaceError(paused ? `Pause ${server}` : `Resume ${server}`, err);
      },
    });
  }
}
