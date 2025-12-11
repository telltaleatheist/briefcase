// ClipChimp/backend/src/downloader/downloader.service.ts
import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DownloadOptions, DownloadResult, HistoryItem } from '../common/interfaces/download.interface';
import { PathService } from '../path/path.service';
import { YtDlpManager } from './yt-dlp-manager';
import { SharedConfigService } from '../config/shared-config.service';
import { MediaEventService } from '../media/media-event.service';
import { FilenameDateUtil } from '../common/utils/filename-date.util';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DownloaderService implements OnModuleInit {
  private readonly logger = new Logger(DownloaderService.name);
  private downloadHistory: HistoryItem[] = [];
  private historyFilePath: string;
  private activeDownloads: Map<string, YtDlpManager> = new Map();

  constructor(
    private readonly pathService: PathService,
    private readonly sharedConfigService: SharedConfigService,
    private readonly eventService: MediaEventService,
    private readonly databaseService: DatabaseService
  ) {
    // Use user's app data directory instead of process.cwd() to avoid permission issues
    const userDataPath = process.env.APPDATA ||
                        (process.platform === 'darwin' ?
                        path.join(os.homedir(), 'Library', 'Application Support') :
                        path.join(os.homedir(), '.config'));

    this.historyFilePath = path.join(userDataPath, 'ClipChimp', 'history.json');
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
   * Calculate the closest Sunday to a given date
   * Returns the date in YYYY-MM-DD format
   */
  private getClosestSunday(date: Date = new Date()): string {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday

    // If today is Sunday (0), use today
    // If Monday-Wednesday (1-3), use previous Sunday
    // If Thursday-Saturday (4-6), use next Sunday
    let daysToAdd: number;

    if (dayOfWeek === 0) {
      daysToAdd = 0; // Today is Sunday
    } else if (dayOfWeek <= 3) {
      daysToAdd = -dayOfWeek; // Go back to previous Sunday
    } else {
      daysToAdd = 7 - dayOfWeek; // Go forward to next Sunday
    }

    const closestSunday = new Date(date);
    closestSunday.setDate(date.getDate() + daysToAdd);

    // Format as YYYY-MM-DD
    const year = closestSunday.getFullYear();
    const month = String(closestSunday.getMonth() + 1).padStart(2, '0');
    const day = String(closestSunday.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  /**
   * Configure YouTube download with multiple fallback client methods
   * Tries: android -> ios -> mweb -> web -> default
   */
  private configureYouTubeDownload(ytDlpManager: YtDlpManager, options: DownloadOptions, clientType: string = 'android'): void {
    this.logger.log(`Configuring YouTube download with client: ${clientType}`);

    // Use QuickTime-compatible format (mp4 with avc1 video codec)
    ytDlpManager.addOption('--format', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best');

    // Set the player client based on type
    switch (clientType) {
      case 'android':
        // Android client - works without cookies for most videos
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=android');
        this.logger.log('Using Android client (no cookies required)');
        break;

      case 'ios':
        // iOS client - another alternative that often works
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=ios');
        this.logger.log('Using iOS client');
        break;

      case 'mweb':
        // Mobile web client - lightweight fallback
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=mweb');
        this.logger.log('Using mobile web client');
        break;

      case 'web':
        // Standard web client
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=web');
        this.logger.log('Using web client');
        break;

      case 'default':
        // No client override - use yt-dlp default behavior
        this.logger.log('Using yt-dlp default client');
        break;

      default:
        // Fallback to android if unknown type
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=android');
        this.logger.log('Unknown client type, defaulting to Android');
    }
  }

  /**
   * Transform ABC News story URLs to video feed URLs
   */
  private async transformAbcNewsUrl(url: string): Promise<string> {
    // Check if this is an ABC News story URL
    const abcStoryMatch = url.match(/abcnews\.go\.com\/[^\/]+\/[^\/]+\/story\?id=(\d+)/);

    if (!abcStoryMatch) {
      // Not an ABC News story URL, return as-is
      return url;
    }

    const storyId = abcStoryMatch[1];
    this.logger.log(`Detected ABC News story URL with ID: ${storyId}`);

    try {
      // Fetch the story page to extract the video ID
      const https = require('https');
      const pageContent = await new Promise<string>((resolve, reject) => {
        https.get(url, (response: any) => {
          let data = '';
          response.on('data', (chunk: any) => data += chunk);
          response.on('end', () => resolve(data));
          response.on('error', reject);
        }).on('error', reject);
      });

      // Look for video ID in the page content
      // ABC News embeds video IDs in their "video" object
      const videoIdMatch = pageContent.match(/"video"[^}]*"id":"(\d{9})"/);

      if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        const videoFeedUrl = `https://abcnews.go.com/video/itemfeed?id=${videoId}`;
        this.logger.log(`Transformed ABC News URL from story ${storyId} to video feed: ${videoFeedUrl} (video ID: ${videoId})`);
        return videoFeedUrl;
      }

      this.logger.warn(`Could not find video ID in ABC News story ${storyId}, trying original URL`);
      return url;

    } catch (error) {
      this.logger.warn(`Failed to transform ABC News URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return url;
    }
  }

  /**
   * Main method to download a video from a URL with automatic retry on different clients
   */
  async downloadVideo(options: DownloadOptions, jobId?: string): Promise<DownloadResult> {
    try {
      // Transform ABC News URLs if needed
      options.url = await this.transformAbcNewsUrl(options.url);

      this.logger.log(`Starting download for URL: ${options.url}`);

      // Check if video already exists in database
      const existingVideo = this.databaseService.findVideoByUrl(options.url);
      if (existingVideo) {
        const reason = `Video already exists in library: "${existingVideo.filename}"`;
        this.logger.log(`Skipping download - ${reason}`);
        this.eventService.emitDownloadSkipped(options.url, reason, existingVideo.id, jobId);

        return {
          success: false,
          outputFile: existingVideo.current_path,
          url: options.url,
          skipped: true,
          reason,
          existingVideoId: existingVideo.id
        };
      }

      // Capture start time BEFORE starting download
      const downloadStartTime = Date.now();

      // Extract upload date for filename formatting (used later in processOutputFilename)
      let uploadDate: string | undefined;
      try {
        const videoInfo = await this.getVideoInfo(options.url);
        if (videoInfo && videoInfo.uploadDate) {
          // uploadDate from getVideoInfo() is already formatted as YYYY-MM-DD
          uploadDate = videoInfo.uploadDate;
          this.logger.log(`Extracted upload date for filename: ${uploadDate}`);
        }
      } catch (error) {
        this.logger.warn(`Could not fetch upload date, will use current date: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Emit download-started event
      this.eventService.emitDownloadStarted(options.url, jobId);

      // Get the base download folder
      const baseDownloadFolder = this.pathService.getSafePath(options.outputDir);

      // Add date-based subfolder (closest Sunday)
      const dateFolderName = this.getClosestSunday();
      const downloadFolder = path.join(baseDownloadFolder, dateFolderName);

      this.logger.log(`Using download directory: ${downloadFolder} (base: ${baseDownloadFolder}, date: ${dateFolderName})`);

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
          const errorMessage = error instanceof Error ? (error as Error).message : 'Unknown error';
          this.logger.warn(`Failed to get Reddit info, trying regular download: ${errorMessage}`);
        }
      }

      // Check if this is a direct Twitter image URL (pbs.twimg.com)
      if (options.url.includes('pbs.twimg.com') || options.url.includes('twimg.com/media/')) {
        this.logger.log('Detected direct Twitter image URL');
        // Extract a title from the URL or use a default
        const mediaId = options.url.match(/\/media\/([^?]+)/)?.[1] || 'twitter-image';
        const title = options.displayName || `Twitter Image ${mediaId}`;

        const result = await this.downloadTwitterImage(options.url, title, downloadFolder, jobId);
        return { ...result, isImage: true };
      }

      // Check if this is a Twitter/X tweet with /photo/ - handle differently
      if ((options.url.includes('twitter.com') || options.url.includes('x.com')) && options.url.includes('/photo/')) {
        try {
          const info = await this.getTwitterImageInfo(options.url);
          if (info && info.imageUrl) {
            // It's an image post, download the image directly
            const result = await this.downloadTwitterImage(info.imageUrl, info.title, downloadFolder, jobId);

            // Add a flag to indicate this is an image
            return { ...result, isImage: true };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? (error as Error).message : 'Unknown error';
          this.logger.warn(`Failed to get Twitter image info: ${errorMessage}`);
          this.logger.warn(`Twitter image posts require the tweet URL, not the direct image URL`);
          this.logger.warn(`Example: https://x.com/user/status/123... instead of https://pbs.twimg.com/...`);
          // Continue with regular download attempt (will likely fail)
        }
      }
      
      // Configure output template
      // Use displayName from metadata if available, otherwise fall back to yt-dlp title
      // Format: YYYY-MM-DD Title.ext
      let outputTemplate: string;

      if (options.displayName) {
        // Sanitize displayName - NEVER allow URLs or paths as filenames!
        let sanitizedName = options.displayName;

        // Check if it looks like a URL and reject it
        if (sanitizedName.includes('://') || sanitizedName.includes('www.')) {
          this.logger.error(`❌ BUG DETECTED: URL passed as displayName: ${sanitizedName}`);
          this.logger.error(`This should NEVER happen - caller should sanitize before passing to downloader`);
          this.logger.error(`URL: ${options.url}`);
          const crypto = require('crypto');
          const hash = crypto.createHash('md5').update(options.url + Date.now()).digest('hex').substring(0, 12);
          sanitizedName = `download-${hash}`;
          this.logger.error(`Using emergency fallback filename: ${sanitizedName}`);
        }

        // Remove invalid filesystem characters
        sanitizedName = sanitizedName
          .replace(/[\/\\:*?"<>|]/g, '-')  // Replace invalid chars with dash
          .replace(/\s+/g, ' ')             // Normalize whitespace
          .trim();

        // Prepend upload date if available
        const displayNameWithDate = uploadDate
          ? `${uploadDate} ${sanitizedName}`
          : sanitizedName;
        outputTemplate = path.join(downloadFolder, `${displayNameWithDate}.%(ext)s`);
        this.logger.log(`Using sanitized displayName for output: ${displayNameWithDate}`);
      } else {
        // Fallback to yt-dlp's dynamic title extraction
        // Include upload_date in filename if available from yt-dlp metadata
        // If upload_date is not available, do NOT use download date - leave filename without date prefix
        // Format: "YYYY-MM-DD Title.ext" if upload_date exists, or "Title.ext" if not
        // Using yt-dlp's conditional: %(field&if_true|if_false)s
        const datePrefix = `%(upload_date&%(upload_date>%Y-%m-%d )s|)s`;
        const maxTitleLength = 200; // Conservative limit to stay under 255 total
        outputTemplate = path.join(downloadFolder, `${datePrefix}%(title.200)s.%(ext)s`);
        this.logger.log(`Using yt-dlp title extraction for output template (upload_date only, no fallback to download date)`);
      }
      
      // Create ytDlpManager instance
      const ytDlpManager = new YtDlpManager();
      
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
                  .addOption('--playlist-items', '1')  // Only download first video if multiple found
                  .addOption('--force-overwrites');
      
      if (options.convertToMp4) {
        ytDlpManager.addOption('--merge-output-format', 'mp4');
      }

      // Configure format options based on source
      if (options.url.includes('reddit.com')) {
        // For Reddit, don't specify any format - let yt-dlp choose the best available format
      } else if (options.url.includes('youtube.com') || options.url.includes('youtu.be')) {
        // YouTube-specific configuration with fallback methods
        this.configureYouTubeDownload(ytDlpManager, options);
      } else if (options.url.includes('rumble.com')) {
        // Rumble-specific configuration: Use HLS formats to avoid .tar extension issues
        // Map quality to HLS format codes based on Rumble's format naming
        let formatSelector: string;
        const quality = parseInt(options.quality || '720');

        if (quality <= 360) {
          // 360p or lower: use hls-222 (360p low bitrate) or hls-681 (360p high bitrate)
          formatSelector = 'hls-681/hls-222';
        } else if (quality <= 480) {
          // 480p: use hls-1057
          formatSelector = 'hls-1057/hls-681/hls-222';
        } else if (quality <= 720) {
          // 720p: use hls-2138
          formatSelector = 'hls-2138/hls-1057/hls-681';
        } else {
          // 1080p or higher: use hls-4108
          formatSelector = 'hls-4108/hls-2138/hls-1057';
        }

        // Add audio track and merge
        ytDlpManager.addOption('--format', `${formatSelector}+audio-192p/best`);
        ytDlpManager.addOption('--merge-output-format', 'mp4');

        // Use cookies for Rumble if specified
        if (options.useCookies && options.browser) {
          ytDlpManager.addOption('--cookies-from-browser', options.browser !== 'auto' ? options.browser : 'chrome');
        }
      } else if (options.url.includes('vimeo.com')) {
        // Vimeo-specific configuration: Vimeo requires authentication for most videos
        ytDlpManager.addOption('--format', `best[height<=${options.quality}]/best`);
        ytDlpManager.addOption('--merge-output-format', 'mp4');

        // Vimeo REQUIRES cookies from browser - use Chrome by default
        const browser = (options.useCookies && options.browser && options.browser !== 'auto')
          ? options.browser
          : 'chrome';

        ytDlpManager.addOption('--cookies-from-browser', browser);
        this.logger.log(`Using cookies from ${browser} for Vimeo authentication`);
      } else {
        // For other sites, use standard format selection
        ytDlpManager.addOption('--format', `best[height<=${options.quality}]/best`);
        ytDlpManager.addOption('--merge-output-format', 'mp4');
        // Note: Cookies only used for YouTube - other sites work better without them
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
        // For YouTube, try multiple client methods if the first one fails
        if (options.url.includes('youtube.com') || options.url.includes('youtu.be')) {
          const clientMethods = ['android', 'ios', 'mweb', 'web', 'default'];
          let lastError: Error | null = null;

          for (const clientType of clientMethods) {
            try {
              this.logger.log(`Attempting YouTube download with ${clientType} client...`);

              // Re-create ytDlpManager with new client configuration
              const newYtDlpManager = new YtDlpManager();
              newYtDlpManager.input(options.url).output(outputTemplate);

              const ffmpegPath = this.sharedConfigService.getFfmpegPath();
              if (ffmpegPath) {
                newYtDlpManager.addOption('--ffmpeg-location', ffmpegPath);
              }

              newYtDlpManager.addOption('--verbose')
                            .addOption('--no-check-certificates')
                            .addOption('--no-playlist')
                            .addOption('--playlist-items', '1')  // Only download first video if multiple found
                            .addOption('--force-overwrites');

              if (options.convertToMp4) {
                newYtDlpManager.addOption('--merge-output-format', 'mp4');
              }

              // Configure YouTube download with current client type
              this.configureYouTubeDownload(newYtDlpManager, options, clientType);

              // Update active downloads reference
              if (jobId) {
                this.activeDownloads.set(jobId, newYtDlpManager);
              }

              // Set up progress tracking
              newYtDlpManager.on('progress', (progress) => {
                this.eventService.emitDownloadProgress(
                  progress.percent,
                  `Downloading (${clientType} client)`,
                  jobId,
                  {
                    speed: progress.downloadSpeed,
                    eta: progress.eta,
                    totalSize: progress.totalSize,
                    downloadedBytes: progress.downloadedBytes
                  }
                );
              });

              // Try this client method
              const output = await newYtDlpManager.runWithRetry(2, 1000);
              outputFile = await this.determineOutputFile(output, downloadFolder, downloadStartTime);

              if (outputFile && fs.existsSync(outputFile)) {
                this.logger.log(`✓ Success with ${clientType} client!`);
                break; // Success! Exit the loop
              } else {
                // No file was created - treat this as a failure
                const errorMsg = `${clientType} client completed but no output file was created`;
                this.logger.warn(`✗ ${errorMsg}`);
                throw new Error(errorMsg);
              }
            } catch (error) {
              lastError = error as Error;
              this.logger.warn(`✗ ${clientType} client failed: ${lastError.message}`);

              // Continue to next client method
              if (clientType !== clientMethods[clientMethods.length - 1]) {
                this.logger.log(`Trying next client method...`);
                continue;
              } else {
                // This was the last method, throw the error
                throw lastError;
              }
            }
          }
        } else {
          // Non-YouTube download - use standard method
          const output = await ytDlpManager.runWithRetry(3, 2000);
          outputFile = await this.determineOutputFile(output, downloadFolder, downloadStartTime);
        }

        // Check if we have a valid output file
        
        if (outputFile && fs.existsSync(outputFile)) {
          this.logger.log(`Download successful: ${outputFile}`);
          outputFile = await this.processOutputFilename(outputFile, uploadDate);

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
        const errorMsg = error instanceof Error ? (error as Error).message : 'Unknown error during yt-dlp execution';
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
      const errorMsg = error instanceof Error ? (error as Error).message : 'Unknown error';
      
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
  private async determineOutputFile(output: string, downloadFolder: string, downloadStartTime: number): Promise<string | null> {
    // Try to extract from output first
    let outputFile: string | null = null;

    // IMPORTANT: Check merger line FIRST because it's the final output file
    // yt-dlp may report a destination file with one extension (.mp4) but then
    // merge formats and create a different file with another extension (.mov)
    const mergerMatch = output.match(/\[Merger\] Merging formats into "(.+)"$/m);
    if (mergerMatch) {
      outputFile = mergerMatch[1];
      this.logger.log(`Found output file from merger line: ${outputFile}`);

      // Verify file exists
      if (fs.existsSync(outputFile)) {
        return outputFile;
      } else {
        this.logger.warn(`Merger output file does not exist: ${outputFile}`);
      }
    }

    // Check for '[download] Destination:' line as fallback
    const destinationMatch = output.match(/\[download\] Destination: (.+)$/m);
    if (destinationMatch) {
      outputFile = destinationMatch[1];
      this.logger.log(`Found output file from destination line: ${outputFile}`);

      // Verify file exists
      if (fs.existsSync(outputFile)) {
        return outputFile;
      } else {
        this.logger.warn(`Destination file does not exist: ${outputFile}`);
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

      // Define valid media file extensions
      const validExtensions = [
        '.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.wmv', '.m4v',
        '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac',
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'
      ];

      const mostRecentFile = files
        .filter(file => {
          // Filter out hidden files, system files, and macOS metadata files
          if (file.startsWith('.') || file.startsWith('._')) return false;

          // Filter for valid media extensions
          const ext = path.extname(file).toLowerCase();
          if (!validExtensions.includes(ext)) return false;

          // CRITICAL: Only consider files created AFTER download started
          const filePath = path.join(downloadFolder, file);
          const fileStats = fs.statSync(filePath);
          const fileModTime = fileStats.mtime.getTime();

          // File must have been modified after we started the download
          return fileModTime >= downloadStartTime;
        })
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
      } else {
        this.logger.warn(`No valid media files found in download directory created after ${new Date(downloadStartTime).toISOString()}`);
        this.logger.warn(`Download folder: ${downloadFolder}`);
        this.logger.warn(`Files in folder: ${files.join(', ')}`);
      }
    } catch (error) {
      this.logger.error(`Error while trying to infer output file: ${error instanceof Error ? (error as Error).message : 'Unknown error'}`);
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
      const ytDlpManager = new YtDlpManager();
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
        const errorMessage = error instanceof Error ? (error as Error).message : String(error);
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
      this.logger.error(`Error in getRedditInfo: ${error instanceof Error ? (error as Error).message : 'Unknown error'}`);
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
        const errorMsg = error instanceof Error ? (error as Error).message : 'Unknown error';
        this.eventService.emitDownloadFailed(imageUrl, errorMsg, jobId);
        reject({
          success: false,
          error: errorMsg
        });
      }
    });
  }

  /**
   * Get information about a Twitter/X post with an image
   */
  private async getTwitterImageInfo(url: string): Promise<{ imageUrl?: string, title: string }> {
    try {
      this.logger.log(`Fetching info for Twitter image URL: ${url}`);

      // Use yt-dlp to get tweet metadata
      const ytDlpManager = new YtDlpManager();
      ytDlpManager
        .input(url)
        .addOption('--dump-json')
        .addOption('--simulate')
        .addOption('--no-playlist');

      try {
        const output = await ytDlpManager.run();

        if (output && output.trim()) {
          const info = JSON.parse(output.trim());

          if (info && info.title) {
            const title = info.title;
            this.logger.log(`Successfully fetched Twitter post title: ${title}`);

            // Extract image URL from the tweet
            // Twitter media is in the 'url' field when it's an image
            if (info.url && (info.url.includes('pbs.twimg.com') || info.url.includes('twimg.com'))) {
              const imageUrl = info.url;
              this.logger.log(`Found image URL in tweet: ${imageUrl}`);
              return { imageUrl, title };
            }

            // Check for thumbnails which might be the image
            if (info.thumbnail) {
              this.logger.log(`Found thumbnail URL: ${info.thumbnail}`);
              return { imageUrl: info.thumbnail, title };
            }
          }
        }
      } catch (error) {
        // If yt-dlp fails with "Media #X is not a video", extract info from error
        const errorMessage = error instanceof Error ? (error as Error).message : String(error);
        this.logger.warn(`yt-dlp execution failed: ${errorMessage}`);

        // Try to use getVideoInfo to get just the title
        try {
          const videoInfo = await this.getVideoInfo(url);
          if (videoInfo && videoInfo.title) {
            // We have the title, but need to construct the image URL from the tweet
            // Remove /photo/1 from URL to get base tweet URL
            const baseTweetUrl = url.replace(/\/photo\/\d+$/, '');

            this.logger.log(`Extracted title from tweet: ${videoInfo.title}`);
            this.logger.log(`Note: Unable to extract image URL directly, would need to fetch from Twitter API`);

            // For now, return title only - the download will fail but at least we tried
            return { title: videoInfo.title };
          }
        } catch (infoError) {
          this.logger.warn(`Could not get video info: ${infoError instanceof Error ? infoError.message : 'Unknown error'}`);
        }

        throw new Error(`Could not extract image URL or title from Twitter post. Error: ${errorMessage}`);
      }

      // Fallback
      throw new Error('Could not extract Twitter image information');

    } catch (error) {
      this.logger.error(`Error in getTwitterImageInfo: ${error instanceof Error ? (error as Error).message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Download an image from Twitter/X directly
   */
  private async downloadTwitterImage(imageUrl: string, title: string, downloadFolder: string, jobId?: string): Promise<DownloadResult> {
    return new Promise((resolve, reject) => {
      try {
        // Create a safe filename from the title
        const safeTitle = title.replace(/[^a-z0-9\s]/gi, '_').replace(/\s+/g, ' ').trim();

        // Prepare a filename with current date like the video naming convention
        const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

        // Twitter images are usually jpg, but check URL for extension
        let ext = path.extname(imageUrl).toLowerCase();
        // Remove query params from extension if present
        if (ext.includes('?')) {
          ext = ext.split('?')[0];
        }
        // Fallback to .jpg if no extension found
        if (!ext || ext === '') {
          ext = '.jpg';
        }

        const filename = `${date} ${safeTitle}${ext}`;
        const outputPath = path.join(downloadFolder, filename);

        this.logger.log(`Downloading Twitter image: ${imageUrl} to ${outputPath}`);
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
            this.downloadTwitterImage(redirectUrl, title, downloadFolder, jobId)
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
        this.logger.error('Error downloading Twitter image:', error);
        const errorMsg = error instanceof Error ? (error as Error).message : 'Unknown error';
        this.eventService.emitDownloadFailed(imageUrl, errorMsg, jobId);
        reject({
          success: false,
          error: errorMsg
        });
      }
    });
  }

  /**
   * Process output filename to ensure consistent date format
   * Uses FilenameDateUtil to enforce YYYY-MM-DD [title] format
   */
  async processOutputFilename(filePath: string, uploadDate?: string): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) {
        this.logger.error(`File does not exist: ${filePath}`);
        return filePath;
      }

      const filename = path.basename(filePath);
      const directory = path.dirname(filePath);

      // Use the utility to ensure proper date format
      const newFilename = FilenameDateUtil.ensureDatePrefix(filename, uploadDate);

      // Only rename if the filename changed
      if (newFilename !== filename) {
        const newPath = path.join(directory, newFilename);
        fs.renameSync(filePath, newPath);
        this.logger.log(`Processed filename: ${filename} -> ${newFilename}`);
        return newPath;
      }

      this.logger.log(`File already has correct date format: ${filename}`);
      return filePath;
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
        this.logger.error(`Error: ${error instanceof Error ? (error as Error).message : String(error)}`);
        
        throw new Error(`URL check failed: ${error instanceof Error ? (error as Error).message : 'Unknown error'}`);
      }
    } catch (error) {
      this.logger.error(`Error in checkUrl: ${error instanceof Error ? (error as Error).message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Get detailed video information
   */
  async getVideoInfo(url: string): Promise<any> {
    try {
      // Transform ABC News URLs if needed
      url = await this.transformAbcNewsUrl(url);

      const startTime = Date.now();
      this.logger.log(`[TIMING] Fetching video info for URL: ${url}`);

      // Create and configure YtDlpManager
      const ytDlpManager = new YtDlpManager();
      ytDlpManager
        .input(url)
        .addOption('--dump-json')
        .addOption('--no-playlist')
        .addOption('--flat-playlist')
        .addOption('--skip-download')
        .addOption('--no-warnings')
        .addOption('--no-check-certificates')
        .addOption('--extractor-retries', '1')
        .addOption('--socket-timeout', '5');

      // For YouTube URLs, use android client for better reliability
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        ytDlpManager.addOption('--extractor-args', 'youtube:player_client=android');
      }

      // For Vimeo, use cookies from Chrome for authentication
      if (url.includes('vimeo.com')) {
        ytDlpManager.addOption('--cookies-from-browser', 'chrome');
        this.logger.log('Using cookies from Chrome for Vimeo metadata retrieval');
      }

      // For Twitter/X, let yt-dlp use its default API (syndication API is slow now)
      // Removed: twitter:api=syndication - it was causing 20+ second delays

      // For Facebook, reduce timeout for metadata since it can be very slow
      if (url.includes('facebook.com') || url.includes('fb.watch')) {
        ytDlpManager.addOption('--socket-timeout', '5'); // Shorter timeout for Facebook
        ytDlpManager.addOption('--extractor-retries', '0'); // No retries for metadata - fail fast
      }

      const beforeRun = Date.now();
      this.logger.log(`[TIMING] Setup took ${beforeRun - startTime}ms, about to call ytDlpManager.run()`);

      // Execute the command and get output
      const output = await ytDlpManager.run();

      const afterRun = Date.now();
      this.logger.log(`[TIMING] ytDlpManager.run() took ${afterRun - beforeRun}ms, processing output...`);

      this.logger.log(`yt-dlp output length: ${output.length} characters`);
      this.logger.log(`yt-dlp output preview: ${output.substring(0, 200)}...`);
      this.logger.log(`yt-dlp output end: ...${output.substring(Math.max(0, output.length - 100))}`);

      try {
        // Parse the JSON output
        // yt-dlp may output multiple JSON objects (one per line), so we need to handle this
        const trimmedOutput = output.trim();

        // Split by newlines and get the first valid JSON object
        const lines = trimmedOutput.split('\n');
        let videoInfo = null;

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('{')) {
            try {
              videoInfo = JSON.parse(trimmedLine);
              break; // Use the first valid JSON object
            } catch (e) {
              // Try next line
              continue;
            }
          }
        }

        if (!videoInfo) {
          throw new Error('No valid JSON found in yt-dlp output');
        }
        
        // Format the upload date if available
        // Use undefined (not empty string) when no date, so falsy checks work correctly
        let formattedDate: string | undefined = undefined;
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
      this.logger.error(`Error in getVideoInfo: ${error instanceof Error ? (error as Error).message : 'Unknown error'}`);
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