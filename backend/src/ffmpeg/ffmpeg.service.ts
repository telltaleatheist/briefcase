// clippy/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from 'node-ffmpeg-installer';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { VideoMetadata } from '../common/interfaces/download.interface';

@WebSocketGateway({ cors: true })
@Injectable()
export class FfmpegService {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(FfmpegService.name);

  constructor() {
    // First try system paths which don't require permission changes
    const systemPaths = [
      '/usr/local/bin/ffmpeg',
      '/usr/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg'
    ];
    
    let ffmpegPath = '';
    for (const path of systemPaths) {
      if (fs.existsSync(path)) {
        ffmpegPath = path;
        this.logger.log(`Using FFmpeg from system path: ${ffmpegPath}`);
        break;
      }
    }
    
    // If not found in system, try installed path
    if (!ffmpegPath) {
      ffmpegPath = ffmpegInstaller.path;
      if (fs.existsSync(ffmpegPath)) {
        this.logger.log(`Using FFmpeg from installer: ${ffmpegPath}`);
      } else {
        // Try user's Documents/clippy/bin directory
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const userBinPath = path.join(homeDir, 'Documents', 'clippy', 'bin', 'ffmpeg');
        
        if (fs.existsSync(userBinPath)) {
          ffmpegPath = userBinPath;
          this.logger.log(`Using FFmpeg from user bin directory: ${ffmpegPath}`);
        } else {
          // Try project root bin directory
          const projectBinPath = path.join(__dirname, '../../../bin/ffmpeg');
          
          if (fs.existsSync(projectBinPath)) {
            ffmpegPath = projectBinPath;
            this.logger.log(`Using FFmpeg from project bin directory: ${ffmpegPath}`);
          }
        }
      }
    }
    
    // Set FFmpeg path if found
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      ffmpeg.setFfmpegPath(ffmpegPath);
      this.logger.log(`FFmpeg path set to: ${ffmpegPath}`);
    } else {
      this.logger.error('Could not find FFmpeg binary in any location');
    }
    
    // Same approach for FFprobe - check system paths first
    const systemProbePaths = [
      '/usr/local/bin/ffprobe',
      '/usr/bin/ffprobe',
      '/opt/homebrew/bin/ffprobe'
    ];
    
    let ffprobePath = '';
    for (const path of systemProbePaths) {
      if (fs.existsSync(path)) {
        ffprobePath = path;
        this.logger.log(`Using FFprobe from system path: ${ffprobePath}`);
        break;
      }
    }
    
    // If not found in system, try other locations
    if (!ffprobePath) {
      // Try user's Documents/clippy/bin directory
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const userProbePath = path.join(homeDir, 'Documents', 'clippy', 'bin', 'ffprobe');
      
      if (fs.existsSync(userProbePath)) {
        ffprobePath = userProbePath;
        this.logger.log(`Using FFprobe from user bin directory: ${ffprobePath}`);
      } else {
        // Try project root bin directory
        const projectProbePath = path.join(__dirname, '../../../bin/ffprobe');
        
        if (fs.existsSync(projectProbePath)) {
          ffprobePath = projectProbePath;
          this.logger.log(`Using FFprobe from project bin directory: ${ffprobePath}`);
        }
      }
    }
    
    // Set FFprobe path if found
    if (ffprobePath && fs.existsSync(ffprobePath)) {
      ffmpeg.setFfprobePath(ffprobePath);
      this.logger.log(`FFprobe path set to: ${ffprobePath}`);
    } else {
      this.logger.error('Could not find FFprobe binary in any location');
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

  async fixAspectRatio(videoFile: string): Promise<string | null> {
    if (!fs.existsSync(videoFile)) {
      this.logger.error(`Video file doesn't exist: ${videoFile}`);
      return null;
    }

    try {
      return new Promise<string | null>((resolve, reject) => {
        // Get video dimensions
        ffmpeg.ffprobe(videoFile, (err, metadata) => {
          if (err) {
            this.logger.error(`Error probing video file: ${err.message}`);
            resolve(null);
            return;
          }

          const stream = metadata.streams.find(s => s.codec_type === 'video');
          if (!stream) {
            this.logger.error('No video stream found');
            resolve(null);
            return;
          }

          let width = stream.width;
          let height = stream.height;
          
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
          this.logger.log(`Video dimensions: ${width}x${height}, Aspect ratio: ${aspectRatio.toFixed(4)}`);
          
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
  
          // Add more event handlers for better debugging
          command.on('start', (cmdline) => {
            this.logger.log(`FFmpeg command started: ${cmdline}`);
          });
          
          command.on('stderr', (stderrLine) => {
            this.logger.debug(`FFmpeg stderr: ${stderrLine}`);
          });

          command.on('progress', (progress) => {
            const percent = Math.round((progress.percent || 0) * 100) / 100;
            // Use safe emit to handle case where server isn't initialized
            this.safeEmit('processing-progress', { 
              progress: percent,
              task: 'Adjusting aspect ratio'
            });
          });

          command.on('end', () => {
            this.logger.log(`Successfully created 16:9 version with blurred background: ${outputFile}`);
            
            // Delete the original video safely
            if (this.safeDeleteFile(videoFile)) {
              this.logger.log(`Deleted original video: ${videoFile}`);
            } else {
              this.logger.debug(`Original file couldn't be deleted (may not exist): ${videoFile}`);
            }
            
            resolve(outputFile);
          });          
          
          command.on('error', (err) => {
            this.logger.error(`Error creating blurred background version: ${err.message}`);
            resolve(null);
          });
          
          // Make sure the command is explicitly run
          command.run();
        });
      });
    } catch (error) {
      this.logger.error('Error checking aspect ratio:', error);
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