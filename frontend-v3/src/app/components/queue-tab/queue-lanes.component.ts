import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { QueueService } from '../../services/queue.service';
import { LaneView } from '../../models/queue-lanes.model';
import { laneIsProblem, laneOccupancy, laneStateLine, laneWaiting } from '../crucible-doors/crucible-words';

/**
 * The queue tab's header strip: one compact card per admission lane, reporting
 * only. The GPU card is the selected Crucible server's (another server's shows
 * only while work started there before a switch finishes); which server is
 * used is chosen in Settings › Crucible Servers. The Cloud card reports
 * occupancy. The parent only mounts it when there are lanes.
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

  readonly lanes = computed<LaneView[]>(() => this.queueService.lanes()?.lanes ?? []);

  readonly stateLine = laneStateLine;
  readonly isProblem = laneIsProblem;
  readonly occupancy = laneOccupancy;
  readonly waitingLine = laneWaiting;
}
