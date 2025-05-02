// clippy/electron/utils/error-windows.ts
import { BrowserWindow, app } from 'electron';
import * as log from 'electron-log';

/**
 * Utility for creating error windows
 */
export class ErrorWindows {
  /**
   * Create a window to show backend errors
   */
  static createBackendErrorWindow(): BrowserWindow {
    log.info('Creating backend error window');
    
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
    
    // HTML content for error window
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
      app.quit();
    });
    
    return errorWindow;
  }
  
  /**
   * Create a window to show configuration errors
   */
  static createConfigErrorWindow(message: string): BrowserWindow {
    log.info('Creating configuration error window');
    
    const errorWindow = new BrowserWindow({
      width: 500,
      height: 300,
      center: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Configuration Error',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    
    // HTML content for error window
    const errorHtml = `
      <html>
        <head>
          <title>Configuration Error</title>
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
            <h2>Configuration Error</h2>
            <p>${message}</p>
            <p>Please restart the application and try again.</p>
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
      app.quit();
    });
    
    return errorWindow;
  }
}