import * as path from 'path';
import * as fs from 'fs';
import { log } from '../common/logger';

// Import the binary installers
import YTDlpWrap from 'yt-dlp-wrap-extended';
import { execSync } from 'child_process';

export class EnvironmentUtil {
  private static isDevMode: boolean | undefined;

  static isDevelopment(): boolean {
    if (this.isDevMode === undefined) {
      this.isDevMode = process.env.NODE_ENV === 'development';
    }
    return this.isDevMode;
  }

  static isProduction(): boolean {
    return !this.isDevelopment();
  }

  static getDownloadsPath(): string {
    const baseDir = this.isDevelopment() 
      ? path.join(process.cwd()) // Current working directory in development
      : path.join(process.env.HOME || process.env.USERPROFILE || '.', 'Documents', 'clipchimp');
    
    const downloadsPath = path.join(baseDir, 'downloads');
    
    // Ensure the directory exists
    try {
      if (!fs.existsSync(downloadsPath)) {
        fs.mkdirSync(downloadsPath, { recursive: true });
      }
      log.info(`Using downloads directory: ${downloadsPath}`);
      return downloadsPath;
    } catch (error) {
      log.error(`Failed to create downloads directory: ${error instanceof Error ? (error as Error).message : String(error)}`);
      // Fallback to a temporary directory
      const tmpDir = path.join(require('os').tmpdir(), 'clipchimp-downloads');
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
