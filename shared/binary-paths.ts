/**
 * Centralized Binary Path Configuration for Clippy
 *
 * This module provides a single source of truth for all binary paths (ffmpeg, ffprobe, yt-dlp)
 * ensuring consistent path resolution across development and production environments.
 *
 * IMPORTANT: Any changes to binary path detection MUST be made here and nowhere else.
 *
 * CONFIGURATION MODES:
 *
 * 1. DEVELOPMENT MODE:
 *    - NODE_ENV=development
 *    - Uses system-installed binaries or npm package binaries
 *
 * 2. PRODUCTION/PACKAGED MODE:
 *    - NODE_ENV=production
 *    - Uses bundled binaries from extraResources
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Configuration for a single binary
 */
export interface BinaryConfig {
  /** The full path to the binary executable */
  path: string;
  /** Whether the binary was found and is accessible */
  exists: boolean;
  /** The source where the binary was found (for debugging) */
  source: 'bundled' | 'npm-package' | 'environment' | 'system' | 'not-found';
}

/**
 * Configuration for all binaries
 */
export interface BinariesConfig {
  ffmpeg: BinaryConfig;
  ffprobe: BinaryConfig;
  ytdlp: BinaryConfig;
}

/**
 * Get the platform-specific folder name for npm installer packages
 */
function getPlatformFolder(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'win32-x64';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    return 'linux-x64';
  }

  return 'unknown';
}

/**
 * Get the binary name with platform-specific extension
 */
function getBinaryName(baseName: string): string {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

/**
 * Get yt-dlp binary name for the current platform
 */
function getYtDlpBinaryName(): string {
  const platform = process.platform;

  if (platform === 'win32') {
    return 'yt-dlp.exe';
  } else if (platform === 'darwin') {
    return 'yt-dlp_macos';
  } else {
    return 'yt-dlp_linux';
  }
}

/**
 * Check if we're running in a packaged app
 */
function isPackaged(): boolean {
  return process.env.NODE_ENV === 'production' ||
         (process as any).resourcesPath !== undefined ||
         (process as any).defaultApp === false;
}

/**
 * Get the resources path (where extraResources are located in production)
 */
function getResourcesPath(): string {
  if ((process as any).resourcesPath) {
    return (process as any).resourcesPath;
  }

  // Fallback for when resourcesPath is not set
  return process.env.RESOURCES_PATH || path.join(process.cwd(), 'resources');
}

/**
 * Get the app path (for development mode)
 */
function getAppPath(): string {
  // Try to get from Electron app if available
  try {
    const { app } = require('electron');
    return app.getAppPath();
  } catch {
    // Not in Electron context, use cwd
    return process.cwd();
  }
}

/**
 * Find ffmpeg binary path
 */
function findFfmpegPath(): BinaryConfig {
  const binaryName = getBinaryName('ffmpeg');
  const platformFolder = getPlatformFolder();

  // 1. Check environment variable
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return {
      path: process.env.FFMPEG_PATH,
      exists: true,
      source: 'environment'
    };
  }

  // 2. Check bundled location (production)
  if (isPackaged()) {
    const resourcesPath = getResourcesPath();

    const possiblePaths = [
      // extraResources location (preferred for production)
      path.join(resourcesPath, 'node_modules', '@ffmpeg-installer', platformFolder, binaryName),
      // backend/node_modules location (fallback)
      path.join(resourcesPath, 'backend', 'node_modules', '@ffmpeg-installer', platformFolder, binaryName),
      // app.asar.unpacked location (fallback)
      path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', platformFolder, binaryName),
    ];

    for (const candidatePath of possiblePaths) {
      if (fs.existsSync(candidatePath)) {
        return {
          path: candidatePath,
          exists: true,
          source: 'bundled'
        };
      }
    }
  }

  // 3. Check npm package location (development)
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
      return {
        path: ffmpegInstaller.path,
        exists: true,
        source: 'npm-package'
      };
    }
  } catch {
    // Package not available
  }

  // 4. Not found
  return {
    path: '',
    exists: false,
    source: 'not-found'
  };
}

/**
 * Find ffprobe binary path
 */
function findFfprobePath(): BinaryConfig {
  const binaryName = getBinaryName('ffprobe');
  const platformFolder = getPlatformFolder();

  // 1. Check environment variable
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return {
      path: process.env.FFPROBE_PATH,
      exists: true,
      source: 'environment'
    };
  }

  // 2. Check bundled location (production)
  if (isPackaged()) {
    const resourcesPath = getResourcesPath();

    const possiblePaths = [
      // extraResources location (preferred for production)
      path.join(resourcesPath, 'node_modules', '@ffprobe-installer', platformFolder, binaryName),
      // backend/node_modules location (fallback)
      path.join(resourcesPath, 'backend', 'node_modules', '@ffprobe-installer', platformFolder, binaryName),
      // app.asar.unpacked location (fallback)
      path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', platformFolder, binaryName),
    ];

    for (const candidatePath of possiblePaths) {
      if (fs.existsSync(candidatePath)) {
        return {
          path: candidatePath,
          exists: true,
          source: 'bundled'
        };
      }
    }
  }

  // 3. Check npm package location (development)
  try {
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    if (ffprobeInstaller && ffprobeInstaller.path && fs.existsSync(ffprobeInstaller.path)) {
      return {
        path: ffprobeInstaller.path,
        exists: true,
        source: 'npm-package'
      };
    }
  } catch {
    // Package not available
  }

  // 4. Not found
  return {
    path: '',
    exists: false,
    source: 'not-found'
  };
}

/**
 * Find yt-dlp binary path
 */
function findYtDlpPath(): BinaryConfig {
  const binaryName = getYtDlpBinaryName();

  // 1. Check environment variable
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    return {
      path: process.env.YT_DLP_PATH,
      exists: true,
      source: 'environment'
    };
  }

  // 2. Check bundled location (production)
  if (isPackaged()) {
    const resourcesPath = getResourcesPath();

    const possiblePaths = [
      // extraResources utilities location (preferred)
      path.join(resourcesPath, 'utilities', 'bin', binaryName),
      // app.asar.unpacked location (fallback)
      path.join(resourcesPath, 'app.asar.unpacked', 'utilities', 'bin', binaryName),
    ];

    for (const candidatePath of possiblePaths) {
      if (fs.existsSync(candidatePath)) {
        return {
          path: candidatePath,
          exists: true,
          source: 'bundled'
        };
      }
    }
  }

  // 3. Check development location
  const appPath = getAppPath();
  const possibleDevPaths = [
    path.join(appPath, 'utilities', 'bin', binaryName),
    path.join(__dirname, '..', 'utilities', 'bin', binaryName),
    path.join(__dirname, '..', '..', 'utilities', 'bin', binaryName),
  ];

  for (const candidatePath of possibleDevPaths) {
    if (fs.existsSync(candidatePath)) {
      return {
        path: candidatePath,
        exists: true,
        source: 'system'
      };
    }
  }

  // 4. Not found
  return {
    path: '',
    exists: false,
    source: 'not-found'
  };
}

/**
 * Get all binary paths
 * This is the main function that should be called to get binary configurations
 */
export function getBinariesConfig(): BinariesConfig {
  return {
    ffmpeg: findFfmpegPath(),
    ffprobe: findFfprobePath(),
    ytdlp: findYtDlpPath()
  };
}

/**
 * Validate that all required binaries are available
 *
 * @returns Object with validation results
 */
export function validateBinaries(): {
  valid: boolean;
  missing: string[];
  config: BinariesConfig;
} {
  const config = getBinariesConfig();
  const missing: string[] = [];

  if (!config.ffmpeg.exists) {
    missing.push('ffmpeg');
  }
  if (!config.ffprobe.exists) {
    missing.push('ffprobe');
  }
  if (!config.ytdlp.exists) {
    missing.push('yt-dlp');
  }

  return {
    valid: missing.length === 0,
    missing,
    config
  };
}

/**
 * Get just the ffmpeg path (for backward compatibility)
 */
export function getFfmpegPath(): string {
  return findFfmpegPath().path;
}

/**
 * Get just the ffprobe path (for backward compatibility)
 */
export function getFfprobePath(): string {
  return findFfprobePath().path;
}

/**
 * Get just the yt-dlp path (for backward compatibility)
 */
export function getYtDlpPath(): string {
  return findYtDlpPath().path;
}
