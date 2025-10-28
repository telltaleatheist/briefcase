// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import * as path from 'path';

// Define types for our exposed API
interface ElectronAPI {
  openDirectoryPicker: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialog: (options: any) => Promise<any>; // Use 'any' for now to avoid type conflicts
  isDirectory: (filePath: string) => Promise<boolean>;
  getAppVersion: () => Promise<string>;
  getBinaryPaths: () => Promise<{
    ytDlpPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    resourcesPath: string;
    isDevelopment: boolean;
  }>;
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
}

// Get resource path information
const isDevelopment = process.env.NODE_ENV !== 'production';
const resourcesPath = process.resourcesPath || '';

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electron', {
  openDirectoryPicker: () => ipcRenderer.invoke('open-directory-picker'),
  showOpenDialog: (options: any) => ipcRenderer.invoke('show-open-dialog', options),
  isDirectory: (filePath: string) => ipcRenderer.invoke('is-directory', filePath),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getBinaryPaths: () => ipcRenderer.invoke('get-binary-paths'),
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
  selectVideoFile: () => ipcRenderer.invoke('select-video-file')
} as ElectronAPI);

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
