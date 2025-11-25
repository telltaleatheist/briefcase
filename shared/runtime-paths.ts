/**
 * Simple runtime path resolution for bundled binaries
 * No user configuration, no auto-detection, no complexity
 * Just returns the paths to bundled binaries
 *
 * IMPORTANT: Works in both Electron main process AND backend Node.js process
 */

import * as path from 'path';

// Try to load electron, but don't fail if not available (e.g., when called from backend)
let app: any = null;
try {
  app = require('electron').app;
} catch {
  // Electron not available - we're probably in the backend process
}

/**
 * Check if we're running in a packaged app
 */
function isPackaged(): boolean {
  // If electron is available, use app.isPackaged
  if (app?.isPackaged !== undefined) {
    return app.isPackaged;
  }

  // Otherwise, check environment or process.resourcesPath
  if (process.env.NODE_ENV === 'production') {
    return true;
  }

  // If process.resourcesPath exists, check if it's actually packaged
  // In development, Electron sets resourcesPath to the Electron binary's resources
  if ((process as any).resourcesPath) {
    const resPath = (process as any).resourcesPath;
    // If the path contains 'node_modules/electron', we're in development
    if (resPath.includes('node_modules/electron') || resPath.includes('node_modules\\electron')) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Get the base resources directory
 */
function getResourcesPath(): string {
  // In packaged app, use process.resourcesPath
  // Must check isPackaged() because Electron sets resourcesPath even in development
  if ((process as any).resourcesPath && isPackaged()) {
    return (process as any).resourcesPath;
  }

  // If electron app is available and packaged
  if (app?.getAppPath && isPackaged()) {
    return path.dirname(app.getAppPath());
  }

  // Development: project root
  return process.cwd();
}

/**
 * Get platform-specific binary name
 */
function getBinaryName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Get platform folder for npm installer packages
 */
function getPlatformFolder(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'win32-x64';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else {
    return 'linux-x64';
  }
}

/**
 * Get yt-dlp binary name for current platform
 */
function getYtDlpBinaryName(): string {
  const platform = process.platform;
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp_linux';
}

/**
 * Try to find a command in PATH (for development mode)
 * Returns the full path if found, otherwise returns the command name
 */
function findInPath(command: string): string {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      const result = execSync(`where ${command}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = result.trim().split('\n');
      if (lines.length > 0 && lines[0]) {
        return lines[0].trim();
      }
    } else {
      const result = execSync(`which ${command}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return result.trim();
    }
  } catch {
    // Command not found in PATH
  }
  return command;
}

/**
 * Get all binary paths
 * Simple and direct - no detection, no validation, no fallbacks
 */
export function getRuntimePaths() {
  const resourcesPath = getResourcesPath();
  const platformFolder = getPlatformFolder();

  return {
    // FFmpeg from npm installer package
    ffmpeg: path.join(
      resourcesPath,
      'node_modules',
      '@ffmpeg-installer',
      platformFolder,
      getBinaryName('ffmpeg')
    ),

    // FFprobe from npm installer package
    ffprobe: path.join(
      resourcesPath,
      'node_modules',
      '@ffprobe-installer',
      platformFolder,
      getBinaryName('ffprobe')
    ),

    // yt-dlp from utilities folder (packaged) or system (development)
    ytdlp: isPackaged()
      ? path.join(
          resourcesPath,
          'utilities',
          'bin',
          getYtDlpBinaryName()
        )
      : findInPath('yt-dlp'), // Find system yt-dlp in development

    // Whisper from utilities folder (packaged) or system (development)
    whisper: isPackaged()
      ? path.join(
          resourcesPath,
          'utilities',
          'bin',
          process.platform === 'win32' ? 'whisper.exe' : 'whisper'
        )
      : findInPath('whisper'), // Find system whisper in development

    // Python from bundled runtime
    python: isPackaged()
      ? path.join(
          resourcesPath,
          'python',
          'bin',
          process.platform === 'win32' ? 'python.exe' : 'python3'
        )
      : findInPath(process.platform === 'win32' ? 'python' : 'python3'), // Find system Python in development

    // Backend entry point
    backend: path.join(resourcesPath, 'backend', 'dist', 'main.js'),
  };
}

/**
 * Get user data directory (for databases, cache, config)
 * Only works when called from Electron context
 */
export function getUserDataPath(): string {
  if (!app) {
    throw new Error('getUserDataPath() can only be called from Electron main process');
  }
  return app.getPath('userData');
}

/**
 * Get cache directory (for Whisper models, etc.)
 * Only works when called from Electron context
 */
export function getCachePath(): string {
  return path.join(getUserDataPath(), 'cache');
}

/**
 * Get logs directory
 * Only works when called from Electron context
 */
export function getLogsPath(): string {
  if (!app) {
    throw new Error('getLogsPath() can only be called from Electron main process');
  }
  return app.getPath('logs');
}
