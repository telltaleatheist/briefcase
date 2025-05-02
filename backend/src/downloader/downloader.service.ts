// clippy/backend/src/downloader/downloader.service.ts
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { 
  DownloadOptions, 
  DownloadResult, 
  HistoryItem 
} from '../common/interfaces/download.interface';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import { PathService } from '../path/path.service';
import { join } from 'node:path';
import { execFile, ExecFileOptions } from 'node:child_process';
import { EnvironmentUtil } from "../config/environment.util";
import { YtDlpManager } from './yt-dlp-manager';
import { SharedConfigService } from '../config/shared-config.service';

@WebSocketGateway({ cors: true })
@Injectable()
export class DownloaderService implements OnModuleInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DownloaderService.name);
  private downloadHistory: HistoryItem[] = [];
  private historyFilePath: string;
  
  constructor(
    private readonly configService: ConfigService,
    private readonly ffmpegService: FfmpegService,
    private readonly pathService: PathService,
    private readonly sharedConfigService: SharedConfigService,
  ) {
    try {
      this.historyFilePath = path.join(process.cwd(), 'downloads', 'history.json');
      this.ensureDirectoriesExist();
      this.loadDownloadHistory();
    } catch (error) {
      throw error;
    }
  }
    
  private ensureDirectoriesExist(): void {
    const downloadsDir = path.dirname(this.historyFilePath);
    
    if (!fs.existsSync(downloadsDir)) {
      try {
        fs.mkdirSync(downloadsDir, { recursive: true });
        this.logger.log(`Created directory: ${downloadsDir}`);
      } catch (error) {
        this.logger.error(`Failed to create directory: ${(error as Error).message}`);
      }
    }
  }

  onModuleInit() {
    if (!this.server) {
      this.logger.warn('WebSocket server not initialized during module initialization');
    } else {
      this.logger.log('WebSocket server initialized successfully');
    }
  }

  /**
   * Helper method to safely emit WebSocket events
   */
  private emitEvent(event: string, data: any): void {
    this.logger.log(`Emitting event: ${event}`, data);
    if (this.server) {
      this.server.emit(event, data);
    } else {
      this.logger.warn(`Cannot emit ${event} - WebSocket server not initialized`);
    }
  }

  private loadDownloadHistory(): void {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const historyData = fs.readFileSync(this.historyFilePath, 'utf8');
        this.downloadHistory = JSON.parse(historyData);
        this.logger.log(`Loaded ${this.downloadHistory.length} items from download history`);
      }
    } catch (error) {
      this.logger.error('Failed to load download history', error);
      this.downloadHistory = [];
    }
  }

  private saveDownloadHistory(): void {
    try {
      fs.writeFileSync(this.historyFilePath, JSON.stringify(this.downloadHistory, null, 2));
    } catch (error) {
      this.logger.error('Failed to save download history', error);
    }
  }

  async downloadVideo(options: DownloadOptions, jobId?: string): Promise<DownloadResult> {
    try {
      this.logger.log(`Starting download for URL: ${options.url}`);
      
      const downloadFolder = this.pathService.getSafePath(options.outputDir);
      this.logger.log(`Using download directory: ${downloadFolder}`);
      
      if (!this.pathService.ensurePathExists(downloadFolder)) {
        throw new Error(`Cannot create or access download directory: ${downloadFolder}`);
      }
      
      // Check if this is a Reddit URL
      if (options.url.includes('reddit.com')) {
        try {
          const info = await this.getRedditInfo(options.url);
          if (info && info.imageUrl) {
            // It's an image post, handle differently
            const result = await this.downloadRedditImage(info.imageUrl, info.title, downloadFolder, jobId);
            
            // Add a flag to indicate this is an image
            return { ...result, isImage: true };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.logger.warn(`Failed to get Reddit info, trying regular download: ${errorMessage}`);
        }
      }
      
      const dateFormat = '%(upload_date>%Y-%m-%d)s ';
      const outputTemplate = path.join(downloadFolder, `${dateFormat}%(title)s.%(ext)s`);
      
      const ytDlpManager = new YtDlpManager();
      ytDlpManager.input(options.url).output(outputTemplate);
      const ffmpegPath = this.sharedConfigService.getFfmpegPath();
      if (ffmpegPath) {
        ytDlpManager.addOption('--ffmpeg-location', ffmpegPath);
        this.logger.log(`Set FFmpeg location for yt-dlp: ${ffmpegPath}`);
      }

      // Add common options
      ytDlpManager.addOption('--verbose')
                  .addOption('--no-check-certificates')
                  .addOption('--no-playlist')
                  .addOption('--force-overwrites');
      
      if (options.convertToMp4) {
        ytDlpManager.addOption('--merge-output-format', 'mp4');
      }
      
      // Special handling for Reddit URLs
      if (options.url.includes('reddit.com')) {
        // For Reddit, don't specify any format - let yt-dlp choose the best available format
      } else if (options.url.includes('youtube.com') || options.url.includes('youtu.be')) {
        ytDlpManager.addOption('--format', `bestvideo[height<=${options.quality}]+bestaudio/best[height<=${options.quality}]`);
      } else {
        ytDlpManager.addOption('--format', `best[height<=${options.quality}]/best`);
      }

      if (options.useCookies && options.browser) {
        ytDlpManager.addOption('--cookies-from-browser', options.browser !== 'auto' ? options.browser : 'chrome');
      }
      
      let outputFile: string | null = null;
      let progressPercent = 0;
      
      this.emitEvent('download-started', { url: options.url, jobId });
      
      // Create a listener for stdout to parse progress information
      const stdoutListener = (output: string) => {
        const progressMatch = output.match(/(\d+\.\d+)% of/);
        if (progressMatch) {
          progressPercent = parseFloat(progressMatch[1]);
          this.emitEvent('download-progress', {
            progress: progressPercent,
            task: 'Downloading',
            jobId
          });
        }
        
        if (output.includes('[download] Destination:')) {
          outputFile = output.split('Destination: ')[1].trim();
        }
        
        if (output.includes('[Merger] Merging formats into')) {
          const match = output.match(/"([^"]+)"/);
          if (match) {
            outputFile = match[1];
          }
        }
      };
      
      try {
        // Run the download and capture output
        const output = await ytDlpManager.run();
        
        // Process the output for progress and file information
        output.split('\n').forEach(line => stdoutListener(line));
        
        // If we didn't capture the output file from the stdout
        if (!outputFile) {
          // Try to infer the outputFile from the filesystem based on the download directory
          const files = fs.readdirSync(downloadFolder);
          const mostRecentFile = files
            .map(file => ({ file, mtime: fs.statSync(path.join(downloadFolder, file)).mtime }))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
            
          if (mostRecentFile) {
            outputFile = path.join(downloadFolder, mostRecentFile.file);
          } else {
            throw new Error('Could not determine output file from download');
          }
        }
        
        if (outputFile && fs.existsSync(outputFile)) {
          this.logger.log(`Download successful: ${outputFile}`);
          outputFile = await this.processOutputFilename(outputFile);
          
          // Determine if this is an image based on file extension
          const fileExt = path.extname(outputFile).toLowerCase();
          const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(fileExt);
          
          if (isImage) {
            this.logger.log(`File is an image, skipping aspect ratio correction: ${outputFile}`);
            this.addToHistory(outputFile, options.url);
            this.emitEvent('download-completed', { outputFile, url: options.url, jobId });
            return { success: true, outputFile, isImage: true };
          }
            
          if (jobId) {
            this.emitEvent('download-completed', { outputFile, url: options.url, jobId });
            return { success: true, outputFile, isImage: false };
          }
          
          // Only process videos
          if (options.fixAspectRatio) {
            this.emitEvent('processing-progress', { task: 'Fixing aspect ratio' });
            const fixedFile = await this.ffmpegService.reencodeVideo(outputFile, jobId);
            if (fixedFile) outputFile = fixedFile;
          }
          
          this.addToHistory(outputFile, options.url);
          this.emitEvent('download-completed', { outputFile, url: options.url, jobId });
          
          return { success: true, outputFile, isImage: false };
        } else {
          const errorMsg = `Download seemed to succeed but output file not found: ${outputFile}`;
          this.logger.error(errorMsg);
          this.emitEvent('download-failed', { error: errorMsg, url: options.url, jobId });
          return { success: false, error: errorMsg };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error during yt-dlp execution';
        this.logger.error(`yt-dlp execution failed: ${errorMsg}`);
        this.emitEvent('download-failed', { error: errorMsg, url: options.url, jobId });
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      this.logger.error('Error in downloadVideo:', error);
      this.emitEvent('download-failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        url: options.url,
        jobId
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
    
  private async getRedditInfo(url: string): Promise<{ imageUrl?: string, title: string }> {
    try {
      this.logger.log(`Fetching info for Reddit URL: ${url}`);
      
      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager();
      ytDlpManager
        .input(url)
        .addOption('--dump-json')
        .addOption('--simulate')
        .addOption('--no-playlist')
        .addOption('--flat-playlist');
        
      // Initialize with default title
      let title = 'Reddit Post';
      
      try {
        // Execute the command and get output
        const output = await ytDlpManager.run();
        
        // Try to extract title from the output
        if (output && output.trim()) {
          const info = JSON.parse(output.trim());
          if (info && info.title) {
            title = info.title;
            this.logger.log(`Successfully fetched info for Reddit post: ${title}`);
          }
          
          // If we got here with no error, it's probably a video, not an image
          return { title };
        }
        
      } catch (error) {
        // If we get an error, it might be because it's an image post
        // Check the error message for image URL patterns
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`YtDlpManager execution failed, checking for image URL pattern: ${errorMessage}`);
        
        // Match the specific Reddit media URL format we're seeing in the error
        const redditMediaMatch = errorMessage.match(/Unsupported URL: (https:\/\/www\.reddit\.com\/media\?url=([^&]+))/);
        
        if (redditMediaMatch) {
          // Found the Reddit media URL, now decode it to get the actual image URL
          const encodedImgUrl = redditMediaMatch[2];
          try {
            const imageUrl = decodeURIComponent(encodedImgUrl);
            this.logger.log(`Extracted image URL from Reddit post: ${imageUrl}`);
            
            // Extract post title from the original URL if possible
            const titleFromUrl = this.extractTitleFromRedditUrl(url);
            if (titleFromUrl) {
              title = titleFromUrl;
            }
            
            // Return the image URL and title
            return { imageUrl, title };
          } catch (e) {
            throw new Error(`Failed to decode image URL: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
        }
        
        // No image URL found in the error message
        throw new Error(`Could not extract image URL from Reddit post. Error: ${errorMessage}`);
      }
      
      // Fallback case - should rarely hit this
      return { title };
      
    } catch (error) {
      this.logger.error(`Error in getRedditInfo: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  // Add this helper method to extract a title from a Reddit URL
  private extractTitleFromRedditUrl(url: string): string | null {
    try {
      // Reddit URLs often contain the title after the post ID
      // Format: /comments/POST_ID/POST_TITLE/
      const titleMatch = url.match(/\/comments\/[^\/]+\/([^\/\?]+)/);
      
      if (titleMatch && titleMatch[1]) {
        // Clean up the title (replace underscores, hyphens with spaces)
        let urlTitle = titleMatch[1]
          .replace(/_/g, ' ')
          .replace(/-/g, ' ');
        
        // Decode URI components in case the title is URL-encoded
        try {
          urlTitle = decodeURIComponent(urlTitle);
        } catch (e) {
          // Ignore decoding errors
        }
        
        return urlTitle;
      }
      
      return null;
    } catch (e) {
      this.logger.warn(`Error extracting title from URL: ${e instanceof Error ? e.message : 'Unknown error'}`);
      return null;
    }
  }

  private async downloadRedditImage(imageUrl: string, title: string, downloadFolder: string, jobId?: string): Promise<DownloadResult> {
    return new Promise((resolve, reject) => {
      try {
        // Create a safe filename from the title
        const safeTitle = title.replace(/[^a-z0-9\s]/gi, '_').replace(/\s+/g, ' ').trim();
        
        // Prepare a filename with current date like the video naming convention
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const ext = path.extname(imageUrl).toLowerCase() || '.jpeg'; // Ensure we have an extension
        const filename = `${date} ${safeTitle}${ext}`;
        const outputPath = path.join(downloadFolder, filename);
        
        this.logger.log(`Downloading Reddit image: ${imageUrl} to ${outputPath}`);
        this.emitEvent('download-started', { url: imageUrl, jobId });
        this.emitEvent('download-progress', { progress: 0, task: 'Downloading Image', jobId });
        
        // Create the output directory if it doesn't exist
        if (!fs.existsSync(downloadFolder)) {
          fs.mkdirSync(downloadFolder, { recursive: true });
        }
        
        // Use https or http module to download the image
        const httpModule = imageUrl.startsWith('https') ? require('https') : require('http');
        const file = fs.createWriteStream(outputPath);
        
        const request = httpModule.get(imageUrl, (response: any) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            this.logger.log(`Following redirect to: ${redirectUrl}`);
            file.close();
            
            // Try again with the new URL
            this.downloadRedditImage(redirectUrl, title, downloadFolder, jobId)
              .then(resolve)
              .catch(reject);
            return;
          }
          
          // Check if we got a successful response
          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(outputPath); // Clean up the empty file
            
            const errorMsg = `HTTP error: ${response.statusCode} ${response.statusMessage}`;
            this.logger.error(errorMsg);
            this.emitEvent('download-failed', { error: errorMsg, url: imageUrl, jobId });
            reject({ success: false, error: errorMsg });
            return;
          }
          
          response.pipe(file);
          
          // Handle progress (approximate since we don't know total size)
          let receivedBytes = 0;
          response.on('data', (chunk: any) => {
            receivedBytes += chunk.length;
            this.emitEvent('download-progress', { 
              progress: 50, // Approximate progress
              task: 'Downloading Image', 
              jobId 
            });
          });
          
          file.on('finish', () => {
            file.close();
            this.logger.log(`Image download completed: ${outputPath}`);
            this.emitEvent('download-progress', { progress: 100, task: 'Completed', jobId });
            
            // Add to history
            this.addToHistory(outputPath, imageUrl);
            this.emitEvent('download-completed', { outputFile: outputPath, url: imageUrl, jobId });
            
            resolve({ success: true, outputFile: outputPath });
          });
        });
        
        request.on('error', (err: any) => {
          file.close();
          fs.unlink(outputPath, () => {}); // Delete the file async
          this.logger.error(`Image download failed: ${err.message}`);
          this.emitEvent('download-failed', { error: err.message, url: imageUrl, jobId });
          reject({ success: false, error: err.message });
        });
        
        request.end();
      } catch (error) {
        this.logger.error('Error downloading Reddit image:', error);
        this.emitEvent('download-failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          url: imageUrl,
          jobId
        });
        reject({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  }

  async processOutputFilename(filePath: string): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logger.error(`File does not exist: ${filePath}`);
        return filePath;
      }
      
      const filename = path.basename(filePath);
      const directory = path.dirname(filePath);
      
      // Check if the filename already starts with a date pattern (YYYY-MM-DD )
      if (/^\d{4}-\d{2}-\d{2} /.test(filename)) {
        this.logger.log(`File already has correct date format: ${filename}`);
        return filePath;
      }
      
      // Check if it has the YYYYMMDD- format
      if (/^\d{8}[-_ ]/.test(filename)) {
        // Convert YYYYMMDD- to YYYY-MM-DD 
        const dateStr = filename.substring(0, 8);
        const separator = filename.charAt(8);
        const restOfFilename = filename.substring(9);
        
        // Format the date with dashes
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        const newDateFormat = `${year}-${month}-${day} `;
        
        const newFilename = `${newDateFormat}${restOfFilename}`;
        const newPath = path.join(directory, newFilename);
        
        // Rename the file
        fs.renameSync(filePath, newPath);
        this.logger.log(`Reformatted date in filename: ${newFilename}`);
        return newPath;
      }
      
      // If no date, add today's date as prefix with proper format
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const newFilename = `${today} ${filename}`;
      const newPath = path.join(directory, newFilename);
      
      // Rename the file
      fs.renameSync(filePath, newPath);
      this.logger.log(`Adding date prefix to file: ${newFilename}`);
      return newPath;
    } catch (error) {
      this.logger.error('Error processing output filename:', error);
      return filePath;
    }
  }

  addToHistory(filePath: string, sourceUrl: string): void {
    try {
      const filename = path.basename(filePath);
      const date = new Date().toISOString();
      const id = Date.now().toString();
      
      // Get file size
      const stats = fs.statSync(filePath);
      const fileSize = stats.size;
      
      // Create history item
      const historyItem: HistoryItem = {
        id,
        filename,
        filePath,
        sourceUrl,
        fileSize,
        date,
      };
      
      // Add to beginning of history array
      this.downloadHistory.unshift(historyItem);
      
      // Limit history to 50 items
      if (this.downloadHistory.length > 50) {
        this.downloadHistory.pop();
      }
      
      // Save history to file
      this.saveDownloadHistory();
      
      // Notify clients
      this.emitEvent('download-history-updated', this.downloadHistory);
    } catch (error) {
      this.logger.error('Error adding to history:', error);
    }
  }

  getDownloadHistory(): HistoryItem[] {
    return this.downloadHistory;
  }

  getFileById(id: string): HistoryItem | undefined {
    const file = this.downloadHistory.find(item => item.id === id);
    
    if (!file) {
      throw new NotFoundException('File not found in download history');
    }
    
    return file;
  }

  removeFromHistory(id: string): { success: boolean, message: string } {
    const initialLength = this.downloadHistory.length;
    this.downloadHistory = this.downloadHistory.filter(item => item.id !== id);
    
    if (this.downloadHistory.length < initialLength) {
      this.saveDownloadHistory();
      this.emitEvent('download-history-updated', this.downloadHistory);
      return { success: true, message: 'Item removed from history' };
    }
    
    return { success: false, message: 'Item not found in history' };
  }

  clearHistory(): { success: boolean, message: string } {
    this.downloadHistory = [];
    this.saveDownloadHistory();
    this.emitEvent('download-history-updated', this.downloadHistory);
    
    return { success: true, message: 'Download history cleared' };
  }

  async checkUrl(url: string): Promise<any> {
    try {
      this.logger.log(`Checking URL validity: ${url}`);
      
      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager();
      ytDlpManager
        .input(url)
        .addOption('--dump-json')
        .addOption('--simulate')
        .addOption('--no-playlist');
      
      try {
        // Execute the command and get output
        const output = await ytDlpManager.run();
        
        // Parse the JSON output
        const info = JSON.parse(output);
        return { valid: true, info };
        
      } catch (error) {
        // Log detailed error information
        this.logger.error(`yt-dlp check failed for URL: ${url}`);
        this.logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        
        throw new Error(`URL check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error(`Error in checkUrl: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  async getVideoInfo(url: string): Promise<any> {
    try {
      this.logger.log(`Fetching video info for URL: ${url}`);
      
      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager();
      ytDlpManager
        .input(url)
        .addOption('--dump-json')
        .addOption('--no-playlist')
        .addOption('--flat-playlist');
      
      // Execute the command and get output
      const output = await ytDlpManager.run();
      
      try {
        // Parse the JSON output
        const videoInfo = JSON.parse(output.trim());
        
        // Format the upload date if available
        let formattedDate = '';
        if (videoInfo.upload_date) {
          // Convert YYYYMMDD to YYYY-MM-DD
          const dateStr = videoInfo.upload_date;
          if (dateStr.length === 8) {
            const year = dateStr.substring(0, 4);
            const month = dateStr.substring(4, 6);
            const day = dateStr.substring(6, 8);
            formattedDate = `${year}-${month}-${day}`;
          }
        }
        
        // Extract relevant information
        const result = {
          title: videoInfo.title || 'Unknown Title',
          uploader: videoInfo.uploader || videoInfo.channel || 'Unknown Uploader',
          duration: videoInfo.duration || 0,
          thumbnail: videoInfo.thumbnail || '',
          uploadDate: formattedDate
        };
        
        this.logger.log(`Successfully fetched info for video: ${result.title}`);
        return result;
        
      } catch (parseError) {
        this.logger.error(`Error parsing video info JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        throw new Error(`Failed to parse video info: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error(`Error in getVideoInfo: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }
}