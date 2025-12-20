// ClipChimp/electron/services/window-service.ts
import { BrowserWindow, shell } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import { AppConfig } from '../config/app-config';
import { ServerConfig } from '../config/server-config';

/**
 * Window management service
 * Handles creation and management of all application windows
 */
export class WindowService {
  private mainWindow: BrowserWindow | null = null;
  private editorWindows: Map<string, BrowserWindow> = new Map();
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
   * Create a new editor window for video editing
   * Opens the editor in a separate window with the given video data
   */
  createEditorWindow(videoData: { videoId: string; videoPath?: string; videoTitle: string }): BrowserWindow {
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

    // Store reference
    this.editorWindows.set(windowId, editorWindow);

    // Clean up on close
    editorWindow.on('closed', () => {
      this.editorWindows.delete(windowId);
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