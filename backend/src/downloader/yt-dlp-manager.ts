// clippy/backend/src/downloader/yt-dlp-manager.ts
import * as fs from 'fs';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { SharedConfigService } from '../config/shared-config.service';
import * as readline from 'readline';
import * as logger from 'electron-log';

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
   */
  private getYtDlpPath(): string {
    // First try to use the configured path from environment variable
    if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
      console.log(`Using configured yt-dlp path: ${process.env.YT_DLP_PATH}`);
      return process.env.YT_DLP_PATH;
    }

    console.log('yt-dlp not found in env. Falling back to shared config.');
    const ytDlpPath = this.sharedConfigService.getYtDlpPath();
    if (!ytDlpPath) {
      throw new Error('yt-dlp path is not defined in the shared configuration.');
    }
    
    if (!fs.existsSync(ytDlpPath)) {
      throw new Error(`yt-dlp executable not found at path: ${ytDlpPath}`);
    }
    
    console.log(`Using yt-dlp from shared config: ${ytDlpPath}`);
    return ytDlpPath;
  }

  /**
   * Set the input URL for the download
   */
  input(url: string): YtDlpManager {
    this.inputUrl = url;
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
    
    // Add progress option
    if (!this.options.includes('--progress-template')) {
      finalArgs.push('--progress-template', '%(progress.downloaded_bytes)s/%(progress.total_bytes)s %(progress.speed)s eta %(progress.eta)s [%(progress._percent_str)s]');
    }
  
    // Add other options
    finalArgs.push(...this.options);
    
    // Add URL as the last argument
    finalArgs.push(this.inputUrl);
  
    console.log(`Executing yt-dlp with args: ${finalArgs.join(' ')}`);
    
    // Store output and error data
    let stdoutBuffer = '';
    let stderrBuffer = '';
    
    return new Promise<string>((resolve, reject) => {
      if (this.aborted) {
        reject(new Error('Download was cancelled'));
        return;
      }
      
      // Spawn the yt-dlp process
      this.isRunning = true;
      this.currentProcess = spawn(this.ytDlpPath, finalArgs);
      
      // Set up stdout and stderr handlers
      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        
        // Process output line by line
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) {
            this.parseProgressUpdate(line);
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
    this.parseDownloadProgress(line) || this.parseGenericProgress(line);
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
        console.log(`yt-dlp execution failed (attempt ${attempt}/${maxRetries}): ${errorObj.message}`);
        
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
      console.log(`yt-dlp update result: ${result}`);
      
      // Restore original configuration
      this.inputUrl = savedUrl;
      this.options = savedOptions;
      this.outputTemplate = savedTemplate;
      
      return result.includes('Updated');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`Failed to update yt-dlp: ${errorMsg}`);
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`Failed to get yt-dlp version: ${errorMsg}`);
      throw new Error(`Failed to get yt-dlp version: ${errorMsg}`);
    }
  }
}