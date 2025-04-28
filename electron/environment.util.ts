// Updated environment.util.ts optimized for both development and packaging
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import log from 'electron-log';

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
  
  // Returns the path to a binary based on the current environment
  static getBinaryPath(binaryName: string): string {
    const cacheKey = binaryName;

    // First, check if we have a cached path that exists
    if (this.binaryPathCache[cacheKey]) {
      return this.binaryPathCache[cacheKey];
    }
  
    const envVar = process.env[`${binaryName.toUpperCase().replace('-', '_')}_PATH`];
    
    // If the environment variable is set and the binary exists at the given path, return it
    if (envVar && fs.existsSync(envVar)) {
      this.binaryPathCache[cacheKey] = envVar;
      return this.binaryPathCache[cacheKey];
    }
  
    const pathsToTry: string[] = [];
    
    // Add paths based on whether we're in development or production
    if (this.isDevelopment()) {
      // Development paths
      pathsToTry.push(
        path.join(process.cwd(), 'bin', binaryName),
        path.join(app.getAppPath(), 'bin', binaryName),
        path.join(__dirname, '../../../bin', binaryName)
      );
    } else {
      // Production (packaged) paths
      pathsToTry.push(
        path.join(process.resourcesPath, 'bin', binaryName),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', binaryName),
        path.join(process.resourcesPath, 'app', 'bin', binaryName)
      );
    }
    
    // User-specific location as a fallback
    pathsToTry.push(
      path.join(process.env.HOME || '.', 'Documents', 'clippy', 'bin', binaryName)
    );
  
    // Append .exe for Windows
    if (process.platform === 'win32') {
      for (let i = 0; i < pathsToTry.length; i++) {
        if (!pathsToTry[i].endsWith('.exe')) {
          pathsToTry[i] += '.exe';
        }
      }
    }
  
    // Return the first existing path
    for (const candidate of pathsToTry) {
      if (fs.existsSync(candidate)) {
        log.info(`Found binary ${binaryName} at: ${candidate}`);
        this.binaryPathCache[cacheKey] = candidate;
        return this.binaryPathCache[cacheKey];
      }
    }
    
    // If we get here, try finding it in the system PATH as a last resort
    try {
      const { execSync } = require('child_process');
      let command;
      
      if (process.platform === 'win32') {
        command = `where ${binaryName}`;
      } else {
        command = `which ${binaryName}`;
      }
      
      const systemPath = execSync(command, { encoding: 'utf8' }).trim();
      
      if (systemPath && fs.existsSync(systemPath)) {
        log.info(`Found ${binaryName} in system PATH: ${systemPath}`);
        this.binaryPathCache[cacheKey] = systemPath;
        return this.binaryPathCache[cacheKey];
      }
    } catch (error) {
      log.warn(`Could not find ${binaryName} in system PATH: ${error}`);
    }
  
    // Final fallback — just return the binary name and hope the system can resolve it
    log.warn(`Could not find ${binaryName} in any location, returning just the name`);
    this.binaryPathCache[cacheKey] = binaryName;
    return this.binaryPathCache[cacheKey];
  }
  
  // Optional: Method to clear the binary path cache if needed
  static clearBinaryPathCache(): void {
    this.binaryPathCache = {};
    this.backendPath = undefined;
    this.frontendPath = undefined;
    this.isDevMode = undefined;
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