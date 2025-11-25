// backend/src/config/shared-config.service.ts
// SIMPLIFIED: No more user configuration, just use bundled binaries
import { Injectable, Logger } from '@nestjs/common';

// Import simple runtime path resolver
const getRuntimePaths = () => {
  try {
    return require('../../../dist-electron/shared/runtime-paths').getRuntimePaths();
  } catch (error) {
    // Fallback for when runtime-paths isn't built yet (during development setup)
    console.warn('runtime-paths not available, using fallback');
    return {
      ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
      ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
      ytdlp: process.env.YT_DLP_PATH || 'yt-dlp',
      whisper: process.env.WHISPER_PATH || 'whisper',
      python: process.env.PYTHON_PATH || 'python'
    };
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
