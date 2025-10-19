// clippy/electron/utils/log-util.ts
import { exec } from 'child_process';
import * as log from 'electron-log';
import { AppConfig } from '../config/app-config';

/**
 * Logging utilities for the application
 */
export class LogUtil {
  /**
   * Configure the logger - always log to both console and file
   */
  static configureLogger(): void {
    log.transports.console.level = 'info';
    log.transports.file.level = 'debug';
  }
  
  /**
   * Log active processes, useful for debugging port conflicts
   */
  static logActiveProcesses(): void {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      exec('lsof -i :3000', (error: any, stdout: any) => {
        if (error) {
          log.info('No process found using port 3000');
          return;
        }
        log.info('Processes using port 3000:');
        log.info(stdout);
      });
    } else if (process.platform === 'win32') {
      exec('netstat -ano | findstr :3000', (error: any, stdout: any) => {
        if (error) {
          log.info('No process found using port 3000');
          return;
        }
        log.info('Processes using port 3000:');
        log.info(stdout);
      });
    }
  }
  
  /**
   * Log a directory's contents, useful for debugging
   */
  static logDirectoryContents(dirPath: string): void {
    const fs = require('fs');
    const path = require('path');
    
    try {
      if (fs.existsSync(dirPath)) {
        const contents = fs.readdirSync(dirPath);
        log.info(`Contents of ${dirPath}:`);
        log.info(contents.join(', '));
        
        // Log first-level subdirectories for more detail
        contents.forEach(item => {
          const itemPath = path.join(dirPath, item);
          try {
            if (fs.statSync(itemPath).isDirectory()) {
              const subContents = fs.readdirSync(itemPath);
              log.info(`  - ${item}/: ${subContents.length} items`);
            }
          } catch (e) {
            log.error(`Error reading subdirectory ${itemPath}: ${e}`);
          }
        });
      } else {
        log.warn(`Directory does not exist: ${dirPath}`);
      }
    } catch (error) {
      log.error(`Error reading directory ${dirPath}: ${error}`);
    }
  }
}