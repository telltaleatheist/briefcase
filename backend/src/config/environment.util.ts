import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';

// Import the binary installers
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ffprobeInstaller from '@ffprobe-installer/ffprobe';
const ytDlpModule = require('yt-dlp-wrap') as { getBinaryPath: () => string };
const getYtDlpPath = ytDlpModule.getBinaryPath;

export class EnvironmentUtil {
  private static isDevMode: boolean | undefined;
  private static binaryPathCache: { [key: string]: string } = {};
  private static manualBinaryPaths: { [key: string]: string } = {};

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
  
    // Use packaged binaries by default
    try {
      let binaryPath: string;
      
      switch (binaryName) {
        case 'ffmpeg':
          binaryPath = ffmpegInstaller.path;
          break;
        case 'ffprobe':
          binaryPath = ffprobeInstaller.path;
          break;
        case 'yt-dlp':
          binaryPath = getYtDlpPath();
          break;
        default:
          throw new Error(`Unsupported binary: ${binaryName}`);
      }
      
      if (binaryPath && fs.existsSync(binaryPath)) {
        log.info(`Using packaged ${binaryName}: ${binaryPath}`);
        this.binaryPathCache[cacheKey] = binaryPath;
        return binaryPath;
      }
      
      throw new Error(`Packaged binary ${binaryName} not found!`);
    } catch (error) {
      log.error(`Error finding packaged binary ${binaryName}: ${error instanceof Error ? error.message : String(error)}`);
      
      // Try system path as fallback
      try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const { execSync } = require('child_process');
        const systemPath = execSync(`${which} ${binaryName}`, { encoding: 'utf8' }).trim().split('\n')[0];
        
        if (systemPath && fs.existsSync(systemPath)) {
          log.warn(`Falling back to system PATH for ${binaryName}: ${systemPath}`);
          this.binaryPathCache[cacheKey] = systemPath;
          return systemPath;
        }
      } catch (fallbackError) {
        log.error(`Could not find ${binaryName} in system PATH either!`);
      }
      
      // Always return something even if it's just the binary name
      log.warn(`Could not find ${binaryName} anywhere, returning binary name as fallback`);
      return binaryName;
    }
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
}
