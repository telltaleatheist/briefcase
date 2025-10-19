// clippy/backend/src/downloader/downloader.service.ts
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { DownloadOptions, DownloadResult, HistoryItem } from '../common/interfaces/download.interface';
import { PathService } from '../path/path.service';
import { YtDlpManager } from './yt-dlp-manager';
import { SharedConfigService } from '../config/shared-config.service';
import { MediaEventService } from '../media/media-event.service';

@Injectable()
export class DownloaderService implements OnModuleInit {
  private readonly logger = new Logger(DownloaderService.name);
  private downloadHistory: HistoryItem[] = [];
  private historyFilePath: string;
  private activeDownloads: Map<string, YtDlpManager> = new Map();
  
  constructor(
    private readonly pathService: PathService,
    private readonly sharedConfigService: SharedConfigService,
    private readonly eventService: MediaEventService
  ) {
    this.historyFilePath = path.join(process.cwd(), 'downloads', 'history.json');
    this.ensureDirectoriesExist();
    this.loadDownloadHistory();
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
    this.logger.log('Downloader service initialized');
  }
  
  /**
   * Main method to download a video from a URL
   */
  async downloadVideo(options: DownloadOptions, jobId?: string): Promise<DownloadResult> {
    try {
      this.logger.log(`Starting download for URL: ${options.url}`);
      
      // Emit download-started event
      this.eventService.emitDownloadStarted(options.url, jobId);
      
      const downloadFolder = this.pathService.getSafePath(options.outputDir);
      this.logger.log(`Using download directory: ${downloadFolder}`);
      
      if (!this.pathService.ensurePathExists(downloadFolder)) {
        const error = `Cannot create or access download directory: ${downloadFolder}`;
        this.eventService.emitDownloadFailed(options.url, error, jobId);
        throw new Error(error);
      }
      
      // Check if this is a Reddit URL - handle differently
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
      
      // Configure output template
      const dateFormat = '%(upload_date>%Y-%m-%d)s ';
      const outputTemplate = path.join(downloadFolder, `${dateFormat}%(title)s.%(ext)s`);
      
      // Create ytDlpManager instance
      const ytDlpManager = new YtDlpManager(this.sharedConfigService);
      
      // Configure download
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
      
      // Configure format options based on source
      if (options.url.includes('reddit.com')) {
        // For Reddit, don't specify any format - let yt-dlp choose the best available format
      } else if (options.url.includes('youtube.com') || options.url.includes('youtu.be')) {
        // YouTube-specific configuration

        // Use Android client to avoid 403 errors (works without cookies on most videos)
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=android');

        // Use QuickTime-compatible format (mp4 with avc1 video codec)
        ytDlpManager.addOption('--format', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best');

        // Note: Safari cookies require Full Disk Access permission on macOS
        // The Android client works well without cookies for most videos
      } else {
        ytDlpManager.addOption('--format', `best[height<=${options.quality}]/best`);

        // Use cookies for other sites if specified
        if (options.useCookies && options.browser) {
          ytDlpManager.addOption('--cookies-from-browser', options.browser !== 'auto' ? options.browser : 'chrome');
        }
      }
      
      let outputFile: string | null = null;
      
      // Store the download manager for potential cancellation
      if (jobId) {
        this.activeDownloads.set(jobId, ytDlpManager);
      }
      
      // Set up progress tracking
      ytDlpManager.on('progress', (progress) => {
        this.eventService.emitDownloadProgress(
          progress.percent,
          'Downloading',
          jobId,
          {
            speed: progress.downloadSpeed,
            eta: progress.eta,
            totalSize: progress.totalSize,
            downloadedBytes: progress.downloadedBytes
          }
        );
      });
      
      try {
        // Run the download with retries
        const output = await ytDlpManager.runWithRetry(3, 2000);
        
        // Try to determine the output file
        outputFile = await this.determineOutputFile(output, downloadFolder);
        
        if (outputFile && fs.existsSync(outputFile)) {
          this.logger.log(`Download successful: ${outputFile}`);
          outputFile = await this.processOutputFilename(outputFile);
          
          // Determine if this is an image based on file extension
          const fileExt = path.extname(outputFile).toLowerCase();
          const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(fileExt);
          
          // Add to history
          this.addToHistory(outputFile, options.url);
          
          // Emit completion event
          this.eventService.emitDownloadCompleted(outputFile, options.url, jobId, isImage);
          
          // Clean up active downloads
          if (jobId) {
            this.activeDownloads.delete(jobId);
          }
          
          return { 
            success: true, 
            outputFile,
            isImage
          };
        } else {
          const errorMsg = `Download seemed to succeed but output file not found: ${outputFile}`;
          this.logger.error(errorMsg);
          this.eventService.emitDownloadFailed(options.url, errorMsg, jobId);
          
          // Clean up active downloads
          if (jobId) {
            this.activeDownloads.delete(jobId);
          }
          
          return { success: false, error: errorMsg };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error during yt-dlp execution';
        this.logger.error(`yt-dlp execution failed: ${errorMsg}`);
        this.eventService.emitDownloadFailed(options.url, errorMsg, jobId);
        
        // Clean up active downloads
        if (jobId) {
          this.activeDownloads.delete(jobId);
        }
        
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      this.logger.error('Error in downloadVideo:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      
      this.eventService.emitDownloadFailed(options.url, errorMsg, jobId);
      
      // Clean up active downloads
      if (jobId) {
        this.activeDownloads.delete(jobId);
      }
      
      return {
        success: false,
        error: errorMsg
      };
    }
  }

  /**
   * Cancel an active download
   */
  cancelDownload(jobId: string): boolean {
    const manager = this.activeDownloads.get(jobId);
    
    if (manager) {
      this.logger.log(`Cancelling download for job ${jobId}`);
      manager.cancel();
      this.activeDownloads.delete(jobId);
      
      return true;
    }
    
    return false;
  }
  
  /**
   * Determine the output file from yt-dlp output or file system
   */
  private async determineOutputFile(output: string, downloadFolder: string): Promise<string | null> {
    // Try to extract from output first
    let outputFile: string | null = null;
    
    // Check for '[download] Destination:' line
    const destinationMatch = output.match(/\[download\] Destination: (.+)$/m);
    if (destinationMatch) {
      outputFile = destinationMatch[1];
      this.logger.log(`Found output file from destination line: ${outputFile}`);
      
      // Verify file exists
      if (fs.existsSync(outputFile)) {
        return outputFile;
      }
    }
    
    // Check for '[Merger] Merging formats into' line
    const mergerMatch = output.match(/\[Merger\] Merging formats into "(.+)"$/m);
    if (mergerMatch) {
      outputFile = mergerMatch[1];
      this.logger.log(`Found output file from merger line: ${outputFile}`);
      
      // Verify file exists
      if (fs.existsSync(outputFile)) {
        return outputFile;
      }
    }
    
    // If we didn't find it in the output, try to infer from the file system
    try {
      // Add delay to give the file system time to update
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const files = fs.readdirSync(downloadFolder);
      if (files.length === 0) {
        this.logger.warn(`No files found in download directory: ${downloadFolder}`);
        return null;
      }
      
      const mostRecentFile = files
        .map(file => ({ 
          file, 
          path: path.join(downloadFolder, file),
          mtime: fs.statSync(path.join(downloadFolder, file)).mtime 
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
        
      if (mostRecentFile) {
        outputFile = mostRecentFile.path;
        this.logger.log(`Inferred output file from file system: ${outputFile}`);
        return outputFile;
      }
    } catch (error) {
      this.logger.error(`Error while trying to infer output file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    return null;
  }
  
  /**
   * Get information about a Reddit post/URL
   */
  private async getRedditInfo(url: string): Promise<{ imageUrl?: string, title: string }> {
    try {
      this.logger.log(`Fetching info for Reddit URL: ${url}`);
      
      // Strip out query parameters to get a clean URL
      const cleanUrl = url.split('?')[0];
      
      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager(this.sharedConfigService);
      ytDlpManager
        .input(cleanUrl)  // Use clean URL
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
        
        // Fallback method: extract title from URL if possible
        const titleFromUrl = this.extractTitleFromRedditUrl(url);
        if (titleFromUrl) {
          this.logger.log(`Extracted title from URL: ${titleFromUrl}`);
          return { title: titleFromUrl };
        }
        
        // No image URL found in the error message
        throw new Error(`Could not extract image URL or title from Reddit post. Error: ${errorMessage}`);
      }
      
      // Fallback case - should rarely hit this
      return { title };
      
    } catch (error) {
      this.logger.error(`Error in getRedditInfo: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }
  
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
        
        // Truncate if too long
        if (urlTitle.length > 100) {
          urlTitle = urlTitle.substring(0, 97) + '...';
        }
        
        return urlTitle;
      }
      
      return null;
    } catch (e) {
      this.logger.warn(`Error extracting title from URL: ${e instanceof Error ? e.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Download an image from Reddit directly
   */
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
        this.eventService.emitDownloadProgress(0, 'Downloading Image', jobId);
        
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
            this.eventService.emitDownloadFailed(imageUrl, errorMsg, jobId);
            reject({ success: false, error: errorMsg });
            return;
          }
          
          response.pipe(file);
          
          // Handle progress (approximate since we don't know total size)
          let receivedBytes = 0;
          response.on('data', (chunk: any) => {
            receivedBytes += chunk.length;
            this.eventService.emitDownloadProgress(50, 'Downloading Image', jobId);
          });
          
          file.on('finish', () => {
            file.close();
            this.logger.log(`Image download completed: ${outputPath}`);
            this.eventService.emitDownloadProgress(100, 'Completed', jobId);
            
            // Add to history
            this.addToHistory(outputPath, imageUrl);
            this.eventService.emitDownloadCompleted(outputPath, imageUrl, jobId, true);
            
            resolve({ success: true, outputFile: outputPath, isImage: true });
          });
        });
        
        request.on('error', (err: any) => {
          file.close();
          fs.unlink(outputPath, () => {}); // Delete the file async
          this.logger.error(`Image download failed: ${err.message}`);
          this.eventService.emitDownloadFailed(imageUrl, err.message, jobId);
          reject({ success: false, error: err.message });
        });
        
        request.end();
      } catch (error) {
        this.logger.error('Error downloading Reddit image:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        this.eventService.emitDownloadFailed(imageUrl, errorMsg, jobId);
        reject({
          success: false,
          error: errorMsg
        });
      }
    });
  }

  /**
   * Process output filename to ensure consistent format
   */
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

  /**
   * Add a download to the history
   */
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
      
      // Notify clients of history update
      this.eventService.emitEvent('download-history-updated', this.downloadHistory);
    } catch (error) {
      this.logger.error('Error adding to history:', error);
    }
  }

  /**
     * Check if a URL is valid/downloadable
     */
  async checkUrl(url: string): Promise<any> {
    try {
      this.logger.log(`Checking URL validity: ${url}`);
      
      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager(this.sharedConfigService);
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

  /**
   * Get detailed video information
   */
  async getVideoInfo(url: string): Promise<any> {
    try {
      this.logger.log(`Fetching video info for URL: ${url}`);
      
      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager(this.sharedConfigService);
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
          uploadDate: formattedDate,
          description: videoInfo.description || '',
          formats: videoInfo.formats || [],
          width: videoInfo.width || 0,
          height: videoInfo.height || 0
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

  /**
   * Load download history from file
   */
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

  /**
   * Save download history to file
   */
  private saveDownloadHistory(): void {
    try {
      fs.writeFileSync(this.historyFilePath, JSON.stringify(this.downloadHistory, null, 2));
    } catch (error) {
      this.logger.error('Failed to save download history', error);
    }
  }

  /**
   * Get download history
   */
  getDownloadHistory(): HistoryItem[] {
    return this.downloadHistory;
  }

  /**
   * Get a file by its ID
   */
  getFileById(id: string): HistoryItem | undefined {
    const file = this.downloadHistory.find(item => item.id === id);
    
    if (!file) {
      throw new NotFoundException('File not found in download history');
    }
    
    return file;
  }

  /**
   * Remove a file from the download history
   */
  removeFromHistory(id: string): { success: boolean, message: string } {
    const initialLength = this.downloadHistory.length;
    this.downloadHistory = this.downloadHistory.filter(item => item.id !== id);
    
    if (this.downloadHistory.length < initialLength) {
      this.saveDownloadHistory();
      
      // Notify clients
      this.eventService.emitEvent('download-history-updated', this.downloadHistory);
      
      return { success: true, message: 'Item removed from history' };
    }
    
    return { success: false, message: 'Item not found in history' };
  }

  /**
   * Clear the download history
   */
  clearHistory(): { success: boolean, message: string } {
    this.downloadHistory = [];
    this.saveDownloadHistory();
    
    // Notify clients
    this.eventService.emitEvent('download-history-updated', this.downloadHistory);
    
    return { success: true, message: 'Download history cleared' };
  }
}