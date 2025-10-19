// clippy/electron/config/app-config.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { EnvironmentUtil } from '../environment.util';

/**
 * Application configuration service
 * Centralizes all environment and path configuration
 */
export class AppConfig {
  // Environment detection
  static get isPackaged(): boolean {
    return app.isPackaged;
  }

  static get isDevelopment(): boolean {
    return process.argv.includes('development') || 
      (!this.isPackaged && process.env.NODE_ENV?.trim().toLowerCase() === 'development');
  }

  static get isProduction(): boolean {
    return !this.isDevelopment;
  }

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
    return this.isPackaged
      ? path.join(__dirname, 'preload.js')
      : path.join(__dirname, '../../electron', 'preload.js');
  }

  static get frontendPath(): string {
    try {
      return EnvironmentUtil.getFrontEndPath(this.isDevelopment);
    } catch (error) {
      log.error('Error getting frontend path:', error);
      throw error;
    }
  }

  static get backendPath(): string {
    try {
      return EnvironmentUtil.getBackEndPath(this.isDevelopment);
    } catch (error) {
      log.error('Error getting backend path:', error);
      throw error;
    }
  }

  // Downloads path
  static get downloadsPath(): string {
    return app.getPath('downloads');
  }

  // Initialization - run at app start
  static initialize(): void {
    // Set environment paths
    process.env.ELECTRON_RESOURCES_PATH = this.resourcesPath;
    process.env.ELECTRON_PRELOAD_PATH = this.preloadPath;
    process.env.APP_ROOT = this.appPath;
  }
}

// Initialize on import
AppConfig.initialize();