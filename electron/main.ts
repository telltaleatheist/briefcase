// clippy/electron/main.ts
import { app } from 'electron';
import * as log from 'electron-log';
import { AppConfig } from './config/app-config';
import { ExecutablesUtil } from './utilities/executables';
import { WindowService } from './services/window-service';
import { BackendService } from './services/backend-service';
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

// Configure logging - always log to file
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// Clean up old log files (keep logs from last 7 days)
LogUtil.cleanupOldLogs(7);

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

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
    
    // Set up IPC handlers
    setupIpcHandlers(windowService, backendService);
    
    // Start backend server
    const backendStarted = await backendService.startBackendServer();
    
    // Create window based on backend status
    if (backendStarted) {
      windowService.createMainWindow();
    } else {
      windowService.showBackendErrorWindow();
    }
    
    // macOS-specific behavior
    app.on('activate', () => {
      if (windowService.getAllWindows().length === 0) {
        if (backendService.isRunning()) {
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