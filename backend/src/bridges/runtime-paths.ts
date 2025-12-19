/**
 * Runtime path resolution for bundled binaries
 * Central source of truth for all binary locations in the backend
 */

import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';

const logger = new Logger('RuntimePaths');

/**
 * Check if running in a packaged Electron app
 */
export function isPackaged(): boolean {
  // Check environment variable set by Electron
  if (process.env.NODE_ENV === 'production') {
    return true;
  }

  // If process.resourcesPath exists, check if it's actually packaged
  const resourcesPath = (process as any).resourcesPath;
  if (resourcesPath) {
    // If the path contains 'node_modules/electron', we're in development
    if (resourcesPath.includes('node_modules/electron') || resourcesPath.includes('node_modules\\electron')) {
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
export function getResourcesPath(): string {
  // In packaged app, use process.resourcesPath
  if ((process as any).resourcesPath && isPackaged()) {
    return (process as any).resourcesPath;
  }

  // Development: project root (where package.json is)
  // Check for CLIPCHIMP_PROJECT_ROOT env var first (set by dev scripts)
  if (process.env.CLIPCHIMP_PROJECT_ROOT) {
    return process.env.CLIPCHIMP_PROJECT_ROOT;
  }

  // Backend runs from backend/ subdir, go up one level for project root
  const backendDir = process.cwd();
  if (backendDir.endsWith('backend')) {
    return path.dirname(backendDir);
  }

  return process.cwd();
}

/**
 * Get platform folder for npm installer packages
 */
export function getPlatformFolder(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'win32-x64';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  return 'linux-x64';
}

/**
 * Get platform-specific binary extension
 */
export function getBinaryExtension(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

/**
 * Get whisper binary name for current platform/architecture
 */
function getWhisperBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'whisper-cli.exe';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'whisper-cli-arm64' : 'whisper-cli-x64';
  }
  return 'whisper-cli';
}

/**
 * Get llama-server binary name for current platform/architecture
 */
function getLlamaBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'llama-server.exe';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'llama-server-arm64' : 'llama-server-x64';
  }
  return 'llama-server';
}

/**
 * Get yt-dlp binary path relative to utilities/bin
 * ALL platforms use "onedir" builds (pre-extracted, fast startup)
 */
function getYtDlpRelativePath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join('yt-dlp_win_dir', 'yt-dlp.exe');
  }
  if (platform === 'darwin') {
    return path.join('yt-dlp_macos_dir', 'yt-dlp_macos');
  }
  // Linux
  return path.join('yt-dlp_linux_dir', 'yt-dlp_linux');
}

/**
 * Runtime paths configuration
 */
export interface RuntimePaths {
  ffmpeg: string;
  ffprobe: string;
  ytdlp: string;
  whisper: string;
  whisperModelsDir: string;
  llama: string;
  llamaModelsDir: string;
}

/**
 * Get all runtime binary paths
 */
export function getRuntimePaths(): RuntimePaths {
  const resourcesPath = getResourcesPath();
  const platformFolder = getPlatformFolder();
  const ext = getBinaryExtension();

  let ffmpegPath: string;
  let ffprobePath: string;
  let ytdlpPath: string;
  let whisperPath: string;
  let llamaPath: string;

  if (isPackaged()) {
    // Packaged: binaries in resources/node_modules (for ffmpeg/ffprobe)
    // and resources/utilities/bin (for whisper, yt-dlp, and llama)
    ffmpegPath = path.join(resourcesPath, 'node_modules', '@ffmpeg-installer', platformFolder, `ffmpeg${ext}`);
    ffprobePath = path.join(resourcesPath, 'node_modules', '@ffprobe-installer', platformFolder, `ffprobe${ext}`);
    ytdlpPath = path.join(resourcesPath, 'utilities', 'bin', getYtDlpRelativePath());
    whisperPath = path.join(resourcesPath, 'utilities', 'bin', getWhisperBinaryName());
    llamaPath = path.join(resourcesPath, 'utilities', 'bin', getLlamaBinaryName());
  } else {
    // Development: ffmpeg from npm package, yt-dlp, whisper, and llama from utilities/bin
    ffmpegPath = path.join(
      resourcesPath,
      'node_modules',
      '@ffmpeg-installer',
      platformFolder,
      `ffmpeg${ext}`
    );
    ffprobePath = path.join(
      resourcesPath,
      'node_modules',
      '@ffprobe-installer',
      platformFolder,
      `ffprobe${ext}`
    );
    ytdlpPath = path.join(resourcesPath, 'utilities', 'bin', getYtDlpRelativePath());
    whisperPath = path.join(resourcesPath, 'utilities', 'bin', getWhisperBinaryName());
    llamaPath = path.join(resourcesPath, 'utilities', 'bin', getLlamaBinaryName());
  }

  return {
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath,
    ytdlp: ytdlpPath,
    whisper: whisperPath,
    whisperModelsDir: path.join(resourcesPath, 'utilities', 'models'),
    llama: llamaPath,
    llamaModelsDir: path.join(resourcesPath, 'utilities', 'models', 'llama'),
  };
}

/**
 * Verify a binary exists and optionally check architecture (macOS)
 */
export function verifyBinary(binaryPath: string, name: string): void {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`${name} binary not found at: ${binaryPath}`);
  }

  // Verify architecture on macOS
  if (process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`file "${binaryPath}"`, { encoding: 'utf8' });
      const expectedArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      const hasCorrectArch = result.includes(expectedArch) || result.includes('universal');

      if (!hasCorrectArch) {
        throw new Error(
          `${name} has wrong architecture. Expected: ${expectedArch}, Got: ${result.trim()}`
        );
      }
    } catch (err: any) {
      if (err.message?.includes('wrong architecture')) {
        throw err;
      }
      // Ignore verification errors (e.g., if 'file' command not available)
    }
  }
}

/**
 * Get DYLD_LIBRARY_PATH for whisper dylibs (macOS)
 */
export function getWhisperLibraryPath(): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }

  const resourcesPath = getResourcesPath();
  const binDir = path.join(resourcesPath, 'utilities', 'bin');

  return binDir;
}

/**
 * Get DYLD_LIBRARY_PATH for llama dylibs (macOS)
 * Same location as whisper dylibs
 */
export function getLlamaLibraryPath(): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }

  const resourcesPath = getResourcesPath();
  const binDir = path.join(resourcesPath, 'utilities', 'bin');

  return binDir;
}
