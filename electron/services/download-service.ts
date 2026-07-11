// Briefcase/electron/services/download-service.ts
import { app } from 'electron';
import * as fs from 'fs';
import { WindowService } from './window-service';

/**
 * Small filesystem/path helpers exposed over IPC.
 *
 * NOTE: this service used to own a `downloadVideo` method backed by a stub
 * (fake file write + system-ffmpeg "aspect fix"). That path had zero renderer
 * callers and was deleted — real downloads go through the backend queue.
 */
export class DownloadService {
  private windowService: WindowService;

  constructor(windowService: WindowService) {
    this.windowService = windowService;
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