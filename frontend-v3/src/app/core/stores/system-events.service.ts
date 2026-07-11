import { Injectable, NgZone, inject } from '@angular/core';
import { NotificationService } from '../../services/notification.service';
import { QueueService } from '../../services/queue.service';
import { LibraryService } from '../../services/library.service';

/**
 * Renderer half of the Electron system events (fallback-audit burn list):
 * backend crash/restart and auto-update lifecycle were previously either
 * silent (backend death) or entirely unwired (update events had zero
 * listeners anywhere in the frontend). In a LAN browser these events simply
 * never fire — no Electron gating needed.
 *
 * Instantiated once by the app shell; listeners live for the app's lifetime
 * (window-scoped events for a root service — nothing to tear down).
 */
@Injectable({ providedIn: 'root' })
export class SystemEventsService {
  private notifications = inject(NotificationService);
  private queueService = inject(QueueService);
  private libraryService = inject(LibraryService);
  private zone = inject(NgZone);

  private started = false;

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    window.addEventListener('electron-backend-unexpected-exit', () => {
      this.zone.run(() => {
        this.notifications.error(
          'Backend crashed',
          'The processing engine stopped unexpectedly — restarting it now. In-flight jobs will resume or resubmit from the queue.',
          true
        );
      });
    });

    window.addEventListener('electron-backend-restarted', () => {
      this.zone.run(() => {
        this.notifications.success('Backend restarted', 'Reconnected — refreshing data.', true);
        // Reconcile state that may have drifted while the backend was down.
        void this.queueService.refreshFromBackend();
        this.libraryService.getCurrentLibrary().subscribe();
      });
    });

    window.addEventListener('electron-update-check-failed', event => {
      const detail = (event as CustomEvent<{ failures?: number; message?: string }>).detail;
      this.zone.run(() => {
        this.notifications.warning(
          'Update check failed',
          detail?.message ?? 'Briefcase could not check for updates. Will retry later.'
        );
      });
    });

    window.addEventListener('electron-update-available', () => {
      this.zone.run(() => {
        this.notifications.info('Update available', 'Downloading the new version in the background…');
      });
    });

    window.addEventListener('electron-update-downloaded', () => {
      this.zone.run(() => {
        this.notifications.info(
          'Update ready',
          'The new version installs when you quit Briefcase.',
          true
        );
      });
    });
  }
}
