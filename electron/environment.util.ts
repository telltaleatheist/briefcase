// ClipChimp/electron/environment.util.ts
// SIMPLIFIED: Removed config persistence code - using bundled binaries via runtime-paths
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import log from 'electron-log';

export const DEFAULT_SERVER_CONFIG = {
  nestBackend: {
    port: 3000,
    host: '0.0.0.0'  // Bind to all interfaces for remote access
  },
  electronServer: {
    port: 3001,
    host: '0.0.0.0'  // Bind to all interfaces for remote access
  }
};

// Interface for server configuration
export interface ServerConfig {
  nestBackend: {
    port: number;
    host: string;
  };
  electronServer: {
    port: number;
    host: string;
  };
}

export class EnvironmentUtil {
  private static frontendPath: string | undefined;
  private static backendPath: string | undefined;

  static getServerConfig(): ServerConfig {
    // Start with default configuration
    const config: ServerConfig = JSON.parse(JSON.stringify(DEFAULT_SERVER_CONFIG));
    
    // Override with environment variables if they exist
    if (process.env.NEST_BACKEND_PORT) {
      config.nestBackend.port = parseInt(process.env.NEST_BACKEND_PORT, 10);
    }
    
    if (process.env.BACKEND_HOST) {
      config.nestBackend.host = process.env.BACKEND_HOST;
    }
    
    if (process.env.ELECTRON_SERVER_PORT) {
      config.electronServer.port = parseInt(process.env.ELECTRON_SERVER_PORT, 10);
    }
    
    if (process.env.ELECTRON_SERVER_HOST) {
      config.electronServer.host = process.env.ELECTRON_SERVER_HOST;
    }
    
    return config;
  }

  static getFrontEndPath(): string {
    // Return cached path if available and still exists
    if (this.frontendPath && fs.existsSync(this.frontendPath)) {
      return this.frontendPath;
    }

    try {
      // Try all possible paths in order - works for both packaged and unpackaged
      const possiblePaths = [
        // Unpackaged/development paths (from project root)
        path.join(process.cwd(), 'frontend-v3', 'dist', 'frontend-v3', 'browser'),
        path.join(process.cwd(), 'frontend-v3', 'dist', 'frontend-v3'),
        path.join(__dirname, '..', '..', 'frontend-v3', 'dist', 'frontend-v3', 'browser'),
        path.join(__dirname, '..', '..', 'frontend-v3', 'dist', 'frontend-v3'),
        path.join(app.getAppPath(), 'frontend-v3', 'dist', 'frontend-v3', 'browser'),
        path.join(app.getAppPath(), 'frontend-v3', 'dist', 'frontend-v3'),

        // Packaged paths (inside app bundle)
        path.join(process.resourcesPath, 'frontend-v3', 'dist', 'frontend-v3', 'browser'),
        path.join(process.resourcesPath, 'frontend-v3', 'dist', 'frontend-v3'),
        path.join(process.resourcesPath, 'app.asar', 'frontend-v3', 'dist', 'frontend-v3', 'browser'),
        path.join(process.resourcesPath, 'app.asar', 'frontend-v3', 'dist', 'frontend-v3'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'frontend-v3'),
        path.join(process.resourcesPath, 'frontend-v3')
      ];

      // Find the first path that exists
      this.frontendPath = possiblePaths.find(p => {
        if (fs.existsSync(p)) {
          log.info(`Found frontend path: ${p}`);
          return true;
        }
        return false;
      });

      if (!this.frontendPath) {
        log.error('Frontend not found in any of these locations:', possiblePaths);
        throw new Error('Frontend distribution directory not found');
      }

      // Verify essential files exist
      const hasIndexHtml = fs.existsSync(path.join(this.frontendPath, 'index.html'));

      if (!hasIndexHtml) {
        log.error(`Found frontend directory but missing index.html: ${this.frontendPath}`);
        throw new Error('Missing essential frontend files (index.html)');
      }

      log.info(`Using frontend path: ${this.frontendPath}`);
      return this.frontendPath;

    } catch (error) {
      log.error('Error resolving frontend path:', error);
      throw error;
    }
  }
  
  static getBackEndPath(): string {
    // Return cached path if available and still exists
    if (this.backendPath && fs.existsSync(this.backendPath)) {
      return this.backendPath;
    }

    // Try all possible paths in order - works for both packaged and unpackaged
    const possiblePaths = [
      // Packaged paths (MUST be checked first - backend is in extraResources, NOT in asar)
      path.join(process.resourcesPath, 'backend', 'dist', 'main.js'),
      path.join(process.resourcesPath, 'app', 'backend', 'dist', 'main.js'),
      path.join(app.getAppPath(), '..', 'backend', 'dist', 'main.js'),

      // Unpackaged paths (from project root - for development)
      path.join(process.cwd(), 'backend', 'dist', 'main.js'),
      path.join(__dirname, '..', '..', 'backend', 'dist', 'main.js'),
      path.join(app.getAppPath(), 'backend', 'dist', 'main.js')
    ];

    // Find the first path that exists
    this.backendPath = possiblePaths.find(p => {
      if (fs.existsSync(p)) {
        log.info(`Found backend path: ${p}`);
        return true;
      }
      return false;
    });

    if (!this.backendPath) {
      log.error('Backend not found in any of these locations:', possiblePaths);
      throw new Error('Backend main.js not found');
    }

    log.info(`Using backend path: ${this.backendPath}`);
    return this.backendPath;
  }
}