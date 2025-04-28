// clippy/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from 'node-ffmpeg-installer';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { VideoMetadata } from '../common/interfaces/download.interface';
import { EnvironmentUtil } from '../config/environment.util';


@WebSocketGateway({ cors: true })
@Injectable()
export class FfmpegService {
  @WebSocketServer()
  server: Server;
  private lastReportedProgress: Map<string, number> = new Map();

  private readonly logger = new Logger(FfmpegService.name);

  constructor() {
    try {
      // Directly use EnvironmentUtil to get binary paths
      const ffmpegPath = EnvironmentUtil.getBinaryPath('ffmpeg');
      const ffprobePath = EnvironmentUtil.getBinaryPath('ffprobe');
      
      // Set paths for fluent-ffmpeg
      ffmpeg.setFfmpegPath(ffmpegPath);
      ffmpeg.setFfprobePath(ffprobePath);
      
      this.logger.log(`FFmpeg path: ${ffmpegPath}`);
      this.logger.log(`FFprobe path: ${ffprobePath}`);
    } catch (error) {
      this.logger.error('Failed to set FFmpeg/FFprobe paths', error);
      throw error; // Rethrow to prevent service initialization
    }
  }
    
  // Helper method for safe WebSocket emission
  private safeEmit(event: string, data: any): void {
    if (this.server) {
      this.server.emit(event, data);
    } else {
      this.logger.warn(`Cannot emit '${event}' - WebSocket server not initialized`);
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

async fixAspectRatio(videoFile: string, jobId?: string): Promise<string | null> {
    if (!fs.existsSync(videoFile)) {
      this.logger.error(`Video file doesn't exist: ${videoFile}`);
      return null;
    }
  
    try {
      // Add this at the class level if not already there
      // private lastReportedProgress: Map<string, number> = new Map();
  
      return new Promise<string | null>((resolve, reject) => {
        ffmpeg.ffprobe(videoFile, (err, metadata) => {
          if (err) {
            this.logger.error(`CRITICAL: Error probing video file: ${err.message}`);
            this.logger.error(`Full error details: ${JSON.stringify(err, null, 2)}`);
            resolve(null);
            return;
          }
  
          this.logger.debug(`FFmpeg Metadata: ${JSON.stringify(metadata, null, 2)}`);
  
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
          this.logger.log(`ASPECT RATIO ANALYSIS:
            Original Dimensions: ${width}x${height}
            Calculated Aspect Ratio: ${aspectRatio.toFixed(4)}
            Is Vertical Video: ${aspectRatio <= 1.0}
            Video Duration: ${totalDuration}s`);
                    
          // Is it a vertical video?
          const isVertical = aspectRatio <= 1.0;
          
          // Check if it's close to 16:9 (1.78)
          const is16_9 = aspectRatio >= 1.75 && aspectRatio <= 1.8;
          
          if (is16_9) {
            this.logger.log('Video already has 16:9 aspect ratio');
            resolve(null);
            return;
          }
  
          // Create output filename
          const fileDir = path.dirname(videoFile);
          const fileName = path.basename(videoFile);
          const fileBase = path.parse(fileName).name;
  
          // Force .mov extension for Final Cut Pro compatibility
          const outputFile = path.join(fileDir, `${fileBase}_16x9.mov`);
          
          // Set the progress key
          const progressKey = outputFile;
          
          // Reset the progress counter for this file
          this.lastReportedProgress.set(progressKey, 0);
  
          // Create FFmpeg command
          let command = ffmpeg(videoFile)
            .outputOptions([
              '-filter_complex', "[0:v]scale=1920:1920:force_original_aspect_ratio=increase,gblur=sigma=50,crop=1920:1080[bg];[0:v]scale='if(gte(a,16/9),1920,-1)':'if(gte(a,16/9),-1,1080)'[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p",
              '-pix_fmt', 'yuv420p',
              '-c:v', 'libx264',
              '-b:v', '3M',
              '-c:a', 'aac',
              '-b:a', '128k'
            ])
            .save(outputFile);
    
          // Start progress at 0%
          this.safeEmit('processing-progress', { 
            progress: 0,
            task: 'Preparing aspect ratio adjustment',
            jobId // Add jobId here
          });
  
          command.on('start', (cmdline) => {
            this.logger.log(`FFmpeg command started: ${cmdline}`);
            // Emit a 5% progress for starting
            this.safeEmit('processing-progress', { 
              progress: 0, 
              task: 'Starting aspect ratio adjustment',
              jobId // Add jobId here
            });
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
                
                // Emit progress to all clients WITH jobId
                this.safeEmit('processing-progress', { 
                  progress: progressPercent,
                  task: `Adjusting aspect ratio ${speedInfo}`,
                  jobId // Add jobId to the event data
                });
                
                // Log the progress for debugging
                this.logger.debug(`Progress: ${progressPercent}% (${currentTimeInSeconds}s / ${effectiveDuration}s)`);
              }
            }
          });
            
          command.on('progress', (progress) => {
            // Fallback progress mechanism (may not always work reliably)
            if (progress && typeof progress.percent === 'number') {
              const percent = Math.round(progress.percent * 100) / 100;
              
              // Scale to 5-95% range
              const scaledPercent = Math.max(5, Math.min(Math.round(5 + (percent * 0.9)), 95));
              
              // Only update if greater than last reported
              const lastProgress = this.lastReportedProgress.get(progressKey) || 0;
              if (scaledPercent > lastProgress) {
                this.lastReportedProgress.set(progressKey, scaledPercent);
                
                // Emit progress event
                this.safeEmit('processing-progress', { 
                  progress: scaledPercent,
                  task: `Adjusting aspect ratio (${percent}%)`,
                  jobId // Add jobId here
                });
                
                this.logger.debug(`Native progress: ${percent}%, Scaled: ${scaledPercent}%`);
              }
            }
          });
  
          command.on('end', () => {
            this.logger.log(`Successfully created 16:9 version with blurred background: ${outputFile}`);
            
            // Delete the original video safely
            if (this.safeDeleteFile(videoFile)) {
              this.logger.log(`Deleted original video: ${videoFile}`);
            } else {
              this.logger.debug(`Original file couldn't be deleted: ${videoFile}`);
            }
            
            // Emit 100% completion
            this.lastReportedProgress.set(progressKey, 100);
            this.safeEmit('processing-progress', { 
              progress: 100,
              task: 'Processing completed',
              jobId // Add jobId here
            });
            
            resolve(outputFile);
          });          
          
          command.on('error', (err) => {
            this.logger.error(`Error creating blurred background version: ${err.message}`);
            
            // Emit error event
            this.safeEmit('processing-failed', {
              error: err.message,
            });
            
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