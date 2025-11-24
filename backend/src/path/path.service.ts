// ClipChimp/backend/src/path/path.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class PathService {
  private readonly logger = new Logger(PathService.name);
  private defaultDownloadPath: string;

  constructor() {
    this.defaultDownloadPath = this.getDefaultDownloadPath();
    this.logger.log(`Default download path set to: ${this.defaultDownloadPath}`);
  }

  getDefaultDownloadPath(): string {
    const platform = os.platform();
    const homeDir = os.homedir();
    
    if (platform === 'darwin') {
      // macOS
      return path.join(homeDir, 'Downloads');
    } else if (platform === 'win32') {
      // Windows - Check for Windows standard Downloads folder
      const windowsDownloads = path.join(homeDir, 'Downloads');
      if (fs.existsSync(windowsDownloads)) {
        return windowsDownloads;
      }
      
      // Fallback to Documents\Downloads
      return path.join(homeDir, 'Documents', 'Downloads');
    } else {
      // Linux and others
      // Try standard XDG directory first
      try {
        // Check if xdg-user-dir command exists and use it to get Downloads path
        const { execSync } = require('child_process');
        const xdgDownloadsDir = execSync('xdg-user-dir DOWNLOAD').toString().trim();
        
        if (xdgDownloadsDir && fs.existsSync(xdgDownloadsDir)) {
          return xdgDownloadsDir;
        }
      } catch (error) {
        this.logger.warn('Could not determine XDG Downloads directory, using fallback');
      }
      
      // Fallback to ~/Downloads or create it if it doesn't exist
      const linuxDownloads = path.join(homeDir, 'Downloads');
      if (!fs.existsSync(linuxDownloads)) {
        try {
          fs.mkdirSync(linuxDownloads, { recursive: true });
        } catch (error: unknown) {
            // Type guard to check if error is an Error object
            if (error instanceof Error) {
              this.logger.error(`Path is not writable: ${linuxDownloads}, error: ${(error as Error).message}`);
            } else {
              this.logger.error(`Path is not writable: ${linuxDownloads}, error: ${String(error)}`);
            }
            return '';
          }
      }
      
      return linuxDownloads;
    }
  }

  ensurePathExists(downloadPath: string): boolean {
    try {
      if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
        this.logger.log(`Created download directory: ${downloadPath}`);
      }
      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to create download directory: ${(error as Error).message}`);
      } else {
        this.logger.error(`Failed to create download directory: ${String(error)}`);
      }
      return false;
    }
  }

  isPathWritable(downloadPath: string): boolean {
    try {
      // Ensure the directory exists first
      if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
      }
      
      // Try to write a test file
      const testFile = path.join(downloadPath, '.write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return true;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Path is not writable: ${downloadPath}, error: ${(error as Error).message}`);
      } else {
        this.logger.error(`Path is not writable: ${downloadPath}, error: ${String(error)}`);
      }
      return false;
    }
  }

  getSafePath(requestedPath: string | null | undefined): string {
    if (!requestedPath) {
      return this.defaultDownloadPath;
    }

    // Ensure the path exists and is writable
    if (this.isPathWritable(requestedPath)) {
      return requestedPath;
    }

    // Fallback to default if there are issues
    this.logger.warn(`Requested path ${requestedPath} is invalid, falling back to default ${this.defaultDownloadPath}`);
    return this.defaultDownloadPath;
  }

  async openFileLocation(filePath: string): Promise<void> {
    const platform = os.platform();
    const dir = path.dirname(filePath);

    // Verify the file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    try {
      if (platform === 'darwin') {
        // macOS - Use 'open' command with -R to reveal in Finder
        await execAsync(`open -R "${filePath}"`);
      } else if (platform === 'win32') {
        // Windows - Use 'explorer' with /select to select the file
        await execAsync(`explorer /select,"${filePath}"`);
      } else {
        // Linux - Try xdg-open to open the directory
        await execAsync(`xdg-open "${dir}"`);
      }

      this.logger.log(`Opened file location: ${filePath}`);
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to open file location: ${error.message}`);
        throw new Error(`Failed to open file location: ${error.message}`);
      } else {
        this.logger.error(`Failed to open file location: ${String(error)}`);
        throw new Error(`Failed to open file location: ${String(error)}`);
      }
    }
  }
}