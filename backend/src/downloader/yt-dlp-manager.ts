// clippy/backend/src/downloader/yt-dlp-manager.ts
import YTDlpWrap from 'yt-dlp-wrap-extended';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { SharedConfigService } from '../config/shared-config.service';
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';

export interface YtDlpProgress {
  percent: number;
  totalSize: number;
  downloadedBytes: number;
  downloadSpeed: number;
  eta: number;
}

@Injectable()
export class YtDlpManager extends EventEmitter {
  private static instance: YTDlpWrap;
  private inputUrl: string | null = null;
  private outputTemplate: string | null = null;
  private options: string[] = [];
  private abortController: AbortController | null = null;
  private isRunning = false;
  private ytDlpPath: string;

  constructor(
    private readonly sharedConfigService: SharedConfigService
  ) {
    super();
    
    if (!YtDlpManager.instance) {
      YtDlpManager.instance = this.createYtDlpWrap();
    }
    
    // Store the yt-dlp path for direct process spawning
    this.ytDlpPath = this.getYtDlpPath();
  }

  /**
   * Get the path to the yt-dlp executable
   */
  private getYtDlpPath(): string {
    // First try to use the configured path from environment variable
    if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
      log.info(`Using configured yt-dlp path: ${process.env.YT_DLP_PATH}`);
      return process.env.YT_DLP_PATH;
    }

    log.warn('yt-dlp not found in env. Falling back to shared config.');
    const ytDlpPath = this.sharedConfigService.getYtDlpPath();
    if (!ytDlpPath) {
      throw new Error('yt-dlp path is not defined in the shared configuration.');
    }
    
    if (!fs.existsSync(ytDlpPath)) {
      throw new Error(`yt-dlp executable not found at path: ${ytDlpPath}`);
    }
    
    log.info(`Using yt-dlp from shared config: ${ytDlpPath}`);
    return ytDlpPath;
  }

  /**
   * Create and configure the YtDlp wrapper
   */
  private createYtDlpWrap(): YTDlpWrap {
    const ytDlpPath = this.getYtDlpPath();
    return new YTDlpWrap(ytDlpPath);
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
    return this;
  }
  
  /**
   * Cancel the current download operation
   */
  cancel(): void {
    if (this.abortController && this.isRunning) {
      log.info('Cancelling yt-dlp download');
      this.abortController.abort();
      this.isRunning = false;
    }
  }

  /**
   * Execute the yt-dlp command with the configured options
   * Uses direct process spawning for better control and event handling
   */
  async run(): Promise<string> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }

    const finalArgs: string[] = [];

    if (this.outputTemplate) {
      finalArgs.push('-o', this.outputTemplate);
    }

    finalArgs.push(...this.options);
    finalArgs.push(this.inputUrl);

    log.info(`Executing yt-dlp with args: ${finalArgs.join(' ')}`);
    
    // Create a new abort controller for this operation
    this.abortController = new AbortController();
    this.isRunning = true;
    
    return new Promise<string>((resolve, reject) => {
      try {
        // Track output
        let stdoutBuffer = '';
        let stderrBuffer = '';
        
        // Spawn the yt-dlp process directly instead of using the wrapper's event system
        const process = spawn(this.ytDlpPath, finalArgs, { 
          signal: this.abortController?.signal 
        });
        
        // Handle stdout - capture output and parse progress
        process.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdoutBuffer += chunk;
          
          // Parse progress information from stdout
          this.parseProgressFromOutput(chunk);
        });
        
        // Handle stderr
        process.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderrBuffer += chunk;
          
          // Also try to parse progress from stderr (some tools output progress here)
          this.parseProgressFromOutput(chunk);
        });
        
        // Handle process completion
        process.on('close', (code: number) => {
          this.isRunning = false;
          
          if (code === 0) {
            // Success
            resolve(stdoutBuffer);
          } else {
            // Error
            const errorMsg = `yt-dlp process exited with code ${code}: ${stderrBuffer}`;
            log.error(errorMsg);
            reject(new Error(errorMsg));
          }
        });
        
        // Handle process errors
        process.on('error', (err: Error) => {
          this.isRunning = false;
          log.error(`yt-dlp process error: ${err.message}`);
          reject(err);
        });
      } catch (error) {
        this.isRunning = false;
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error(`Failed to spawn yt-dlp process: ${errorMessage}`);
        reject(new Error(`Failed to spawn yt-dlp process: ${errorMessage}`));
      }
    });
  }
  
  /**
   * Parse progress information from yt-dlp output
   */
  private parseProgressFromOutput(output: string): void {
    // Try to parse download progress
    const progressRegex = /(\d+\.\d+)% of\s+~?(\d+\.\d+)(\w+) at\s+(\d+\.\d+)(\w+\/s) ETA (\d+:\d+)/;
    const match = output.match(progressRegex);
    
    if (match) {
      const [, percent, size, sizeUnit, speed, speedUnit, eta] = match;
      
      // Convert size to bytes
      let totalBytes = parseFloat(size);
      if (sizeUnit === 'KiB') totalBytes *= 1024;
      if (sizeUnit === 'MiB') totalBytes *= 1024 * 1024;
      if (sizeUnit === 'GiB') totalBytes *= 1024 * 1024 * 1024;
      
      // Convert speed to bytes/s
      let bytesPerSec = parseFloat(speed);
      if (speedUnit === 'KiB/s') bytesPerSec *= 1024;
      if (speedUnit === 'MiB/s') bytesPerSec *= 1024 * 1024;
      
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
        // Properly handle unknown error type
        const errorObj: Error = error instanceof Error 
          ? error 
          : new Error(String(error));
        
        // If the operation was canceled, don't retry
        if (errorObj.message.includes('abort') || errorObj.name === 'AbortError') {
          throw errorObj;
        }
        
        lastError = errorObj;
        log.warn(`yt-dlp execution failed (attempt ${attempt}/${maxRetries}): ${errorObj.message}`);
        
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
      
      log.error(`Failed to get video info: ${errorObj.message}`);
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
      log.info(`yt-dlp update result: ${result}`);
      
      // Restore original configuration
      this.inputUrl = savedUrl;
      this.options = savedOptions;
      this.outputTemplate = savedTemplate;
      
      return result.includes('Updated');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to update yt-dlp: ${errorMsg}`);
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
      log.error(`Failed to get yt-dlp version: ${errorMsg}`);
      throw new Error(`Failed to get yt-dlp version: ${errorMsg}`);
    }
  }
}