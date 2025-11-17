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
// Import centralized binary path resolver
import { getBinariesConfig, validateBinaries } from '../../dist-electron/shared/binary-paths';

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
    // Step 1: Try auto-detection of bundled binaries
    log.info('Step 1: Attempting auto-detection of bundled binaries...');
    const autoDetectionResult = await this.autoDetectBinaries();

    if (autoDetectionResult) {
      log.info('Auto-detection successful!');
      return true;
    }

    log.info('Auto-detection failed, proceeding to Step 2...');

    // Step 2: Check if executables are configured (from previous runs)
    let executablesConfigured = await this.checkRequiredExecutables();

    if (executablesConfigured) {
      log.info('Using previously configured executables');
      return true;
    }

    log.info('No previously configured executables found.');

    // IMPORTANT: We do NOT attempt automatic installation (Step 3) because
    // all dependencies should be bundled with the application. If we reach this
    // point, it means either:
    // 1. The app was not packaged correctly, OR
    // 2. The bundled binaries are corrupted/missing
    //
    // In production, we should NEVER ask users to install dependencies via Homebrew.
    // Instead, we show an error and ask them to reinstall the app.

    log.error('Bundled executables not found or invalid. This indicates a packaging issue.');

    // Show error dialog instead of trying to install dependencies
    const response = await dialog.showMessageBox({
      type: 'error',
      buttons: ['Show Manual Configuration', 'Quit'],
      defaultId: 1,
      title: 'Missing Dependencies',
      message: 'Clippy is missing required components.',
      detail: 'The application appears to be missing FFmpeg and yt-dlp binaries. This may indicate the app was not installed correctly.\n\nPlease try reinstalling Clippy. If the problem persists, you can manually configure the paths to these tools.'
    });

    if (response.response === 1) {
      // User chose to quit
      log.info('User chose to quit after missing dependencies error');
      return false;
    }

    // Step 3: Show manual configuration dialog as last resort
    log.info('Step 3: Showing manual configuration dialog...');
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
   * Now uses the centralized binary path resolver
   */
  private getBundledBinaryPaths(): Partial<PathConfig> {
    const bundledPaths: Partial<PathConfig> = {};

    try {
      // Use centralized binary path resolver
      const binariesConfig = getBinariesConfig();

      log.info('Using centralized binary path resolver');
      log.info(`FFmpeg: ${binariesConfig.ffmpeg.path} (${binariesConfig.ffmpeg.source})`);
      log.info(`FFprobe: ${binariesConfig.ffprobe.path} (${binariesConfig.ffprobe.source})`);
      log.info(`yt-dlp: ${binariesConfig.ytdlp.path} (${binariesConfig.ytdlp.source})`);

      if (binariesConfig.ffmpeg.exists) {
        bundledPaths.ffmpegPath = binariesConfig.ffmpeg.path;
      }

      if (binariesConfig.ffprobe.exists) {
        bundledPaths.ffprobePath = binariesConfig.ffprobe.path;
      }

      if (binariesConfig.ytdlp.exists) {
        bundledPaths.ytDlpPath = binariesConfig.ytdlp.path;
      }
    } catch (error) {
      log.error('Error using centralized binary path resolver:', error);
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

    if (!hasValidPaths) {
      log.warn('Auto-detection failed: No binary paths were detected');
      return false;
    }

    // Validate detected paths
    log.info('Validating detected binary paths...');
    const validationResult = await PathValidator.validateAllPaths(detectedPaths);

    // Log validation results in detail
    log.info('Validation results:', {
      allValid: validationResult.allValid,
      ffmpeg: {
        isValid: validationResult.ffmpeg.isValid,
        version: validationResult.ffmpeg.version,
        error: validationResult.ffmpeg.error
      },
      ffprobe: {
        isValid: validationResult.ffprobe.isValid,
        version: validationResult.ffprobe.version,
        error: validationResult.ffprobe.error
      },
      ytDlp: {
        isValid: validationResult.ytDlp.isValid,
        version: validationResult.ytDlp.version,
        error: validationResult.ytDlp.error
      }
    });

    if (!validationResult.allValid) {
      log.warn('Auto-detection failed: Some detected paths failed validation');
      return false;
    }

    // Update config with detected paths
    const updateSuccess = this.configManager.updateConfig(detectedPaths);

    if (!updateSuccess) {
      log.error('Auto-detection failed: Could not save configuration');
      return false;
    }

    log.info('Successfully auto-configured binary paths');
    return true;
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