// ClipChimp/electron/services/update-service.ts
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
    autoUpdater.on('update-available', () => {
      log.info('Update available');
      const mainWindow = this.windowService.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('update-available');
      }
    });
    
    // Update downloaded
    autoUpdater.on('update-downloaded', () => {
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