// ClipChimp/backend/src/downloader/yt-dlp-manager.ts
import * as fs from 'fs';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { SharedConfigService } from '../config/shared-config.service';
import * as readline from 'readline';
import * as logger from 'electron-log';
import { log } from 'electron-log';
import { getPythonConfig } from '../shared/python-config';

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
  private inputUrl: string | null = null;
  private outputTemplate: string | null = null;
  private options: string[] = [];
  private currentProcess: ChildProcess | null = null;
  private isRunning = false;
  private ytDlpPath: string;
  private aborted = false;
  logger: any;

  constructor(
    private readonly sharedConfigService: SharedConfigService
  ) {
    super();
    
    // Store the yt-dlp path for process spawning
    this.ytDlpPath = this.getYtDlpPath();
  }

  /**
   * Get the path to the yt-dlp executable
   * SIMPLIFIED: Just use bundled binary from shared config
   */
  private getYtDlpPath(): string {
    const ytDlpPath = this.sharedConfigService.getYtDlpPath();

    if (!ytDlpPath) {
      throw new Error('yt-dlp path is not defined');
    }

    // Only check fs.existsSync for absolute paths
    // For PATH-based commands (like 'yt-dlp'), skip the check
    if (path.isAbsolute(ytDlpPath) && !fs.existsSync(ytDlpPath)) {
      logger.error(`yt-dlp not found at: ${ytDlpPath}`);
      throw new Error(`yt-dlp executable not found at path: ${ytDlpPath}`);
    }

    return ytDlpPath;
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
    return this;
  }
  
  /**
   * Cancel the current download operation
   */
  cancel(): void {
    if (this.currentProcess && this.isRunning) {
      console.log('Cancelling yt-dlp download');
      this.aborted = true;
      
      // On Windows, use taskkill to ensure the process and its children are killed
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${this.currentProcess.pid} /T /F`);
        } catch (err) {
          // Silent fail - the process might already be gone
        }
      } else {
        // On Unix-like systems, send SIGTERM
        this.currentProcess.kill('SIGTERM');
      }
      
      this.isRunning = false;
    }
  }

  /**
   * Verify a file exists with retries
   */
  private async verifyFileExists(filePath: string, maxRetries = 10, interval = 500): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.debug(`Verifying file exists (attempt ${attempt}/${maxRetries}): ${filePath}`);
      try {
        // Use fs.promises.access instead of fs.access for Promise-based API
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
   * Uses direct process spawning for better control
   */
  async run(): Promise<string> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }
    
    // Reset abort flag
    this.aborted = false;
  
    // Build the command arguments
    const finalArgs: string[] = [];
  
    if (this.outputTemplate) {
      finalArgs.push('-o', this.outputTemplate);
    }

    // Add progress option (but NOT for JSON dump operations)
    const isDumpJson = this.options.includes('--dump-json');
    if (!this.options.includes('--progress-template') && !isDumpJson) {
      finalArgs.push('--progress-template', '%(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s eta %(progress.eta)s [%(progress._percent_str)s]');
    }

    // Add other options
    finalArgs.push(...this.options);
    
    // Add URL as the last argument
    finalArgs.push(this.inputUrl);
  
    logger.info(`Executing yt-dlp with args: ${finalArgs.join(' ')}`);
    
    // Store output and error data
    let stdoutBuffer = '';
    let stderrBuffer = '';
    
    return new Promise<string>((resolve, reject) => {
      if (this.aborted) {
        reject(new Error('Download was cancelled'));
        return;
      }
      
      // Spawn the yt-dlp process with bundled Python
      this.isRunning = true;

      // Determine how to execute yt-dlp based on whether it's an absolute path or a PATH command
      let command: string;
      let args: string[];

      if (path.isAbsolute(this.ytDlpPath)) {
        // Bundled yt-dlp: execute with bundled Python
        // Execute: python3 /path/to/yt-dlp [args...]
        const pythonConfig = getPythonConfig();
        command = pythonConfig.fullPath || 'python3';
        args = [this.ytDlpPath, ...finalArgs];
        logger.info(`Using Python to run bundled yt-dlp: ${command} ${this.ytDlpPath}`);
      } else {
        // System yt-dlp: execute directly (it's a standalone executable)
        // Execute: yt-dlp [args...]
        command = this.ytDlpPath;
        args = finalArgs;
        logger.info(`Running system yt-dlp directly: ${this.ytDlpPath}`);
      }

      this.currentProcess = spawn(command, args);
      
      // Set up stdout and stderr handlers
      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        logger.info(`[STDOUT] Received ${chunk.length} bytes`);
        stdoutBuffer += chunk;

        // Also check stdout for progress (--progress-template output goes to stdout)
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            logger.debug(`[STDOUT LINE]: ${line}`);
            this.parseProgressUpdate(line);
          }
        }

        // Process output line by line (but skip for JSON dumps)
        const isDumpJson = this.options.includes('--dump-json');
        if (!isDumpJson) {
          const lines = chunk.split(/\r?\n/);
          for (const line of lines) {
            if (line.trim()) {
              this.parseProgressUpdate(line);
            }
          }
        }
      });
      
      // Create a readline interface to process stderr line by line in real time
      if (this.currentProcess.stderr) {
        const stderrReader = readline.createInterface({
          input: this.currentProcess.stderr,
          terminal: false
        });
        
        stderrReader.on('line', (line) => {
          stderrBuffer += line + '\n';

          // Log stderr lines for debugging
          if (line.includes('[download]') || line.includes('%')) {
            logger.info(`[STDERR LINE]: ${line}`);
          }

          // Process the line for progress information
          this.parseProgressUpdate(line);

          // Check for download phase
          if (line.includes('[download]')) {
            this.parseDownloadProgress(line);
          }
          
          // Check for extraction phase
          if (line.includes('[ExtractAudio]') || line.includes('[Merger]') || line.includes('[ffmpeg]')) {
            // When post-processing, emit a high progress percentage
            this.emit('progress', {
              percent: 95, // High percentage to indicate near completion
              totalSize: 0,
              downloadedBytes: 0,
              downloadSpeed: 0,
              eta: 0
            });
          }
        });
      }
      
      // Handle process exit
      this.currentProcess.on('close', (code) => {
        this.isRunning = false;

        logger.info(`[PROCESS EXIT] Code: ${code}, Stdout length: ${stdoutBuffer.length}, Stderr length: ${stderrBuffer.length}`);
        if (stderrBuffer.length > 0) {
          logger.info(`[STDERR CONTENT]: ${stderrBuffer.substring(0, 500)}`);
        }

        if (this.aborted) {
          reject(new Error('Download was cancelled'));
          return;
        }

        if (code === 0) {
          // Emit a final progress event to show completion
          this.emit('progress', {
            percent: 100,
            totalSize: 0,
            downloadedBytes: 0,
            downloadSpeed: 0,
            eta: 0
          });

          resolve(stdoutBuffer);
        } else {
          reject(new Error(`yt-dlp exited with code ${code}. Error: ${stderrBuffer}`));
        }
      });
      
      // Handle process error
      this.currentProcess.on('error', (err) => {
        this.isRunning = false;
        reject(new Error(`Failed to start yt-dlp process: ${err.message}`));
      });
    });
  }

  /**
   * Parse a line of output to check for progress information
   */
  private parseProgressUpdate(line: string): void {
    // Try several patterns to extract progress information
    this.parseProgressTemplate(line) || this.parseDownloadProgress(line) || this.parseGenericProgress(line);
  }

  /**
   * Parse progress template output
   * Matches format: 261120/1693770 32046367.64044944 eta 0 [ 15.4%]
   */
  private parseProgressTemplate(line: string): boolean {
    // Match progress template format: bytes/total speed eta time [percent%]
    // Speed is raw bytes/s, eta is seconds or NA, percent has optional leading space
    const templateRegex = /(\d+)\/(\d+)\s+([\d.]+)\s+eta\s+(\S+)\s+\[\s*([\d.]+)%\]/;
    const match = line.match(templateRegex);

    if (match) {
      const [, downloaded, total, speed, eta, percent] = match;

      // Speed is already in bytes/s
      const bytesPerSec = parseFloat(speed);

      // Parse ETA (could be number of seconds or "NA")
      let etaSeconds = 0;
      if (eta !== 'NA' && !isNaN(parseFloat(eta))) {
        etaSeconds = parseFloat(eta);
      }

      logger.info(`[PROGRESS TEMPLATE] ${percent}% - ${downloaded}/${total} bytes at ${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`);

      this.emit('progress', {
        percent: parseFloat(percent),
        totalSize: parseInt(total),
        downloadedBytes: parseInt(downloaded),
        downloadSpeed: bytesPerSec,
        eta: etaSeconds
      });

      return true;
    }

    return false;
  }
  
  /**
   * Parse download progress line
   * Matches patterns like: [download] 32.5% of ~50.33MiB at 2.43MiB/s ETA 00:20
   */
  private parseDownloadProgress(line: string): boolean {
    // Regular expression for download progress
    const downloadProgressRegex = /\[download\]\s+(\d+\.\d+)%\s+of\s+~?(\d+\.\d+)(\w+)\s+at\s+(\d+\.\d+)(\w+\/s)\s+ETA\s+(\d+:\d+)/;
    const match = line.match(downloadProgressRegex);
    
    if (match) {
      const [, percent, size, sizeUnit, speed, speedUnit, eta] = match;
      
      // Convert size to bytes
      let totalBytes = parseFloat(size);
      if (sizeUnit === 'KiB') totalBytes *= 1024;
      if (sizeUnit === 'MiB') totalBytes *= 1024 * 1024;
      if (sizeUnit === 'GiB') totalBytes *= 1024 * 1024 * 1024;
      
      // Convert speed to bytes/s
      let bytesPerSec = parseFloat(speed);
      if (speedUnit.startsWith('KiB')) bytesPerSec *= 1024;
      if (speedUnit.startsWith('MiB')) bytesPerSec *= 1024 * 1024;
      if (speedUnit.startsWith('GiB')) bytesPerSec *= 1024 * 1024 * 1024;
      
      // Calculate downloaded bytes
      const downloadedBytes = totalBytes * (parseFloat(percent) / 100);
      
      // Convert ETA to seconds
      const [minutes, seconds] = eta.split(':').map(Number);
      const etaSeconds = minutes * 60 + seconds;
      
      // Emit progress event
      this.emit('progress', {
        percent: parseFloat(percent),
        totalSize: totalBytes,
        downloadedBytes,
        downloadSpeed: bytesPerSec,
        eta: etaSeconds
      });
      
      return true;
    }
    
    return false;
  }
  
  /**
   * Parse various other progress indicators in the output
   */
  private parseGenericProgress(line: string): boolean {
    // Match ffmpeg progress
    if (line.includes('time=') && line.includes('bitrate=')) {
      // Extract time values - typically in format 00:00:00.00
      const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch) {
        // For ffmpeg lines, emit higher progress values (70-90%)
        // as this is typically after the download phase
        this.emit('progress', {
          percent: 85, // Arbitrary high value for processing phase
          totalSize: 0,
          downloadedBytes: 0,
          downloadSpeed: 0,
          eta: 0
        });
        
        return true;
      }
    }
    
    // Match download destination (beginning of download)
    if (line.includes('[download] Destination:')) {
      this.emit('progress', {
        percent: 0, // Starting download
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0
      });
      
      return true;
    }
    
    // Match merging/post-processing indicators
    if (line.includes('[Merger]') || 
        line.includes('[ExtractAudio]') ||
        line.includes('Deleting original file')) {
      this.emit('progress', {
        percent: 95, // Near completion
        totalSize: 0,
        downloadedBytes: 0,
        downloadSpeed: 0,
        eta: 0
      });
      
      return true;
    }
    
    return false;
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
        // Properly handle unknown error type
        const errorObj: Error = error instanceof Error 
          ? error 
          : new Error(String(error));
        
        // If the operation was canceled, don't retry
        if (errorObj.message.includes('cancelled') || this.aborted) {
          throw errorObj;
        }
        
        lastError = errorObj;
        logger.info(`yt-dlp execution failed (attempt ${attempt}/${maxRetries}): ${errorObj.message}`);
        
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
    
    // Save current options
    const savedOptions = [...this.options];
    const savedTemplate = this.outputTemplate;
    
    // Reset and set info-specific options
    this.options = [];
    this.outputTemplate = null;
    
    this.addOption('--dump-json');
    this.addOption('--no-playlist');
    this.addOption('--flat-playlist');
    
    try {
      const output = await this.run();
      return JSON.parse(output.trim());
    } catch (error) {
      const errorObj = error instanceof Error 
        ? error 
        : new Error(String(error));
      
      console.log(`Failed to get video info: ${errorObj.message}`);
      throw errorObj;
    } finally {
      // Restore original options
      this.options = savedOptions;
      this.outputTemplate = savedTemplate;
    }
  }
  
  /**
   * Check if a URL is supported by yt-dlp
   */
  async checkUrl(): Promise<boolean> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }
    
    // Save current options
    const savedOptions = [...this.options];
    const savedTemplate = this.outputTemplate;
    
    // Reset and set check-specific options
    this.options = [];
    this.outputTemplate = null;
    
    this.addOption('--simulate');
    this.addOption('--quiet');
    
    try {
      await this.run();
      return true;
    } catch (error) {
      return false;
    } finally {
      // Restore original options
      this.options = savedOptions;
      this.outputTemplate = savedTemplate;
    }
  }
  
  /**
   * Update yt-dlp to the latest version
   */
  async updateYtDlp(): Promise<boolean> {
    try {
      // Save any current configuration
      const savedUrl = this.inputUrl;
      const savedOptions = [...this.options];
      const savedTemplate = this.outputTemplate;
      
      // Reset and set update option
      this.inputUrl = '';
      this.options = ['--update'];
      this.outputTemplate = null;
      
      // Run the update command
      const result = await this.run();
      
      // Restore original configuration
      this.inputUrl = savedUrl;
      this.options = savedOptions;
      this.outputTemplate = savedTemplate;
      
      return result.includes('Updated');
    } catch (error) {
      const errorMsg = error instanceof Error ? (error as Error).message : String(error);
      return false;
    }
  }
  
  /**
   * Get the current version of yt-dlp
   */
  async getYtDlpVersion(): Promise<string> {
    try {
      // Save any current configuration
      const savedUrl = this.inputUrl;
      const savedOptions = [...this.options];
      const savedTemplate = this.outputTemplate;
      
      // Reset and set version option
      this.inputUrl = '';
      this.options = ['--version'];
      this.outputTemplate = null;
      
      // Run the version command
      const result = await this.run();
      
      // Restore original configuration
      this.inputUrl = savedUrl;
      this.options = savedOptions;
      this.outputTemplate = savedTemplate;
      
      return result.trim();
    } catch (error) {
      const errorMsg = error instanceof Error ? (error as Error).message : String(error);
      throw new Error(`Failed to get yt-dlp version: ${errorMsg}`);
    }
  }
}