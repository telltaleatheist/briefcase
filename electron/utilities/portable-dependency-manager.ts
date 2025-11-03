// clippy/electron/utilities/portable-dependency-manager.ts
import { app, dialog } from 'electron';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as log from 'electron-log';
import { DependencyInfo } from './dependency-checker';

/**
 * Portable dependency configuration
 */
export interface PortableDependencyConfig {
  name: string;
  version: string;
  downloadUrl: string;
  fileName: string;
  extractPath?: string; // Path within archive to extract
  postInstall?: string[]; // Commands to run after extraction
}

/**
 * Download progress callback
 */
export type DownloadProgressCallback = (progress: {
  dependency: string;
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  status: string;
}) => void;

/**
 * Manager for portable app-specific dependencies
 */
export class PortableDependencyManager {
  private appDataPath: string;
  private depsPath: string;
  private binPath: string;
  private pythonPath: string;

  constructor() {
    // Use app.getPath('userData') for app-specific data
    this.appDataPath = app.getPath('userData');
    this.depsPath = path.join(this.appDataPath, 'dependencies');
    this.binPath = path.join(this.depsPath, 'bin');
    this.pythonPath = path.join(this.depsPath, 'python');

    // Create directories if they don't exist
    this.ensureDirectories();
  }

  /**
   * Ensure all required directories exist
   */
  private ensureDirectories(): void {
    const dirs = [this.depsPath, this.binPath, this.pythonPath];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log.info(`Created directory: ${dir}`);
      }
    }
  }

  /**
   * Get portable dependency configurations
   */
  private getPortableDependencies(): Record<string, PortableDependencyConfig> {
    return {
      ffmpeg: {
        name: 'ffmpeg',
        version: '7.0.1',
        downloadUrl: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
        fileName: 'ffmpeg-essentials.zip',
        extractPath: 'ffmpeg-*-essentials_build/bin'
      },
      'yt-dlp': {
        name: 'yt-dlp',
        version: 'latest',
        downloadUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        fileName: 'yt-dlp.exe'
      },
      python: {
        name: 'python',
        version: '3.11.9',
        downloadUrl: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
        fileName: 'python-embed.zip',
        extractPath: '',
        postInstall: [
          // Install pip
          'curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py',
          'python get-pip.py',
          'del get-pip.py'
        ]
      }
    };
  }

  /**
   * Download a file with progress tracking
   */
  private async downloadFile(
    url: string,
    destPath: string,
    progressCallback?: DownloadProgressCallback,
    dependencyName?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);

      https.get(url, { headers: { 'User-Agent': 'Clippy' } }, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            return this.downloadFile(redirectUrl, destPath, progressCallback, dependencyName)
              .then(resolve)
              .catch(reject);
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`Download failed with status: ${response.statusCode}`));
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;

          if (progressCallback && dependencyName) {
            const percentage = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
            progressCallback({
              dependency: dependencyName,
              bytesDownloaded: downloadedBytes,
              totalBytes,
              percentage,
              status: `Downloading... ${(percentage).toFixed(1)}%`
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
  }

  /**
   * Extract a zip file
   */
  private async extractZip(zipPath: string, extractTo: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use PowerShell to extract (available on all Windows systems)
      const command = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTo}' -Force"`;

      child_process.exec(command, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Move files from extracted location to bin directory
   */
  private async moveExtractedFiles(
    extractedPath: string,
    config: PortableDependencyConfig
  ): Promise<void> {
    if (!config.extractPath) {
      return;
    }

    // Find the extracted directory (it might have version number in name)
    const parentDir = path.dirname(extractedPath);
    const items = fs.readdirSync(parentDir);

    for (const item of items) {
      const itemPath = path.join(parentDir, item);

      if (fs.statSync(itemPath).isDirectory()) {
        // Look for the bin directory
        const binSource = path.join(itemPath, 'bin');

        if (fs.existsSync(binSource)) {
          // Copy all files from bin to our bin directory
          const files = fs.readdirSync(binSource);

          for (const file of files) {
            const srcFile = path.join(binSource, file);
            const destFile = path.join(this.binPath, file);

            fs.copyFileSync(srcFile, destFile);
            log.info(`Copied ${file} to ${this.binPath}`);
          }

          return;
        }
      }
    }
  }

  /**
   * Install a portable dependency
   */
  async installPortableDependency(
    depName: string,
    progressCallback?: DownloadProgressCallback
  ): Promise<boolean> {
    const configs = this.getPortableDependencies();
    const config = configs[depName];

    if (!config) {
      log.error(`No portable configuration for ${depName}`);
      return false;
    }

    log.info(`Installing portable ${depName}...`);

    try {
      // Determine destination
      const isZip = config.fileName.endsWith('.zip');
      const downloadPath = path.join(this.depsPath, config.fileName);

      // Download
      log.info(`Downloading ${depName} from ${config.downloadUrl}`);
      await this.downloadFile(
        config.downloadUrl,
        downloadPath,
        progressCallback,
        config.name
      );

      log.info(`Downloaded ${depName} to ${downloadPath}`);

      // Extract if it's a zip
      if (isZip) {
        const extractPath = path.join(this.depsPath, depName);
        log.info(`Extracting ${depName} to ${extractPath}`);

        await this.extractZip(downloadPath, extractPath);

        // Move files to bin directory
        await this.moveExtractedFiles(extractPath, config);

        // Clean up
        fs.unlinkSync(downloadPath);
      } else {
        // Move single file to bin directory
        const destPath = path.join(this.binPath, config.fileName);
        fs.renameSync(downloadPath, destPath);

        // Make executable (not necessary on Windows but good practice)
        if (process.platform !== 'win32') {
          fs.chmodSync(destPath, '755');
        }
      }

      // Run post-install commands
      if (config.postInstall) {
        for (const command of config.postInstall) {
          log.info(`Running post-install command: ${command}`);
          child_process.execSync(command, {
            cwd: depName === 'python' ? this.pythonPath : this.binPath,
            encoding: 'utf8'
          });
        }
      }

      log.info(`Successfully installed portable ${depName}`);
      return true;
    } catch (error) {
      log.error(`Failed to install portable ${depName}:`, error);
      return false;
    }
  }

  /**
   * Check if a portable dependency is installed
   */
  isPortableDependencyInstalled(depName: string): boolean {
    const configs = this.getPortableDependencies();
    const config = configs[depName];

    if (!config) {
      return false;
    }

    // Check if the executable exists in bin directory
    let execName = config.fileName;

    if (config.fileName.endsWith('.zip')) {
      // For archives, check for the actual executable
      switch (depName) {
        case 'ffmpeg':
          execName = 'ffmpeg.exe';
          break;
        case 'python':
          execName = 'python.exe';
          break;
      }
    }

    const execPath = path.join(this.binPath, execName);
    return fs.existsSync(execPath);
  }

  /**
   * Get path to a portable dependency
   */
  getPortableDependencyPath(depName: string): string | null {
    if (!this.isPortableDependencyInstalled(depName)) {
      return null;
    }

    const configs = this.getPortableDependencies();
    const config = configs[depName];

    if (!config) {
      return null;
    }

    let execName = config.fileName;

    if (config.fileName.endsWith('.zip')) {
      switch (depName) {
        case 'ffmpeg':
          execName = 'ffmpeg.exe';
          break;
        case 'ffprobe':
          execName = 'ffprobe.exe';
          break;
        case 'python':
          execName = 'python.exe';
          break;
      }
    }

    return path.join(this.binPath, execName);
  }

  /**
   * Install all portable dependencies
   */
  async installAllPortable(
    dependencies: DependencyInfo[],
    progressCallback?: DownloadProgressCallback
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const dep of dependencies) {
      // Skip Ollama - it should be system-wide
      if (dep.name === 'ollama') {
        continue;
      }

      // Skip if already installed
      if (this.isPortableDependencyInstalled(dep.name)) {
        log.info(`Portable ${dep.name} already installed`);
        results.set(dep.name, true);
        continue;
      }

      const success = await this.installPortableDependency(dep.name, progressCallback);
      results.set(dep.name, success);
    }

    return results;
  }

  /**
   * Set environment variables for portable dependencies
   */
  setupEnvironmentVariables(): void {
    const ffmpegPath = this.getPortableDependencyPath('ffmpeg');
    const ffprobePath = this.getPortableDependencyPath('ffprobe');
    const ytDlpPath = this.getPortableDependencyPath('yt-dlp');
    const pythonPath = this.getPortableDependencyPath('python');

    if (ffmpegPath) {
      process.env.FFMPEG_PATH = ffmpegPath;
      log.info(`Set FFMPEG_PATH to ${ffmpegPath}`);
    }

    if (ffprobePath) {
      process.env.FFPROBE_PATH = ffprobePath;
      log.info(`Set FFPROBE_PATH to ${ffprobePath}`);
    }

    if (ytDlpPath) {
      process.env.YT_DLP_PATH = ytDlpPath;
      log.info(`Set YT_DLP_PATH to ${ytDlpPath}`);
    }

    if (pythonPath) {
      process.env.PYTHON_PATH = pythonPath;
      // Add Python to PATH
      const currentPath = process.env.PATH || '';
      process.env.PATH = `${path.dirname(pythonPath)};${currentPath}`;
      log.info(`Set PYTHON_PATH to ${pythonPath}`);
    }

    // Add bin directory to PATH
    const currentPath = process.env.PATH || '';
    process.env.PATH = `${this.binPath};${currentPath}`;
    log.info(`Added ${this.binPath} to PATH`);
  }

  /**
   * Get installation directory info
   */
  getInstallationInfo(): {
    depsPath: string;
    binPath: string;
    pythonPath: string;
    totalSize: number;
  } {
    const totalSize = this.calculateDirectorySize(this.depsPath);

    return {
      depsPath: this.depsPath,
      binPath: this.binPath,
      pythonPath: this.pythonPath,
      totalSize
    };
  }

  /**
   * Calculate directory size
   */
  private calculateDirectorySize(dirPath: string): number {
    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    let totalSize = 0;
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        totalSize += this.calculateDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }

    return totalSize;
  }

  /**
   * Clean up all portable dependencies
   */
  async cleanupAll(): Promise<void> {
    if (fs.existsSync(this.depsPath)) {
      fs.rmSync(this.depsPath, { recursive: true, force: true });
      log.info('Cleaned up all portable dependencies');
    }
  }
}
