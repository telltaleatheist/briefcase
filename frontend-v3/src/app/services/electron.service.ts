import { Injectable } from '@angular/core';

// Type definitions for the Electron API exposed via preload
interface ElectronAPI {
  selectDirectory: () => Promise<string | null>;
  openDirectoryPicker: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialog: (options: any) => Promise<{ canceled: boolean; filePaths: string[] }>;
  openFile: (filePath: string) => Promise<string>;
  openMultipleFiles: (filePaths: string[]) => Promise<{ success: boolean; error?: string }>;
  showInFolder: (filePath: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getBackendUrl: () => Promise<string>;
  getAppVersion: () => Promise<string>;
  saveConsoleLogs: (filename: string, content: string) => Promise<string>;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

@Injectable({
  providedIn: 'root'
})
export class ElectronService {

  /**
   * Check if running in Electron environment
   */
  get isElectron(): boolean {
    return !!(window.electron);
  }

  /**
   * Open a directory picker dialog
   * Returns the selected path or null if cancelled
   */
  async selectDirectory(): Promise<string | null> {
    if (!this.isElectron) {
      console.warn('selectDirectory: Not running in Electron');
      return null;
    }

    try {
      return await window.electron!.selectDirectory();
    } catch (error) {
      console.error('Error selecting directory:', error);
      return null;
    }
  }

  /**
   * Open a directory picker with more options
   */
  async openDirectoryPicker(): Promise<string | null> {
    if (!this.isElectron) {
      console.warn('openDirectoryPicker: Not running in Electron');
      return null;
    }

    try {
      const result = await window.electron!.openDirectoryPicker();
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    } catch (error) {
      console.error('Error opening directory picker:', error);
      return null;
    }
  }

  /**
   * Open a file in its default application
   */
  async openFile(filePath: string): Promise<void> {
    if (!this.isElectron) {
      console.warn('openFile: Not running in Electron');
      return;
    }

    try {
      await window.electron!.openFile(filePath);
    } catch (error) {
      console.error('Error opening file:', error);
    }
  }

  /**
   * Open multiple files in their default application (as tabs if supported)
   * On macOS, files will open as tabs in QuickTime if user has tab preference enabled
   */
  async openMultipleFiles(filePaths: string[]): Promise<void> {
    if (!this.isElectron) {
      console.warn('openMultipleFiles: Not running in Electron');
      return;
    }

    try {
      await window.electron!.openMultipleFiles(filePaths);
    } catch (error) {
      console.error('Error opening files:', error);
    }
  }

  /**
   * Show a file in Finder/Explorer
   */
  async showInFolder(filePath: string): Promise<void> {
    if (!this.isElectron) {
      console.warn('showInFolder: Not running in Electron');
      return;
    }

    try {
      await window.electron!.showInFolder(filePath);
    } catch (error) {
      console.error('Error showing in folder:', error);
    }
  }

  /**
   * Get the backend URL from Electron
   */
  async getBackendUrl(): Promise<string> {
    if (!this.isElectron) {
      // Default to localhost in development
      return 'http://localhost:3001';
    }

    try {
      return await window.electron!.getBackendUrl();
    } catch (error) {
      console.error('Error getting backend URL:', error);
      return 'http://localhost:3001';
    }
  }

  /**
   * Get the app version
   */
  async getAppVersion(): Promise<string> {
    if (!this.isElectron) {
      return 'dev';
    }

    try {
      return await window.electron!.getAppVersion();
    } catch (error) {
      console.error('Error getting app version:', error);
      return 'unknown';
    }
  }

  /**
   * Save console logs to the logs directory
   * Returns the path where logs were saved
   */
  async saveConsoleLogs(filename: string, content: string): Promise<string | null> {
    if (!this.isElectron) {
      console.warn('saveConsoleLogs: Not running in Electron');
      return null;
    }

    try {
      return await window.electron!.saveConsoleLogs(filename, content);
    } catch (error) {
      console.error('Error saving console logs:', error);
      return null;
    }
  }

  /**
   * Open external URL in default browser
   */
  async openExternal(url: string): Promise<void> {
    if (!this.isElectron) {
      // Fallback for non-Electron: open in new tab
      window.open(url, '_blank');
      return;
    }

    try {
      await window.electron!.openExternal(url);
    } catch (error) {
      console.error('Error opening external URL:', error);
      // Fallback to window.open
      window.open(url, '_blank');
    }
  }
}
