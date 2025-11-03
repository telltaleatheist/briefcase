// clippy/electron/ipc/ipc-handlers.ts
import { ipcMain, dialog, shell, app } from 'electron';
import * as log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
import { ConfigManager } from '../../config/ConfigManager';
import { PathValidator } from '../../utilities/PathValidator';
import { WindowService } from '../services/window-service';
import { BackendService } from '../services/backend-service';
import { DownloadService } from '../services/download-service';
import { UpdateService } from '../services/update-service';

// Create service instances
let downloadService: DownloadService;
let updateService: UpdateService;

// Define settings schema
interface Settings {
  lastUsedProvider: string;
  lastUsedModel: string;
  claudeApiKey: string;
  openaiApiKey: string;
}

// Initialize electron-store for user settings
// Stored in user's app data directory - won't transfer with app
const store = new Store<Settings>({
  name: 'clippy-settings',
  defaults: {
    lastUsedProvider: 'ollama',
    lastUsedModel: 'qwen2.5:7b',
    claudeApiKey: '',
    openaiApiKey: '',
  }
});

/**
 * Set up all IPC handlers
 */
export function setupIpcHandlers(
  windowService: WindowService,
  backendService: BackendService
): void {
  // Create services
  downloadService = new DownloadService(windowService);
  updateService = new UpdateService(windowService);

  // Register handlers
  setupConfigHandlers();
  setupDownloadHandlers();
  setupFileSystemHandlers();
  setupUpdateHandlers();
  setupSettingsHandlers();
}

/**
 * Set up configuration-related IPC handlers
 */
function setupConfigHandlers(): void {
  const configManager = ConfigManager.getInstance();
  
  // Check path configuration
  ipcMain.handle('check-path-config', async () => {
    const validation = await PathValidator.validateAllPaths(configManager.getConfig());
    return { isValid: validation.allValid };
  });
  
  // Show path configuration dialog
  ipcMain.handle('show-path-config-dialog', async () => {
    const configDialog = new (require('../../utilities/configDialog').ConfigDialog)(() => {
      const config = configManager.getConfig();
      process.env.FFMPEG_PATH = config.ffmpegPath;
      process.env.FFPROBE_PATH = config.ffprobePath;
      process.env.YT_DLP_PATH = config.ytDlpPath;
    });
    
    return configDialog.showDialog();
  });
  
  // Get current path configuration
  ipcMain.handle('get-path-config', () => {
    return configManager.getConfig();
  });
  
  // Update path configuration
  ipcMain.handle('update-path-config', (_, config) => {
    const success = configManager.updateConfig(config);
    
    if (success) {
      // Update environment variables
      const updatedConfig = configManager.getConfig();
      process.env.FFMPEG_PATH = updatedConfig.ffmpegPath;
      process.env.FFPROBE_PATH = updatedConfig.ffprobePath;
      process.env.YT_DLP_PATH = updatedConfig.ytDlpPath;
    }
    
    return { success };
  });
}

/**
 * Set up download-related IPC handlers
 */
function setupDownloadHandlers(): void {
  // Download video
  ipcMain.handle('download-video', async (_, options) => {
    return downloadService.downloadVideo(options);
  });
}

/**
 * Set up file system-related IPC handlers
 */
function setupFileSystemHandlers(): void {
  // Select directory
  ipcMain.handle('select-directory', async (event) => {
    const window = event.sender ? require('electron').BrowserWindow.fromWebContents(event.sender) : null;
    
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    });

    if (result.canceled) {
      return null;
    }

    return result.filePaths[0];
  });
  
  // Open file in native application
  ipcMain.handle('open-file', (_, filePath) => {
    return shell.openPath(filePath);
  });
  
  // Show file in folder
  ipcMain.handle('show-in-folder', (_, filePath) => {
    return shell.showItemInFolder(filePath);
  });
  
  // Directory picker dialog
  ipcMain.handle('open-directory-picker', async (event) => {
    const window = event.sender ? require('electron').BrowserWindow.fromWebContents(event.sender) : null;

    if (!window) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Select Download Location'
    });

    return result;
  });

  // Generic open dialog (for file/folder selection)
  ipcMain.handle('show-open-dialog', async (event, options) => {
    const window = event.sender ? require('electron').BrowserWindow.fromWebContents(event.sender) : null;

    if (!window) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(window, options);

    return result;
  });

  // Select video file dialog
  ipcMain.handle('select-video-file', async (event) => {
    const window = event.sender ? require('electron').BrowserWindow.fromWebContents(event.sender) : null;

    if (!window) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: 'Select Video or Audio File',
      filters: [
        { name: 'All Media Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma', 'opus'] },
        { name: 'Video Files', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'] },
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma', 'opus'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    return result;
  });

  // Check if a path is a directory
  ipcMain.handle('is-directory', async (_, filePath) => {
    try {
      const fs = require('fs');
      const stats = fs.statSync(filePath);
      return stats.isDirectory();
    } catch (error) {
      log.error('Error checking if path is directory:', error);
      return false;
    }
  });

  // Get downloads path
  ipcMain.handle('get-downloads-path', () => {
    return require('electron').app.getPath('downloads');
  });
  
  // Check if file exists
  ipcMain.handle('check-file-exists', (_, filePath) => {
    return downloadService.checkFileExists(filePath);
  });
  
  // Get app paths
  ipcMain.handle('get-app-paths', () => {
    return downloadService.getAppPaths();
  });
}

/**
 * Set up update-related IPC handlers
 */
function setupUpdateHandlers(): void {
  // Install update
  ipcMain.handle('install-update', () => {
    updateService.installUpdate();
  });
}

/**
 * Set up settings-related IPC handlers
 */
function setupSettingsHandlers(): void {
  // Get all settings
  ipcMain.handle('get-settings', () => {
    try {
      return (store as any).store;
    } catch (error) {
      log.error('Error getting settings:', error);
      return {};
    }
  });

  // Update settings
  ipcMain.handle('update-settings', (_, settings) => {
    try {
      Object.keys(settings).forEach(key => {
        (store as any).set(key, settings[key]);
      });
      return { success: true };
    } catch (error) {
      log.error('Error updating settings:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Get a specific setting
  ipcMain.handle('get-setting', (_, key) => {
    try {
      return (store as any).get(key);
    } catch (error) {
      log.error(`Error getting setting ${key}:`, error);
      return null;
    }
  });

  // Set a specific setting
  ipcMain.handle('set-setting', (_, key, value) => {
    try {
      (store as any).set(key, value);
      return { success: true };
    } catch (error) {
      log.error(`Error setting ${key}:`, error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Clear all settings (reset to defaults)
  ipcMain.handle('clear-settings', () => {
    try {
      (store as any).clear();
      return { success: true };
    } catch (error) {
      log.error('Error clearing settings:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Get settings file path (for debugging)
  ipcMain.handle('get-settings-path', () => {
    return (store as any).path;
  });
}