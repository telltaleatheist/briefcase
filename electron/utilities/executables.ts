// clippy/electron/utils/executables.ts
import { dialog, shell } from 'electron';
import * as log from 'electron-log';
import { ConfigManager, PathConfig } from '../../config/ConfigManager';
import { PathValidator } from '../../utilities/PathValidator';
import { ConfigDialog } from '../../utilities/configDialog';
import * as child_process from 'child_process';
import * as fs from 'fs';
import path from 'path';
import * as os from 'os';

/**
 * Utilities for managing executable paths (FFmpeg, FFprobe, yt-dlp)
 */
export class ExecutablesUtil {
  private configManager: ConfigManager;
  
  constructor() {
    this.configManager = ConfigManager.getInstance();
  }
  
  /**
   * Check if required executables are configured and valid
   */
  async checkRequiredExecutables(): Promise<boolean> {
    // If no configuration exists, return false immediately
    if (!this.configManager.hasRequiredPaths()) {
      log.info('Required paths are not configured');
      return false;
    }
    
    // Get configuration
    const config = this.configManager.getConfig();
    
    // Set environment variables with the paths
    process.env.FFMPEG_PATH = config.ffmpegPath;
    process.env.FFPROBE_PATH = config.ffprobePath;
    process.env.YT_DLP_PATH = config.ytDlpPath;
    
    log.info(`Using configured paths:
      FFmpeg: ${config.ffmpegPath}
      FFprobe: ${config.ffprobePath}
      yt-dlp: ${config.ytDlpPath}`);
    
    // Validate all paths
    const validation = await PathValidator.validateAllPaths(config);
    
    if (!validation.allValid) {
      log.error('Some required executables are invalid:');
      if (!validation.ffmpeg.isValid) {
        log.error(`FFmpeg: ${validation.ffmpeg.error}`);
      }
      if (!validation.ffprobe.isValid) {
        log.error(`FFprobe: ${validation.ffprobe.error}`);
      }
      if (!validation.ytDlp.isValid) {
        log.error(`yt-dlp: ${validation.ytDlp.error}`);
      }
      return false;
    }
    
    return true;
  }

  /**
   * Show configuration dialog for required executables
   */
  async showExecutablesConfigDialog(): Promise<boolean> {
    // Create dialog with a callback to update environment variables
    const configDialog = new ConfigDialog(() => {
      const config = this.configManager.getConfig();
      process.env.FFMPEG_PATH = config.ffmpegPath;
      process.env.FFPROBE_PATH = config.ffprobePath;
      process.env.YT_DLP_PATH = config.ytDlpPath;
    });
    
    // Show dialog and return result
    return configDialog.showDialog();
  }
  
  /**
   * Check and configure required executables
   * Shows configuration dialog if needed
   */
  async checkAndConfigureExecutables(): Promise<boolean> {
    // Step 1: Try auto-detection
    log.info('Step 1: Attempting auto-detection of binaries...');
    const autoDetectionResult = await this.autoDetectBinaries();

    if (autoDetectionResult) {
      log.info('Auto-detection successful!');
      return true;
    }

    log.info('Auto-detection failed, proceeding to Step 2...');

    // Step 2: Try automatic installation (macOS with Homebrew)
    log.info('Step 2: Attempting automatic installation...');
    const autoInstallResult = await this.autoInstallDependencies();

    if (autoInstallResult) {
      log.info('Automatic installation successful!');
      return true;
    }

    log.info('Automatic installation failed or was skipped, proceeding to Step 3...');

    // Step 3: Check if executables are configured (from previous runs)
    let executablesConfigured = await this.checkRequiredExecutables();

    if (!executablesConfigured) {
      // Step 4: Show manual configuration dialog as last resort
      log.info('Step 4: Showing manual configuration dialog...');
      const dialogResult = await this.showExecutablesConfigDialog();

      if (!dialogResult) {
        log.info('User cancelled configuration dialog');
        return false;
      }

      executablesConfigured = await this.checkRequiredExecutables();

      if (!executablesConfigured) {
        log.error('Still unable to configure required executables');
        dialog.showErrorBox(
          'Configuration Error',
          'Failed to configure required executables. Please ensure FFmpeg, FFprobe, and yt-dlp are installed and accessible.'
        );
        return false;
      }
    }

    return true;
  }

  private findBinaryInPath(binaryName: string): string | null {
    try {
      // First, try standard locations (most reliable after fresh install)
      log.info(`Searching for ${binaryName} in standard locations...`);
      const standardLocations = this.getPlatformSpecificLocations(binaryName);

      for (const location of standardLocations) {
        if (fs.existsSync(location) && this.isExecutable(location)) {
          log.info(`Found ${binaryName} at: ${location}`);
          return location;
        }
      }

      // If not found in standard locations, try using which/where command
      log.info(`${binaryName} not in standard locations, trying system PATH...`);
      const command = os.platform() === 'win32' ? 'where' : 'which';
      const output = child_process.execSync(`${command} ${binaryName}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();

      // which/where might return multiple paths, take the first one
      const binaryPath = output.split('\n')[0].trim();

      // Validate the found path
      if (binaryPath && fs.existsSync(binaryPath) && this.isExecutable(binaryPath)) {
        log.info(`Found ${binaryName} via system PATH at: ${binaryPath}`);
        return binaryPath;
      }

      log.warn(`Binary ${binaryName} not found anywhere`);
      return null;
    } catch (error) {
      // If command fails, we've already tried standard locations above
      log.warn(`Binary ${binaryName} not found anywhere`);
      return null;
    }
  }

  /**
   * Get platform-specific binary locations
   * @param binaryName Name of the executable
   * @returns Array of potential binary paths
   */
  private getPlatformSpecificLocations(binaryName: string): string[] {
    const platform = os.platform();
    const homeDir = os.homedir();

    switch (platform) {
      case 'darwin': // macOS
        return [
          // Homebrew on Apple Silicon (most common)
          path.join('/opt/homebrew/bin', binaryName),
          // Homebrew on Intel Mac
          path.join('/usr/local/bin', binaryName),
          // MacPorts
          path.join('/opt/local/bin', binaryName),
          // System binaries
          path.join('/usr/bin', binaryName),
          // User-installed Homebrew
          path.join(homeDir, 'homebrew/bin', binaryName),
          path.join(homeDir, '.homebrew/bin', binaryName),
          // User local binaries
          path.join(homeDir, '.local/bin', binaryName),
          path.join(homeDir, 'bin', binaryName)
        ];

      case 'win32': // Windows
        return [
          path.join(process.env.ProgramFiles || '', binaryName),
          path.join(process.env.ProgramFiles || '', `${binaryName}.exe`),
          path.join(process.env['ProgramFiles(x86)'] || '', binaryName),
          path.join(process.env['ProgramFiles(x86)'] || '', `${binaryName}.exe`),
          path.join(homeDir, 'scoop', 'shims', `${binaryName}.exe`),
          path.join(homeDir, 'chocolatey', 'bin', `${binaryName}.exe`)
        ];

      case 'linux':
        return [
          path.join('/usr/local/bin', binaryName),
          path.join('/usr/bin', binaryName),
          path.join(homeDir, '.local/bin', binaryName),
          path.join('/snap/bin', binaryName)
        ];

      default:
        return [];
    }
  }

  /**
   * Check if file is executable
   * @param filePath Path to the file
   * @returns Boolean indicating if file is executable
   */
  private isExecutable(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Try to get bundled binary paths from npm packages and utilities folder
   */
  private getBundledBinaryPaths(): Partial<PathConfig> {
    const bundledPaths: Partial<PathConfig> = {};

    try {
      // Try to get ffmpeg from @ffmpeg-installer/ffmpeg
      const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
      if (ffmpegInstaller && ffmpegInstaller.path) {
        log.info(`Found bundled ffmpeg at: ${ffmpegInstaller.path}`);
        bundledPaths.ffmpegPath = ffmpegInstaller.path;
      }
    } catch (error) {
      log.warn('Could not load @ffmpeg-installer/ffmpeg:', error);
    }

    try {
      // Try to get ffprobe from @ffprobe-installer/ffprobe
      const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
      if (ffprobeInstaller && ffprobeInstaller.path) {
        log.info(`Found bundled ffprobe at: ${ffprobeInstaller.path}`);
        bundledPaths.ffprobePath = ffprobeInstaller.path;
      }
    } catch (error) {
      log.warn('Could not load @ffprobe-installer/ffprobe:', error);
    }

    try {
      // Try to get bundled yt-dlp from utilities/bin folder
      const { app } = require('electron');
      const platform = os.platform();

      // Determine the correct binary name for the platform
      let ytDlpBinaryName: string;
      if (platform === 'win32') {
        ytDlpBinaryName = 'yt-dlp.exe';
      } else if (platform === 'darwin') {
        ytDlpBinaryName = 'yt-dlp_macos';
      } else {
        ytDlpBinaryName = 'yt-dlp_linux';
      }

      // Check in resources path (production) and project root (development)
      const resourcesPath = process.resourcesPath || path.join(__dirname, '../../..');
      const ytDlpPath = path.join(resourcesPath, 'utilities', 'bin', ytDlpBinaryName);

      if (fs.existsSync(ytDlpPath) && this.isExecutable(ytDlpPath)) {
        log.info(`Found bundled yt-dlp at: ${ytDlpPath}`);
        bundledPaths.ytDlpPath = ytDlpPath;
      } else {
        log.info(`Bundled yt-dlp not found at: ${ytDlpPath}`);
      }
    } catch (error) {
      log.warn('Could not load bundled yt-dlp:', error);
    }

    return bundledPaths;
  }

  /**
   * Download yt-dlp binary to a local directory
   */
  private async downloadYtDlp(): Promise<string | null> {
    try {
      log.info('Attempting to download yt-dlp...');
      const YTDlpWrap = require('yt-dlp-wrap').default;

      // Download to user data directory
      const { app } = require('electron');
      const ytDlpDir = path.join(app.getPath('userData'), 'bin');

      // Create directory if it doesn't exist
      if (!fs.existsSync(ytDlpDir)) {
        fs.mkdirSync(ytDlpDir, { recursive: true });
      }

      const ytDlpPath = await YTDlpWrap.downloadFromGithub(ytDlpDir);
      log.info(`Successfully downloaded yt-dlp to: ${ytDlpPath}`);

      return ytDlpPath;
    } catch (error) {
      log.error('Failed to download yt-dlp:', error);
      return null;
    }
  }

  /**
   * Automatically detect and configure binary paths
   */
  async autoDetectBinaries(): Promise<boolean> {
    // First, try to use bundled binaries from npm packages and utilities folder
    log.info('Checking for bundled binaries...');
    const bundledPaths = this.getBundledBinaryPaths();

    // For yt-dlp, prioritize: bundled -> system PATH -> download
    let ytDlpPath = bundledPaths.ytDlpPath || this.findBinaryInPath('yt-dlp');

    // If yt-dlp is still not found, try to download it as last resort
    if (!ytDlpPath) {
      log.info('yt-dlp not found in bundle or system, attempting to download...');
      const downloadedPath = await this.downloadYtDlp();
      if (downloadedPath) {
        ytDlpPath = downloadedPath;
      }
    }

    const detectedPaths: Partial<PathConfig> = {
      // Use bundled paths if available, otherwise try to find in system
      ffmpegPath: bundledPaths.ffmpegPath || this.findBinaryInPath('ffmpeg') || undefined,
      ffprobePath: bundledPaths.ffprobePath || this.findBinaryInPath('ffprobe') || undefined,
      ytDlpPath: ytDlpPath || undefined
    };

    log.info('Auto-detected binary paths:', detectedPaths);

    // Check if at least one path was found
    const hasValidPaths = Object.values(detectedPaths).some(path => path !== undefined);

    if (hasValidPaths) {
      // Validate detected paths
      const validationResult = await PathValidator.validateAllPaths(detectedPaths);

      if (validationResult.allValid) {
        // Update config with detected paths
        const updateSuccess = this.configManager.updateConfig(detectedPaths);

        if (updateSuccess) {
          log.info('Successfully auto-configured binary paths');
          return true;
        }
      }
    }

    log.warn('Auto-detection failed or paths are invalid');
    return false;
  }

  /**
   * Get the path to Homebrew executable on macOS
   * Returns null if Homebrew is not installed
   */
  private getBrewPath(): string | null {
    if (os.platform() !== 'darwin') {
      return null;
    }

    try {
      // Check both Apple Silicon and Intel locations
      const brewPaths = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

      for (const brewPath of brewPaths) {
        if (fs.existsSync(brewPath)) {
          log.info(`Found Homebrew at: ${brewPath}`);
          return brewPath;
        }
      }

      // Also try using which as fallback
      const output = child_process.execSync('which brew', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();

      if (output && fs.existsSync(output)) {
        log.info(`Found Homebrew via which at: ${output}`);
        return output;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if Homebrew is installed on macOS
   */
  private isHomebrewInstalled(): boolean {
    return this.getBrewPath() !== null;
  }

  /**
   * Install dependencies using Homebrew on macOS
   */
  private async installViaBrew(packages: string[]): Promise<boolean> {
    const brewPath = this.getBrewPath();
    if (!brewPath) {
      log.warn('Homebrew is not installed');
      return false;
    }

    try {
      log.info(`Installing packages via Homebrew: ${packages.join(', ')}`);
      log.info(`Using Homebrew at: ${brewPath}`);

      for (const pkg of packages) {
        try {
          // Check if already installed
          const checkCmd = `"${brewPath}" list ${pkg}`;
          try {
            child_process.execSync(checkCmd, {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore']
            });
            log.info(`Package ${pkg} is already installed`);
            continue;
          } catch {
            // Not installed, proceed with installation
            log.info(`Package ${pkg} not found, installing...`);
          }

          // Install the package using full path to brew
          const installCmd = `"${brewPath}" install ${pkg}`;
          log.info(`Running: ${installCmd}`);
          child_process.execSync(installCmd, {
            encoding: 'utf8',
            stdio: 'inherit' // Show output to user
          });
          log.info(`Successfully installed ${pkg}`);
        } catch (error) {
          log.error(`Failed to install ${pkg}:`, error);
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`Error details: ${errorMsg}`);
          return false;
        }
      }

      return true;
    } catch (error) {
      log.error('Error during Homebrew installation:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Error details: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Attempt automatic installation of missing dependencies
   */
  async autoInstallDependencies(): Promise<boolean> {
    const platform = os.platform();

    if (platform === 'darwin') {
      // macOS - use Homebrew
      if (!this.isHomebrewInstalled()) {
        log.warn('Homebrew not installed, cannot auto-install dependencies');

        // Offer to install Homebrew
        const response = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Install Homebrew', 'Skip'],
          defaultId: 0,
          title: 'Homebrew Required',
          message: 'Homebrew package manager is required to install dependencies automatically.',
          detail: 'Would you like to install Homebrew now? This will open a Terminal window with installation instructions.'
        });

        if (response.response === 0) {
          // Open Homebrew installation page
          await shell.openExternal('https://brew.sh');

          dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Install Homebrew',
            message: 'Please follow the instructions on the Homebrew website to install it.',
            detail: 'After installing Homebrew, restart Clippy to automatically install the required dependencies.'
          });
        }

        return false;
      }

      // Ask user for permission to install
      const response = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Install', 'Manual Configuration'],
        defaultId: 0,
        title: 'Install Required Dependencies',
        message: 'Clippy requires FFmpeg and yt-dlp to function properly.',
        detail: 'Would you like to install them automatically using Homebrew?\n\nThis will run:\n• brew install ffmpeg\n• brew install yt-dlp'
      });

      if (response.response !== 0) {
        return false;
      }

      // Install via Homebrew
      const success = await this.installViaBrew(['ffmpeg', 'yt-dlp']);

      if (success) {
        log.info('Installation completed, attempting to detect binaries...');

        // Wait a moment for the installation to settle
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Try auto-detection again
        const detectionSuccess = await this.autoDetectBinaries();

        if (detectionSuccess) {
          dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Installation Complete',
            message: 'Dependencies installed successfully!',
            detail: 'FFmpeg and yt-dlp have been installed and configured via Homebrew.'
          });
          return true;
        } else {
          // Installation succeeded but detection failed - might need manual configuration
          log.warn('Installation succeeded but auto-detection failed');
          dialog.showMessageBox({
            type: 'warning',
            buttons: ['OK'],
            title: 'Installation Complete',
            message: 'Dependencies were installed but could not be detected automatically.',
            detail: 'FFmpeg and yt-dlp have been installed via Homebrew, but Clippy needs to be configured manually.\n\nPlease use the manual configuration dialog to set the paths.'
          });
          return false;
        }
      } else {
        dialog.showMessageBox({
          type: 'error',
          buttons: ['OK'],
          title: 'Installation Failed',
          message: 'Failed to install some dependencies.',
          detail: 'Please install them manually using Homebrew:\n\nbrew install ffmpeg\nbrew install yt-dlp\n\nOr configure the paths manually in the next dialog.'
        });
        return false;
      }
    }

    // For other platforms, return false (not implemented yet)
    log.info(`Auto-installation not implemented for platform: ${platform}`);
    return false;
  }
}