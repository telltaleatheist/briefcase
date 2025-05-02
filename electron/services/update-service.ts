// clippy/electron/services/update-service.ts
import * as log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import { AppConfig } from '../config/app-config';
import { WindowService } from './window-service';

/**
 * Auto-update service
 * Handles checking for and installing application updates
 */
export class UpdateService {
  private windowService: WindowService;
  
  constructor(windowService: WindowService) {
    this.windowService = windowService;
    
    // Set up event handlers
    this.setupUpdateEvents();
  }
  
  /**
   * Check for updates
   */
  checkForUpdates(): void {
    // Only check for updates in production
    if (!AppConfig.isDevelopment) {
      try {
        log.info('Checking for updates...');
        autoUpdater.checkForUpdatesAndNotify().catch(err => {
          log.warn('Auto-updater error:', err);
        });
      } catch (error) {
        log.warn('Failed to check for updates:', error);
      }
    } else {
      log.info('Skipping update check in development mode');
    }
  }
  
  /**
   * Install available update
   */
  installUpdate(): void {
    log.info('Installing update...');
    autoUpdater.quitAndInstall();
  }
  
  /**
   * Set up update event handlers
   */
  private setupUpdateEvents(): void {
    // Update available
    autoUpdater.on('update-available', () => {
      log.info('Update available');
      const mainWindow = this.windowService.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('update-available');
      }
    });
    
    // Update downloaded
    autoUpdater.on('update-downloaded', () => {
      log.info('Update downloaded');
      const mainWindow = this.windowService.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('update-downloaded');
      }
    });
    
    // Update error
    autoUpdater.on('error', (err) => {
      log.error('Update error:', err);
    });
  }
}