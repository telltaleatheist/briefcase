/**
 * YT-DLP Bridge - Process wrapper for yt-dlp binary
 * Supports video downloading with progress tracking and multiple concurrent downloads
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { Logger } from '@nestjs/common';

export interface YtDlpProgress {
  processId: string;
  percent: number;
  totalSize: number;
  downloadedBytes: number;
  downloadSpeed: number;
  eta: number;
  phase: 'download' | 'postprocess' | 'complete';
}

export interface YtDlpProcessInfo {
  id: string;
  process: ChildProcess;
  url: string;
  args: string[];
  startTime: number;
  aborted: boolean;
}

export interface YtDlpResult {
  processId: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  stdout: string;
  error?: string;
}

export interface YtDlpVideoInfo {
  id: string;
  title: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  upload_date?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  thumbnail?: string;
  webpage_url?: string;
  extractor?: string;
  format?: string;
  formats?: any[];
  [key: string]: any;
}

export interface YtDlpConfig {
  ffmpegPath?: string;  // Path to FFmpeg for post-processing
}

export class YtDlpBridge extends EventEmitter {
  private binaryPath: string;
  private config: YtDlpConfig;
  private activeProcesses = new Map<string, YtDlpProcessInfo>();
  private readonly logger = new Logger(YtDlpBridge.name);

  constructor(ytdlpPath: string, config: YtDlpConfig = {}) {
    super();
    this.binaryPath = ytdlpPath;
    this.config = config;
    this.logger.log(`Initialized with binary: ${ytdlpPath}`);
  }

  /**
   * Get platform-appropriate browser impersonation target
   * Uses Chrome with curl_cffi to bypass Cloudflare bot detection
   */
  private getImpersonateTarget(): string {
    switch (process.platform) {
      case 'win32':
        return 'chrome-116:windows-10';
      case 'darwin':
        return 'chrome-131:macos-14';
      default: // linux
        return 'chrome-131:macos-14'; // No linux targets, macOS works fine
    }
  }

  /**
   * Get the binary path
   */
  get path(): string {
    return this.binaryPath;
  }

  /**
   * Download a video
   */
  download(
    url: string,
    outputTemplate: string,
    options?: {
      format?: string;
      processId?: string;
      mergeOutputFormat?: string;
      extractAudio?: boolean;
      audioFormat?: string;
      audioQuality?: string;
      cookies?: string;
      cookiesFromBrowser?: string;
      noPlaylist?: boolean;
      playlistItems?: string;
      extractorArgs?: string;
      additionalArgs?: string[];
    }
  ): Promise<YtDlpResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    return new Promise((resolve, reject) => {
      const args: string[] = [];

      // Output template
      args.push('-o', outputTemplate);

      // Progress template for parsing
      args.push('--progress-template', '%(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s eta %(progress.eta)s [%(progress._percent_str)s]');

      // Impersonate Chrome to bypass anti-bot protection (Rumble, etc.)
      // This uses curl_cffi to fully impersonate Chrome's TLS fingerprint
      // Must specify exact target - generic "chrome" doesn't work reliably
      args.push('--impersonate', this.getImpersonateTarget());

      // Format selection
      if (options?.format) {
        args.push('-f', options.format);
      }

      // Merge output format
      if (options?.mergeOutputFormat) {
        args.push('--merge-output-format', options.mergeOutputFormat);
      }

      // Audio extraction
      if (options?.extractAudio) {
        args.push('-x');
        if (options.audioFormat) {
          args.push('--audio-format', options.audioFormat);
        }
        if (options.audioQuality) {
          args.push('--audio-quality', options.audioQuality);
        }
      }

      // Cookies
      if (options?.cookies) {
        args.push('--cookies', options.cookies);
      }
      if (options?.cookiesFromBrowser) {
        args.push('--cookies-from-browser', options.cookiesFromBrowser);
      }

      // Playlist options
      if (options?.noPlaylist) {
        args.push('--no-playlist');
      }
      if (options?.playlistItems) {
        args.push('--playlist-items', options.playlistItems);
      }

      // Extractor args
      if (options?.extractorArgs) {
        args.push('--extractor-args', options.extractorArgs);
      }

      // FFmpeg path for post-processing
      if (this.config.ffmpegPath) {
        args.push('--ffmpeg-location', this.config.ffmpegPath);
      }

      // Force overwrite
      args.push('--force-overwrites');

      // Additional custom args
      if (options?.additionalArgs) {
        args.push(...options.additionalArgs);
      }

      // URL last
      args.push(url);

      this.logger.log(`[${processId}] Starting download: ${url}`);
      this.logger.log(`[${processId}] Args: ${args.join(' ')}`);

      const proc = spawn(this.binaryPath, args);
      const startTime = Date.now();

      const processInfo: YtDlpProcessInfo = {
        id: processId,
        process: proc,
        url,
        args,
        startTime,
        aborted: false,
      };

      this.activeProcesses.set(processId, processInfo);

      let stdoutBuffer = '';
      let stderrBuffer = '';

      // Process stdout for progress
      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;

        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.parseProgress(processId, line);
          }
        }
      });

      // Process stderr line by line for real-time progress
      if (proc.stderr) {
        const stderrReader = readline.createInterface({
          input: proc.stderr,
          terminal: false,
        });

        stderrReader.on('line', (line) => {
          stderrBuffer += line + '\n';
          this.parseProgress(processId, line);
        });
      }

      proc.on('close', (code) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        if (processInfo.aborted) {
          this.logger.log(`[${processId}] Aborted after ${duration}ms`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
            error: 'Download was cancelled',
          });
          return;
        }

        if (code === 0) {
          this.logger.log(`[${processId}] Completed successfully in ${duration}ms`);

          // Emit final progress
          this.emit('progress', {
            processId,
            percent: 100,
            totalSize: 0,
            downloadedBytes: 0,
            downloadSpeed: 0,
            eta: 0,
            phase: 'complete',
          } as YtDlpProgress);

          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
          });
        } else {
          this.logger.error(`[${processId}] Failed with code ${code}`);
          this.logger.error(`[${processId}] stderr: ${stderrBuffer.slice(-500)}`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            stdout: stdoutBuffer,
            error: `yt-dlp exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        this.logger.error(`[${processId}] Spawn error: ${err.message}`);

        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`yt-dlp binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`yt-dlp binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Get video information without downloading
   */
  async getVideoInfo(url: string, options?: { processId?: string }): Promise<YtDlpVideoInfo> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    const args = [
      '--dump-json',
      '--no-playlist',
      '--flat-playlist',
      '--impersonate', this.getImpersonateTarget(),
      url,
    ];

    this.logger.log(`[${processId}] Getting video info: ${url}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const info = JSON.parse(stdout.trim());
            resolve(info);
          } catch (e) {
            reject(new Error(`Failed to parse video info: ${e}`));
          }
        } else {
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        if (err.message.includes('ENOENT')) {
          reject(new Error(`yt-dlp binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Check if a URL is supported
   */
  async checkUrl(url: string): Promise<boolean> {
    const args = [
      '--simulate',
      '--quiet',
      '--impersonate', this.getImpersonateTarget(),
      url,
    ];

    return new Promise((resolve) => {
      const proc = spawn(this.binaryPath, args);

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Get yt-dlp version
   */
  async getVersion(): Promise<string> {
    const args = ['--version'];

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Failed to get version`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Update yt-dlp to latest version
   */
  async update(): Promise<boolean> {
    const args = ['--update'];

    return new Promise((resolve) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('close', (code) => {
        resolve(code === 0 || stdout.includes('Updated'));
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Abort a running download
   */
  abort(processId: string): boolean {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) {
      this.logger.warn(`Cannot abort ${processId}: not found`);
      return false;
    }

    this.logger.log(`[${processId}] Aborting download`);
    processInfo.aborted = true;

    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${processInfo.process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        processInfo.process.kill('SIGKILL');
      }
    } else {
      processInfo.process.kill('SIGTERM');
    }

    return true;
  }

  /**
   * Abort all running downloads
   */
  abortAll(): void {
    this.logger.log(`Aborting all ${this.activeProcesses.size} downloads`);
    for (const processId of this.activeProcesses.keys()) {
      this.abort(processId);
    }
  }

  /**
   * Get list of active process IDs
   */
  getActiveProcesses(): string[] {
    return Array.from(this.activeProcesses.keys());
  }

  /**
   * Check if a download is running
   */
  isRunning(processId: string): boolean {
    return this.activeProcesses.has(processId);
  }

  /**
   * Parse progress from yt-dlp output
   */
  private parseProgress(processId: string, line: string): void {
    // Try progress template format: bytes/total speed eta time [percent%]
    const templateMatch = line.match(/(\d+)\/(\d+)\s+([\d.]+)\s+eta\s+(\S+)\s+\[\s*([\d.]+)%\]/);
    if (templateMatch) {
      const [, downloaded, total, speed, eta, percent] = templateMatch;

      this.emit('progress', {
        processId,
        percent: parseFloat(percent),
        totalSize: parseInt(total),
        downloadedBytes: parseInt(downloaded),
        downloadSpeed: parseFloat(speed),
        eta: eta !== 'NA' ? parseFloat(eta) : 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Try standard download format: [download] 32.5% of ~50.33MiB at 2.43MiB/s ETA 00:20
    // Also handles HLS format: [download]   0.1% of ~   3.26GiB at    4.04MiB/s ETA Unknown (frag 1/1371)
    const downloadMatch = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*)\s*(\w+)\s+at\s+(\d+\.?\d*)\s*(\w+\/s)\s+ETA\s+(\S+)/);
    if (downloadMatch) {
      const [, percent, size, sizeUnit, speed, speedUnit, eta] = downloadMatch;

      let totalBytes = parseFloat(size);
      if (sizeUnit === 'KiB') totalBytes *= 1024;
      if (sizeUnit === 'MiB') totalBytes *= 1024 * 1024;
      if (sizeUnit === 'GiB') totalBytes *= 1024 * 1024 * 1024;

      let bytesPerSec = parseFloat(speed);
      if (speedUnit.startsWith('KiB')) bytesPerSec *= 1024;
      if (speedUnit.startsWith('MiB')) bytesPerSec *= 1024 * 1024;
      if (speedUnit.startsWith('GiB')) bytesPerSec *= 1024 * 1024 * 1024;

      const downloadedBytes = totalBytes * (parseFloat(percent) / 100);

      // Parse ETA - could be "00:20" or "Unknown"
      let etaSeconds = 0;
      if (eta !== 'Unknown' && eta.includes(':')) {
        const parts = eta.split(':').map(Number);
        if (parts.length === 2) {
          etaSeconds = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
          etaSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      }

      this.emit('progress', {
        processId,
        percent: parseFloat(percent),
        totalSize: totalBytes,
        downloadedBytes,
        downloadSpeed: bytesPerSec,
        eta: etaSeconds,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Try HLS fragment progress: (frag 123/1371) - extract percent from fragment ratio
    const fragMatch = line.match(/\(frag\s+(\d+)\/(\d+)\)/);
    if (fragMatch) {
      const [, current, total] = fragMatch;
      const fragPercent = (parseInt(current) / parseInt(total)) * 100;

      this.emit('progress', {
        processId,
        percent: fragPercent,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
      return;
    }

    // Post-processing indicators
    if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[ffmpeg]') || line.includes('Deleting original file')) {
      this.emit('progress', {
        processId,
        percent: 95,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0,
        phase: 'postprocess',
      } as YtDlpProgress);
      return;
    }

    // Download started
    if (line.includes('[download] Destination:')) {
      this.emit('progress', {
        processId,
        percent: 0,
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0,
        phase: 'download',
      } as YtDlpProgress);
    }
  }
}
