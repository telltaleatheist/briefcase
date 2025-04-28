import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';

// Import the binary installers
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ffprobeInstaller from '@ffprobe-installer/ffprobe';
import YTDlpWrap from 'yt-dlp-wrap';
import { execSync } from 'child_process';

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
    try {
      switch (binaryName) {
        case 'ffmpeg':
          return ffmpegInstaller.path;
        case 'ffprobe':
          return ffprobeInstaller.path;
        case 'yt-dlp':
          // Try to find yt-dlp in system PATH first
          const systemPath = this.findBinaryInPath('yt-dlp');
          if (systemPath) {
            log.info(`Found yt-dlp at: ${systemPath}`);
            return systemPath;
          }

          // If not found, fallback to just 'yt-dlp' (hope it's in minimal PATH)
          log.warn('yt-dlp not found in system PATH. Falling back to default binary name.');
          return 'yt-dlp';

        default:
          throw new Error(`Unsupported binary: ${binaryName}`);
      }
    } catch (error) {
      log.error(`Error resolving binary path for ${binaryName}:`, error);
      return binaryName; // Last resort: just return the binary name
    }
  }

  private static findBinaryInPath(binaryName: string): string | null {
    try {
      const command = process.platform === 'win32' ? 'where' : 'which';
      const binaryPath = execSync(`${command} ${binaryName}`, { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0]; // Always use first result
          
      if (binaryPath && fs.existsSync(binaryPath)) {
        return binaryPath;
      }
      
      return null;
    } catch (error) {
      log.warn(`findBinaryInPath failed for ${binaryName}:`, error);
      return null;
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
