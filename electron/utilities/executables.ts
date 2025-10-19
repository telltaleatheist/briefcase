// clippy/electron/utils/executables.ts
import { dialog } from 'electron';
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
    // First try auto-detection
    const autoDetectionResult = await this.autoDetectBinaries();

    if (autoDetectionResult) {
      return true;
    }

    // If auto-detection fails, fall back to existing method
    let executablesConfigured = await this.checkRequiredExecutables();

    if (!executablesConfigured) {
      log.info('Executables not auto-configured, showing dialog...');
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
          'Failed to configure required executables. Please manually locate FFmpeg, FFprobe, and yt-dlp.'
        );
        return false;
      }
    }
    
    return true;
  }

  private findBinaryInPath(binaryName: string): string | null {
    try {
      // Use platform-specific command to find binary
      const command = os.platform() === 'win32' ? 'where' : 'which';
      const binaryPath = child_process.execSync(`${command} ${binaryName}`, { 
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();

      // Validate the found path
      if (binaryPath && fs.existsSync(binaryPath) && this.isExecutable(binaryPath)) {
        return binaryPath;
      }
      
      // If system command fails, fall back to manual search
      const standardLocations = this.getPlatformSpecificLocations(binaryName);
      
      for (const location of standardLocations) {
        if (fs.existsSync(location) && this.isExecutable(location)) {
          return location;
        }
      }
      
      return null;
    } catch (error) {
      // If command fails (binary not found), return null
      log.warn(`Binary ${binaryName} not found in PATH`);
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
          path.join('/usr/local/bin', binaryName),
          path.join('/usr/bin', binaryName),
          path.join(homeDir, 'homebrew/bin', binaryName),
          path.join(homeDir, '.homebrew/bin', binaryName)
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
          path.join(homeDir, '.local/bin', binaryName)
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
   * Automatically detect and configure binary paths
   */
  async autoDetectBinaries(): Promise<boolean> {
    const detectedPaths: Partial<PathConfig> = {
      ffmpegPath: this.findBinaryInPath('ffmpeg') || undefined,
      ffprobePath: this.findBinaryInPath('ffprobe') || undefined,
      ytDlpPath: this.findBinaryInPath('yt-dlp') || undefined
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
}