// ClipChimp/electron/ipc/ipc-handlers.ts
// SIMPLIFIED: Removed ConfigManager and PathValidator - using bundled binaries
import { ipcMain, dialog, shell, app } from 'electron';
import * as log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import Store from 'electron-store';
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
  name: 'clipchimp-settings',
  defaults: {
    lastUsedProvider: 'ollama',
    lastUsedModel: 'qwen2.5:7b',
    claudeApiKey: '',
    openaiApiKey: '',
  }
});

// Store backend service reference for IPC handlers
let backendServiceRef: BackendService;
let windowServiceRef: WindowService;

/**
 * Set up all IPC handlers
 */
export function setupIpcHandlers(
  windowService: WindowService,
  backendService: BackendService
): void {
  // Store references for use in handlers
  backendServiceRef = backendService;
  windowServiceRef = windowService;

  // Create services
  downloadService = new DownloadService(windowService);
  updateService = new UpdateService(windowService);

  // Register handlers
  setupConfigHandlers();
  setupDownloadHandlers();
  setupFileSystemHandlers();
  setupUpdateHandlers();
  setupSettingsHandlers();
  setupWindowHandlers();
}

/**
 * Set up configuration-related IPC handlers
 * SIMPLIFIED: Just backend URL now - no more path configuration
 */
function setupConfigHandlers(): void {
  // Get backend URL
  ipcMain.handle('get-backend-url', () => {
    return backendServiceRef.getBackendUrl();
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

  // Copy files to clipboard (for Cmd+C functionality)
  ipcMain.handle('copy-files-to-clipboard', (_, filePaths: string[]) => {
    try {
      const { clipboard } = require('electron');
      clipboard.writeBuffer('public.file-url', Buffer.from(
        filePaths.map(p => `file://${p}`).join('\n')
      ));
      log.info(`Copied ${filePaths.length} file(s) to clipboard`);
      return { success: true };
    } catch (error) {
      log.error('Error copying files to clipboard:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Open file in QuickTime Player (macOS)
  ipcMain.handle('open-in-quicktime', async (_, filePath: string) => {
    try {
      if (process.platform === 'darwin') {
        const { exec } = require('child_process');
        return new Promise((resolve, reject) => {
          exec(`open -a "QuickTime Player" "${filePath}"`, (error: any) => {
            if (error) {
              log.error('Error opening file in QuickTime:', error);
              reject(error);
            } else {
              log.info(`Opened ${filePath} in QuickTime Player`);
              resolve({ success: true });
            }
          });
        });
      } else {
        // On non-macOS platforms, just open with default app
        return shell.openPath(filePath);
      }
    } catch (error) {
      log.error('Error opening in QuickTime:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Open multiple files in their default application (as tabs if supported)
  ipcMain.handle('open-files', async (_, filePaths: string[]) => {
    try {
      if (filePaths.length === 0) {
        return { success: false, error: 'No files provided' };
      }

      if (process.platform === 'darwin') {
        // On macOS, use 'open' command with all files at once
        // This will open them as tabs in QuickTime if user has tab preference enabled
        const { exec } = require('child_process');
        const escapedPaths = filePaths.map(p => `"${p}"`).join(' ');
        const command = `open ${escapedPaths}`;

        return new Promise((resolve, reject) => {
          exec(command, (error: any) => {
            if (error) {
              log.error('Error opening files:', error);
              reject(error);
            } else {
              log.info(`Opened ${filePaths.length} file(s) in default application`);
              resolve({ success: true });
            }
          });
        });
      } else {
        // On non-macOS platforms, open each file with default app
        const promises = filePaths.map(fp => shell.openPath(fp));
        await Promise.all(promises);
        return { success: true };
      }
    } catch (error) {
      log.error('Error opening files:', error);
      return { success: false, error: (error as Error).message };
    }
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

  // Select multiple video files dialog
  ipcMain.handle('dialog:openFiles', async (event, options) => {
    const window = event.sender ? require('electron').BrowserWindow.fromWebContents(event.sender) : null;

    if (!window) return { canceled: true, filePaths: [] };

    const result = await dialog.showOpenDialog(window, {
      ...options,
      title: options?.title || 'Select Video Files to Import'
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

  // Recursively scan directory for media files
  ipcMain.handle('scan-directory-for-media', async (_, directoryPath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const validExtensions = [
        // Videos
        '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv',
        // Audio
        '.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg',
        // Documents
        '.pdf', '.epub', '.mobi', '.txt', '.md',
        // Images
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
        // Webpages
        '.html', '.htm', '.mhtml'
      ];

      const mediaFiles: string[] = [];

      function scanDirectory(dirPath: string) {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            // Skip macOS resource fork files (._*)
            if (entry.name.startsWith('._')) {
              continue;
            }

            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(fullPath);
            } else if (entry.isFile()) {
              // Check if file has valid media extension
              const ext = path.extname(entry.name).toLowerCase();
              if (validExtensions.includes(ext)) {
                mediaFiles.push(fullPath);
              }
            }
          }
        } catch (err) {
          log.error(`Error scanning directory ${dirPath}:`, err);
        }
      }

      scanDirectory(directoryPath);
      return mediaFiles;
    } catch (error) {
      log.error('Error scanning directory for media:', error);
      return [];
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

  // Save console logs to logs directory
  ipcMain.handle('save-console-logs', async (_event, filename: string, content: string) => {
    try {
      const fs = await import('fs').then(m => m.promises);
      const path = await import('path');

      // Save to app logs directory
      const logsDir = log.transports.file.getFile().path.replace(/[^/]+$/, '');
      const logPath = path.join(logsDir, filename);

      await fs.writeFile(logPath, content, 'utf-8');
      log.info(`Console logs saved to: ${logPath}`);

      return logPath;
    } catch (error) {
      log.error('Failed to save console logs:', error);
      throw error;
    }
  });

  // Import files to library
  ipcMain.handle('import-files', async (event, filePaths: string[]) => {
    try {
      log.info(`Importing ${filePaths.length} file(s):`, filePaths);

      // Get backend URL
      const backendUrl = await backendServiceRef.getBackendUrl();
      const url = `${backendUrl}/api/database/import`;

      log.info(`Calling backend at: ${url}`);

      // Call backend import API using native fetch
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filePaths }),
      });

      const result = await response.json();
      log.info('Import result:', result);

      return result;
    } catch (error: any) {
      log.error('Failed to import files:', error);
      return {
        success: false,
        message: error.message,
        error: error.toString()
      };
    }
  });
}

/**
 * Set up window-related IPC handlers
 */
function setupWindowHandlers(): void {
  // Open video editor in a new window
  ipcMain.handle('open-editor-window', async (_, videoData: { videoId: string; videoPath?: string; videoTitle: string }) => {
    try {
      log.info('Opening editor window for video:', videoData.videoId);
      windowServiceRef.createEditorWindow(videoData);
      return { success: true };
    } catch (error: any) {
      log.error('Error opening editor window:', error);
      return { success: false, error: error.message };
    }
  });
}