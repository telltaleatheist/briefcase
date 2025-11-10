// clippy/electron/services/tray-service.ts
import { app, Tray, Menu, nativeImage, shell } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import { AppConfig } from '../config/app-config';
import { WindowService } from './window-service';

/**
 * System tray/menu bar service
 * Manages the application's presence in the system tray (Windows) or menu bar (macOS)
 */
export class TrayService {
  private tray: Tray | null = null;
  private windowService: WindowService;
  private savedLinksCount: number = 0;
  private backendPort: number = 3000;

  constructor(windowService: WindowService) {
    this.windowService = windowService;
  }

  /**
   * Create the system tray icon and menu
   */
  createTray(): void {
    try {
      // Get the appropriate icon for the platform
      const iconPath = this.getTrayIconPath();
      log.info(`Creating tray with icon: ${iconPath}`);

      // Create the tray icon
      let icon = nativeImage.createFromPath(iconPath);

      // On macOS, make the icon template (monochrome) and resize
      if (process.platform === 'darwin') {
        icon = icon.resize({ width: 16, height: 16 });
        icon.setTemplateImage(true);
      }

      this.tray = new Tray(icon);
      this.tray.setToolTip('Clippy - Video Library Manager');

      // Build and set the context menu
      this.updateTrayMenu();

      // Handle tray icon click
      this.tray.on('click', () => {
        // On Windows, show/hide window on click
        if (process.platform === 'win32') {
          this.toggleWindow();
        }
      });

      // On macOS, clicking the dock icon should also restore the window
      if (process.platform === 'darwin') {
        app.on('activate', () => {
          this.showWindow();
        });
      }

      log.info('Tray icon created successfully');
    } catch (error) {
      log.error('Error creating tray icon:', error);
    }
  }

  /**
   * Update the tray context menu
   */
  private updateTrayMenu(): void {
    if (!this.tray) return;

    const savedLinksLabel = this.savedLinksCount > 0
      ? `Saved Links (${this.savedLinksCount})`
      : 'Saved Links';

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Clippy',
        click: () => this.showWindow()
      },
      {
        label: 'Open Web Interface',
        click: () => this.openWebInterface()
      },
      { type: 'separator' },
      {
        label: savedLinksLabel,
        click: () => this.openSavedLinks()
      },
      { type: 'separator' },
      {
        label: 'Quit Clippy',
        click: () => this.quitApplication()
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Get the appropriate tray icon path for the current platform
   */
  private getTrayIconPath(): string {
    let iconName: string;

    if (process.platform === 'darwin') {
      // macOS uses template images (monochrome)
      iconName = 'tray-icon-macos-Template.png';
    } else if (process.platform === 'win32') {
      // Windows uses .ico files
      iconName = 'tray-icon-windows.ico';
    } else {
      // Linux uses PNG
      iconName = 'tray-icon-linux.png';
    }

    return path.join(AppConfig.resourcesPath, 'assets', iconName);
  }

  /**
   * Show or restore the main window
   */
  private showWindow(): void {
    const mainWindow = this.windowService.getMainWindow();

    if (mainWindow) {
      // Window exists, restore it
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    } else {
      // Window doesn't exist, create it
      this.windowService.createMainWindow();
    }
  }

  /**
   * Toggle window visibility (show if hidden, hide if shown)
   */
  private toggleWindow(): void {
    const mainWindow = this.windowService.getMainWindow();

    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        this.showWindow();
      }
    } else {
      this.showWindow();
    }
  }

  /**
   * Open the web interface in the default browser
   */
  private openWebInterface(): void {
    const url = `http://localhost:${this.backendPort}/saved`;
    log.info(`Opening web interface: ${url}`);
    shell.openExternal(url);
  }

  /**
   * Open the Saved Links view in the main window
   */
  private openSavedLinks(): void {
    this.showWindow();
    // TODO: Navigate to /saved-links route once we implement the frontend
    // For now, just open the main window
  }

  /**
   * Quit the application completely
   */
  private quitApplication(): void {
    log.info('Quitting application from tray');
    // Set the quitting flag so the window can actually close
    this.windowService.setQuitting(true);
    app.quit();
  }

  /**
   * Update the saved links count badge
   */
  setSavedLinksCount(count: number): void {
    this.savedLinksCount = count;
    this.updateTrayMenu();

    // On macOS, we can also update the dock badge
    if (process.platform === 'darwin' && count > 0) {
      app.dock.setBadge(count.toString());
    } else if (process.platform === 'darwin') {
      app.dock.setBadge('');
    }
  }

  /**
   * Set the backend port for web interface URL
   */
  setBackendPort(port: number): void {
    this.backendPort = port;
  }

  /**
   * Destroy the tray icon
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  /**
   * Show a notification from the tray
   */
  showNotification(title: string, body: string): void {
    // Electron's Notification API
    const notification = new (require('electron').Notification)({
      title,
      body,
      icon: path.join(AppConfig.resourcesPath, 'assets', 'icon.png')
    });

    notification.show();

    // On click, show the main window
    notification.on('click', () => {
      this.showWindow();
    });
  }
}
