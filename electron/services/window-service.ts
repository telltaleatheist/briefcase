// clippy/electron/services/window-service.ts
import { BrowserWindow, shell } from 'electron';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';
import { ServerConfig } from '../config/server-config';

/**
 * Window management service
 * Handles creation and management of all application windows
 */
export class WindowService {
  private mainWindow: BrowserWindow | null = null;
  
  /**
   * Create the main application window
   */
  createMainWindow(): BrowserWindow {
    log.info('Creating main application window...');

    this.mainWindow = new BrowserWindow({
      width: 800,
      height: 1000,
      minWidth: 800,  // Reasonable minimum width
      minHeight: 600, // Reasonable minimum height
      autoHideMenuBar: true,
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
    
    // Set up event handlers for debugging in development mode
    if (AppConfig.isDevelopment) {
      this.setupDebugEventHandlers();
    }
    
    // Load the frontend URL
    this.mainWindow.loadURL(ServerConfig.frontendUrl);

    // Window close handler
    this.mainWindow.on('closed', () => {
      log.info('Main window closed');
      this.mainWindow = null;
    });
    
    return this.mainWindow;
  }
  
  /**
   * Show error window when backend fails to start
   */
  showBackendErrorWindow(): BrowserWindow {
    log.info('Showing backend error window');
    
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
      log.info('Error window closed, quitting application');
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
   * Setup Content Security Policy
   */
  private setupContentSecurityPolicy(): void {
    if (!this.mainWindow) return;
    
    this.mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "font-src 'self' https://fonts.gstatic.com; " +
            "connect-src 'self' http://localhost:3000 http://localhost:8080 ws://localhost:3000 ws://localhost:8080;"
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