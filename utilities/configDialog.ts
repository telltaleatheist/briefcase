// utilities/configDialog.ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { ConfigManager, PathConfig } from '../config/ConfigManager';
import { PathValidator } from './PathValidator';

export class ConfigDialog {
  private window: BrowserWindow | null = null;
  private resolver: ((value: boolean) => void) | null = null;
  private configManager: ConfigManager;
  private onConfigUpdated: (() => void) | null = null;

  constructor(onConfigUpdated?: () => void) {
    this.configManager = ConfigManager.getInstance();
    this.onConfigUpdated = onConfigUpdated || null;
    this.setupIpcHandlers();
  }

  private setupIpcHandlers() {
    // Handler for selecting a directory containing all executables
    ipcMain.handle('select-executables-directory', async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Directory Containing FFmpeg, FFprobe, and yt-dlp'
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false };
      }

      const selectedDir = result.filePaths[0];
      const foundExecutables = PathValidator.findExecutablesInDirectory(selectedDir);
      
      return {
        success: true,
        directory: selectedDir,
        ...foundExecutables
      };
    });

    // Handler for selecting individual executable
    ipcMain.handle('select-executable', async (_, executableType: 'ffmpeg' | 'ffprobe' | 'ytdlp') => {
      let title: string;
      let filters: Electron.FileFilter[];
      
      if (process.platform === 'win32') {
        filters = [{ name: 'Executables', extensions: ['exe'] }];
      } else {
        // On macOS and Linux, we don't filter by extension
        filters = [{ name: 'All Files', extensions: ['*'] }];
      }
      
      switch (executableType) {
        case 'ffmpeg':
          title = 'Select FFmpeg Executable';
          break;
        case 'ffprobe':
          title = 'Select FFprobe Executable';
          break;
        case 'ytdlp':
          title = 'Select yt-dlp Executable';
          break;
        default:
          return { success: false, error: 'Invalid executable type' };
      }
      
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title,
        filters
      });
      
      if (result.canceled || !result.filePaths.length) {
        return { success: false };
      }
      
      const selectedFile = result.filePaths[0];
      
      // Validate the selected file
      let validationResult;
      if (executableType === 'ffmpeg') {
        validationResult = await PathValidator.validateFFmpeg(selectedFile);
      } else if (executableType === 'ffprobe') {
        validationResult = await PathValidator.validateFFprobe(selectedFile);
      } else { // ytdlp
        validationResult = await PathValidator.validateYtDlp(selectedFile);
      }
      
      if (!validationResult.isValid) {
        return {
          success: false,
          path: selectedFile,
          error: validationResult.error || 'Selected file is not valid'
        };
      }
      
      return {
        success: true,
        path: selectedFile,
        version: validationResult.version
      };
    });

    // Save configuration
    ipcMain.handle('save-config', async (_, config: PathConfig) => {
      // Validate all paths one more time before saving
      const validation = await PathValidator.validateAllPaths(config);
      
      if (!validation.allValid) {
        return { 
          success: false,
          errors: {
            ffmpeg: validation.ffmpeg.error,
            ffprobe: validation.ffprobe.error,
            ytDlp: validation.ytDlp.error
          }
        };
      }
      
      const success = this.configManager.updateConfig(config);
      
      if (success && this.onConfigUpdated) {
        // Notify that config was updated
        this.onConfigUpdated();
      }
      
      return { success };
    });

    // Try to auto-detect executables in PATH
    ipcMain.handle('auto-detect-executables', async () => {
      // First, check if they're in PATH
      const pathExecutables = PathValidator.findExecutablesInSystemPath();
      const result: {
        ffmpeg?: { path: string; isValid: boolean; version?: string; error?: string };
        ffprobe?: { path: string; isValid: boolean; version?: string; error?: string };
        ytDlp?: { path: string; isValid: boolean; version?: string; error?: string };
      } = {};

      // Validate each found executable
      if (pathExecutables.ffmpegPath) {
        const validation = await PathValidator.validateFFmpeg(pathExecutables.ffmpegPath);
        result.ffmpeg = {
          path: pathExecutables.ffmpegPath,
          isValid: validation.isValid,
          version: validation.version,
          error: validation.error
        };
      }
      
      if (pathExecutables.ffprobePath) {
        const validation = await PathValidator.validateFFprobe(pathExecutables.ffprobePath);
        result.ffprobe = {
          path: pathExecutables.ffprobePath,
          isValid: validation.isValid,
          version: validation.version,
          error: validation.error
        };
      }
      
      if (pathExecutables.ytDlpPath) {
        const validation = await PathValidator.validateYtDlp(pathExecutables.ytDlpPath);
        result.ytDlp = {
          path: pathExecutables.ytDlpPath,
          isValid: validation.isValid,
          version: validation.version,
          error: validation.error
        };
      }
      
      return result;
    });

    // Check if config is valid
    ipcMain.handle('check-config', async () => {
      const config = this.configManager.getConfig();
      if (!this.configManager.hasRequiredPaths()) {
        return { 
          isValid: false, 
          message: 'Required paths are not configured' 
        };
      }
      
      // Validate all paths
      const validation = await PathValidator.validateAllPaths(config);
      
      if (!validation.allValid) {
        const errors: string[] = [];
        if (!validation.ffmpeg.isValid) {
          errors.push(`FFmpeg: ${validation.ffmpeg.error}`);
        }
        if (!validation.ffprobe.isValid) {
          errors.push(`FFprobe: ${validation.ffprobe.error}`);
        }
        if (!validation.ytDlp.isValid) {
          errors.push(`yt-dlp: ${validation.ytDlp.error}`);
        }
        
        return { 
          isValid: false, 
          message: errors.join(', ')
        };
      }
      
      return { 
        isValid: true,
        versions: {
          ffmpeg: validation.ffmpeg.version,
          ffprobe: validation.ffprobe.version,
          ytDlp: validation.ytDlp.version
        }
      };
    });

    // Exit the app
    ipcMain.on('exit-app', () => {
      app.quit();
    });
  }

  /**
   * Show the configuration dialog window
   */
  showDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      
      // Create a window if one doesn't exist
      if (!this.window) {
        this.createWindow();
      } else {
        this.window.show();
      }
    });
  }

  private createWindow() {
    // First determine the preload path before creating the window
    let preloadPath;
    
    if (app.isPackaged) {
      // In a packaged app, the code is inside the app.asar archive
      const possiblePaths = [
        path.join(process.resourcesPath, 'app.asar', 'utilities', 'configPreload.js'),
        path.join(process.resourcesPath, 'app.asar', 'dist-electron', 'utilities', 'configPreload.js'),
        path.join(process.resourcesPath, 'app.asar', 'dist-electron', 'preload', 'utilities', 'configPreload.js'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'utilities', 'configPreload.js')
      ];
      
      // Try each path until we find one that exists
      for (const potentialPath of possiblePaths) {
        log.info(`Checking for preload at: ${potentialPath}`);
        try {
          // We can't directly check if files exist inside asar archives with fs.existsSync
          // Instead, we need to try to access it and catch any errors
          require.resolve(potentialPath);
          preloadPath = potentialPath;
          log.info(`Found preload at: ${preloadPath}`);
          break;
        } catch (error) {
          log.info(`Not found at: ${potentialPath}`);
        }
      }
    } else {
      // In development mode
      preloadPath = path.join(app.getAppPath(), 'utilities', 'configPreload.js');
      
      // Try alternate location if the first one doesn't exist
      if (!fs.existsSync(preloadPath)) {
        const altPreloadPath = path.join(app.getAppPath(), 'dist-electron', 'utilities', 'configPreload.js');
        if (fs.existsSync(altPreloadPath)) {
          preloadPath = altPreloadPath;
        }
      }
    }
    
    log.info(`Final preload path: ${preloadPath}`);
    
    // Now create the window with the correct preload path
    this.window = new BrowserWindow({
      width: 600,
      height: 550,
      center: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      title: 'Configure Required Executables',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath
      }
    });
    
    // Determine HTML path based on environment
    let htmlPath;
    if (app.isPackaged) {
      // In production/packaged mode, check both the asar and the extracted/unpacked locations
      const possibleHtmlPaths = [
        path.join(process.resourcesPath, 'utilities', 'configDialog.html'),
        path.join(process.resourcesPath, 'app.asar', 'utilities', 'configDialog.html'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'utilities', 'configDialog.html')
      ];
      
      for (const potentialPath of possibleHtmlPaths) {
        log.info(`Checking for HTML at: ${potentialPath}`);
        try {
          // For HTML files inside asar, we need to be careful with how we check
          if (potentialPath.includes('app.asar') && !potentialPath.includes('unpacked')) {
            try {
              require.resolve(potentialPath);
              htmlPath = potentialPath;
              log.info(`Found HTML at: ${htmlPath}`);
              break;
            } catch (error) {
              log.info(`Not found at: ${potentialPath}`);
            }
          } else {
            // For regular files, we can use existsSync
            if (fs.existsSync(potentialPath)) {
              htmlPath = potentialPath;
              log.info(`Found HTML at: ${htmlPath}`);
              break;
            }
          }
        } catch (error) {
          log.info(`Error checking path ${potentialPath}: ${(error as Error).message || String(error)}`);
        }
      }
    } else {
      // In development mode
      htmlPath = path.join(app.getAppPath(), 'utilities', 'configDialog.html');
    }
    
    log.info(`Final HTML path: ${htmlPath}`);
    
    // Load the HTML file
    if (htmlPath) {
      try {
        this.window.loadFile(htmlPath);
      } catch (error) {
        log.error(`Error loading HTML file: ${(error as Error).message || String(error)}`);
        this.window.loadURL(`data:text/html;charset=utf-8,<html><body><h2>Error</h2><p>Failed to load configuration dialog: ${(error as Error).message || String(error)}</p></body></html>`);
      }
    } else {
      this.window.loadURL(`data:text/html;charset=utf-8,<html><body><h2>Error</h2><p>Could not find configuration dialog HTML file</p></body></html>`);
    }

    // Handle window closed
    this.window.on('closed', () => {
      this.window = null;
      
      // If dialog was closed without resolving, resolve as false
      if (this.resolver) {
        this.resolver(false);
        this.resolver = null;
      }
    });
  
    // When config is saved and valid, resolve promise
    ipcMain.once('config-saved', () => {
      if (this.resolver) {
        this.resolver(true);
        this.resolver = null;
      }
      
      if (this.window) {
        this.window.close();
      }
    });
  }
}