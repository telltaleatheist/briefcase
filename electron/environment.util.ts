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
      log.info(`Environment config written to: ${configPath}`);
    } catch (error) {
      log.error('Error writing environment config:', error);
    }
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

      log.info(`Environment config read from: ${configPath}`);
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
          path.join(process.cwd(), 'frontend/dist/clippy-frontend/browser'),
          path.join(process.cwd(), 'frontend/dist/clippy-frontend'),
          path.join(__dirname, '../../frontend/dist/clippy-frontend/browser'),
          path.join(__dirname, '../../frontend/dist/clippy-frontend')
        ];
  
        this.frontendPath = devPaths.find(fs.existsSync);
      } else {
        const prodPaths = [
          path.join(process.resourcesPath, 'frontend/dist/clippy-frontend/browser'),
          path.join(process.resourcesPath, 'frontend/dist/clippy-frontend'),
          path.join(process.resourcesPath, 'app.asar', 'frontend/dist/clippy-frontend/browser'),
          path.join(process.resourcesPath, 'app.asar', 'frontend/dist/clippy-frontend')
        ];
  
        this.frontendPath = prodPaths.find(fs.existsSync);
      }
  
      if (!this.frontendPath) {
        throw new Error('Frontend distribution directory not found');
      }
  
      // NEW: Dynamic file verification
      const requiredFiles = ['index.html', 'main-*.js', 'styles-*.css'];
      const missingRequired = requiredFiles.some(pattern => {
        const matchingFiles = fs.readdirSync(this.frontendPath!)
          .filter(file => file.match(new RegExp(pattern.replace('*', '.*'))));
        return matchingFiles.length === 0;
      });
  
      if (missingRequired) {
        log.warn('Missing essential frontend files');
        const dirContents = fs.readdirSync(this.frontendPath!);
        log.info(`Directory contents: ${dirContents.join(', ')}`);
        throw new Error('Missing essential frontend files');
      }
  
      log.info(`Frontend path resolved: ${this.frontendPath}`);
      log.info(`Frontend directory contents: ${fs.readdirSync(this.frontendPath!).join(', ')}`);
      
      return this.frontendPath;
  
    } catch (error) {
      log.error('Error resolving frontend path:', error);
      
      // Log additional context for debugging
      log.info('Development mode:', isDevelopment);
      log.info('Current working directory:', process.cwd());
      log.info('Resources path:', process.resourcesPath);
      log.info('__dirname:', __dirname);
  
      // List contents of the Resources directory
      try {
        log.info('Resources directory contents:', 
          fs.readdirSync(process.resourcesPath).join(', ')
        );
      } catch (listError) {
        log.error('Could not list Resources directory:', listError);
      }
  
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

    log.info(`Backend path resolved to: ${this.backendPath} (exists: ${fs.existsSync(this.backendPath || '')})`);
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