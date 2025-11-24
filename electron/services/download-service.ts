// ClipChimp/electron/services/download-service.ts
import { app } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import * as fs from 'fs';
import { downloadVideo, checkAndFixAspectRatio, processOutputFilename } from '../utilities/download';
import { WindowService } from './window-service';

/**
 * Download service
 * Handles video download operations
 */
export class DownloadService {
  private windowService: WindowService;
  
  constructor(windowService: WindowService) {
    this.windowService = windowService;
  }
  
  /**
   * Download a video with the given options
   */
  async downloadVideo(options: any): Promise<any> {
    try {
      log.info(`Starting download for: ${options.url}`);
      
      // Ensure we have a valid download directory
      const downloadFolder = options.outputDir || app.getPath('downloads');
      
      // Start the download process
      const result = await downloadVideo(options, downloadFolder);

      // Process the output filename if download was successful
      if (result.success && result.outputFile) {
        let outputFile = result.outputFile;
        
        // Add date prefix to filename if needed
        outputFile = await processOutputFilename(outputFile);
        
        // Fix aspect ratio if requested
        if (options.fixAspectRatio) {
          const mainWindow = this.windowService.getMainWindow();
          const fixedFile = await checkAndFixAspectRatio(outputFile, mainWindow);
          if (fixedFile) {
            outputFile = fixedFile;
          }
        }
        
        return {
          success: true,
          outputFile
        };
      }
      
      return result;
    } catch (error) {
      log.error('Download error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
  /**
   * Check if a file exists
   */
  checkFileExists(filePath: string): boolean {
    const exists = fs.existsSync(filePath);
    return exists;
  }
  
  /**
   * Get app paths (helpful for debugging)
   */
  getAppPaths(): any {
    return {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      dirname: __dirname,
      execPath: process.execPath,
      cwd: process.cwd(),
      downloadsPath: app.getPath('downloads'),
      tempPath: app.getPath('temp'),
      userDataPath: app.getPath('userData')
    };
  }
}