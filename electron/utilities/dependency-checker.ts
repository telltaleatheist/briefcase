// clippy/electron/utilities/dependency-checker.ts
import * as child_process from 'child_process';
import * as os from 'os';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Dependency information structure
 */
export interface DependencyInfo {
  name: string;
  displayName: string;
  command: string; // Command to check if installed (e.g., 'node --version')
  versionRegex?: RegExp; // Regex to extract version from output
  minimumVersion?: string;
  isInstalled: boolean;
  installedVersion?: string;
  installMethod?: 'chocolatey' | 'scoop' | 'manual' | 'winget';
  downloadUrl?: string; // For manual installation
  isOptional?: boolean; // If true, user can skip this dependency
  category?: 'required' | 'ai' | 'optional'; // Category of dependency
  description?: string; // Long description for optional dependencies
  estimatedSize?: string; // Estimated disk space needed
}

/**
 * Check results for all dependencies
 */
export interface DependencyCheckResult {
  allInstalled: boolean;
  missing: DependencyInfo[];
  installed: DependencyInfo[];
  packageManagerAvailable: 'chocolatey' | 'scoop' | 'winget' | 'none';
}

/**
 * Utility for checking system dependencies
 */
export class DependencyChecker {
  private platform: string;

  constructor() {
    this.platform = os.platform();
  }

  /**
   * Check if a command exists in the system
   */
  private commandExists(command: string): boolean {
    try {
      const checkCommand = this.platform === 'win32' ? 'where' : 'which';
      child_process.execSync(`${checkCommand} ${command}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a command and get output
   */
  private executeCommand(command: string): string | null {
    try {
      const output = child_process.execSync(command, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000
      }).trim();
      return output;
    } catch (error) {
      log.debug(`Command failed: ${command}`, error);
      return null;
    }
  }

  /**
   * Check if a specific dependency is installed
   */
  private checkDependency(dep: DependencyInfo): DependencyInfo {
    const result = { ...dep };

    // Check if command exists
    if (this.commandExists(dep.command.split(' ')[0])) {
      result.isInstalled = true;

      // Try to get version if regex provided
      if (dep.versionRegex) {
        const output = this.executeCommand(dep.command);
        if (output) {
          const match = output.match(dep.versionRegex);
          if (match && match[1]) {
            result.installedVersion = match[1];
          }
        }
      }
    } else {
      result.isInstalled = false;
    }

    return result;
  }

  /**
   * Check which package manager is available on Windows
   */
  private checkPackageManager(): 'chocolatey' | 'scoop' | 'winget' | 'none' {
    if (this.platform !== 'win32') {
      return 'none';
    }

    // Check for Chocolatey
    if (this.commandExists('choco')) {
      log.info('Chocolatey package manager detected');
      return 'chocolatey';
    }

    // Check for Scoop
    if (this.commandExists('scoop')) {
      log.info('Scoop package manager detected');
      return 'scoop';
    }

    // Check for winget (Windows Package Manager)
    if (this.commandExists('winget')) {
      log.info('Winget package manager detected');
      return 'winget';
    }

    log.info('No package manager detected');
    return 'none';
  }

  /**
   * Get the list of required dependencies based on platform
   */
  private getRequiredDependencies(): DependencyInfo[] {
    const dependencies: DependencyInfo[] = [];

    if (this.platform === 'win32') {
      // Node.js
      dependencies.push({
        name: 'node',
        displayName: 'Node.js',
        command: 'node --version',
        versionRegex: /v(\d+\.\d+\.\d+)/,
        minimumVersion: '18.0.0',
        isInstalled: false,
        downloadUrl: 'https://nodejs.org/en/download/',
        category: 'required',
        description: 'JavaScript runtime required for the backend'
      });

      // Python
      dependencies.push({
        name: 'python',
        displayName: 'Python',
        command: 'python --version',
        versionRegex: /Python (\d+\.\d+\.\d+)/,
        minimumVersion: '3.7.0',
        isInstalled: false,
        downloadUrl: 'https://www.python.org/downloads/',
        category: 'required',
        description: 'Required for audio transcription features'
      });

      // FFmpeg
      dependencies.push({
        name: 'ffmpeg',
        displayName: 'FFmpeg',
        command: 'ffmpeg -version',
        versionRegex: /ffmpeg version (\d+\.\d+\.?\d*)/,
        isInstalled: false,
        downloadUrl: 'https://www.gyan.dev/ffmpeg/builds/',
        category: 'required',
        description: 'Video processing and conversion tool'
      });

      // FFprobe (usually comes with FFmpeg)
      dependencies.push({
        name: 'ffprobe',
        displayName: 'FFprobe',
        command: 'ffprobe -version',
        versionRegex: /ffprobe version (\d+\.\d+\.?\d*)/,
        isInstalled: false,
        downloadUrl: 'https://www.gyan.dev/ffmpeg/builds/',
        category: 'required',
        description: 'Video metadata analysis tool (comes with FFmpeg)'
      });

      // yt-dlp
      dependencies.push({
        name: 'yt-dlp',
        displayName: 'yt-dlp',
        command: 'yt-dlp --version',
        versionRegex: /(\d{4}\.\d{2}\.\d{2})/,
        isInstalled: false,
        downloadUrl: 'https://github.com/yt-dlp/yt-dlp/releases',
        category: 'required',
        description: 'Video downloader tool'
      });

      // Ollama (optional, for AI features)
      dependencies.push({
        name: 'ollama',
        displayName: 'Ollama',
        command: 'ollama --version',
        versionRegex: /ollama version is (\d+\.\d+\.\d+)/,
        isInstalled: false,
        downloadUrl: 'https://ollama.ai/download',
        isOptional: true,
        category: 'ai',
        description: 'Local AI model runtime for video analysis and content generation',
        estimatedSize: '~1-5 GB (depending on models)'
      });
    }

    return dependencies;
  }

  /**
   * Check all required dependencies
   */
  async checkAll(): Promise<DependencyCheckResult> {
    log.info('Checking system dependencies...');

    const dependencies = this.getRequiredDependencies();
    const checkedDependencies = dependencies.map(dep => this.checkDependency(dep));

    const installed = checkedDependencies.filter(dep => dep.isInstalled);
    const missing = checkedDependencies.filter(dep => !dep.isInstalled);

    const packageManager = this.checkPackageManager();

    log.info(`Dependencies check complete: ${installed.length}/${checkedDependencies.length} installed`);

    if (missing.length > 0) {
      log.info('Missing dependencies:', missing.map(d => d.displayName).join(', '));
    }

    return {
      allInstalled: missing.length === 0,
      missing,
      installed,
      packageManagerAvailable: packageManager
    };
  }

  /**
   * Compare two version strings
   * Returns: -1 if v1 < v2, 0 if equal, 1 if v1 > v2
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 < part2) return -1;
      if (part1 > part2) return 1;
    }

    return 0;
  }

  /**
   * Check if installed version meets minimum requirements
   */
  checkVersionRequirements(dep: DependencyInfo): boolean {
    if (!dep.isInstalled || !dep.installedVersion || !dep.minimumVersion) {
      return dep.isInstalled;
    }

    return this.compareVersions(dep.installedVersion, dep.minimumVersion) >= 0;
  }
}
