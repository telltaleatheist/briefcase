// clippy/electron/utilities/dependency-installer.ts
import * as child_process from 'child_process';
import * as log from 'electron-log';
import { dialog, shell } from 'electron';
import { DependencyInfo } from './dependency-checker';

/**
 * Installation progress callback
 */
export type InstallProgressCallback = (progress: {
  dependency: string;
  status: 'installing' | 'success' | 'failed' | 'skipped';
  message: string;
  error?: string;
}) => void;

/**
 * Installation result for a single dependency
 */
export interface InstallResult {
  dependency: string;
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Batch installation result
 */
export interface BatchInstallResult {
  allSuccessful: boolean;
  results: InstallResult[];
  installedCount: number;
  failedCount: number;
  skippedCount: number;
}

/**
 * Utility for installing system dependencies
 */
export class DependencyInstaller {
  private packageManager: 'chocolatey' | 'scoop' | 'winget' | 'none';

  constructor(packageManager: 'chocolatey' | 'scoop' | 'winget' | 'none') {
    this.packageManager = packageManager;
  }

  /**
   * Get installation command for a dependency
   */
  private getInstallCommand(dep: DependencyInfo): string | null {
    const packageName = this.getPackageManagerName(dep.name);

    switch (this.packageManager) {
      case 'chocolatey':
        return `choco install ${packageName} -y`;

      case 'scoop':
        return `scoop install ${packageName}`;

      case 'winget':
        return `winget install ${packageName} --silent --accept-package-agreements --accept-source-agreements`;

      default:
        return null;
    }
  }

  /**
   * Map internal dependency names to package manager names
   */
  private getPackageManagerName(depName: string): string {
    const packageMap: Record<string, Record<string, string>> = {
      chocolatey: {
        node: 'nodejs',
        python: 'python',
        ffmpeg: 'ffmpeg',
        ffprobe: 'ffmpeg', // ffprobe comes with ffmpeg
        'yt-dlp': 'yt-dlp'
      },
      scoop: {
        node: 'nodejs',
        python: 'python',
        ffmpeg: 'ffmpeg',
        ffprobe: 'ffmpeg',
        'yt-dlp': 'yt-dlp'
      },
      winget: {
        node: 'OpenJS.NodeJS',
        python: 'Python.Python.3.11',
        ffmpeg: 'Gyan.FFmpeg',
        ffprobe: 'Gyan.FFmpeg',
        'yt-dlp': 'yt-dlp.yt-dlp'
      }
    };

    return packageMap[this.packageManager]?.[depName] || depName;
  }

  /**
   * Show confirmation dialog to user
   */
  async askUserPermission(dependencies: DependencyInfo[]): Promise<boolean> {
    const depList = dependencies.map(d => `• ${d.displayName}`).join('\n');

    let message = `Clippy requires the following dependencies to function properly:\n\n${depList}\n\n`;

    if (this.packageManager !== 'none') {
      message += `Would you like to install these automatically using ${this.getPackageManagerDisplayName()}?\n\n`;
      message += 'Note: This will require administrator privileges.';
    } else {
      message += 'No package manager was detected. You will need to install these manually.\n\n';
      message += 'Would you like to see installation instructions?';
    }

    const response = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Install', 'Cancel', 'Manual Installation'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install Dependencies',
      message: 'Missing Required Dependencies',
      detail: message,
      noLink: true
    });

    if (response.response === 2) {
      // User chose manual installation
      await this.showManualInstructions(dependencies);
      return false;
    }

    return response.response === 0;
  }

  /**
   * Get display name for package manager
   */
  private getPackageManagerDisplayName(): string {
    switch (this.packageManager) {
      case 'chocolatey': return 'Chocolatey';
      case 'scoop': return 'Scoop';
      case 'winget': return 'Windows Package Manager (winget)';
      default: return 'Package Manager';
    }
  }

  /**
   * Show manual installation instructions
   */
  private async showManualInstructions(dependencies: DependencyInfo[]): Promise<void> {
    const instructions = dependencies.map(dep => {
      return `${dep.displayName}:\n  Download from: ${dep.downloadUrl || 'Official website'}`;
    }).join('\n\n');

    const message = `Please install the following dependencies manually:\n\n${instructions}\n\n` +
      'After installation, make sure to add them to your system PATH and restart Clippy.';

    await dialog.showMessageBox({
      type: 'info',
      buttons: ['Open Downloads Folder', 'OK'],
      title: 'Manual Installation Required',
      message: 'Installation Instructions',
      detail: message
    });

    // Open download URLs in browser
    for (const dep of dependencies) {
      if (dep.downloadUrl) {
        await shell.openExternal(dep.downloadUrl);
      }
    }
  }

  /**
   * Install a single dependency
   */
  private async installDependency(
    dep: DependencyInfo,
    progressCallback?: InstallProgressCallback
  ): Promise<InstallResult> {
    const result: InstallResult = {
      dependency: dep.displayName,
      success: false,
      message: ''
    };

    if (this.packageManager === 'none') {
      result.message = 'No package manager available';
      result.error = 'Please install manually';
      return result;
    }

    const command = this.getInstallCommand(dep);
    if (!command) {
      result.message = 'Could not determine install command';
      result.error = 'Package manager not supported';
      return result;
    }

    log.info(`Installing ${dep.displayName} with command: ${command}`);

    if (progressCallback) {
      progressCallback({
        dependency: dep.displayName,
        status: 'installing',
        message: `Installing ${dep.displayName}...`
      });
    }

    try {
      // Execute installation command with elevated privileges
      const output = child_process.execSync(command, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000, // 5 minutes timeout
        windowsHide: true
      });

      log.info(`Successfully installed ${dep.displayName}`);
      log.debug(`Install output: ${output}`);

      result.success = true;
      result.message = `Successfully installed ${dep.displayName}`;

      if (progressCallback) {
        progressCallback({
          dependency: dep.displayName,
          status: 'success',
          message: result.message
        });
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to install ${dep.displayName}:`, errorMsg);

      result.success = false;
      result.message = `Failed to install ${dep.displayName}`;
      result.error = errorMsg;

      if (progressCallback) {
        progressCallback({
          dependency: dep.displayName,
          status: 'failed',
          message: result.message,
          error: errorMsg
        });
      }

      return result;
    }
  }

  /**
   * Install multiple dependencies
   */
  async installDependencies(
    dependencies: DependencyInfo[],
    progressCallback?: InstallProgressCallback
  ): Promise<BatchInstallResult> {
    log.info(`Starting installation of ${dependencies.length} dependencies`);

    const results: InstallResult[] = [];
    let installedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const dep of dependencies) {
      // Skip ffprobe if ffmpeg is being installed (they come together)
      if (dep.name === 'ffprobe' && dependencies.some(d => d.name === 'ffmpeg')) {
        log.info('Skipping ffprobe installation (included with ffmpeg)');
        results.push({
          dependency: dep.displayName,
          success: true,
          message: 'Included with FFmpeg'
        });
        skippedCount++;

        if (progressCallback) {
          progressCallback({
            dependency: dep.displayName,
            status: 'skipped',
            message: 'Included with FFmpeg'
          });
        }
        continue;
      }

      const result = await this.installDependency(dep, progressCallback);
      results.push(result);

      if (result.success) {
        installedCount++;
      } else {
        failedCount++;
      }
    }

    log.info(`Installation complete: ${installedCount} installed, ${failedCount} failed, ${skippedCount} skipped`);

    return {
      allSuccessful: failedCount === 0,
      results,
      installedCount,
      failedCount,
      skippedCount
    };
  }

  /**
   * Show installation results dialog
   */
  async showResults(result: BatchInstallResult): Promise<void> {
    let message = '';
    let type: 'info' | 'warning' | 'error' = 'info';

    if (result.allSuccessful) {
      message = `Successfully installed ${result.installedCount} dependencies!\n\n`;
      message += 'Clippy will now restart to apply the changes.';
      type = 'info';
    } else {
      message = `Installation partially completed:\n\n`;
      message += `✓ Installed: ${result.installedCount}\n`;
      message += `✗ Failed: ${result.failedCount}\n`;
      message += `⊘ Skipped: ${result.skippedCount}\n\n`;

      const failed = result.results.filter(r => !r.success);
      if (failed.length > 0) {
        message += 'Failed installations:\n';
        failed.forEach(r => {
          message += `• ${r.dependency}: ${r.error || r.message}\n`;
        });
      }

      message += '\nYou may need to install failed dependencies manually.';
      type = 'warning';
    }

    await dialog.showMessageBox({
      type,
      buttons: ['OK'],
      title: 'Installation Complete',
      message: result.allSuccessful ? 'Success!' : 'Installation Incomplete',
      detail: message
    });
  }

  /**
   * Check if running with administrator privileges (Windows only)
   */
  static isElevated(): boolean {
    if (process.platform !== 'win32') {
      return true; // Not applicable on non-Windows
    }

    try {
      // Try to execute a command that requires admin privileges
      child_process.execSync('net session', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Request elevation (restart with admin privileges)
   */
  static async requestElevation(): Promise<boolean> {
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Restart as Administrator', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Administrator Privileges Required',
      message: 'Installation requires administrator privileges',
      detail: 'Clippy needs to be restarted with administrator privileges to install dependencies.\n\n' +
        'Click "Restart as Administrator" to continue.'
    });

    return response.response === 0;
  }
}
