/**
 * Runtime path resolution for bundled binaries
 * ALWAYS uses packaged binaries - NEVER falls back to system
 *
 * Works in both Electron main process AND backend Node.js process
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

  // Check environment variable set by production build
  if (process.env.NODE_ENV === 'production') {
    return true;
  }

  // If process.resourcesPath exists, check if it's actually packaged
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
 * In dev mode, this is the project root
 * In packaged mode, this is the resources folder
 */
function getResourcesPath(): string {
  // In packaged app, use process.resourcesPath
  if ((process as any).resourcesPath && isPackaged()) {
    return (process as any).resourcesPath;
  }

  // If electron app is available and packaged
  if (app?.getAppPath && isPackaged()) {
    return path.dirname(app.getAppPath());
  }

  // Development: project root (where package.json is)
  // Check for CLIPCHIMP_PROJECT_ROOT env var first (set by dev scripts)
  if (process.env.CLIPCHIMP_PROJECT_ROOT) {
    return process.env.CLIPCHIMP_PROJECT_ROOT;
  }

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
 * Get the Python directory path
 * In dev: dist-python/python-x64 (or python-arm64)
 * In prod: resources/python
 */
function getPythonDir(resourcesPath: string): string {
  if (isPackaged()) {
    return path.join(resourcesPath, 'python');
  }

  // In development, use the dist-python folder created by package-python-windows.js
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return path.join(resourcesPath, 'dist-python', `python-${arch}`);
}

/**
 * Get all binary paths
 * ALWAYS uses packaged/bundled binaries - NEVER falls back to system
 */
export function getRuntimePaths() {
  const resourcesPath = getResourcesPath();
  const platformFolder = getPlatformFolder();
  const pythonDir = getPythonDir(resourcesPath);

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

    // yt-dlp from utilities folder - ALWAYS bundled
    ytdlp: path.join(
      resourcesPath,
      'utilities',
      'bin',
      getYtDlpBinaryName()
    ),

    // Whisper - no longer used directly (we use Python whisper now)
    // Kept for backward compatibility but points to utilities folder
    whisper: path.join(
      resourcesPath,
      'utilities',
      'bin',
      process.platform === 'win32' ? 'whisper.exe' : 'whisper'
    ),

    // Python from bundled runtime - ALWAYS bundled
    // Windows: python.exe in root of python dir (embedded package)
    // macOS/Linux: bin/python3 (standard layout)
    python: process.platform === 'win32'
      ? path.join(pythonDir, 'python.exe')
      : path.join(pythonDir, 'bin', 'python3'),

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
