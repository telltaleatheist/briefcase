// ClipChimp/backend/src/downloader/yt-dlp-manager.ts
import * as fs from 'fs';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import {
  YtDlpBridge,
  getRuntimePaths,
  verifyBinary,
  type YtDlpProgress as BridgeProgress,
} from '../bridges';

export interface YtDlpProgress {
  percent: number;
  totalSize: number;
  downloadedBytes: number;
  downloadSpeed: number;
  eta: number;
}

export interface YtDlpRetryInfo {
  attempt: number;
  maxRetries: number;
  error: string;
}

export interface YtDlpFileInfo {
  filename: string;
  size: number;
  extension: string;
  format: string;
}

@Injectable()
export class YtDlpManager extends EventEmitter {
  private readonly logger = new Logger(YtDlpManager.name);
  private inputUrl: string | null = null;
  private outputTemplate: string | null = null;
  private options: string[] = [];
  private ytdlp: YtDlpBridge;
  private ffmpegPath: string;
  private currentProcessId: string | null = null;
  private aborted = false;

  constructor() {
    super();

    // Get paths from runtime-paths or environment
    let ytdlpPath = process.env.YT_DLP_PATH;
    let ffmpegPath = process.env.FFMPEG_PATH;

    const runtimePaths = getRuntimePaths();

    if (!ytdlpPath || !fs.existsSync(ytdlpPath)) {
      ytdlpPath = runtimePaths.ytdlp;
    }

    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      ffmpegPath = runtimePaths.ffmpeg;
    }

    this.ffmpegPath = ffmpegPath;

    // Verify yt-dlp exists (ffmpeg verification is optional for downloads)
    if (path.isAbsolute(ytdlpPath) && !fs.existsSync(ytdlpPath)) {
      this.logger.error(`yt-dlp not found at: ${ytdlpPath}`);
      throw new Error(`yt-dlp executable not found at path: ${ytdlpPath}`);
    }

    // Initialize the YtDlpBridge
    this.ytdlp = new YtDlpBridge(ytdlpPath, { ffmpegPath });

    // Forward progress events from bridge to this manager (translate format)
    this.ytdlp.on('progress', (progress: BridgeProgress) => {
      this.emit('progress', {
        percent: progress.percent,
        totalSize: progress.totalSize,
        downloadedBytes: progress.downloadedBytes,
        downloadSpeed: progress.downloadSpeed,
        eta: progress.eta,
      } as YtDlpProgress);
    });

    this.logger.log(`YtDlpManager initialized with binary: ${ytdlpPath}`);
  }

  /**
   * Set the input URL for the download
   */
  input(url: string): YtDlpManager {
    // Just remove trailing slashes, but KEEP the query string (critical for YouTube, etc.)
    const cleanUrl = url.replace(/\/+$/, '');
    this.inputUrl = cleanUrl;
    return this;
  }

  /**
   * Set the output template for the download
   */
  output(template: string): YtDlpManager {
    this.outputTemplate = template;
    return this;
  }

  /**
   * Add a command-line option to the yt-dlp command
   */
  addOption(option: string, value?: string): YtDlpManager {
    if (value !== undefined) {
      this.options.push(option, value);
    } else {
      this.options.push(option);
    }
    return this;
  }

  /**
   * Reset all options to defaults
   */
  reset(): YtDlpManager {
    this.inputUrl = null;
    this.outputTemplate = null;
    this.options = [];
    this.aborted = false;
    this.currentProcessId = null;
    return this;
  }

  /**
   * Cancel the current download operation
   */
  cancel(): void {
    if (this.currentProcessId && this.ytdlp.isRunning(this.currentProcessId)) {
      this.logger.log('Cancelling yt-dlp download');
      this.aborted = true;
      this.ytdlp.abort(this.currentProcessId);
    }
  }

  /**
   * Verify a file exists with retries
   */
  private async verifyFileExists(filePath: string, maxRetries = 10, interval = 500): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.debug(`Verifying file exists (attempt ${attempt}/${maxRetries}): ${filePath}`);
      try {
        await fs.promises.access(filePath);
        this.logger.log(`Verified output file exists: ${filePath}`);
        return true;
      } catch (error) {
        if (attempt === maxRetries) {
          this.logger.warn(`File not found after ${maxRetries} attempts: ${filePath}`);
          return false;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
    return false;
  }

  /**
   * Execute the yt-dlp command with the configured options
   */
  async run(): Promise<string> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }

    // Reset abort flag
    this.aborted = false;

    // Build additional args from options
    const additionalArgs: string[] = [];
    const isDumpJson = this.options.includes('--dump-json');

    // Add other options (but skip progress-template for JSON dumps)
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];

      // Skip progress-template handling - bridge handles this
      if (option === '--progress-template') {
        i++; // Skip value too
        continue;
      }

      additionalArgs.push(option);
    }

    // Generate a unique process ID
    const processId = `download-${Date.now()}`;
    this.currentProcessId = processId;

    this.logger.log(`Starting download: ${this.inputUrl}`);

    try {
      const result = await this.ytdlp.download(
        this.inputUrl,
        this.outputTemplate || '%(title)s.%(ext)s',
        {
          processId,
          additionalArgs,
        }
      );

      this.currentProcessId = null;

      if (this.aborted) {
        throw new Error('Download was cancelled');
      }

      if (!result.success) {
        throw new Error(result.error || `yt-dlp exited with code ${result.exitCode}`);
      }

      return result.stdout;
    } catch (error) {
      this.currentProcessId = null;
      throw error;
    }
  }

  /**
   * Execute the yt-dlp command with automatic retries
   */
  async runWithRetry(maxRetries = 3, delayMs = 1000): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.run();
      } catch (error: unknown) {
        const errorObj: Error = error instanceof Error
          ? error
          : new Error(String(error));

        // If the operation was canceled, don't retry
        if (errorObj.message.includes('cancelled') || this.aborted) {
          throw errorObj;
        }

        lastError = errorObj;
        this.logger.log(`yt-dlp execution failed (attempt ${attempt}/${maxRetries}): ${errorObj.message}`);

        if (attempt < maxRetries) {
          // Emit retry event
          this.emit('retry', {
            attempt,
            maxRetries,
            error: errorObj.message
          });

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delayMs));

          // Increase delay for next retry (exponential backoff)
          delayMs *= 2;
        }
      }
    }

    // If we get here, all retries failed
    throw lastError || new Error('All retry attempts failed');
  }

  /**
   * Get video information without downloading
   */
  async getVideoInfo(): Promise<any> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }

    try {
      return await this.ytdlp.getVideoInfo(this.inputUrl);
    } catch (error) {
      const errorObj = error instanceof Error
        ? error
        : new Error(String(error));

      this.logger.error(`Failed to get video info: ${errorObj.message}`);
      throw errorObj;
    }
  }

  /**
   * Check if a URL is supported by yt-dlp
   */
  async checkUrl(): Promise<boolean> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }

    return this.ytdlp.checkUrl(this.inputUrl);
  }

  /**
   * Update yt-dlp to the latest version
   */
  async updateYtDlp(): Promise<boolean> {
    return this.ytdlp.update();
  }

  /**
   * Get the current version of yt-dlp
   */
  async getYtDlpVersion(): Promise<string> {
    return this.ytdlp.getVersion();
  }
}
