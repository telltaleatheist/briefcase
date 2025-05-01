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
      preloadPath = path.join(process.resourcesPath, 'utilities', 'configPreload.js');
    } else {
      preloadPath = path.join(app.getAppPath(), 'utilities', 'configPreload.js');
      
      // Try alternate location if the first one doesn't exist
      if (!fs.existsSync(preloadPath)) {
        const altPreloadPath = path.join(app.getAppPath(), 'dist-electron', 'utilities', 'configPreload.js');
        if (fs.existsSync(altPreloadPath)) {
          preloadPath = altPreloadPath;
        }
      }
    }
    
    log.info(`Preload path: ${preloadPath}`);
    log.info(`Preload exists: ${fs.existsSync(preloadPath)}`);
  
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
        preload: fs.existsSync(preloadPath) ? preloadPath : undefined
      }
    });
    
    // Determine HTML path based on environment
    let htmlPath;
    if (app.isPackaged) {
      // In production/packaged mode
      htmlPath = path.join(process.resourcesPath, 'utilities', 'configDialog.html');
    } else {
      // In development mode
      htmlPath = path.join(app.getAppPath(), 'utilities', 'configDialog.html');
    }
    
    // Add logging to help debug path issues
    log.info(`Config dialog HTML path: ${htmlPath}`);
    log.info(`HTML file exists: ${fs.existsSync(htmlPath)}`);
    
    // Try to list contents of the parent directory if the file isn't found
    if (!fs.existsSync(htmlPath)) {
      const parentDir = path.dirname(htmlPath);
      log.info(`Parent directory exists: ${fs.existsSync(parentDir)}`);
      if (fs.existsSync(parentDir)) {
        log.info(`Parent directory contents: ${fs.readdirSync(parentDir).join(', ')}`);
      }
      
      // Also try a different path as fallback
      const altPath = path.join(app.getAppPath(), 'dist-electron', 'utilities', 'configDialog.html');
      log.info(`Trying alternative path: ${altPath}`);
      log.info(`Alternative path exists: ${fs.existsSync(altPath)}`);
      
      if (fs.existsSync(altPath)) {
        htmlPath = altPath;
      }
    }
    
    // Check if the HTML file exists
    if (fs.existsSync(htmlPath)) {
      this.window.loadFile(htmlPath);
    } else {
      // Fallback to a data URL with a simple HTML error message
      this.window.loadURL(`data:text/html;charset=utf-8,
        <html>
          <head><title>Configuration Error</title>
            <style>
              body { font-family: sans-serif; padding: 20px; color: #333; }
              h2 { color: #c0392b; }
              button { padding: 10px 20px; background: #3498db; color: white; 
                     border: none; border-radius: 4px; cursor: pointer; }
              button:hover { background: #2980b9; }
            </style>
          </head>
          <body>
            <h2>Configuration Dialog Error</h2>
            <p>Unable to load the configuration dialog HTML file.</p>
            <p>Path tried: ${htmlPath}</p>
            <button onclick="window.electronAPI && window.electronAPI.exitApp()">
              Exit Application
            </button>
          </body>
        </html>`);
      log.error('Configuration dialog HTML file not found:', htmlPath);
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