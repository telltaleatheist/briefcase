// clippy/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import * as fs from 'fs';
import { VideoMetadata } from '../common/interfaces/download.interface';
import { MediaEventService } from '../media/media-event.service';
import * as ffmpegPath from '@ffmpeg-installer/ffmpeg';
import * as ffprobePath from '@ffprobe-installer/ffprobe';
import { SharedConfigService } from '@/config/shared-config.service';

@Injectable()
export class FfmpegService {
  private lastReportedProgress: Map<string, number> = new Map();
  private readonly logger = new Logger(FfmpegService.name);

  constructor(
    private readonly eventService: MediaEventService,
    private readonly configService: SharedConfigService
  ) {
    try {
      // Prioritize config service paths, then environment variables, then installer paths
      const configFfmpegPath = this.configService.getFfmpegPath();
      const configFfprobePath = this.configService.getFfprobePath();

      const ffmpegExecutablePath = 
        configFfmpegPath || 
        process.env.FFMPEG_PATH || 
        ffmpegPath.path;

      const ffprobeExecutablePath = 
        configFfprobePath || 
        process.env.FFPROBE_PATH || 
        ffprobePath.path;
      
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

        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (!videoStream) {
          return reject(new Error('No video stream found'));
        }

        const { width, height, r_frame_rate, duration, codec_name, bit_rate } = videoStream;
        
        // Calculate FPS from rational frame rate (e.g., "30000/1001")
        let fps: number | undefined;
        if (r_frame_rate) {
          const [numerator, denominator] = r_frame_rate.split('/').map(Number);
          if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
            fps = numerator / denominator;
          }
        }

        // Calculate aspect ratio
        let aspectRatio: string | undefined;
        if (width && height) {
          const gcd = this.calculateGCD(width, height);
          aspectRatio = `${width / gcd}:${height / gcd}`;
        }

        resolve({
          width,
          height,
          duration: parseFloat(duration || '0'),
          codecName: codec_name,
          bitrate: bit_rate ? parseInt(bit_rate) : undefined,
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
      audioNormalizationMethod?: 'ebur128' | 'rms' | 'peak'
    }
  ): Promise<string | null> {
        if (!fs.existsSync(videoFile)) {
      this.logger.error(`Video file doesn't exist: ${videoFile}`);
      return null;
    }
    
    try {
      // Use a single default encoder without detection
      const selectedEncoder = 'libx264';  
  
      return new Promise<string | null>((resolve, reject) => {
        ffmpeg.ffprobe(videoFile, (err, metadata) => {
          if (err) {
            this.logger.error(`CRITICAL: Error probing video file: ${err.message}`);
            resolve(null);
            return;
          }
    
          const stream = metadata.streams.find(s => s.codec_type === 'video');
          if (!stream) {
            this.logger.error('CRITICAL: No video stream found');
            resolve(null);
            return;
          }
    
          let width = stream.width;
          let height = stream.height;
          let totalDuration = parseFloat(stream.duration || '0');
          
          if (!width || !height) {
            this.logger.error('Could not determine video dimensions');
            resolve(null);
            return;
          }
          
          // Check for rotation metadata
          const tags = stream.tags || {};
          const rotation = stream.rotation || tags.rotate || 0;
          
          if (rotation === '90' || rotation === '270' || rotation === 90 || rotation === 270) {
            [width, height] = [height, width];
          }
    
          const aspectRatio = width / height;
          this.logger.log(`REENCODING ANALYSIS:
            Original Dimensions: ${width}x${height}
            Calculated Aspect Ratio: ${aspectRatio.toFixed(4)}
            Is Vertical Video: ${aspectRatio <= 1.0}
            Video Duration: ${totalDuration}s`);
                      
          // Is it a vertical video?
          const isVertical = aspectRatio <= 1.0;
          
          // Create output filename
          const fileDir = path.dirname(videoFile);
          const fileName = path.basename(videoFile);
          const fileBase = path.parse(fileName).name;
    
          // Force .mov extension for Final Cut Pro compatibility
          const outputFile = path.join(fileDir, `${fileBase}_reencoded.mov`);
          
          // Set the progress key
          const progressKey = outputFile;
          
          // Reset the progress counter for this file
          this.lastReportedProgress.set(progressKey, 0);
    
          // Prepare filter complex for aspect ratio correction and encoding
          const filterOptions = [];
          const baseFilter = "[0:v]format=yuv420p"; // Basic format conversion
          if (isVertical) {
            filterOptions.push(
              '-filter_complex', 
              "[0:v]scale=1920:1920:force_original_aspect_ratio=increase,gblur=sigma=50,crop=1920:1080[bg];[0:v]scale='if(gte(a,16/9),1920,-1)':'if(gte(a,16/9),-1,1080)'[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p"
            );
          } else {
            // For non-vertical videos, apply a simpler filter that still ensures proper format
            filterOptions.push('-filter_complex', baseFilter);
          }
          
          // Simplified encoder options
          const encoderOptions = ['-c:v', selectedEncoder, '-b:v', '3M'];
          
          const audioNormalizationOptions = options?.normalizeAudio 
          ? this.getAudioNormalizationFilter(options.audioNormalizationMethod || 'ebur128') 
          : [];
                
          // Create FFmpeg command
          let command = ffmpeg(videoFile)
            .outputOptions([
              ...filterOptions,
              ...audioNormalizationOptions,
              '-pix_fmt', 'yuv420p',
              ...encoderOptions,
              '-c:a', 'aac',
              '-b:a', '128k',
              '-movflags', '+faststart'
            ])
            .output(outputFile);
                      
          // Start progress at 0%
          this.eventService.emitProcessingProgress(0, 'Preparing video re-encoding', jobId);
              
          command.on('start', (cmdline) => {
            this.logger.log(`FFmpeg re-encoding command started: ${cmdline}`);
            this.eventService.emitProcessingProgress(0, 'Starting video re-encoding', jobId);
          });
          
          command.on('stderr', (stderrLine) => {
            // Parse ffmpeg output to get current time and calculate progress
            const timeMatch = stderrLine.match(/time=(\d+:\d+:\d+\.\d+)/);
            const speedMatch = stderrLine.match(/speed=(\d+\.\d+)x/);
            
            if (timeMatch) {
              const timeStr = timeMatch[1];
              const timeParts = timeStr.split(/[:\.]/);
              
              if (timeParts.length >= 3) {
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
                  return;
                }
                this.lastReportedProgress.set(progressKey, progressPercent);
                
                let speedInfo = '';
                if (speedMatch) {
                  speedInfo = `(Speed: ${speedMatch[1]}x)`;
                }
                
                // Emit progress with jobId
                this.eventService.emitProcessingProgress(
                  progressPercent,
                  `Re-encoding video ${speedInfo}`,
                  jobId
                );
              }
            }
          });
    
          command.on('end', () => {
            this.logger.log(`Successfully re-encoded video: ${outputFile}`);
            
            // Delete the original video safely
            if (this.safeDeleteFile(videoFile)) {
              this.logger.log(`Deleted original video: ${videoFile}`);
            }
            
            // Emit 100% completion
            this.lastReportedProgress.set(progressKey, 100);
            this.eventService.emitProcessingProgress(100, 'Video re-encoding completed', jobId);
            
            resolve(outputFile);
          });          
          
          command.on('error', (err) => {
            this.logger.error(`Error re-encoding video: ${err.message}`);
            
            // Emit error event
            this.eventService.emitProcessingFailed(videoFile, err.message, jobId);
            
            resolve(null);
          });
          
          // Make sure the command is explicitly run
          command.run();
        });
      });
    } catch (error) {
      this.logger.error('CRITICAL: Unexpected error in aspect ratio processing:', error);
      return null;
    }
  }

  private getAudioNormalizationFilter(method: 'ebur128' | 'rms' | 'peak'): string[] {
    switch (method) {
      case 'ebur128':
        return [
          '-filter_complex', 
          '[0:a]loudnorm=I=-16:LRA=11:tp=-1.5[normalized_audio]',
          '-map', '[normalized_audio]'
        ];
      case 'rms':
        return [
          '-filter_complex', 
          '[0:a]volumedetect,volume=replaygain=track[normalized_audio]',
          '-map', '[normalized_audio]'
        ];
      case 'peak':
        return [
          '-filter_complex', 
          '[0:a]volumedetect,volume=adjustment=+0dB[normalized_audio]',
          '-map', '[normalized_audio]'
        ];
      default:
        return [];
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

      return new Promise<string | null>((resolve, reject) => {
        const command = ffmpeg(videoPath)
          .screenshots({
            timestamps: ['10%'], // Take screenshot at 10% of the video duration
            filename: path.basename(outputPath || ''),
            folder: path.dirname(outputPath || ''),
            size: '640x360', // Thumbnail size
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
}