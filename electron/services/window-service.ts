// ClipChimp/electron/services/window-service.ts
import { BrowserWindow, shell } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import { AppConfig } from '../config/app-config';
import { ServerConfig } from '../config/server-config';

/**
 * Editor group info for tracking window groups
 */
export interface EditorGroup {
  groupNumber: number;
  windowId: string;
  window: BrowserWindow;
}

/**
 * Tab data for moving between groups
 */
export interface TabMoveData {
  videoId: string;
  videoPath: string | null;
  videoTitle: string;
  videoUrl: string | undefined;
  editorState: any;
  sections: any[];
  chapters: any[];
  waveformData: any;
  transcript: any[];
  analysisData: any;
  highlightSelection: any;
  categoryFilters: any[];
  hasAnalysis: boolean;
}

/**
 * Window management service
 * Handles creation and management of all application windows
 */
export class WindowService {
  private mainWindow: BrowserWindow | null = null;
  private editorWindows: Map<string, BrowserWindow> = new Map();
  private editorGroups: Map<string, number> = new Map(); // windowId -> groupNumber
  private nextGroupNumber: number = 1;
  private frontendPort: number = 8080;
  private isQuitting: boolean = false;

  /**
   * Set the frontend port to use
   */
  setFrontendPort(port: number): void {
    this.frontendPort = port;
  }

  /**
   * Create the main application window
   */
  createMainWindow(): BrowserWindow {
    // Get icon path - works for both development and production
    const iconPath = path.join(AppConfig.appPath, 'assets', 'icon.png');

    this.mainWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1200,
      minHeight: 600,
      autoHideMenuBar: true,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: true,
        webSecurity: true, // Enable web security
        allowRunningInsecureContent: false, // Disable insecure content
        preload: AppConfig.preloadPath,
      },
    });

    // Set up CSP headers
    this.setupContentSecurityPolicy();

    // Set up keyboard shortcuts for reload
    this.setupKeyboardShortcuts();

    // Load the frontend URL using the actual port
    // Use localhost for the URL even if server binds to 0.0.0.0 (all interfaces)
    const host = ServerConfig.config.electronServer.host === '0.0.0.0' ? 'localhost' : ServerConfig.config.electronServer.host;
    const frontendUrl = `http://${host}:${this.frontendPort}`;
    log.info(`Loading frontend from: ${frontendUrl}`);
    this.mainWindow.loadURL(frontendUrl);

    // Intercept window close event to hide instead of quit
    this.mainWindow.on('close', (event) => {
      // If we're actually quitting, allow the window to close
      if (this.isQuitting) {
        return;
      }

      // Otherwise, prevent the window from closing
      event.preventDefault();

      // Hide the window instead
      if (this.mainWindow) {
        this.mainWindow.hide();
      }

      log.info('Window hidden to tray');
    });

    // Window closed handler (if actually destroyed)
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  /**
   * Get the first available editor window (for adding tabs)
   */
  getFirstEditorWindow(): BrowserWindow | null {
    const entries = Array.from(this.editorWindows.entries());
    if (entries.length > 0) {
      return entries[0][1];
    }
    return null;
  }

  /**
   * Add a video as a new tab to an existing editor window
   */
  addTabToEditorWindow(editorWindow: BrowserWindow, videoData: { videoId: string; videoPath?: string; videoTitle: string }): void {
    log.info('Adding video as new tab:', videoData.videoId);
    editorWindow.webContents.send('add-editor-tab', videoData);
    // Focus the window
    if (editorWindow.isMinimized()) {
      editorWindow.restore();
    }
    editorWindow.focus();
  }

  /**
   * Create a new editor window for video editing
   * If an editor window already exists, adds the video as a new tab instead
   */
  createEditorWindow(videoData: { videoId: string; videoPath?: string; videoTitle: string }): BrowserWindow {
    // Check if an editor window already exists - add as tab instead
    const existingEditor = this.getFirstEditorWindow();
    if (existingEditor && !existingEditor.isDestroyed()) {
      this.addTabToEditorWindow(existingEditor, videoData);
      return existingEditor;
    }

    const windowId = `editor-${videoData.videoId}-${Date.now()}`;

    // Get icon path
    const iconPath = path.join(AppConfig.appPath, 'assets', 'icon.png');

    const editorWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      autoHideMenuBar: true,
      icon: iconPath,
      title: videoData.videoTitle || 'RippleCut',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: AppConfig.preloadPath,
      },
    });

    // Build the editor URL with query params for the video data
    const host = ServerConfig.config.electronServer.host === '0.0.0.0' ? 'localhost' : ServerConfig.config.electronServer.host;
    const params = new URLSearchParams({
      videoId: videoData.videoId,
      videoTitle: videoData.videoTitle || '',
      ...(videoData.videoPath && { videoPath: videoData.videoPath }),
      popout: 'true'
    });
    const editorUrl = `http://${host}:${this.frontendPort}/editor?${params.toString()}`;

    log.info(`Opening editor window: ${editorUrl}`);
    editorWindow.loadURL(editorUrl);

    // Store reference and assign group number
    this.editorWindows.set(windowId, editorWindow);
    const groupNumber = this.nextGroupNumber++;
    this.editorGroups.set(windowId, groupNumber);
    log.info(`Created editor window ${windowId} as Group ${groupNumber}`);

    // Clean up on close
    editorWindow.on('closed', () => {
      this.editorWindows.delete(windowId);
      this.editorGroups.delete(windowId);
      log.info(`Editor window closed: ${windowId}`);
    });

    // Set up keyboard shortcuts for this window too
    editorWindow.webContents.on('before-input-event', (event, input) => {
      if ((input.meta || input.control) && input.key.toLowerCase() === 'r' && !input.shift) {
        event.preventDefault();
        editorWindow.reload();
      }
      if ((input.meta || input.control) && input.shift && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        editorWindow.webContents.reloadIgnoringCache();
      }
    });

    return editorWindow;
  }

  /**
   * Show error window when backend fails to start
   */
  showBackendErrorWindow(): BrowserWindow {
    
    const errorWindow = new BrowserWindow({
      width: 500,
      height: 300,
      center: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Backend Error',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    
    // Generate a simple HTML error page
    const errorHtml = `
      <html>
        <head>
          <title>Backend Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              margin: 0;
              padding: 20px;
              color: #333;
              background-color: #f5f5f5;
              text-align: center;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              height: 100vh;
            }
            .container {
              background-color: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              width: 100%;
              max-width: 450px;
            }
            h2 { 
              color: #e74c3c;
              margin-top: 0;
            }
            p { 
              line-height: 1.5;
              margin-bottom: 20px;
            }
            button {
              background-color: #3498db;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 4px;
              cursor: pointer;
            }
            button:hover {
              background-color: #2980b9;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Backend Server Error</h2>
            <p>The application encountered an error while starting the backend server.</p>
            <p>This could be because:</p>
            <ul style="text-align: left;">
              <li>Another instance of the application is already running</li>
              <li>Port 3000 is being used by another application</li>
              <li>There was an error during backend initialization</li>
            </ul>
            <p>Please close all instances of this application and try again.</p>
            <button onclick="window.close()">Close Application</button>
          </div>
        </body>
      </html>
    `;

    // Load the HTML content
    errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
    
    // Handle window closed
    errorWindow.on('closed', () => {
      process.exit(0);
    });
    
    return errorWindow;
  }
  
  /**
   * Focus the main window (used when a second instance is launched)
   */
  focusWindow(): void {
    if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.focus();
    }
  }
  
  /**
   * Get all windows
   */
  getAllWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows();
  }
  
  /**
   * Get the main window
   */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /**
   * Get all editor groups
   */
  getEditorGroups(): EditorGroup[] {
    const groups: EditorGroup[] = [];
    for (const [windowId, window] of this.editorWindows.entries()) {
      if (!window.isDestroyed()) {
        const groupNumber = this.editorGroups.get(windowId) || 0;
        groups.push({ groupNumber, windowId, window });
      }
    }
    // Sort by group number
    return groups.sort((a, b) => a.groupNumber - b.groupNumber);
  }

  /**
   * Get group number for a specific window by webContents ID
   */
  getGroupNumberForWindow(webContentsId: number): number | null {
    for (const [windowId, window] of this.editorWindows.entries()) {
      if (!window.isDestroyed() && window.webContents.id === webContentsId) {
        return this.editorGroups.get(windowId) || null;
      }
    }
    return null;
  }

  /**
   * Get editor window by group number
   */
  getEditorWindowByGroup(groupNumber: number): BrowserWindow | null {
    for (const [windowId, window] of this.editorWindows.entries()) {
      if (!window.isDestroyed() && this.editorGroups.get(windowId) === groupNumber) {
        return window;
      }
    }
    return null;
  }

  /**
   * Move a tab to a different group (window)
   */
  moveTabToGroup(tabData: TabMoveData, targetGroupNumber: number, sourceWebContentsId: number): boolean {
    const targetWindow = this.getEditorWindowByGroup(targetGroupNumber);
    if (!targetWindow || targetWindow.isDestroyed()) {
      log.error(`Target group ${targetGroupNumber} not found`);
      return false;
    }

    // Send the tab data to the target window
    targetWindow.webContents.send('receive-tab', tabData);

    // Focus the target window
    if (targetWindow.isMinimized()) {
      targetWindow.restore();
    }
    targetWindow.focus();

    log.info(`Moved tab ${tabData.videoId} to Group ${targetGroupNumber}`);
    return true;
  }

  /**
   * Create a new group (window) with a tab
   */
  createGroupWithTab(tabData: TabMoveData): number {
    const windowId = `editor-${tabData.videoId}-${Date.now()}`;
    const iconPath = path.join(AppConfig.appPath, 'assets', 'icon.png');

    const editorWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      autoHideMenuBar: true,
      icon: iconPath,
      title: tabData.videoTitle || 'RippleCut',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: AppConfig.preloadPath,
      },
    });

    // Build the editor URL with query params
    const host = ServerConfig.config.electronServer.host === '0.0.0.0' ? 'localhost' : ServerConfig.config.electronServer.host;
    const params = new URLSearchParams({
      videoId: tabData.videoId,
      videoTitle: tabData.videoTitle || '',
      ...(tabData.videoPath && { videoPath: tabData.videoPath }),
      popout: 'true'
    });
    const editorUrl = `http://${host}:${this.frontendPort}/editor?${params.toString()}`;

    editorWindow.loadURL(editorUrl);

    // Store reference and assign group number
    this.editorWindows.set(windowId, editorWindow);
    const groupNumber = this.nextGroupNumber++;
    this.editorGroups.set(windowId, groupNumber);

    // Once loaded, send the full tab data to restore state
    editorWindow.webContents.once('did-finish-load', () => {
      // Small delay to ensure Angular is ready
      setTimeout(() => {
        editorWindow.webContents.send('restore-tab-state', tabData);
      }, 500);
    });

    // Clean up on close
    editorWindow.on('closed', () => {
      this.editorWindows.delete(windowId);
      this.editorGroups.delete(windowId);
      log.info(`Editor window closed: ${windowId}`);
    });

    // Set up keyboard shortcuts
    editorWindow.webContents.on('before-input-event', (event, input) => {
      if ((input.meta || input.control) && input.key.toLowerCase() === 'r' && !input.shift) {
        event.preventDefault();
        editorWindow.reload();
      }
      if ((input.meta || input.control) && input.shift && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        editorWindow.webContents.reloadIgnoringCache();
      }
    });

    log.info(`Created new Group ${groupNumber} with tab ${tabData.videoId}`);
    return groupNumber;
  }

  /**
   * Consolidate all groups into the lowest-numbered group
   */
  consolidateGroups(): void {
    const groups = this.getEditorGroups();
    if (groups.length <= 1) {
      log.info('Only one or no groups, nothing to consolidate');
      return;
    }

    // Find the lowest group number (target)
    const targetGroup = groups[0];
    const otherGroups = groups.slice(1);

    log.info(`Consolidating ${otherGroups.length} groups into Group ${targetGroup.groupNumber}`);

    // Request tabs from all other windows
    for (const group of otherGroups) {
      group.window.webContents.send('request-all-tabs', targetGroup.groupNumber);
    }
  }

  /**
   * Set the quitting flag to allow the app to actually quit
   */
  setQuitting(quitting: boolean): void {
    this.isQuitting = quitting;
  }
  
  /**
   * Setup keyboard shortcuts for reload
   */
  private setupKeyboardShortcuts(): void {
    if (!this.mainWindow) return;

    this.mainWindow.webContents.on('before-input-event', (event, input) => {
      // Cmd+R (Mac) or Ctrl+R (Windows/Linux) - Regular reload
      if ((input.meta || input.control) && input.key.toLowerCase() === 'r' && !input.shift) {
        event.preventDefault();
        log.info('Reloading window (Cmd/Ctrl+R)');
        this.mainWindow?.reload();
      }

      // Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows/Linux) - Hard reload (ignore cache)
      if ((input.meta || input.control) && input.shift && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        log.info('Hard reloading window (Cmd/Ctrl+Shift+R)');
        this.mainWindow?.webContents.reloadIgnoringCache();
      }
    });
  }

  /**
   * Setup Content Security Policy
   */
  private setupContentSecurityPolicy(): void {
    if (!this.mainWindow) return;

    // Import environment config
    const { environmentConfig } = require('../config/environment');
    const { security } = environmentConfig;

    this.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      let cspPolicy: string;

      // Both development and production need localhost access since the packaged app
      // runs frontend and backend on localhost with different ports
      const localhostSrc = "http://localhost:* ws://localhost:*";

      if (!security.csp.enableStrictCSP) {
        // Development: Relaxed CSP for hot-reload and debugging
        cspPolicy = "default-src 'self'; " +
          `script-src 'self'${security.csp.allowUnsafeInline ? " 'unsafe-inline'" : ""}${security.csp.allowUnsafeEval ? " 'unsafe-eval'" : ""}; ` +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          `img-src 'self' ${localhostSrc} data: blob:; ` +
          `connect-src 'self' ${localhostSrc}; ` +
          `media-src 'self' ${localhostSrc} blob:;`;
      } else {
        // Production: Strict CSP but still allow localhost since app runs locally
        cspPolicy = "default-src 'self'; " +
          "script-src 'self'; " +  // No unsafe-inline or unsafe-eval in production
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +  // Keep unsafe-inline for Angular styles
          "font-src 'self' https://fonts.gstatic.com; " +
          `img-src 'self' ${localhostSrc} data: blob:; ` +
          `connect-src 'self' ${localhostSrc}; ` +  // Allow localhost for backend API/WebSocket
          `media-src 'self' ${localhostSrc} blob:;`;
      }

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': cspPolicy
        }
      });
    });
  }
  
  /**
   * Setup debug event handlers (only in development mode)
   */
  private setupDebugEventHandlers(): void {
    if (!this.mainWindow) return;
    
    this.mainWindow.webContents.on('did-start-loading', () => 
      log.info('Started loading'));
      
    this.mainWindow.webContents.on('did-stop-loading', () => 
      log.info('Stopped loading'));
      
    this.mainWindow.webContents.on('did-finish-load', () => 
      log.info('Finished loading'));
      
    this.mainWindow.webContents.on('did-fail-load', (_, code, desc) => 
      log.info(`Failed loading: ${code} ${desc}`));
      
    this.mainWindow.webContents.on('crashed' as any, () => 
      log.info('Renderer crashed'));
      
    this.mainWindow.webContents.on('unresponsive', () => 
      log.info('Window unresponsive'));

    // Log console messages from the renderer
    this.mainWindow.webContents.on('console-message', (_, level, message, line, sourceId) => {
      const levelNames = ['debug', 'info', 'warning', 'error', 'log'];
      const levelName = levelNames[level] || 'unknown';
      log.info(`Console [${levelName}]: ${message} (${sourceId}:${line})`);
    });
  }
}