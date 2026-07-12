// Briefcase/electron/main.ts
// SIMPLIFIED: No more executable checking - binaries are bundled!
import { app, BrowserWindow, dialog } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import { AppConfig } from './config/app-config';
import { WindowService } from './services/window-service';
import { BackendService } from './services/backend-service';
import { TrayService } from './services/tray-service';
import { UserDataMigration } from './services/user-data-migration';
import { setupIpcHandlers } from './ipc/ipc-handlers';
import { UpdateService } from './services/update-service';
import { LogUtil } from './utilities/log-util';

/**
 * Main application entry point
 * Responsible for coordinating the app startup process
 */

// TEST MODE: Simulate packaged environment for testing
// Set this BEFORE anything else runs
// Use: npm run electron:test-packaged
console.log('[Main] NODE_ENV:', process.env.NODE_ENV);
console.log('[Main] process.resourcesPath:', (process as any).resourcesPath);
console.log('[Main] __dirname:', __dirname);

if (process.env.NODE_ENV === 'production') {
  // Check if we're in test mode (not actually packaged)
  const isActuallyPackaged = (process as any).resourcesPath &&
                              ((process as any).resourcesPath.includes('win-unpacked') ||
                               (process as any).resourcesPath.includes('mac') ||
                               (process as any).resourcesPath.includes('.app'));

  console.log('[Main] isActuallyPackaged:', isActuallyPackaged);

  if (!isActuallyPackaged) {
    // __dirname when built is 'dist-electron/electron', so go up twice to project root
    const testResourcesPath = path.join(__dirname, '..', '..', 'dist-electron', 'win-unpacked', 'resources');
    const absolutePath = path.resolve(testResourcesPath);
    console.log(`TEST PACKAGED MODE: Setting RESOURCES_PATH to ${absolutePath}`);
    process.env.RESOURCES_PATH = absolutePath;
  }
}

let windowService: WindowService;
let backendService: BackendService;
let updateService: UpdateService;
let trayService: TrayService;

// "Press again to quit" confirmation state (Chrome-style double-press to quit)
let quitConfirmActive = false;
let quitConfirmTimer: NodeJS.Timeout | undefined;
let isQuittingForReal = false;
// A4: guards the async shutdown so it runs exactly once, even though several
// paths (before-quit, OS signals, uncaughtException) can trigger it.
let cleanupStarted = false;
const QUIT_CONFIRM_MS = 5000;

/**
 * Show or hide the "press again to quit" toast in every open window.
 */
function setQuitConfirmVisible(visible: boolean): void {
  const label = process.platform === 'darwin'
    ? 'Press ⌘Q again to quit'
    : 'Press Ctrl+Q again to quit';
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(visible ? 'quit-confirm-show' : 'quit-confirm-hide', label);
    }
  }
}

/**
 * Cleanup performed right before the app actually exits.
 * A4: this is async and MUST be awaited — the backend is a child process that
 * we have to fully terminate, otherwise it is orphaned when Electron exits.
 */
async function performQuitCleanup(): Promise<void> {
  log.info('Application is quitting...');

  // Set the quitting flag to allow windows to close
  if (windowService) {
    windowService.setQuitting(true);
  }

  // Destroy tray icon (synchronous)
  if (trayService) {
    trayService.destroy();
  }

  // Shutdown backend service — await so the child process is actually gone
  // before we exit.
  if (backendService) {
    try {
      await backendService.shutdown();
    } catch (err) {
      log.error('Error shutting down backend during quit:', err);
    }
  }
}

/**
 * A4: single, idempotent graceful-exit path. Prevents Electron from exiting
 * before the backend child has been terminated. Uses app.exit() (not app.quit)
 * so it does not re-enter the before-quit handler.
 */
async function gracefulExit(code: number): Promise<void> {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  isQuittingForReal = true;
  await performQuitCleanup();
  app.exit(code);
}

// Configure logging - always log to file
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// Clean up old log files (keep logs from last 7 days)
LogUtil.cleanupOldLogs(7);

// Handle process signals for graceful shutdown
process.on('SIGTERM', () => {
  log.info('Received SIGTERM signal, initiating graceful shutdown...');
  void gracefulExit(0);
});

process.on('SIGINT', () => {
  log.info('Received SIGINT signal, initiating graceful shutdown...');
  void gracefulExit(0);
});

// Handle uncaught exceptions to prevent zombie processes
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  void gracefulExit(1);
});

// An unhandled promise rejection must NOT tear down the app. In a long-running
// desktop app used for constant downloads, a routine rejection (e.g. a
// BrowserWindow.loadURL aborted by ERR_ABORTED on window close, Cmd+R, or a
// slow-mount startup race) would otherwise force a full gracefulExit — killing
// the backend and every in-flight download. Match Node's default: log it (and
// count it for diagnostics) but keep running. Genuinely fatal synchronous
// faults are still handled by the uncaughtException handler above.
let unhandledRejectionCount = 0;
process.on('unhandledRejection', (reason) => {
  unhandledRejectionCount++;
  log.error(`Unhandled promise rejection (#${unhandledRejectionCount}):`, reason);
});

// Single instance lock - must be called before app.whenReady()
// Wrap in try-catch to handle cases where app object isn't ready
let gotTheLock = false;
try {
  gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    log.info('Another instance is already running. Exiting.');
    app.quit();
    process.exit(0);
  }

  // Handle second instance attempt
  app.on('second-instance', () => {
    log.info('Second instance detected. Focusing main window.');
    if (windowService) {
      windowService.focusWindow();
    }
  });
} catch (error) {
  // Running WITHOUT the lock means a second instance could share the same
  // SQLite library files — a corruption risk. Refuse to run unlocked.
  log.error('Error setting up single instance lock — refusing to run unlocked:', error);
  dialog.showErrorBox(
    'Briefcase could not start',
    'Failed to acquire the single-instance lock. Running two copies of Briefcase ' +
    'against the same library risks data corruption, so this instance will exit.\n\n' +
    `Error: ${error instanceof Error ? error.message : String(error)}`
  );
  app.exit(1);
}

// App is ready - start initialization sequence
app.whenReady().then(async () => {

  try {
    // One-time migration from the legacy "clipchimp" userData folder to
    // the new "briefcase" folder. Must run BEFORE AppConfig.initialize()
    // or any service reads from userData, so the backend, database, and
    // settings all see the same files.
    UserDataMigration.run();

    // Initialize AppConfig first
    AppConfig.initialize();

    // SIMPLIFIED: No executable checking needed - binaries are bundled!
    log.info('Using bundled binaries from extraResources');

    // Initialize services
    backendService = new BackendService();
    windowService = new WindowService();
    trayService = new TrayService(windowService);
    updateService = new UpdateService(windowService);

    // Set up IPC handlers — pass the single UpdateService so it isn't
    // constructed twice (which would register duplicate autoUpdater listeners).
    setupIpcHandlers(windowService, backendService, updateService);

    // Start backend server with retry logic for first-time installs
    let backendStarted = await backendService.startBackendServer();

    // If backend fails on first try (common on fresh install), retry once after a delay
    if (!backendStarted) {
      log.warn('Backend failed to start on first attempt, retrying in 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      backendStarted = await backendService.startBackendServer();
    }

    // Create window based on backend status
    if (backendStarted) {
      // Set the backend port for the window to connect to
      windowService.setFrontendPort(backendService.getBackendPort());
      windowService.createMainWindow();

      // Create tray icon
      trayService.createTray();
      trayService.setBackendPort(backendService.getBackendPort());

      // Mid-session backend crash: tell every window, attempt exactly ONE
      // automatic restart, and fall back to the backend-error window if the
      // restart fails. Without this the app silently runs against a dead
      // backend and every feature fails one HTTP error at a time.
      let backendRestartAttempted = false;
      backendService.setUnexpectedExitHandler((info) => {
        void (async () => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('backend-unexpected-exit');
            }
          }

          if (backendRestartAttempted) {
            log.error('Backend died again after an automatic restart — showing error window');
            windowService.showBackendErrorWindow();
            return;
          }
          backendRestartAttempted = true;

          log.warn(
            `Attempting one automatic backend restart after unexpected exit ` +
            `(code ${info.code}, signal ${info.signal})...`
          );
          const restarted = await backendService.startBackendServer();
          if (restarted) {
            log.info('Backend restarted successfully after unexpected exit');
            // The restart may have bound a NEW port. Reload the existing main
            // window to the new origin if it changed — otherwise the renderer
            // is stranded on the dead old port. No-op (no flash) if unchanged.
            windowService.reloadMainWindowForPort(backendService.getBackendPort());
            trayService.setBackendPort(backendService.getBackendPort());
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('backend-restarted');
              }
            }
          } else {
            log.error('Automatic backend restart failed — showing error window');
            windowService.showBackendErrorWindow();
          }
        })();
      });

      // Begin periodic auto-update checks (packaged builds only).
      updateService.startPeriodicChecks();
    } else {
      // Backend failed twice - show error
      log.error('Backend failed to start after retry attempt');
      windowService.showBackendErrorWindow();
    }
    
    // macOS-specific behavior
    app.on('activate', () => {
      if (windowService.getAllWindows().length === 0) {
        if (backendService.isRunning()) {
          windowService.setFrontendPort(backendService.getBackendPort());
          windowService.createMainWindow();
        } else {
          windowService.showBackendErrorWindow();
        }
      }
    });
    
  } catch (error) {
    log.error('Error during application initialization:', error);
    app.quit();
  }
});

// Don't quit when all windows are closed - keep running in tray
// The app will only quit when user selects "Quit" from the tray menu.
// EXCEPT: if tray creation failed, "running in the tray" would be an
// unreachable zombie process — in that case, quit like a normal app.
app.on('window-all-closed', () => {
  if (trayService && !trayService.hasTray()) {
    log.warn('All windows closed and no tray icon exists — quitting instead of running unreachable');
    void gracefulExit(0);
    return;
  }
  log.info('All windows closed, app continues running in tray');
});

// Intercept quit to require a second confirmation press (Chrome-style).
// Real shutdowns (tray "Quit", OS signals) bypass this and exit immediately.
app.on('before-quit', (event) => {
  // Already confirmed by a signal, the tray menu, or a prior second press → exit.
  // A4: prevent the default (immediate) quit, run the async cleanup so the
  // backend child is fully terminated, then hard-exit. gracefulExit is
  // idempotent, so a re-entrant before-quit is a no-op.
  if (isQuittingForReal || windowService?.shouldForceQuit()) {
    event.preventDefault();
    void gracefulExit(0);
    return;
  }

  // The toast is already on screen → this is the second press → exit.
  if (quitConfirmActive) {
    if (quitConfirmTimer) clearTimeout(quitConfirmTimer);
    quitConfirmActive = false;
    setQuitConfirmVisible(false);
    event.preventDefault();
    void gracefulExit(0);
    return;
  }

  // First press → cancel the quit and show the confirmation toast for 5s.
  event.preventDefault();
  quitConfirmActive = true;
  setQuitConfirmVisible(true);
  quitConfirmTimer = setTimeout(() => {
    quitConfirmActive = false;
    setQuitConfirmVisible(false);
  }, QUIT_CONFIRM_MS);
});