// clippy/electron/main.ts
import { app } from 'electron';
import * as log from 'electron-log';
import { AppConfig } from './config/app-config';
import { ExecutablesUtil } from './utilities/executables';
import { WindowService } from './services/window-service';
import { BackendService } from './services/backend-service';
import { SetupService } from './services/setup-service';
import { setupIpcHandlers } from './ipc/ipc-handlers';
import { UpdateService } from './services/update-service';
import { LogUtil } from './utilities/log-util';

/**
 * Main application entry point
 * Responsible for coordinating the app startup process
 */

let windowService: WindowService;
let backendService: BackendService;
let updateService: UpdateService;
let setupService: SetupService;

// Configure logging - always log to file
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// Clean up old log files (keep logs from last 7 days)
LogUtil.cleanupOldLogs(7);

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
  log.error('Error setting up single instance lock:', error);
  // Continue anyway - better to run than fail completely
}

// App is ready - start initialization sequence
app.whenReady().then(async () => {

  try {
    // Initialize AppConfig first
    AppConfig.initialize();

    // Check required executables first
    const executablesUtil = new ExecutablesUtil();
    const executablesConfigured = await executablesUtil.checkAndConfigureExecutables();
    
    if (!executablesConfigured) {
      log.error('Failed to configure required executables, exiting application');
      app.quit();
      return;
    }
    
    // Initialize services
    backendService = new BackendService();
    windowService = new WindowService();
    updateService = new UpdateService(windowService);
    setupService = new SetupService();

    // Set up IPC handlers
    setupIpcHandlers(windowService, backendService);

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
      // Set the actual frontend port before creating the window
      windowService.setFrontendPort(backendService.getFrontendPort());
      windowService.createMainWindow();

      // Run optional AI features setup after window is created (non-blocking)
      // This runs in the background and won't prevent the app from starting
      setTimeout(async () => {
        try {
          const checkResult = await setupService.checkDependencies();
          await setupService.runOptionalSetups(checkResult);
        } catch (error) {
          log.error('Error during optional setups:', error);
          // Silently fail - don't interrupt user experience
        }
      }, 2000); // Wait 2 seconds after launch to let user see the app first
    } else {
      // Backend failed twice - show error
      log.error('Backend failed to start after retry attempt');
      windowService.showBackendErrorWindow();
    }
    
    // macOS-specific behavior
    app.on('activate', () => {
      if (windowService.getAllWindows().length === 0) {
        if (backendService.isRunning()) {
          windowService.setFrontendPort(backendService.getFrontendPort());
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

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Cleanup before quitting
app.on('before-quit', () => {
  log.info('Application is quitting...');
  if (backendService) {
    backendService.shutdown();
  }
});