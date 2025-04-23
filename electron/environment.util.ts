// Updated environment.util.ts optimized for both development and packaging
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import log from 'electron-log';

export class EnvironmentUtil {

  static getFrontEndPath(isDevelopment: boolean): string {
    let frontendPath;
    
    if (isDevelopment) {
      // Development paths
      frontendPath = path.join(process.cwd(), 'frontend/dist/clippy-frontend/browser');
      
      // If that doesn't exist, try a few alternatives
      if (!fs.existsSync(frontendPath)) {
        const devAlternatives = [
          path.join(app.getAppPath(), 'frontend/dist/clippy-frontend/browser'),
          path.join(__dirname, '../../frontend/dist/clippy-frontend/browser'),
          path.join(__dirname, '../../../frontend/dist/clippy-frontend/browser')
        ];
        
        for (const altPath of devAlternatives) {
          if (fs.existsSync(altPath)) {
            frontendPath = altPath;
            break;
          }
        }
      }
    } else {
      // Production (packaged) paths - follow Electron conventions
      frontendPath = path.join(process.resourcesPath, 'app.asar', 'frontend/dist/clippy-frontend/browser');
      
      // If that doesn't exist, try unpackaged location
      if (!fs.existsSync(frontendPath)) {
        frontendPath = path.join(process.resourcesPath, 'frontend/dist/clippy-frontend/browser');
      }
      
      // If still not found, try some other common locations in packaged apps
      if (!fs.existsSync(frontendPath)) {
        const prodAlternatives = [
          path.join(process.resourcesPath, 'app', 'frontend/dist/clippy-frontend/browser'),
          path.join(app.getAppPath(), '../frontend/dist/clippy-frontend/browser'),
          path.join(app.getAppPath(), 'frontend/dist/clippy-frontend/browser')
        ];
        
        for (const altPath of prodAlternatives) {
          if (fs.existsSync(altPath)) {
            frontendPath = altPath;
            break;
          }
        }
      }
    }
    
    log.info(`Frontend path resolved to: ${frontendPath} (exists: ${fs.existsSync(frontendPath)})`);
    
    // If we still haven't found a valid path, log alternatives for debugging
    if (!fs.existsSync(frontendPath)) {
      log.warn(`Frontend path not found at: ${frontendPath}`);
      
      // Log the contents of parent directories to help debug
      try {
        const parentDir = path.dirname(frontendPath);
        if (fs.existsSync(parentDir)) {
          log.info(`Contents of parent directory ${parentDir}:`);
          const files = fs.readdirSync(parentDir);
          for (const file of files) {
            log.info(`- ${file}`);
          }
        }
        
        // Also check one level up
        const grandParentDir = path.dirname(parentDir);
        if (fs.existsSync(grandParentDir)) {
          log.info(`Contents of grandparent directory ${grandParentDir}:`);
          const files = fs.readdirSync(grandParentDir);
          for (const file of files) {
            log.info(`- ${file}`);
          }
        }
      } catch (error) {
        log.error(`Error inspecting directories: ${error}`);
      }
    }
    
    return frontendPath;
  }

  static getBackEndPath(isDevelopment: boolean): string {
    let backendPath;
    
    if (isDevelopment) {
      // Development path
      backendPath = path.join(app.getAppPath(), 'backend/dist/main.js');
    } else {
      // Production paths with fallbacks
      backendPath = path.join(process.resourcesPath, 'app.asar', 'backend/dist/main.js');
      
      if (!fs.existsSync(backendPath)) {
        // Try unpackaged location
        backendPath = path.join(process.resourcesPath, 'backend/dist/main.js');
        
        if (!fs.existsSync(backendPath)) {
          // Try other common locations
          const alternatives = [
            path.join(process.resourcesPath, 'app', 'backend/dist/main.js'),
            path.join(app.getAppPath(), 'backend/dist/main.js'),
            path.join(app.getAppPath(), '../backend/dist/main.js')
          ];
          
          for (const altPath of alternatives) {
            if (fs.existsSync(altPath)) {
              backendPath = altPath;
              break;
            }
          }
        }
      }
    }
    
    log.info(`Backend path resolved to: ${backendPath} (exists: ${fs.existsSync(backendPath)})`);
    return backendPath;
  }
  
  static isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development';
  }

  static isProduction(): boolean {
    return process.env.NODE_ENV === 'production' || process.env.NODE_ENV === undefined;
  }

  // Returns the path to a binary based on the current environment
  static getBinaryPath(binaryName: string): string {
    const envVar = process.env[`${binaryName.toUpperCase().replace('-', '_')}_PATH`];
    
    // If the environment variable is set and the binary exists at the given path, return it
    if (envVar && fs.existsSync(envVar)) return envVar;
  
    const pathsToTry: string[] = [];
    
    // Add paths based on whether we're in development or production
    if (this.isDevelopment()) {
      // Development paths
      pathsToTry.push(
        path.join(process.cwd(), 'bin', binaryName),
        path.join(app.getAppPath(), 'bin', binaryName),
        path.join(__dirname, '../../../bin', binaryName)
      );
    } else {
      // Production (packaged) paths
      pathsToTry.push(
        path.join(process.resourcesPath, 'bin', binaryName),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', binaryName),
        path.join(process.resourcesPath, 'app', 'bin', binaryName)
      );
    }
    
    // User-specific location as a fallback
    pathsToTry.push(
      path.join(process.env.HOME || '.', 'Documents', 'clippy', 'bin', binaryName)
    );
  
    // Append .exe for Windows
    if (process.platform === 'win32') {
      for (let i = 0; i < pathsToTry.length; i++) {
        if (!pathsToTry[i].endsWith('.exe')) {
          pathsToTry[i] += '.exe';
        }
      }
    }
  
    // Return the first existing path
    for (const candidate of pathsToTry) {
      if (fs.existsSync(candidate)) {
        log.info(`Found binary ${binaryName} at: ${candidate}`);
        return candidate;
      }
    }
    
    // If we get here, try finding it in the system PATH as a last resort
    try {
      const { execSync } = require('child_process');
      let command;
      
      if (process.platform === 'win32') {
        command = `where ${binaryName}`;
      } else {
        command = `which ${binaryName}`;
      }
      
      const systemPath = execSync(command, { encoding: 'utf8' }).trim();
      
      if (systemPath && fs.existsSync(systemPath)) {
        log.info(`Found ${binaryName} in system PATH: ${systemPath}`);
        return systemPath;
      }
    } catch (error) {
      log.warn(`Could not find ${binaryName} in system PATH: ${error}`);
    }
  
    // Final fallback — just return the binary name and hope the system can resolve it
    log.warn(`Could not find ${binaryName} in any location, returning just the name`);
    return binaryName;
  }
}