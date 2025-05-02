// clippy/electron/utils/executables.ts
import { dialog } from 'electron';
import * as log from 'electron-log';
import { ConfigManager } from '../../config/ConfigManager';
import { PathValidator } from '../../utilities/PathValidator';
import { ConfigDialog } from '../../utilities/configDialog';

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
    log.info('Checking required executables configuration...');
    
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
    
    log.info('All required executables are valid');
    return true;
  }

  /**
   * Show configuration dialog for required executables
   */
  async showExecutablesConfigDialog(): Promise<boolean> {
    log.info('Showing executables configuration dialog...');
    
    // Create dialog with a callback to update environment variables
    const configDialog = new ConfigDialog(() => {
      const config = this.configManager.getConfig();
      process.env.FFMPEG_PATH = config.ffmpegPath;
      process.env.FFPROBE_PATH = config.ffprobePath;
      process.env.YT_DLP_PATH = config.ytDlpPath;
      
      log.info(`Updated environment variables:
        FFMPEG_PATH: ${process.env.FFMPEG_PATH}
        FFPROBE_PATH: ${process.env.FFPROBE_PATH}
        YT_DLP_PATH: ${process.env.YT_DLP_PATH}`);
    });
    
    // Show dialog and return result
    return configDialog.showDialog();
  }
  
  /**
   * Check and configure required executables
   * Shows configuration dialog if needed
   */
  async checkAndConfigureExecutables(): Promise<boolean> {
    let executablesConfigured = await this.checkRequiredExecutables();
  
    // If not configured or invalid, show configuration dialog
    if (!executablesConfigured) {
      log.info('Required executables not configured or invalid, showing dialog...');
      const dialogResult = await this.showExecutablesConfigDialog();
      
      if (!dialogResult) {
        log.info('User cancelled configuration dialog');
        return false;
      }
      
      // Check again after dialog
      executablesConfigured = await this.checkRequiredExecutables();
      
      if (!executablesConfigured) {
        log.error('Still unable to configure required executables');
        dialog.showErrorBox(
          'Configuration Error',
          'Failed to configure required executables. Please make sure FFmpeg, FFprobe, and yt-dlp are installed correctly.'
        );
        return false;
      }
    }
    
    log.info('Required executables are properly configured');
    return true;
  }
}