// src/environment/environment.util.ts
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as log from 'electron-log';

export class EnvironmentUtil {
  private static isDevMode: boolean | undefined;
  private static binaryPathCache: { [key: string]: string } = {};
  // Store manually set binary paths
  private static manualBinaryPaths: { [key: string]: string } = {};

  /**
   * Set a manual path for a specific binary
   * @param binaryName Name of the binary (e.g., 'yt-dlp', 'ffmpeg')
   * @param binaryPath Full path to the binary
   * @throws Error if the binary path is invalid
   */
  static setManualBinaryPath(binaryName: string, binaryPath: string): void {
    if (!binaryName || typeof binaryName !== 'string') {
      throw new Error('Invalid binary name. Must be a non-empty string.');
    }

    if (!binaryPath || typeof binaryPath !== 'string') {
      throw new Error('Invalid binary path. Must be a non-empty string.');
    }

    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Binary path does not exist: ${binaryPath}`);
    }

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch (error) {
      throw new Error(`Binary is not executable: ${binaryPath}`);
    }

    try {
      const versionCommands: { [key: string]: string } = {
        'yt-dlp': '--version',
        'ffmpeg': '-version',
        'ffprobe': '-version'
      };

      const versionCommand = versionCommands[binaryName] || '--version';
      
      childProcess.execSync(`"${binaryPath}" ${versionCommand}`, { 
        stdio: 'ignore',
        timeout: 5000 // 5-second timeout
      });
    } catch (error) {
      throw new Error(`Failed to run binary ${binaryName} from path: ${binaryPath}`);
    }

    this.manualBinaryPaths[binaryName] = binaryPath;
    delete this.binaryPathCache[binaryName];
    log.info(`Manual path set for ${binaryName}: ${binaryPath}`);
  }

  static getManualBinaryPath(binaryName: string): string | undefined {
    return this.manualBinaryPaths[binaryName];
  }

  static clearManualBinaryPath(binaryName: string): void {
    if (this.manualBinaryPaths[binaryName]) {
      delete this.manualBinaryPaths[binaryName];
      log.info(`Cleared manual path for ${binaryName}`);
    }
  }

  static clearAllManualBinaryPaths(): void {
    this.manualBinaryPaths = {};
    log.info('Cleared all manual binary paths');
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

  static getBinaryPath(binaryName: string): string {
    const cacheKey = binaryName;
    
    // First, check if we have a cached path that exists
    if (this.binaryPathCache[cacheKey]) {
      return this.binaryPathCache[cacheKey];
    }
    
    // Determine the correct command to find binary in PATH
    const which = process.platform === 'win32' ? 'where' : 'which';
    
    try {
      // Use the system's PATH command to find the binary
      const systemPath = childProcess.execSync(`${which} ${binaryName}`, { encoding: 'utf8' }).trim().split('\n')[0];
      
      if (systemPath && fs.existsSync(systemPath)) {
        log.info(`Using ${binaryName} from system PATH: ${systemPath}`);
        this.binaryPathCache[cacheKey] = systemPath;
        return systemPath;
      }
    } catch (error) {
      log.error(`Could not find ${binaryName} in system PATH: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // If we get here, the binary wasn't found in PATH
    throw new Error(`Binary ${binaryName} not found in system PATH!`);
  }  

  static getDownloadsPath(): string {
    const baseDir = this.isDevelopment() 
      ? path.join(process.cwd()) // Current working directory in development
      : path.join(process.env.HOME || process.env.USERPROFILE || '.', 'Documents', 'clippy');
    
    const downloadsPath = path.join(baseDir, 'downloads');
    
    // Ensure the directory exists
    try {
      if (!fs.existsSync(downloadsPath)) {
        fs.mkdirSync(downloadsPath, { recursive: true });
      }
      log.info(`Using downloads directory: ${downloadsPath}`);
      return downloadsPath;
    } catch (error) {
      log.error(`Failed to create downloads directory: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to a temporary directory
      const tmpDir = path.join(require('os').tmpdir(), 'clippy-downloads');
      try {
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }
        log.info(`Using fallback downloads directory: ${tmpDir}`);
        return tmpDir;
      } catch (innerError) {
        log.error(`Failed to create fallback downloads directory: ${innerError instanceof Error ? innerError.message : String(innerError)}`);
        throw new Error('Cannot create downloads directory!');
      }
    }
  }

  // Clear the cache if needed
  static clearBinaryPathCache(): void {
    this.binaryPathCache = {};
    this.isDevMode = undefined;
  }
}