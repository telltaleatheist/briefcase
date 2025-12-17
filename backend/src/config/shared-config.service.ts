// backend/src/config/shared-config.service.ts
// SIMPLIFIED: ALWAYS use bundled binaries - NEVER use system binaries or environment variables
import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';

// Import bundled binary path resolver
// NEVER uses environment variables for binary paths to prevent using system binaries
const getRuntimePaths = () => {
  // Try to load runtime-paths module - this is the ONLY source of binary paths
  try {
    // In development, use CLIPCHIMP_PROJECT_ROOT (set by Electron)
    // Check this FIRST because RESOURCES_PATH points to electron's resources in dev mode
    if (process.env.CLIPCHIMP_PROJECT_ROOT) {
      const runtimePathsFile = path.join(process.env.CLIPCHIMP_PROJECT_ROOT, 'dist-electron', 'shared', 'runtime-paths.js');
      return require(runtimePathsFile).getRuntimePaths();
    }
    // In packaged app, use RESOURCES_PATH env var to locate the module
    if (process.env.RESOURCES_PATH) {
      const runtimePathsFile = path.join(process.env.RESOURCES_PATH, 'dist-electron', 'shared', 'runtime-paths.js');
      return require(runtimePathsFile).getRuntimePaths();
    }
    // Fallback to relative path
    return require('../../../dist-electron/shared/runtime-paths').getRuntimePaths();
  } catch (error: any) {
    // NO FALLBACK - throw error instead of using system binaries
    throw new Error(
      'runtime-paths module not available. ' +
      'This usually means the app was not started correctly. ' +
      'In development, use: npm run electron:dev (NOT npm run start:dev). ' +
      'The backend must be spawned by Electron to receive proper binary paths. ' +
      'Original error: ' + error.message
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
    return getRuntimePaths().whisperCpp;
  }

  getWhisperModelPath(): string {
    return getRuntimePaths().whisperModel;
  }

  getOutputDir(): string | undefined {
    // Output directory is now handled by the library's clips folder
    return undefined;
  }

  getConfig() {
    return {
      ffmpegPath: this.getFfmpegPath(),
      ffprobePath: this.getFfprobePath(),
      ytDlpPath: this.getYtDlpPath(),
      whisperPath: this.getWhisperPath(),
      whisperModelPath: this.getWhisperModelPath(),
      aiModel: process.env.AI_MODEL || 'qwen2.5:7b',
      ollamaEndpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
    };
  }

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

  refreshConfig(): void {
    // No-op - paths are determined at runtime from bundled binaries
  }
}
