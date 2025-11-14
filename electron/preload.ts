// electron/preload.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import * as path from 'path';

// Define types for our exposed API
interface ElectronAPI {
  openDirectoryPicker: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialog: (options: any) => Promise<any>; // Use 'any' for now to avoid type conflicts
  isDirectory: (filePath: string) => Promise<boolean>;
  scanDirectoryForMedia: (directoryPath: string) => Promise<string[]>;
  getAppVersion: () => Promise<string>;
  getBinaryPaths: () => Promise<{
    ytDlpPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    resourcesPath: string;
    isDevelopment: boolean;
  }>;
  getBackendUrl: () => Promise<string>;
  environment: {
    isDevelopment: boolean;
    resourcesPath: string;
    appPath: string;
    getBinaryPath: (binaryName: string) => string;
  };
  openFile: (filePath: string) => Promise<string>;
  showInFolder: (filePath: string) => Promise<void>;
  installUpdate: () => Promise<void>;
  downloadVideo: (options: any) => Promise<{
    success: boolean;
    outputFile?: string;
    error?: string;
  }>;
  selectDirectory: () => Promise<string | null>;
  selectVideoFile: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  getFilePathFromFile: (file: File) => string;
  // Settings API
  getSettings: () => Promise<any>;
  updateSettings: (settings: any) => Promise<{ success: boolean; error?: string }>;
  getSetting: (key: string) => Promise<any>;
  setSetting: (key: string, value: any) => Promise<{ success: boolean; error?: string }>;
  clearSettings: () => Promise<{ success: boolean; error?: string }>;
  getSettingsPath: () => Promise<string>;
  // Setup progress listener
  onSetupProgress?: (callback: (event: any, data: any) => void) => void;
}

// Get resource path information
const isDevelopment = process.env.NODE_ENV !== 'production';
const resourcesPath = process.resourcesPath || '';

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  },
  openDirectoryPicker: () => ipcRenderer.invoke('open-directory-picker'),
  showOpenDialog: (options: any) => ipcRenderer.invoke('show-open-dialog', options),
  isDirectory: (filePath: string) => ipcRenderer.invoke('is-directory', filePath),
  scanDirectoryForMedia: (directoryPath: string) => ipcRenderer.invoke('scan-directory-for-media', directoryPath),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getBinaryPaths: () => ipcRenderer.invoke('get-binary-paths'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  environment: {
    isDevelopment,
    resourcesPath,
    appPath: process.cwd(),
    getBinaryPath: (binaryName: string) => {
      const executable = process.platform === 'win32' ? `${binaryName}.exe` : binaryName;

      if (isDevelopment) {
        // In development, binaries are in the project root's bin directory
        return path.join(process.cwd(), 'bin', executable);
      } else {
        // In production, binaries are in the resources/bin directory
        return path.join(resourcesPath, 'bin', executable);
      }
    },
    checkPathConfig: () => {
      return ipcRenderer.invoke('check-path-config');
    },

    // Notify about missing executables
    showPathConfigDialog: () => {
      return ipcRenderer.invoke('show-path-config-dialog');
    },

    // Get current configuration
    getPathConfig: () => {
      return ipcRenderer.invoke('get-path-config');
    },

    // Update configuration programmatically
    updatePathConfig: (config: any) => {
      return ipcRenderer.invoke('update-path-config', config);
    },
  },
  // Add all your other IPC handlers here
  openFile: (filePath: string) => ipcRenderer.invoke('open-file', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('show-in-folder', filePath),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  downloadVideo: (options: any) => ipcRenderer.invoke('download-video', options),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  getFilePathFromFile: (file: File) => webUtils.getPathForFile(file),
  // Settings API
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: any) => ipcRenderer.invoke('update-settings', settings),
  getSetting: (key: string) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key: string, value: any) => ipcRenderer.invoke('set-setting', key, value),
  clearSettings: () => ipcRenderer.invoke('clear-settings'),
  getSettingsPath: () => ipcRenderer.invoke('get-settings-path')
} as ElectronAPI);

// Expose setup progress listener to window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', {
  onSetupProgress: (callback: (event: any, data: any) => void) => {
    ipcRenderer.on('setup-progress', callback);
  }
});

// Listen for update events from main process
ipcRenderer.on('update-available', () => {
  // You can use a custom event to communicate with your Angular app
  window.dispatchEvent(new CustomEvent('electron-update-available'));
});

ipcRenderer.on('update-downloaded', () => {
  window.dispatchEvent(new CustomEvent('electron-update-downloaded'));
});

// For TypeScript - declare the API on the window object
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
