// Briefcase/electron/services/update-service.ts
import { app } from 'electron';
import * as log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import { WindowService } from './window-service';

/** Re-check cadence once the app is running (4 hours). */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Delay before the first check so startup isn't competing with it. */
const FIRST_CHECK_DELAY_MS = 15 * 1000;
/** Surface to the renderer after this many consecutive failed checks. */
const FAILURES_BEFORE_SURFACING = 3;

/**
 * Auto-update service
 * Handles checking for and installing application updates.
 *
 * Checks run ONLY in packaged builds (app.isPackaged): dev/test builds have
 * no update feed and would just log errors.
 */
export class UpdateService {
  private windowService: WindowService;
  private checkTimer: NodeJS.Timeout | null = null;
  private consecutiveCheckFailures = 0;

  constructor(windowService: WindowService) {
    this.windowService = windowService;

    // Set up event handlers
    this.setupUpdateEvents();
  }

  /**
   * Begin periodic update checks. Call once after the main window exists.
   * No-op in unpackaged (dev/test) builds.
   */
  startPeriodicChecks(): void {
    if (!app.isPackaged) {
      log.info('[Updates] Skipping auto-update checks (unpackaged build)');
      return;
    }
    if (this.checkTimer) {
      return; // already started
    }

    log.info(
      `[Updates] Auto-update checks enabled: first check in ${FIRST_CHECK_DELAY_MS / 1000}s, ` +
      `then every ${CHECK_INTERVAL_MS / (60 * 60 * 1000)}h`
    );

    setTimeout(() => this.checkNow(), FIRST_CHECK_DELAY_MS);
    this.checkTimer = setInterval(() => this.checkNow(), CHECK_INTERVAL_MS);
    // Don't let the timer keep the process alive during quit.
    this.checkTimer.unref?.();
  }

  /**
   * Run one update check. Failures are logged and counted; after
   * FAILURES_BEFORE_SURFACING consecutive failures the renderer is told.
   */
  private checkNow(): void {
    log.info('[Updates] Checking for updates…');
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      // The 'error' event handler below does the counting/surfacing; this
      // catch exists because the promise also rejects for the same error.
      log.debug(`[Updates] checkForUpdatesAndNotify rejected: ${err?.message ?? err}`);
    });
  }

  /**
   * Install available update
   */
  installUpdate(): void {
    autoUpdater.quitAndInstall();
  }

  /**
   * Set up update event handlers
   */
  private setupUpdateEvents(): void {
    // Update available
    autoUpdater.on('update-available', (info) => {
      log.info(`[Updates] Update available: ${info?.version ?? 'unknown version'}`);
      this.consecutiveCheckFailures = 0;
      const mainWindow = this.windowService.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('update-available');
      }
    });

    autoUpdater.on('update-not-available', () => {
      log.info('[Updates] No update available (current version is latest)');
      this.consecutiveCheckFailures = 0;
    });

    // Update downloaded
    autoUpdater.on('update-downloaded', (info) => {
      log.info(`[Updates] Update downloaded: ${info?.version ?? 'unknown version'}`);
      const mainWindow = this.windowService.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('update-downloaded');
      }
    });

    // Update error — loud, counted, surfaced to the renderer when repeated.
    autoUpdater.on('error', (err) => {
      this.consecutiveCheckFailures++;
      log.error(
        `[Updates] Update check failed (${this.consecutiveCheckFailures} consecutive): ` +
        `${err?.message ?? err}`
      );
      if (this.consecutiveCheckFailures >= FAILURES_BEFORE_SURFACING) {
        const mainWindow = this.windowService.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-check-failed', {
            failures: this.consecutiveCheckFailures,
            message: String(err?.message ?? err),
          });
        }
      }
    });
  }
}
