// backend/src/config/shared-config.service.ts
// SIMPLIFIED: No more user configuration, just use bundled binaries
import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';

// Import simple runtime path resolver
// Priority: Environment variables (passed from Electron) > runtime-paths module
// NO FALLBACK TO SYSTEM BINARIES - app must be started correctly
const getRuntimePaths = () => {
  // First check environment variables - these are set by Electron when spawning the backend
  if (process.env.FFMPEG_PATH && process.env.YT_DLP_PATH) {
    // All required env vars must be set - no partial fallbacks
    if (!process.env.FFMPEG_PATH || !process.env.FFPROBE_PATH || !process.env.YT_DLP_PATH || !process.env.PYTHON_PATH) {
      throw new Error(
        'Incomplete binary paths. Required env vars: FFMPEG_PATH, FFPROBE_PATH, YT_DLP_PATH, PYTHON_PATH. ' +
        'App must be started via Electron which sets these paths.'
      );
    }
    return {
      ffmpeg: process.env.FFMPEG_PATH,
      ffprobe: process.env.FFPROBE_PATH,
      ytdlp: process.env.YT_DLP_PATH,
      whisper: process.env.WHISPER_PATH || '', // Optional - whisper-cpp may not be installed
      whisperCpp: process.env.WHISPER_CPP_PATH || '',
      whisperModel: process.env.WHISPER_MODEL_PATH || '',
      python: process.env.PYTHON_PATH
    };
  }

  // Try to load runtime-paths module
  try {
    // In packaged app, use RESOURCES_PATH env var
    if (process.env.RESOURCES_PATH) {
      const runtimePathsFile = path.join(process.env.RESOURCES_PATH, 'dist-electron', 'shared', 'runtime-paths.js');
      return require(runtimePathsFile).getRuntimePaths();
    }
    // In development, use relative path
    return require('../../../dist-electron/shared/runtime-paths').getRuntimePaths();
  } catch (error) {
    // NO FALLBACK - throw error instead of using system binaries
    throw new Error(
      'runtime-paths module not available and no environment variables set. ' +
      'This usually means the app was not started correctly. ' +
      'In development, use: npm run electron:dev (NOT npm run start:dev). ' +
      'The backend must be spawned by Electron to receive proper binary paths.'
    );
  }
};

@Injectable()
export class SharedConfigService {
  private static instance: SharedConfigService;
  private readonly logger = new Logger(SharedConfigService.name);

  private constructor() {
    this.logger.log('SharedConfigService initialized with bundled binaries');
  }

  static getInstance(): SharedConfigService {
    if (!SharedConfigService.instance) {
      SharedConfigService.instance = new SharedConfigService();
    }
    return SharedConfigService.instance;
  }

  getFfmpegPath(): string {
    return getRuntimePaths().ffmpeg;
  }

  getFfprobePath(): string {
    return getRuntimePaths().ffprobe;
  }

  getYtDlpPath(): string {
    return getRuntimePaths().ytdlp;
  }

  getWhisperPath(): string {
    return getRuntimePaths().whisper;
  }

  getPythonPath(): string {
    return getRuntimePaths().python;
  }

  // Legacy method - no longer needed but kept for compatibility
  getOutputDir(): string | undefined {
    return undefined;
  }

  // Legacy method - no longer needed but kept for compatibility
  getConfig(): any {
    return {
      ffmpegPath: this.getFfmpegPath(),
      ffprobePath: this.getFfprobePath(),
      ytDlpPath: this.getYtDlpPath(),
      whisperPath: this.getWhisperPath()
    };
  }

  // Legacy method - no longer needed but kept for compatibility
  getConfigDir(): string {
    const os = require('os');
    const path = require('path');
    const homeDir = os.homedir();

    if (process.platform === 'darwin') {
      return path.join(homeDir, 'Library', 'Application Support', 'ClipChimp');
    } else if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'ClipChimp');
    } else {
      return path.join(homeDir, '.config', 'ClipChimp');
    }
  }

  // No longer needed - paths are fixed to bundled binaries
  refreshConfig(): void {
    this.logger.log('refreshConfig called (no-op - using bundled binaries)');
  }
}
