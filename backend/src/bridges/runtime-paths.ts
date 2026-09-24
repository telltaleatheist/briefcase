/**
 * Runtime path resolution for bundled binaries
 * Central source of truth for all binary locations in the backend
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Logger } from '@nestjs/common';

const logger = new Logger('RuntimePaths');

/**
 * Downloaded-component resolution (download-on-demand).
 *
 * Binaries fetched by ComponentManagerService live under
 * <configDir>/components/<id>/, recorded in components/installed.json. We must
 * derive <configDir> without Electron's `app` (the backend is a plain Node
 * process), mirroring ComponentManagerService / SharedConfigService.getConfigDir().
 */
interface DownloadedRecord {
  dir: string;
  entry: string;
  kind: string;
}

export function getBriefcaseConfigDir(): string {
  const userDataPath =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support')
      : path.join(process.env.HOME || os.homedir(), '.config'));
  return path.join(userDataPath, 'briefcase');
}

function getDownloadedComponents(): Record<string, DownloadedRecord> {
  try {
    const p = path.join(getBriefcaseConfigDir(), 'components', 'installed.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')).components || {};
    }
  } catch {
    // ignore — fall back to bundled
  }
  return {};
}

/** Absolute path to a downloaded component's file, or null if not installed/missing. */
function downloadedEntry(
  comps: Record<string, DownloadedRecord>,
  id: string,
  fileOverride?: string,
): string | null {
  const rec = comps[id];
  if (!rec) return null;
  const full = path.join(rec.dir, fileOverride || rec.entry);
  return fs.existsSync(full) ? full : null;
}

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
  // Check for BRIEFCASE_PROJECT_ROOT env var first (set by dev scripts)
  if (process.env.BRIEFCASE_PROJECT_ROOT) {
    return process.env.BRIEFCASE_PROJECT_ROOT;
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

  if (isPackaged()) {
    // Packaged: binaries in resources/node_modules (for ffmpeg/ffprobe)
    // and resources/utilities/bin (for yt-dlp)
    ffmpegPath = path.join(resourcesPath, 'node_modules', '@ffmpeg-installer', platformFolder, `ffmpeg${ext}`);
    ffprobePath = path.join(resourcesPath, 'node_modules', '@ffprobe-installer', platformFolder, `ffprobe${ext}`);
    ytdlpPath = path.join(resourcesPath, 'utilities', 'bin', getYtDlpRelativePath());
  } else {
    // Development: ffmpeg from npm package, yt-dlp from utilities/bin
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
  }

  // Prefer downloaded components (download-on-demand) over bundled paths.
  const comps = getDownloadedComponents();
  ffmpegPath = downloadedEntry(comps, 'ffmpeg-tools', `ffmpeg${ext}`) || ffmpegPath;
  ffprobePath = downloadedEntry(comps, 'ffmpeg-tools', `ffprobe${ext}`) || ffprobePath;
  ytdlpPath = downloadedEntry(comps, 'yt-dlp') || ytdlpPath;

  return {
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath,
    ytdlp: ytdlpPath,
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
