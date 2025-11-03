// clippy/electron/config/app-config.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { EnvironmentUtil } from '../environment.util';

/**
 * Application configuration service
 * Centralizes all path configuration - works the same whether packaged or not
 */
export class AppConfig {
  // Path configurations
  static get resourcesPath(): string {
    return process.resourcesPath || app.getAppPath();
  }

  static get appPath(): string {
    return app.getAppPath();
  }

  static get userDataPath(): string {
    return app.getPath('userData');
  }

  static get preloadPath(): string {
    // Try both packaged and unpackaged locations
    const possiblePaths = [
      path.join(__dirname, 'preload.js'),
      path.join(__dirname, '../../preload/electron/preload.js'),  // Development
      path.join(__dirname, '../preload/electron/preload.js'),      // Alternative dev
      path.join(__dirname, '../../electron', 'preload.js'),
      path.join(__dirname, '../preload', 'preload.js')
    ];

    const foundPath = possiblePaths.find(p => fs.existsSync(p));
    if (!foundPath) {
      log.error('Preload script not found in:', possiblePaths);
      log.error('Current __dirname:', __dirname);
      log.error('Checked paths:', possiblePaths);
      throw new Error('Preload script not found');
    }

    log.info('Using preload script from:', foundPath);
    return foundPath;
  }

  static get frontendPath(): string {
    try {
      return EnvironmentUtil.getFrontEndPath();
    } catch (error) {
      log.error('Error getting frontend path:', error);
      throw error;
    }
  }

  static get backendPath(): string {
    try {
      return EnvironmentUtil.getBackEndPath();
    } catch (error) {
      log.error('Error getting backend path:', error);
      throw error;
    }
  }

  // Downloads path
  static get downloadsPath(): string {
    return app.getPath('downloads');
  }

  // Initialization - run at app start (must be called after app.whenReady())
  static initialize(): void {
    // Set environment paths
    process.env.ELECTRON_RESOURCES_PATH = this.resourcesPath;
    process.env.ELECTRON_PRELOAD_PATH = this.preloadPath;
    process.env.APP_ROOT = this.appPath;
  }
}