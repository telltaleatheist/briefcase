// src/environment/environment.util.ts
import * as path from 'path';
import * as fs from 'fs';

export class EnvironmentUtil {
  static isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development';
  }

  static isProduction(): boolean {
    return process.env.NODE_ENV === 'production' || process.env.NODE_ENV === undefined;
  }

  // Returns the path to a binary based on the current environment
  static getBinaryPath(binaryName: string): string {
    const envVar = process.env[`${binaryName.toUpperCase().replace('-', '_')}_PATH`];
    if (envVar && fs.existsSync(envVar)) return envVar;
  
    const pathsToTry: string[] = [];
  
    // Electron packaged binary path
    if (!!process.versions?.electron && 'resourcesPath' in process) {
      const electronProc = process as { resourcesPath?: string };
      pathsToTry.push(path.join(electronProc.resourcesPath || '.', 'bin', binaryName));
    }
  
    // Standard fallback paths
    pathsToTry.push(
      path.join(__dirname, '../../../bin', binaryName),                             // Project bin
      path.join(process.env.HOME || '.', 'Documents', 'clippy', 'bin', binaryName)  // User-specific bin
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
      if (fs.existsSync(candidate)) return candidate;
    }
  
    // Final fallback — let the system PATH try to resolve it
    return binaryName;
  }
}