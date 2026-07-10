import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NotificationBellComponent } from '../../components/notification-bell/notification-bell.component';

/**
 * Shell toolbar — the unified top bar.
 *
 * Phase 1 contents: mobile hamburger, section title, an <ng-content> slot
 * reserved for Phase 2's contextual actions (+ Add, Trim, Transcribe, …),
 * then bell / tour / logs / theme / inspector toggles on the right.
 * Left padding honors --traffic-light-inset for the Phase 2 hiddenInset move.
 */
@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [NotificationBellComponent],
  templateUrl: './toolbar.component.html',
  styleUrls: ['./toolbar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToolbarComponent {
  title = input('');
  hasTour = input(false);
  isDarkTheme = input(true);

  toggleDrawer = output<void>();
  toggleTheme = output<void>();
  toggleInspector = output<void>();
  startTour = output<void>();
  downloadLogs = output<void>();
}
