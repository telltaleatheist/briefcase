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

/**
 * Backend server management service
 * Handles starting, stopping, and communicating with the NestJS backend
 */
export class BackendService {
  private backendProcess: ChildProcess | null = null;
  private server: Server | null = null;
  private backendStarted: boolean = false;
  private lockFilePath: string;
  
  constructor() {
    this.lockFilePath = path.join(app.getPath('userData'), 'backend.lock');
  }
  
  /**
   * Start the backend server and HTTP server
   */
  async startBackendServer(): Promise<boolean> {
    log.info('Starting backend servers...');
    
    // If backend already started, return true
    if (this.backendStarted) {
      log.info('Backend already started. Skipping.');
      return true;
    }
    
    // Check if lock file exists and is recent (less than 10 seconds old)
    if (fs.existsSync(this.lockFilePath)) {
      const stats = fs.statSync(this.lockFilePath);
      const fileAge = Date.now() - stats.mtimeMs;
      
      if (fileAge < 10000) {  // 10 seconds
        log.info('Recent lock file found. Another backend instance may be running.');
        return false;
      } else {
        fs.unlinkSync(this.lockFilePath);
      }
    }
    
    // Create lock file
    try {
      fs.writeFileSync(this.lockFilePath, new Date().toString());
    } catch (err) {
      log.error('Failed to create lock file:', err);
    }
    
    try {
      // Start the Node.js backend (NestJS)
      const success = await this.startNodeBackend();
      
      if (!success) {
        log.warn('Failed to start Node.js backend, falling back to HTTP server only');
      }
      
      // Start the HTTP server for frontend regardless of backend status
      await this.startHttpServer();
      
      // Mark backend as started
      this.backendStarted = true;
      
      // Wait for backend to initialize
      log.info('Waiting for backend to initialize...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check if backend is running
      const isRunning = await ServerConfig.isBackendRunning();
      log.info(`Backend server status check: ${isRunning ? 'RUNNING' : 'NOT RUNNING'}`);
      
      return isRunning;
      
    } catch (error) {
      log.error('Error starting backend servers:', error);
      return false;
    }
  }
  
  /**
   * Start the Node.js backend (NestJS)
   */
  private async startNodeBackend(): Promise<boolean> {
    try {
      // Get backend path
      const backendPath = AppConfig.backendPath;
      log.info(`Backend entry point: ${backendPath} (exists: ${fs.existsSync(backendPath)})`);
      
      // If backend doesn't exist, return false
      if (!fs.existsSync(backendPath)) {
        log.error(`Backend server not found at: ${backendPath}`);
        return false;
      }
      
      // Get Node.js executable
      const nodePath = process.execPath;
      log.info(`Using Node.js executable: ${nodePath}`);
      
      // Get frontend path for backend to serve
      const frontendPath = AppConfig.frontendPath;
      log.info(`Frontend path for backend: ${frontendPath} (exists: ${fs.existsSync(frontendPath)})`);
      
      // Create environment for backend process
      const backendEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLIPPY_BACKEND: 'true',
        FRONTEND_PATH: frontendPath,
        NODE_PATH: path.join(process.resourcesPath, 'backend/node_modules'),
        PORT: ServerConfig.config.nestBackend.port.toString(),
        NODE_ENV: AppConfig.isDevelopment ? 'development' : 'production',
        APP_ROOT: process.resourcesPath,
        VERBOSE: 'true'
      };
      
      // Log environment variables
      log.info('Environment variables for backend process:');
      log.info(`- FRONTEND_PATH: ${backendEnv.FRONTEND_PATH}`);
      log.info(`- NODE_ENV: ${backendEnv.NODE_ENV}`);
      log.info(`- PORT: ${backendEnv.PORT}`);
      
      // Spawn backend process
      this.backendProcess = spawn(nodePath, [backendPath], {
        env: backendEnv,
        stdio: 'pipe',
      });
      
      log.info(`Backend process spawned with PID: ${this.backendProcess.pid}`);
      
      // Set up process event handlers
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
    
    log.info(`Starting HTTP server to serve frontend from: ${frontendPath}`);
    
    // Create HTTP server
    this.server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url || '/';
      
      log.info(`[HTTP Server] Received request: ${url}`);
      
      // Proxy API and socket.io routes to NestJS
      if (url.startsWith('/api/') || url.includes('/socket.io/')) {
        log.info(`[HTTP Server] Proxying request to backend: ${url}`);
        
        const proxyOptions = {
          hostname: serverConfig.nestBackend.host,
          port: serverConfig.nestBackend.port,
          path: url,
          method: req.method,
          headers: {
            ...req.headers,
            'Host': `${serverConfig.nestBackend.host}:${serverConfig.nestBackend.port}`
          }
        };

        const proxyReq = http.request(proxyOptions, (proxyRes) => {
          // Set CORS headers
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
          log.info(`[HTTP Server] Proxy response for ${url}: ${proxyRes.statusCode}`);
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
      log.info(`[HTTP Server] Checking for file: ${filePath}`);

      if (fs.existsSync(filePath)) {
        if (fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }
        
        if (fs.existsSync(filePath)) {
          log.info(`[HTTP Server] Serving file: ${filePath}`);
                
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
      log.info(`[HTTP Server] File not found: ${filePath}, falling back to index.html`);
      
      const indexPath = path.join(frontendPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        log.info(`[HTTP Server] Serving index.html as fallback`);
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } else {
        log.error(`[HTTP Server] Index.html not found at: ${indexPath}`);
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    // Handle server errors
    this.server.on('error', (err) => {
      log.error(`HTTP server error: ${err.message}`);
    });

    // Start HTTP server
    this.server.listen(serverConfig.electronServer.port, serverConfig.electronServer.host, () => {
      log.info(`HTTP Server started on ${serverConfig.electronServer.host}:${serverConfig.electronServer.port}`);
    });
  }

  /**
   * Set up event handlers for the backend process
   */
  private setupProcessEventHandlers(): void {
    if (!this.backendProcess) return;
    
    // Handle stdout
    if (this.backendProcess.stdout) {
      this.backendProcess.stdout.on('data', (data: Buffer) => {
        log.info(`[Backend stdout]: ${data.toString().trim()}`);
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
    log.info('Shutting down backend server...');
    
    // Clean up lock file
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