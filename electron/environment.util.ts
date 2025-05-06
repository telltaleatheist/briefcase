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
  static frontendPath: string | undefined;
  private static readonly CONFIG_FILENAME = 'clippy-config.json';
  private static binaryPathCache: { [key: string]: string } = {};
  private static backendPath: string | undefined;
  private static isDevMode: boolean | undefined;

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

  static getFrontEndPath(isDevelopment: boolean): string {
    // First, check if frontendPath is already set and exists
    if (this.frontendPath && fs.existsSync(this.frontendPath)) {
      return this.frontendPath;
    }
  
    try {
      if (isDevelopment) {
        const devPaths = [
          path.join(process.cwd(), 'frontend', 'dist', 'clippy-frontend', 'browser'),
          path.join(process.cwd(), 'frontend', 'dist', 'clippy-frontend'),
          path.join(__dirname, '..', '..', 'frontend', 'dist', 'clippy-frontend', 'browser'),
          path.join(__dirname, '..', '..', 'frontend', 'dist', 'clippy-frontend'),
          // Add Angular 17 standalone output path
          path.join(process.cwd(), 'frontend', 'dist', 'browser'),
          path.join(__dirname, '..', '..', 'frontend', 'dist', 'browser')
        ];
  
        this.frontendPath = devPaths.find(p => fs.existsSync(p));
      } else {
        const prodPaths = [
          path.join(process.resourcesPath, 'frontend', 'dist', 'clippy-frontend', 'browser'),
          path.join(process.resourcesPath, 'frontend', 'dist', 'clippy-frontend'),
          path.join(process.resourcesPath, 'app.asar', 'frontend', 'dist', 'clippy-frontend', 'browser'),
          path.join(process.resourcesPath, 'app.asar', 'frontend', 'dist', 'clippy-frontend'),
          // Add more paths
          path.join(process.resourcesPath, 'frontend', 'dist', 'browser'),
          path.join(process.resourcesPath, 'app.asar.unpacked', 'frontend'),
          path.join(process.resourcesPath, 'frontend')
        ];
  
        this.frontendPath = prodPaths.find(p => fs.existsSync(p));
      }
  
      if (!this.frontendPath) {
        throw new Error('Frontend distribution directory not found');
      }
  
      // Verify essential files exist
      const hasIndexHtml = fs.existsSync(path.join(this.frontendPath, 'index.html'));
      
      // Check for JS files (main bundle)
      const dirContents = fs.readdirSync(this.frontendPath);
      const hasMainJs = dirContents.some(file => file.match(/main-.*\.js$/));
      const hasStyles = dirContents.some(file => file.match(/styles-.*\.css$/));
  
      if (!hasIndexHtml || !hasMainJs || !hasStyles) {
        log.warn('Missing essential frontend files');
        throw new Error('Missing essential frontend files');
      }
  
      return this.frontendPath;
  
    } catch (error) {
      // Error handling remains the same
      log.error('Error resolving frontend path:', error);
      throw error;
    }
  }
  
  static isDevelopment(): boolean {
    // Cache the development mode status
    if (this.isDevMode === undefined) {
      this.isDevMode = process.env.NODE_ENV === 'development';
    }
    return this.isDevMode;
  }

  static isProduction(): boolean {
    return !this.isDevelopment();
  }
    
  static getBackEndPath(isDevelopment: boolean): string {
    // Return cached path if available
    if (this.backendPath) {
      return this.backendPath;
    }
    
    if (isDevelopment) {
      // Development path
      this.backendPath = path.join(app.getAppPath(), 'backend/dist/main.js');
    } else {
      // Production paths with fallbacks
      this.backendPath = path.join(process.resourcesPath, 'app.asar', 'backend/dist/main.js');
      
      if (!fs.existsSync(this.backendPath)) {
        // Try unpackaged location
        this.backendPath = path.join(process.resourcesPath, 'backend/dist/main.js');
        
        if (!fs.existsSync(this.backendPath)) {
          // Try other common locations
          const alternatives = [
            path.join(process.resourcesPath, 'app', 'backend/dist/main.js'),
            path.join(app.getAppPath(), 'backend/dist/main.js'),
            path.join(app.getAppPath(), '../backend/dist/main.js')
          ];
          
          for (const altPath of alternatives) {
            if (fs.existsSync(altPath)) {
              this.backendPath = altPath;
              break;
            }
          }
        }
      }
    }

    return this.backendPath || '';
  }
  
  static setupEnvironmentConfig(mainWindow: Electron.BrowserWindow): void {
    // Collect environment variables to persist
    const envToPersist = { ...process.env };

    // Additional environment detection or modification can happen here
    envToPersist.NODE_ENV = this.isDevelopment() ? 'development' : 'production';

    // Write the environment config
    this.writeEnvironmentConfig(envToPersist);
  }
}