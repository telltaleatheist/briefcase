// ClipChimp/electron/services/backend-service.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as log from 'electron-log';
import { spawn, ChildProcess } from 'child_process';
import * as lockfile from 'proper-lockfile';
import { AppConfig } from '../config/app-config';
import { ServerConfig } from '../config/server-config';
import { PortUtil } from '../utilities/port-util';

// Import runtime paths for binary locations - lazy loaded to avoid issues with app not being ready
let _runtimePathsCache: any = null;
function getRuntimePaths(): any {
  if (_runtimePathsCache) {
    return _runtimePathsCache;
  }

  try {
    // In packaged app, runtime-paths is in resources/dist-electron/shared/
    // In development, it's built to dist-electron/shared/
    // This file compiles to dist-electron/electron/services/backend-service.js
    // From there: ../../shared/runtime-paths goes to dist-electron/shared/runtime-paths
    // (one level up to electron/, another level up to dist-electron/, then into shared/)
    if (app && app.isPackaged) {
      const runtimePathsFile = path.join(process.resourcesPath!, 'dist-electron', 'shared', 'runtime-paths.js');
      _runtimePathsCache = require(runtimePathsFile).getRuntimePaths();
    } else {
      _runtimePathsCache = require('../../shared/runtime-paths').getRuntimePaths();
    }
  } catch (error) {
    log.warn('runtime-paths not available, will use environment variables:', error);
    _runtimePathsCache = { ffmpeg: '', ffprobe: '', ytdlp: '', python: '' };
  }

  return _runtimePathsCache;
}

/**
 * Backend server management service
 * Handles starting, stopping, and communicating with the NestJS backend
 */
export class BackendService {
  private backendProcess: ChildProcess | null = null;
  private backendStarted: boolean = false;
  private lockFilePath: string;
  private lockRelease: (() => Promise<void>) | null = null;
  private actualBackendPort: number = 3000;

  constructor() {
    this.lockFilePath = path.join(app.getPath('userData'), 'backend.lock');
  }
  
  /**
   * Kill any stale backend processes from previous runs
   */
  private async killStaleBackends(): Promise<void> {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);

      if (process.platform === 'win32') {
        // Windows: Kill node processes running dist/main.js
        try {
          await execPromise('taskkill /F /IM node.exe /FI "WINDOWTITLE eq dist/main.js*"');
        } catch (err) {
          // Ignore errors - might not find any processes
        }
      } else {
        // Unix-like: Kill node/electron processes running dist/main.js
        try {
          await execPromise('pkill -9 -f "node.*dist/main.js" || true');
          await execPromise('pkill -9 -f "Electron.*dist/main.js" || true');
        } catch (err) {
          // Ignore errors - might not find any processes
        }
      }

      log.info('Cleaned up any stale backend processes');
    } catch (err) {
      log.warn(`Error cleaning up stale backends: ${err}`);
    }
  }

  /**
   * Start the backend server and HTTP server
   */
  async startBackendServer(): Promise<boolean> {

    // If backend already started, return true
    if (this.backendStarted) {
      return true;
    }

    // Kill any stale backend processes from previous runs
    await this.killStaleBackends();

    // Try to acquire lock using proper-lockfile
    try {
      // Check if lock file exists and try to break stale locks
      if (fs.existsSync(this.lockFilePath)) {
        try {
          const isLocked = await lockfile.check(this.lockFilePath);
          if (isLocked) {
            log.warn('Lock file is held, attempting to clean up stale processes...');
            // Try to free the port instead of failing
            const backendPortFreed = await PortUtil.attemptToFreePort(ServerConfig.config.nestBackend.port);
            const frontendPortFreed = await PortUtil.attemptToFreePort(ServerConfig.config.electronServer.port);

            if (backendPortFreed && frontendPortFreed) {
              log.info('Successfully freed ports, breaking stale lock');
              // Release the stale lock
              await lockfile.unlock(this.lockFilePath).catch(() => {
                // If unlock fails, remove the lock file manually
                try {
                  fs.unlinkSync(this.lockFilePath);
                } catch (err) {
                  log.warn('Could not remove lock file:', err);
                }
              });
            }
          }
        } catch (err) {
          log.warn('Error checking lock file:', err);
        }
      }
    } catch (err) {
      log.warn('Error during lock acquisition setup:', err);
    }

    // Find available port for backend
    const backendPort = await PortUtil.findAvailablePort(ServerConfig.config.nestBackend.port, 10);

    if (!backendPort) {
      log.error('Could not find available port for backend server');
      return false;
    }

    this.actualBackendPort = backendPort;

    if (backendPort !== ServerConfig.config.nestBackend.port) {
      log.info(`Using alternative backend port: ${backendPort} (default ${ServerConfig.config.nestBackend.port} was in use)`);
    }

    // Acquire lock file atomically
    try {
      // Ensure the lock file exists before locking
      if (!fs.existsSync(this.lockFilePath)) {
        fs.writeFileSync(this.lockFilePath, '');
      }

      this.lockRelease = await lockfile.lock(this.lockFilePath, {
        retries: {
          retries: 3,
          minTimeout: 100,
          maxTimeout: 1000
        },
        stale: 10000, // Consider lock stale after 10 seconds
        update: 2000  // Update lock every 2 seconds
      });
      log.info('Successfully acquired backend lock');
    } catch (err) {
      log.error(`Could not acquire lock file: ${err}`);
      return false;
    }

    try {
      await this.startNodeBackend();

      // Wait for backend ready signal with exponential backoff
      const isRunning = await this.waitForBackendReady();

      if (isRunning) {
        log.info(`✓ Backend successfully started on port ${this.actualBackendPort}`);
        log.info(`✓ Frontend is served directly from backend`);
        this.backendStarted = true;
      } else {
        log.error('Backend failed to start - cleaning up processes');
        await this.cleanup();
      }

      return isRunning;

    } catch (error) {
      log.error('Error starting backend servers:', error);
      await this.cleanup();
      return false;
    }
  }

  /**
   * Wait for backend to be ready using HTTP health checks with exponential backoff
   * This is the standard approach for Electron apps with HTTP backends
   */
  private async waitForBackendReady(): Promise<boolean> {
    const maxAttempts = 40; // Max 40 attempts (~25 seconds total)
    let delay = 100; // Start with 100ms
    const maxDelay = 1000; // Cap at 1 second per attempt

    log.info('Waiting for backend to be ready...');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check immediately on first attempt, then wait
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, maxDelay); // Exponential backoff
      }

      // HTTP health check - standard approach
      const isReady = await this.checkBackendRunning();

      if (isReady) {
        log.info(`✓ Backend ready after ${attempt + 1} attempt(s)`);
        return true;
      }

      // Log progress every 5 attempts
      if (attempt > 0 && attempt % 5 === 0) {
        log.info(`Still waiting for backend (attempt ${attempt + 1}/${maxAttempts})...`);
      }
    }

    log.error('Backend failed to respond after maximum attempts');
    return false;
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
        timeout: 5000
      }, (res) => {
        // Silently check status - don't log every attempt
        resolve(res.statusCode === 200);
      });

      req.on('error', () => {
        // Expected during startup - silently fail
        resolve(false);
      });

      req.on('timeout', () => {
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
   * Get the full backend URL with the actual port
   * Note: Uses localhost if host is 0.0.0.0 since that's for binding, not connecting
   */
  getBackendUrl(): string {
    const host = ServerConfig.config.nestBackend.host;
    const connectHost = host === '0.0.0.0' ? 'localhost' : host;
    return `http://${connectHost}:${this.actualBackendPort}`;
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

      // Use environment variable if already set (for test mode), otherwise use process.resourcesPath
      const resourcesPath = process.env.RESOURCES_PATH || process.resourcesPath;

      // Get the backend node_modules path - handle both development and production
      const backendDir = path.dirname(path.dirname(backendPath)); // Go up from dist/main.js to backend/
      const backendNodeModules = path.join(backendDir, 'node_modules');

      log.info(`Backend path: ${backendPath}`);
      log.info(`Backend directory: ${backendDir}`);
      log.info(`Backend node_modules: ${backendNodeModules}`);
      log.info(`Node modules exists: ${fs.existsSync(backendNodeModules)}`);

      // Get binary paths from runtime-paths
      const runtimePaths = getRuntimePaths();
      log.info(`Binary paths: ffmpeg=${runtimePaths.ffmpeg}, ffprobe=${runtimePaths.ffprobe}, ytdlp=${runtimePaths.ytdlp}`);

      // Determine FFmpeg/FFprobe paths - prioritize runtime paths, then env vars, then backend node_modules installers
      let ffmpegPath = runtimePaths.ffmpeg || process.env.FFMPEG_PATH;
      let ffprobePath = runtimePaths.ffprobe || process.env.FFPROBE_PATH;

      // If not provided, look for them in backend's node_modules
      if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        const platformFolder = process.platform === 'win32' ? 'win32-x64' :
                              (process.platform === 'darwin' ?
                                (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64') :
                                'linux-x64');
        const ffmpegInstaller = path.join(backendNodeModules, '@ffmpeg-installer', platformFolder,
                                         process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
        if (fs.existsSync(ffmpegInstaller)) {
          ffmpegPath = ffmpegInstaller;
          log.info(`Using FFmpeg from backend node_modules: ${ffmpegPath}`);
        }
      }

      if (!ffprobePath || !fs.existsSync(ffprobePath)) {
        const platformFolder = process.platform === 'win32' ? 'win32-x64' :
                              (process.platform === 'darwin' ?
                                (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64') :
                                'linux-x64');
        const ffprobeInstaller = path.join(backendNodeModules, '@ffprobe-installer', platformFolder,
                                          process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        if (fs.existsSync(ffprobeInstaller)) {
          ffprobePath = ffprobeInstaller;
          log.info(`Using FFprobe from backend node_modules: ${ffprobePath}`);
        }
      }

      const backendEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLIPCHIMP_BACKEND: 'true',
        FRONTEND_PATH: frontendPath,
        NODE_PATH: backendNodeModules,
        RESOURCES_PATH: resourcesPath,
        PORT: this.actualBackendPort.toString(),
        NODE_ENV: process.env.NODE_ENV || 'production',
        APP_ROOT: resourcesPath,
        VERBOSE: 'true',
        // Set binary paths for backend to use
        FFMPEG_PATH: ffmpegPath,
        FFPROBE_PATH: ffprobePath,
        YT_DLP_PATH: runtimePaths.ytdlp || process.env.YT_DLP_PATH,
        // whisper.cpp paths (standalone binary - no Python needed!)
        WHISPER_CPP_PATH: runtimePaths.whisperCpp || process.env.WHISPER_CPP_PATH,
        WHISPER_MODEL_PATH: runtimePaths.whisperModel || process.env.WHISPER_MODEL_PATH,
        PYTHON_PATH: runtimePaths.python || process.env.PYTHON_PATH,
      };
      
      // Set the working directory to the backend directory for proper module resolution
      const workingDir = backendDir;
      log.info(`Starting backend with working directory: ${workingDir}`);

      this.backendProcess = spawn(nodePath, [backendPath], {
        env: backendEnv,
        stdio: 'pipe',
        cwd: workingDir
      });
      
      this.setupProcessEventHandlers();
      
      return true;
      
    } catch (error) {
      log.error('Error starting Node.js backend:', error);
      return false;
    }
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
   * Clean up backend resources (processes, servers, lock files)
   */
  private async cleanup(): Promise<void> {
    log.info('Cleaning up backend resources...');

    // Release lock file properly using proper-lockfile
    if (this.lockRelease) {
      try {
        await this.lockRelease();
        log.info('Released backend lock during cleanup');
      } catch (err) {
        log.warn('Error releasing lock during cleanup:', err);
        // Fallback: try to delete the lock file manually
        if (fs.existsSync(this.lockFilePath)) {
          try {
            fs.unlinkSync(this.lockFilePath);
          } catch (unlinkErr) {
            log.warn(`Error removing lock file: ${unlinkErr}`);
          }
        }
      }
      this.lockRelease = null;
    } else if (fs.existsSync(this.lockFilePath)) {
      // No release function available, try manual delete
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch (err) {
        log.warn(`Error removing lock file: ${err}`);
      }
    }

    // Kill backend process
    if (this.backendProcess && !this.backendProcess.killed) {
      try {
        // Try graceful shutdown first
        this.backendProcess.kill('SIGTERM');

        // Wait for graceful shutdown (up to 2 seconds)
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (this.backendProcess && !this.backendProcess.killed) {
              log.warn('Backend process did not exit gracefully, forcing kill...');
              this.backendProcess.kill('SIGKILL');
            }
            resolve();
          }, 2000);

          if (this.backendProcess) {
            this.backendProcess.once('exit', () => {
              clearTimeout(timeout);
              resolve();
            });
          }
        });
      } catch (err) {
        log.warn(`Error killing backend process: ${err}`);
      }
    }

    this.backendStarted = false;
  }
  
  /**
   * Shutdown the backend server
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down backend service...');

    // Save PID before cleanup clears it
    const pid = this.backendProcess?.pid;

    await this.cleanup();

    // Additional force kill for the specific PID if cleanup didn't fully terminate it
    if (pid) {
      // On Windows, kill the process group
      if (process.platform === 'win32') {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (err) {
          // Process may already be dead, which is fine
        }
      } else {
        // On Unix-like systems, try to force kill the specific PID
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          // Process may already be dead, which is fine
        }
      }
    }

    this.backendProcess = null;
  }
}