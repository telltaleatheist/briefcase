/**
 * Simple runtime path resolution for bundled binaries
 * No user configuration, no auto-detection, no complexity
 * Just returns the paths to bundled binaries
 */

import * as path from 'path';
import { app } from 'electron';

/**
 * Check if we're running in a packaged app
 */
function isPackaged(): boolean {
  return app?.isPackaged ?? process.env.NODE_ENV === 'production';
}

/**
 * Get the base resources directory
 */
function getResourcesPath(): string {
  if (isPackaged()) {
    // Production: app.getAppPath() points to app.asar, go up one level to Resources
    return process.resourcesPath || path.dirname(app.getAppPath());
  } else {
    // Development: project root
    return process.cwd();
  }
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

    // yt-dlp from utilities folder
    ytdlp: path.join(
      resourcesPath,
      'utilities',
      'bin',
      getYtDlpBinaryName()
    ),

    // Python from bundled runtime
    python: isPackaged()
      ? path.join(
          resourcesPath,
          'python',
          'bin',
          process.platform === 'win32' ? 'python.exe' : 'python3'
        )
      : 'python3', // Use system Python in development

    // Backend entry point
    backend: path.join(resourcesPath, 'backend', 'dist', 'main.js'),
  };
}

/**
 * Get user data directory (for databases, cache, config)
 */
export function getUserDataPath(): string {
  return app.getPath('userData');
}

/**
 * Get cache directory (for Whisper models, etc.)
 */
export function getCachePath(): string {
  return path.join(getUserDataPath(), 'cache');
}

/**
 * Get logs directory
 */
export function getLogsPath(): string {
  return app.getPath('logs');
}
