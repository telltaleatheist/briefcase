// clippy/electron/environment.util.ts
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import log from 'electron-log';

let getYtDlpPath: () => string;
try {
  const ytDlpWrap = require('yt-dlp-wrap');
  getYtDlpPath = typeof ytDlpWrap.getBinaryPath === 'function' 
    ? ytDlpWrap.getBinaryPath 
    : () => {
        // Fallback if function doesn't exist
        throw new Error('getBinaryPath not available in yt-dlp-wrap');
      };
} catch (error) {
  getYtDlpPath = () => {
    throw new Error(`Error loading yt-dlp-wrap: ${error instanceof Error ? error.message : 'Unknown error'}`);
  };
}

export const DEFAULT_SERVER_CONFIG = {
  nestBackend: {
    port: 3000,
    host: 'localhost'
  },
  electronServer: {
    port: 3001,
    host: 'localhost'
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

interface ConfigFile {
  [key: string]: string | undefined;
}

export class EnvironmentUtil {
  private static frontendPath: string | undefined;
  private static backendPath: string | undefined;
  private static readonly CONFIG_FILENAME = 'clippy-config.json';

  private static getConfigPath(): string {
    // Use app.getPath for a user-specific, persistent location
    return path.join(app.getPath('userData'), this.CONFIG_FILENAME);
  }
  
  static writeEnvironmentConfig(envVars: NodeJS.ProcessEnv): void {
    try {
      const configPath = this.getConfigPath();
      const configToWrite: ConfigFile = {};

      // Select specific environment variables to persist
      const keysToSave = [
        'FRONTEND_PATH', 
        'BACKEND_PATH', 
        'YT_DLP_PATH', 
        'FFMPEG_PATH',
        'NODE_ENV'
        // Add other keys you want to persist
      ];

      keysToSave.forEach(key => {
        if (envVars[key]) {
          configToWrite[key] = envVars[key];
        }
      });

      // Ensure the directory exists
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      // Write the config file
      fs.writeFileSync(configPath, JSON.stringify(configToWrite, null, 2), 'utf8');
    } catch (error) {
      log.error('Error writing environment config:', error);
    }
  }

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
  
  // Read environment variables from config file
  static readEnvironmentConfig(): NodeJS.ProcessEnv {
    try {
      const configPath = this.getConfigPath();
      
      // If config file doesn't exist, return empty object
      if (!fs.existsSync(configPath)) {
        log.warn(`Config file not found at: ${configPath}`);
        return {};
      }

      // Read and parse the config file
      const configContent = fs.readFileSync(configPath, 'utf8');
      const parsedConfig: ConfigFile = JSON.parse(configContent);

      return parsedConfig;
    } catch (error) {
      log.error('Error reading environment config:', error);
      return {};
    }
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
        path.join(process.cwd(), 'frontend', 'dist', 'clippy-frontend', 'browser'),
        path.join(process.cwd(), 'frontend', 'dist', 'clippy-frontend'),
        path.join(__dirname, '..', '..', 'frontend', 'dist', 'clippy-frontend', 'browser'),
        path.join(__dirname, '..', '..', 'frontend', 'dist', 'clippy-frontend'),
        path.join(app.getAppPath(), 'frontend', 'dist', 'clippy-frontend', 'browser'),
        path.join(app.getAppPath(), 'frontend', 'dist', 'clippy-frontend'),

        // Packaged paths (inside app bundle)
        path.join(process.resourcesPath, 'frontend', 'dist', 'clippy-frontend', 'browser'),
        path.join(process.resourcesPath, 'frontend', 'dist', 'clippy-frontend'),
        path.join(process.resourcesPath, 'app.asar', 'frontend', 'dist', 'clippy-frontend', 'browser'),
        path.join(process.resourcesPath, 'app.asar', 'frontend', 'dist', 'clippy-frontend'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'frontend'),
        path.join(process.resourcesPath, 'frontend')
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
  
  static setupEnvironmentConfig(): void {
    // Collect environment variables to persist
    const envToPersist = { ...process.env };
    envToPersist.NODE_ENV = 'production';

    // Write the environment config
    this.writeEnvironmentConfig(envToPersist);
  }
}