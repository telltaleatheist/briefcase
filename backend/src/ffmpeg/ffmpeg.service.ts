// clippy/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { VideoMetadata } from '../common/interfaces/download.interface';
import { MediaEventService } from '../media/media-event.service';
import * as ffmpegPath from '@ffmpeg-installer/ffmpeg';
import * as ffprobePath from '@ffprobe-installer/ffprobe';
import { SharedConfigService } from '../config/shared-config.service';

@Injectable()
export class FfmpegService {
  private lastReportedProgress: Map<string, number> = new Map();
  private readonly logger = new Logger(FfmpegService.name);

  constructor(
    private readonly eventService: MediaEventService,
    private readonly configService: SharedConfigService,
    private readonly eventEmitter: EventEmitter2
  ) {
    try {
      // Prioritize config service paths, then environment variables, then packaged binaries, then installer paths
      const configFfmpegPath = this.configService.getFfmpegPath();
      const configFfprobePath = this.configService.getFfprobePath();

      let ffmpegExecutablePath = configFfmpegPath || process.env.FFMPEG_PATH;
      let ffprobeExecutablePath = configFfprobePath || process.env.FFPROBE_PATH;

      // If not configured, try packaged binaries in production
      // In production: Check if RESOURCES_PATH env var is set OR resourcesPath property exists
      const isPackaged = process.env.NODE_ENV === 'production' &&
                         (process.env.RESOURCES_PATH !== undefined ||
                          (process as any).resourcesPath !== undefined ||
                          (process as any).defaultApp === false);

      this.logger.log(`isPackaged: ${isPackaged}, NODE_ENV: ${process.env.NODE_ENV}`);

      if (isPackaged && (!ffmpegExecutablePath || !ffprobeExecutablePath)) {
        const resourcesPath = process.env.RESOURCES_PATH || (process as any).resourcesPath || path.join(process.cwd(), 'resources');
        this.logger.log(`RESOURCES_PATH env: ${process.env.RESOURCES_PATH}`);
        this.logger.log(`process.resourcesPath: ${(process as any).resourcesPath}`);
        this.logger.log(`process.cwd(): ${process.cwd()}`);
        this.logger.log(`Final resources path for ffmpeg lookup: ${resourcesPath}`);

        if (!ffmpegExecutablePath) {
          // Try to find packaged ffmpeg in backend/node_modules
          let platformFolder = '';
          if (process.platform === 'win32') {
            platformFolder = 'win32-x64';
          } else if (process.platform === 'darwin') {
            platformFolder = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
          } else if (process.platform === 'linux') {
            platformFolder = 'linux-x64';
          }

          // Try multiple possible locations for ffmpeg
          const possibleFfmpegPaths = [
            // app.asar.unpacked location
            path.join(resourcesPath, 'app.asar.unpacked', 'backend', 'node_modules', '@ffmpeg-installer', platformFolder,
              process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
            // extraResources location
            path.join(resourcesPath, 'backend', 'node_modules', '@ffmpeg-installer', platformFolder,
              process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
          ];

          for (const packagedFfmpegPath of possibleFfmpegPaths) {
            this.logger.log(`Looking for packaged ffmpeg at: ${packagedFfmpegPath}`);
            this.logger.log(`ffmpeg exists: ${fs.existsSync(packagedFfmpegPath)}`);
            if (fs.existsSync(packagedFfmpegPath)) {
              ffmpegExecutablePath = packagedFfmpegPath;
              break;
            }
          }
        }

        if (!ffprobeExecutablePath) {
          // Try to find packaged ffprobe in backend/node_modules
          let platformFolder = '';
          if (process.platform === 'win32') {
            platformFolder = 'win32-x64';
          } else if (process.platform === 'darwin') {
            platformFolder = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
          } else if (process.platform === 'linux') {
            platformFolder = 'linux-x64';
          }

          // Try multiple possible locations for ffprobe
          const possibleFfprobePaths = [
            // app.asar.unpacked location
            path.join(resourcesPath, 'app.asar.unpacked', 'backend', 'node_modules', '@ffprobe-installer', platformFolder,
              process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
            // extraResources location
            path.join(resourcesPath, 'backend', 'node_modules', '@ffprobe-installer', platformFolder,
              process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
          ];

          for (const packagedFfprobePath of possibleFfprobePaths) {
            this.logger.log(`Looking for packaged ffprobe at: ${packagedFfprobePath}`);
            this.logger.log(`ffprobe exists: ${fs.existsSync(packagedFfprobePath)}`);
            if (fs.existsSync(packagedFfprobePath)) {
              ffprobeExecutablePath = packagedFfprobePath;
              break;
            }
          }
        }
      }

      // Fall back to installer paths if still not found
      if (!ffmpegExecutablePath) {
        ffmpegExecutablePath = ffmpegPath.path;
      }

      if (!ffprobeExecutablePath) {
        ffprobeExecutablePath = ffprobePath.path;
      }

      if (!ffmpegExecutablePath) {
        throw new Error('FFmpeg path not found. Please configure it in the application settings.');
      }

      if (!ffprobeExecutablePath) {
        throw new Error('FFprobe path not found. Please configure it in the application settings.');
      }

      // Set paths for fluent-ffmpeg
      ffmpeg.setFfmpegPath(ffmpegExecutablePath);
      ffmpeg.setFfprobePath(ffprobeExecutablePath);

      this.logger.log(`FFmpeg path: ${ffmpegExecutablePath}`);
      this.logger.log(`FFprobe path: ${ffprobeExecutablePath}`);

      // Verify if the paths are valid by checking file existence
      if (!fs.existsSync(ffmpegExecutablePath)) {
        throw new Error(`FFmpeg executable not found at path: ${ffmpegExecutablePath}`);
      }

      if (!fs.existsSync(ffprobeExecutablePath)) {
        throw new Error(`FFprobe executable not found at path: ${ffprobeExecutablePath}`);
      }
    } catch (error) {
      this.logger.error('Failed to set FFmpeg/FFprobe paths', error);
      throw error;
    }
  }
  
  async getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    return new Promise<VideoMetadata>((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          this.logger.error(`Error probing video: ${err.message}`);
          return reject(err);
        }

        // Try to find video stream first
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');

        // If no video stream, try audio stream (for audio-only files)
        const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');

        if (!videoStream && !audioStream) {
          return reject(new Error('No video or audio stream found'));
        }

        // Prefer video stream, fall back to audio stream (we know at least one exists)
        const primaryStream = videoStream || audioStream!;

        // Get duration from stream, or fall back to format duration
        let fileDuration = 0;
        if (primaryStream.duration) {
          fileDuration = parseFloat(primaryStream.duration as any);
        }
        if (!fileDuration && metadata.format && metadata.format.duration) {
          fileDuration = typeof metadata.format.duration === 'string'
            ? parseFloat(metadata.format.duration)
            : metadata.format.duration;
        }

        // Calculate FPS from rational frame rate (e.g., "30000/1001") - only for video
        let fps: number | undefined;
        if (videoStream && videoStream.r_frame_rate) {
          const [numerator, denominator] = videoStream.r_frame_rate.split('/').map(Number);
          if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
            fps = numerator / denominator;
          }
        }

        // Calculate aspect ratio - only for video
        let aspectRatio: string | undefined;
        if (videoStream && videoStream.width && videoStream.height) {
          const gcd = this.calculateGCD(videoStream.width, videoStream.height);
          aspectRatio = `${videoStream.width / gcd}:${videoStream.height / gcd}`;
        }

        resolve({
          width: videoStream?.width,
          height: videoStream?.height,
          duration: fileDuration,
          codecName: primaryStream.codec_name,
          bitrate: primaryStream.bit_rate ? parseInt(primaryStream.bit_rate as any) : undefined,
          fps,
          aspectRatio,
        });
      });
    });
  }

  async reencodeVideo(
    videoFile: string,
    jobId?: string,
    options?: {
      fixAspectRatio?: boolean,
      normalizeAudio?: boolean,
      audioNormalizationMethod?: 'rms' | 'peak',
      useRmsNormalization?: boolean,
      rmsNormalizationLevel?: number,
      useCompression?: boolean,
      compressionLevel?: number
    },
    taskType?: string  // NEW: Task type for new queue system
  ): Promise<string | null> {
    this.logger.log('Received reencoding options:', JSON.stringify({
      fixAspectRatio: options?.fixAspectRatio,
      normalizeAudio: options?.normalizeAudio,
      audioNormalizationMethod: options?.audioNormalizationMethod
    }, null, 2));
        
    try {
      // Use a single default encoder without detection
      const selectedEncoder = 'libx264';
  
      return new Promise<string | null>((resolve, reject) => {
        this.probeVideo(videoFile, (err, metadata) => {
          if (err) {
            this.logger.error(`CRITICAL: Error probing video file: ${err.message}`);
            resolve(null);
            return;
          }
  
          const videoAnalysis = this.analyzeVideoMetadata(metadata);
          if (!videoAnalysis.isValid) {
            resolve(null);
            return;
          }
  
          // Set defaults for potentially undefined values
          const dimensions = videoAnalysis.dimensions || { width: 0, height: 0 };
          const duration = videoAnalysis.duration || 0;
          const isVertical = videoAnalysis.isVertical ?? false;
          const needsAspectRatioFix = videoAnalysis.needsAspectRatioFix ?? false;

          const { outputFile, progressKey } = this.generateOutputPath(videoFile);

          // Reset the progress counter for this file
          this.lastReportedProgress.set(progressKey, 0);

          // Create FFmpeg command
          const command = this.buildFfmpegCommand(
            videoFile,
            outputFile,
            isVertical,
            needsAspectRatioFix,
            selectedEncoder,
            options,
            duration
          );
                      
          // Start progress at 0%
          this.eventService.emitProcessingProgress(0, 'Preparing video re-encoding', jobId);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, 0, 'Preparing video re-encoding');
          }

          this.setupCommandEventHandlers(command, videoFile, outputFile, progressKey, duration, jobId, resolve, taskType);

          // Make sure the command is explicitly run
          command.run();
        });
      });
    } catch (error) {
      this.logger.error('CRITICAL: Unexpected error in aspect ratio processing:', error);
      return null;
    }
  }
  
  private probeVideo(videoFile: string, callback: (err: any, metadata: any) => void): void {
    ffmpeg.ffprobe(videoFile, callback);
  }

  private analyzeVideoMetadata(metadata: any): {
    isValid: boolean,
    dimensions?: { width: number, height: number },
    duration?: number,
    isVertical?: boolean,
    needsAspectRatioFix?: boolean
  } {
    const stream = metadata.streams.find((s: { codec_type: string; }) => s.codec_type === 'video');
    if (!stream) {
      this.logger.error('CRITICAL: No video stream found');
      return { isValid: false };
    }
  
    let width = stream.width;
    let height = stream.height;
    let totalDuration = parseFloat(stream.duration || '0');
    
    if (!width || !height) {
      this.logger.error('Could not determine video dimensions');
      return { isValid: false };
    }
    
    // Check for rotation metadata
    const tags = stream.tags || {};
    const rotation = stream.rotation || tags.rotate || 0;
    
    if (rotation === '90' || rotation === '270' || rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }
  
    const aspectRatio = width / height;

    // Target aspect ratio is 16:9 (1.777...)
    const targetAspectRatio = 16 / 9;
    const aspectRatioTolerance = 0.01; // Allow small variations

    // Does it need aspect ratio correction? (Not already 16:9)
    const needsAspectRatioFix = Math.abs(aspectRatio - targetAspectRatio) > aspectRatioTolerance;

    // Is it a vertical video?
    const isVertical = aspectRatio <= 1.0;

    this.logger.log(`REENCODING ANALYSIS:
      Original Dimensions: ${width}x${height}
      Calculated Aspect Ratio: ${aspectRatio.toFixed(4)}
      Target Aspect Ratio: ${targetAspectRatio.toFixed(4)}
      Is Vertical Video: ${isVertical}
      Needs Aspect Ratio Fix: ${needsAspectRatioFix}
      Video Duration: ${totalDuration}s`);

    return {
      isValid: true,
      dimensions: { width, height },
      duration: totalDuration,
      isVertical,
      needsAspectRatioFix
    };
  }

  private generateOutputPath(videoFile: string): { outputFile: string, progressKey: string } {
    const fileDir = path.dirname(videoFile);
    const fileName = path.basename(videoFile);
    const fileBase = path.parse(fileName).name;
  
    // Force .mov extension for Final Cut Pro compatibility
    const outputFile = path.join(fileDir, `${fileBase}_reencoded.mov`);
    
    // Set the progress key
    const progressKey = outputFile;
    
    return { outputFile, progressKey };
  }

  private getFilterOptions(isVertical: boolean): string[] {
    if (isVertical) {
      return [
        '-filter_complex', 
        "[0:v]scale=1920:1920:force_original_aspect_ratio=increase,gblur=sigma=50,crop=1920:1080[bg];[0:v]scale='if(gte(a,16/9),1920,-1)':'if(gte(a,16/9),-1,1080)'[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p"
      ];
    } else {
      // For non-vertical videos, apply a simpler filter
      return ['-filter_complex', "[0:v]format=yuv420p"];
    }
  }
  
  // Helper to build the full FFmpeg command
  private buildFfmpegCommand(
    videoFile: string,
    outputFile: string,
    isVertical: boolean,
    needsAspectRatioFix: boolean,
    encoder: string,
    options?: {
      fixAspectRatio?: boolean,
      useRmsNormalization?: boolean,
      rmsNormalizationLevel?: number,
      useCompression?: boolean,
      compressionLevel?: number
    },
    duration?: number
  ): any {
    let filterComplex = '';

    // Apply blurred background fix if fixAspectRatio is enabled AND video needs fixing
    if (options?.fixAspectRatio && needsAspectRatioFix) {
      // Use the same blurred background technique for ALL non-16:9 videos
      filterComplex = "[0:v]scale=1920:1920:force_original_aspect_ratio=increase,gblur=sigma=50,crop=1920:1080[bg];" +
                       "[0:v]scale='if(gte(a,16/9),1920,-1)':'if(gte(a,16/9),-1,1080)'[fg];" +
                       "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]";
    } else {
      filterComplex = "[0:v]format=yuv420p[v]";
    }
    
    const commandOptions = ['-map', '[v]'];
    
    if (options?.useRmsNormalization || options?.useCompression) {
      let audioFilter = '';
      
      if (options?.useRmsNormalization) {
        const level = options.rmsNormalizationLevel ?? 0;
        audioFilter = `[0:a]volume=${level}dB`;
        
        if (options?.useCompression) {
          audioFilter += `[a1];[a1]`;
        } else {
          audioFilter += '[aout]';
        }
      } else {
        audioFilter = '[0:a]';
      }
      
      if (options?.useCompression) {
        const level = options.compressionLevel ?? 5;
        audioFilter += `compand=attacks=0.3:decays=0.3:points=-90/-900|-45/-900|-30/-15|0/-6|15/0:gain=${level}[aout]`;
      }
      
      filterComplex += `;${audioFilter}`;
      commandOptions.push('-map', '[aout]?');
    } else {
      commandOptions.push('-map', '0:a?');
    }
    
    commandOptions.unshift('-filter_complex', filterComplex);
    commandOptions.push(
      '-pix_fmt', 'yuv420p',
      '-c:v', encoder,
      '-b:v', '3M',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart'
    );
    
    return ffmpeg(videoFile)
      .outputOptions(commandOptions)
      .output(outputFile);
  }
  
  private parseProgress(
    stderrLine: string, 
    totalDuration: number, 
    progressKey: string
  ): { progressPercent: number, speedInfo: string } | null {
    const timeMatch = stderrLine.match(/time=(\d+:\d+:\d+\.\d+)/);
    const speedMatch = stderrLine.match(/speed=(\d+\.\d+)x/);
    
    if (!timeMatch) return null;
    
    const timeStr = timeMatch[1];
    const timeParts = timeStr.split(/[:\.]/);
    
    if (timeParts.length < 3) return null;
    
    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);
    const seconds = parseInt(timeParts[2]);
    const millis = timeParts.length > 3 ? parseInt(timeParts[3]) : 0;
    
    const currentTimeInSeconds = hours * 3600 + minutes * 60 + seconds + (millis / 100);
    
    // Make sure totalDuration is valid (fallback to default if not)
    let effectiveDuration = totalDuration;
    if (effectiveDuration <= 0 || isNaN(effectiveDuration)) {
      this.logger.warn(`Invalid duration: ${totalDuration}, using default`);
      effectiveDuration = 100; // Use a default if duration is invalid
    }
    
    let progressPercent = Math.min(Math.round((currentTimeInSeconds / effectiveDuration) * 100), 100);
    
    // Always force progress to be between 5-95% (leaving room for start and end operations)
    progressPercent = Math.max(5, Math.min(progressPercent, 95));
    
    // Skip if progress is too small or moving backwards
    const lastProgress = this.lastReportedProgress.get(progressKey) || 0;
    if (progressPercent <= lastProgress) {
      return null;
    }
    
    this.lastReportedProgress.set(progressKey, progressPercent);
    
    let speedInfo = '';
    if (speedMatch) {
      speedInfo = `(Speed: ${speedMatch[1]}x)`;
    }
    
    return { progressPercent, speedInfo };
  }

  private setupCommandEventHandlers(
    command: any,
    videoFile: string,
    outputFile: string,
    progressKey: string,
    duration: number,
    jobId?: string,
    resolve?: (value: string | null) => void,
    taskType?: string  // NEW: Task type for new queue system
  ): void {
    command.on('start', (cmdline: string) => {
      this.logger.log(`FFmpeg re-encoding command started: ${cmdline}`);
      this.eventService.emitProcessingProgress(0, 'Starting video re-encoding', jobId);
      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 0, 'Starting video re-encoding');
      }
    });

    command.on('stderr', (stderrLine: string) => {
      const progress = this.parseProgress(stderrLine, duration, progressKey);
      if (progress) {
        const message = `Re-encoding video ${progress.speedInfo}`;
        // Emit progress with jobId (old system)
        this.eventService.emitProcessingProgress(
          progress.progressPercent,
          message,
          jobId
        );
        // Also emit task-progress for new queue system
        if (taskType && jobId) {
          this.eventService.emitTaskProgress(jobId, taskType, progress.progressPercent, message);
        }
      }
    });

    command.on('end', () => {
      this.logger.log(`Successfully re-encoded video: ${outputFile}`);

      // Preserve original file timestamps before deletion
      const fs = require('fs');
      const originalStats = fs.statSync(videoFile);
      const originalAtime = originalStats.atime;
      const originalMtime = originalStats.mtime;

      // Delete the original video safely
      if (this.safeDeleteFile(videoFile)) {
        this.logger.log(`Deleted original video: ${videoFile}`);

        // Rename the reencoded file to the original name (keep original extension)
        const originalName = videoFile;  // Keep exact original filename
        try {
          fs.renameSync(outputFile, originalName);
          this.logger.log(`Renamed ${outputFile} to ${originalName}`);

          // Preserve original timestamps (critical for maintaining download_date)
          // atime = access time, mtime = modification time
          // These determine the file's birthtime/creation date
          fs.utimesSync(originalName, originalAtime, originalMtime);
          this.logger.log(`Preserved original file timestamps (download_date maintained)`);

          // Emit 100% completion
          this.lastReportedProgress.set(progressKey, 100);
          this.eventService.emitProcessingProgress(100, 'Video re-encoding completed', jobId);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, 100, 'Video re-encoding completed');
          }

          if (resolve) resolve(originalName);
        } catch (err: any) {
          this.logger.error(`Failed to rename file: ${err.message}`);
          // Still resolve with the _reencoded file if rename fails
          this.lastReportedProgress.set(progressKey, 100);
          this.eventService.emitProcessingProgress(100, 'Video re-encoding completed', jobId);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, 100, 'Video re-encoding completed');
          }
          if (resolve) resolve(outputFile);
        }
      } else {
        // If deletion failed, keep the _reencoded version
        this.lastReportedProgress.set(progressKey, 100);
        this.eventService.emitProcessingProgress(100, 'Video re-encoding completed', jobId);
        if (taskType && jobId) {
          this.eventService.emitTaskProgress(jobId, taskType, 100, 'Video re-encoding completed');
        }
        if (resolve) resolve(outputFile);
      }
    });

    command.on('error', (err: any) => {
      this.logger.error(`Error re-encoding video: ${err.message}`);

      // Emit error event
      this.eventService.emitProcessingFailed(videoFile, err.message, jobId);

      if (resolve) resolve(null);
    });
  }
  
  private getAudioNormalizationFilter(options?: {
    normalizeAudio?: boolean;
    audioNormalizationMethod?: 'rms' | 'peak';
    useRmsNormalization?: boolean;
    rmsNormalizationLevel?: number;
    useCompression?: boolean;
    compressionLevel?: number;
  }): string[] {
    const filters: string[] = [];
  
    // New RMS Normalization
    if (options?.useRmsNormalization) {
      const rmsLevel = options.rmsNormalizationLevel || 0;
      const rmsGain = rmsLevel; // Direct mapping of slider value to gain
      filters.push(
        '-filter_complex', 
        `[0:a]volume=replaygain=track:replaygain-adjustment=${rmsGain}[rms_normalized]`,
        '-map', '[rms_normalized]'
      );
    }
  
    // New Compression
    if (options?.useCompression) {
      const compressionLevel = options.compressionLevel || 5;
      const compandPoints = this.getCompandPointsForLevel(compressionLevel);
      filters.push(
        '-filter_complex', 
        `[0:a]compand=attacks=0.3:decays=0.3:points=${compandPoints}[compressed]`,
        '-map', '[compressed]'
      );
    }
  
    return filters;
  }

  private getCompandPointsForLevel(level: number): string {
    // Provide different compression curves based on level
    switch (true) {
      case level <= 2: 
        return '-90/-900|-45/-900|-27/-18|0/-9|12/0'; // Light compression
      case level <= 5: 
        return '-90/-900|-45/-900|-30/-15|0/-6|15/0'; // Moderate compression
      default: 
        return '-90/-900|-45/-900|-35/-10|0/-3|20/0'; // Heavy compression
    }
  }

  private safeDeleteFile(filePath: string): boolean {
    if (!filePath) return false;
    
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.log(`Deleted file: ${filePath}`);
        return true;
      } else {
        this.logger.debug(`File doesn't exist, no need to delete: ${filePath}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Error deleting file ${filePath}:`, error);
      return false;
    }
  }
  
  async createThumbnail(videoPath: string, outputPath?: string): Promise<string | null> {
    if (!fs.existsSync(videoPath)) {
      this.logger.error(`Video file doesn't exist: ${videoPath}`);
      return null;
    }

    try {
      // Generate output path if not provided
      if (!outputPath) {
        const fileDir = path.dirname(videoPath);
        const fileBase = path.parse(videoPath).name;
        outputPath = path.join(fileDir, `${fileBase}_thumbnail.jpg`);
      }

      // First, get video duration to calculate 10% mark
      const metadata = await this.getVideoMetadata(videoPath);
      const duration = metadata.duration || 0;
      const thumbnailTime = Math.max(1, duration * 0.1); // 10% of duration, minimum 1 second

      return new Promise<string | null>((resolve, reject) => {
        const command = ffmpeg(videoPath)
          .screenshots({
            timestamps: [thumbnailTime], // Take screenshot at 10% of the video duration
            filename: path.basename(outputPath || ''),
            folder: path.dirname(outputPath || ''),
            size: '?x360', // Height of 360px, width auto-calculated to preserve aspect ratio
          })
          .on('start', (cmdline) => {
            this.logger.log(`FFmpeg thumbnail command started: ${cmdline}`);
          })
          .on('end', () => {
            this.logger.log(`Thumbnail created at: ${outputPath}`);
            resolve(outputPath || null);
          })
          .on('error', (err) => {
            this.logger.error(`Error creating thumbnail: ${err.message}`);
            resolve(null);
          });

        // Make sure the command is explicitly run
        command.run();
      });
    } catch (error) {
      this.logger.error('Error creating thumbnail:', error);
      return null;
    }
  }

  private calculateGCD(a: number, b: number): number {
    return b === 0 ? a : this.calculateGCD(b, a % b);
  }

  /**
   * Normalize audio volume of a file
   * @param filePath - Path to the input file
   * @param targetVolume - Target volume in dB (e.g., -20)
   * @returns Path to the normalized file
   */
  async normalizeAudio(filePath: string, targetVolume: number = -20, jobId?: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) {
      this.logger.error(`File doesn't exist: ${filePath}`);
      return null;
    }

    try {
      const fileDir = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const fileExt = path.extname(fileName);
      const fileBase = path.parse(fileName).name;

      // Generate temporary output file path
      const tempOutputFile = path.join(fileDir, `${fileBase}_temp_normalized${fileExt}`);

      return new Promise<string | null>((resolve, reject) => {
        // Use loudnorm filter for professional audio normalization
        // This uses EBU R128 standard for loudness normalization
        const command = ffmpeg(filePath)
          .audioFilters([
            {
              filter: 'loudnorm',
              options: {
                I: targetVolume,           // Integrated loudness target
                TP: -1.5,                  // True peak limit
                LRA: 11                    // Loudness range target
              }
            }
          ])
          .audioCodec('aac')              // Use AAC codec for audio
          .audioBitrate('192k')           // Set audio bitrate
          .output(tempOutputFile);

        command.on('start', (cmdline: string) => {
          this.logger.log(`Audio normalization started: ${cmdline}`);
          // Emit internal event for analysis service to track
          if (jobId) {
            this.eventEmitter.emit('processing-progress', {
              jobId,
              progress: 0,
              task: 'Starting audio normalization'
            });
          }
        });

        command.on('progress', (progress: any) => {
          if (progress.percent) {
            const percent = Math.round(progress.percent);
            this.logger.log(`Normalizing: ${percent}%`);
            // Emit internal event for analysis service to track
            if (jobId) {
              this.eventEmitter.emit('processing-progress', {
                jobId,
                progress: percent,
                task: `Normalizing audio: ${percent}%`
              });
            }
          }
        });

        command.on('end', () => {
          this.logger.log(`Successfully normalized audio to temp file: ${tempOutputFile}`);
          // Emit internal event for analysis service to track
          if (jobId) {
            this.eventEmitter.emit('processing-progress', {
              jobId,
              progress: 95,
              task: 'Audio normalization complete, finalizing...'
            });
          }

          // Preserve original file timestamps before deletion
          const originalStats = fs.statSync(filePath);
          const originalAtime = originalStats.atime;
          const originalMtime = originalStats.mtime;

          // Delete the original file and rename temp file to original name
          if (this.safeDeleteFile(filePath)) {
            this.logger.log(`Deleted original file: ${filePath}`);

            try {
              fs.renameSync(tempOutputFile, filePath);
              this.logger.log(`Renamed ${tempOutputFile} to ${filePath}`);

              // Preserve original timestamps (critical for maintaining download_date)
              fs.utimesSync(filePath, originalAtime, originalMtime);
              this.logger.log(`Preserved original file timestamps (download_date maintained)`);

              resolve(filePath);
            } catch (err: any) {
              this.logger.error(`Failed to rename file: ${err.message}`);
              // If rename fails, return the temp file
              resolve(tempOutputFile);
            }
          } else {
            // If deletion failed, keep the temp file
            this.logger.warn(`Could not delete original file, keeping temp file: ${tempOutputFile}`);
            resolve(tempOutputFile);
          }
        });

        command.on('error', (err: any) => {
          this.logger.error(`Error normalizing audio: ${err.message}`);
          // Clean up temp file if it exists
          this.safeDeleteFile(tempOutputFile);
          resolve(null);
        });

        command.run();
      });
    } catch (error) {
      this.logger.error('Error in normalizeAudio:', error);
      return null;
    }
  }

  /**
   * List all media files in a directory
   * @param dirPath - Directory path to scan
   * @returns Array of file paths
   */
  async listMediaFiles(dirPath: string): Promise<string[]> {
    const mediaExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.aac', '.flac', '.m4a', '.webm'];

    if (!fs.existsSync(dirPath)) {
      this.logger.error(`Directory doesn't exist: ${dirPath}`);
      return [];
    }

    try {
      const files = fs.readdirSync(dirPath);
      const mediaFiles: string[] = [];

      for (const file of files) {
        // Skip macOS metadata files that start with ._
        if (file.startsWith('._')) {
          continue;
        }

        // Skip hidden files
        if (file.startsWith('.')) {
          continue;
        }

        const filePath = path.join(dirPath, file);

        try {
          const stat = fs.statSync(filePath);

          if (stat.isFile()) {
            const ext = path.extname(file).toLowerCase();
            if (mediaExtensions.includes(ext)) {
              mediaFiles.push(filePath);
            }
          }
        } catch (statError) {
          this.logger.warn(`Could not stat file: ${filePath}`, statError);
          // Continue to next file if we can't stat this one
          continue;
        }
      }

      this.logger.log(`Found ${mediaFiles.length} media files in ${dirPath}`);
      return mediaFiles;
    } catch (error) {
      this.logger.error(`Error listing media files: ${error}`);
      return [];
    }
  }
}