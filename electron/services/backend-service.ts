// clippy/electron/services/backend-service.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { Server } from 'http';
import * as log from 'electron-log';
import { spawn, ChildProcess } from 'child_process';
import { AppConfig } from '../config/app-config';
import { ServerConfig } from '../config/server-config';
import { PortUtil } from '../utilities/port-util';

/**
 * Backend server management service
 * Handles starting, stopping, and communicating with the NestJS backend
 */
export class BackendService {
  private backendProcess: ChildProcess | null = null;
  private server: Server | null = null;
  private backendStarted: boolean = false;
  private lockFilePath: string;
  private actualBackendPort: number = 3000;
  private actualFrontendPort: number = 8080;

  constructor() {
    this.lockFilePath = path.join(app.getPath('userData'), 'backend.lock');
  }
  
  /**
   * Start the backend server and HTTP server
   */
  async startBackendServer(): Promise<boolean> {

    // If backend already started, return true
    if (this.backendStarted) {
      return true;
    }

    // Check if lock file exists and is recent (less than 10 seconds old)
    if (fs.existsSync(this.lockFilePath)) {
      const stats = fs.statSync(this.lockFilePath);
      const fileAge = Date.now() - stats.mtimeMs;

      if (fileAge < 10000) {  // 10 seconds
        log.info('Recent lock file found. Attempting to clean up stale processes...');
        // Try to free the port instead of failing
        const backendPortFreed = await PortUtil.attemptToFreePort(ServerConfig.config.nestBackend.port);
        const frontendPortFreed = await PortUtil.attemptToFreePort(ServerConfig.config.electronServer.port);

        if (backendPortFreed && frontendPortFreed) {
          log.info('Successfully freed ports, continuing with startup');
          fs.unlinkSync(this.lockFilePath);
        } else {
          log.warn('Could not free ports, will try alternative ports');
        }
      } else {
        fs.unlinkSync(this.lockFilePath);
      }
    }

    // Find available ports
    const backendPort = await PortUtil.findAvailablePort(ServerConfig.config.nestBackend.port, 10);
    const frontendPort = await PortUtil.findAvailablePort(ServerConfig.config.electronServer.port, 10);

    if (!backendPort || !frontendPort) {
      log.error('Could not find available ports for backend and frontend servers');
      return false;
    }

    this.actualBackendPort = backendPort;
    this.actualFrontendPort = frontendPort;

    if (backendPort !== ServerConfig.config.nestBackend.port) {
      log.info(`Using alternative backend port: ${backendPort} (default ${ServerConfig.config.nestBackend.port} was in use)`);
    }

    if (frontendPort !== ServerConfig.config.electronServer.port) {
      log.info(`Using alternative frontend port: ${frontendPort} (default ${ServerConfig.config.electronServer.port} was in use)`);
    }

    // Create lock file
    try {
      fs.writeFileSync(this.lockFilePath, new Date().toString());
    } catch (err) {
      log.warn(`Could not create lock file: ${err}`);
    }

    try {
      const success = await this.startNodeBackend();
      await this.startHttpServer();

      this.backendStarted = true;
      await new Promise(resolve => setTimeout(resolve, 3000));

      const isRunning = await this.checkBackendRunning();

      if (isRunning) {
        log.info(`Backend successfully started on port ${this.actualBackendPort}`);
        log.info(`Frontend server successfully started on port ${this.actualFrontendPort}`);
      }

      return isRunning;

    } catch (error) {
      log.error('Error starting backend servers:', error);
      // Clean up lock file on failure
      if (fs.existsSync(this.lockFilePath)) {
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch (err) {
          // Ignore
        }
      }
      return false;
    }
  }

  /**
   * Check if backend is running on the actual port being used
   */
  private async checkBackendRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: ServerConfig.config.nestBackend.host,
        port: this.actualBackendPort,
        path: '/api',
        method: 'GET',
        timeout: 2000
      }, (res) => {
        log.info(`Backend check response status: ${res.statusCode}`);
        resolve(res.statusCode === 200);
      });

      req.on('error', (err) => {
        log.error(`Backend check error: ${err.message}`);
        resolve(false);
      });

      req.on('timeout', () => {
        log.error('Backend check timeout');
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  /**
   * Get the actual backend port being used
   */
  getBackendPort(): number {
    return this.actualBackendPort;
  }

  /**
   * Get the actual frontend port being used
   */
  getFrontendPort(): number {
    return this.actualFrontendPort;
  }
  
  /**
   * Start the Node.js backend (NestJS)
   */
  private async startNodeBackend(): Promise<boolean> {
    try {
      // Get backend path
      const backendPath = AppConfig.backendPath;
      
      // If backend doesn't exist, return false
      if (!fs.existsSync(backendPath)) {
        log.error(`Backend server not found at: ${backendPath}`);
        return false;
      }
      
      const nodePath = process.execPath;
      const frontendPath = AppConfig.frontendPath;
      
      const backendEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLIPPY_BACKEND: 'true',
        FRONTEND_PATH: frontendPath,
        NODE_PATH: path.join(process.resourcesPath, 'backend/node_modules'),
        PORT: this.actualBackendPort.toString(),
        NODE_ENV: 'production',
        APP_ROOT: process.resourcesPath,
        VERBOSE: 'true'
      };
      
      this.backendProcess = spawn(nodePath, [backendPath], {
        env: backendEnv,
        stdio: 'pipe',
      });
      
      this.setupProcessEventHandlers();
      
      return true;
      
    } catch (error) {
      log.error('Error starting Node.js backend:', error);
      return false;
    }
  }
  
  /**
   * Start the HTTP server for serving frontend
   */
  private async startHttpServer(): Promise<void> {
    // Get frontend path
    const frontendPath = AppConfig.frontendPath;
    const serverConfig = ServerConfig.config;
    
    this.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url || '/';
      
      if (url.startsWith('/api/') || url.includes('/socket.io/')) {
        
        const proxyOptions = {
          hostname: serverConfig.nestBackend.host,
          port: this.actualBackendPort,
          path: url,
          method: req.method,
          headers: {
            ...req.headers,
            'Host': `${serverConfig.nestBackend.host}:${this.actualBackendPort}`
          }
        };

        const proxyReq = http.request(proxyOptions, (proxyRes) => {
          // Set CORS headers
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        });
      
        req.pipe(proxyReq);
      
        proxyReq.on('error', (err) => {
          log.error(`[HTTP Server] Proxy error for ${url}: ${err.message}`);
          
          // Error page for API requests
          res.writeHead(503, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head>
                <title>Service Unavailable</title>
                <style>
                  body {
                    font-family: Arial, sans-serif;
                    text-align: center;
                    padding: 50px;
                    background-color: #f5f5f5;
                  }
                  .error-container {
                    background-color: white;
                    border-radius: 8px;
                    padding: 30px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                    max-width: 500px;
                    margin: 0 auto;
                  }
                  h1 { color: #e74c3c; }
                  p { color: #333; line-height: 1.5; }
                  button {
                    background-color: #3498db;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-top: 20px;
                    font-size: 14px;
                  }
                  button:hover { background-color: #2980b9; }
                </style>
              </head>
              <body>
                <div class="error-container">
                  <h1>Connection Error</h1>
                  <p>Unable to connect to the backend service. This is typically because the backend server isn't running.</p>
                  <p>Please make sure the backend server is started before using the application.</p>
                  <button onclick="window.location.reload()">Retry Connection</button>
                </div>
              </body>
            </html>
          `);
        });
        
        return;
      }

      // Serve static frontend files
      let filePath = path.join(frontendPath, url === '/' ? 'index.html' : url);

      if (fs.existsSync(filePath)) {
        if (fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }
        
        if (fs.existsSync(filePath)) {
                
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          
          // Set content type based on file extension
          let contentType = 'text/html';
          if (ext === '.js') contentType = 'application/javascript';
          if (ext === '.css') contentType = 'text/css';
          if (ext === '.ico') contentType = 'image/x-icon';
          if (ext === '.png') contentType = 'image/png';
          if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
          if (ext === '.svg') contentType = 'image/svg+xml';
          
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
          return;
        }
      }
      
      // Fallback to serving index.html for client-side routing
      
      const indexPath = path.join(frontendPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    // Handle server errors
    this.server.on('error', (err) => {
      log.error(`HTTP server error: ${err.message}`);
    });

    // Start HTTP server
    this.server.listen(this.actualFrontendPort, serverConfig.electronServer.host, () => {
      log.info(`HTTP server listening on ${serverConfig.electronServer.host}:${this.actualFrontendPort}`);
    });
  }

  /**
   * Set up event handlers for the backend process
   */
  private setupProcessEventHandlers(): void {
    if (!this.backendProcess) return;
    
    // Handle stdout - only log important messages, skip verbose progress updates
    if (this.backendProcess.stdout) {
      this.backendProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString().trim();

        // Skip routine progress logging (only log errors, warnings, or important info)
        // Suppress "Python progress:" messages unless they're important milestones
        if (output.includes('Python progress:')) {
          // Only log major phase changes or important milestones
          if (output.includes('Starting') ||
              output.includes('complete') ||
              output.includes('Failed') ||
              output.includes('Error')) {
            log.info(`[Backend]: ${output}`);
          }
          // Skip routine "Analyzing chunk X/Y" messages
        } else {
          // Log all non-progress messages
          log.info(`[Backend]: ${output}`);
        }
      });
    } else {
      log.warn('Backend stdout stream is not available');
    }
  
    // Handle stderr
    if (this.backendProcess.stderr) {
      this.backendProcess.stderr.on('data', (data: Buffer) => {
        log.error(`[Backend stderr]: ${data.toString().trim()}`);
      });
    } else {
      log.warn('Backend stderr stream is not available');
    }
  
    // Handle process errors
    this.backendProcess.on('error', (err: Error) => {
      log.error(`[Backend process error]: ${err.message}`);
    });
  
    // Handle process exit
    this.backendProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      log.error(`[Backend process exited] code: ${code}, signal: ${signal}`);
    });
  
    // Handle process close
    this.backendProcess.on('close', (code: number | null) => {
      log.error(`[Backend process closed] code: ${code}`);
    });
  }
  
  /**
   * Check if the backend is running
   */
  isRunning(): boolean {
    return this.backendStarted;
  }
  
  /**
   * Shutdown the backend server
   */
  shutdown(): void {
    if (fs.existsSync(this.lockFilePath)) {
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch (err) {
        log.warn(`Error removing lock file: ${err}`);
      }
    }
    
    // Stop HTTP server
    if (this.server) {
      try {
        this.server.close();
      } catch (err) {
        log.warn(`Error closing HTTP server: ${err}`);
      }
    }
    
    // Kill backend process
    if (this.backendProcess && !this.backendProcess.killed) {
      // On Windows, we need to kill the process group since it's detached
      if (process.platform === 'win32' && this.backendProcess.pid) {
        try {
          process.kill(-this.backendProcess.pid, 'SIGTERM');
        } catch (err) {
          log.warn(`Error killing process group: ${err}`);
        }
      }
      
      try {
        this.backendProcess.kill();
      } catch (err) {
        log.warn(`Error killing backend process: ${err}`);
      }
    }
  }
}