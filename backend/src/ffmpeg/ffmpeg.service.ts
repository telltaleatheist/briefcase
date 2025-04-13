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
    // First try to set path from node-ffmpeg-installer
    let ffmpegPath = ffmpegInstaller.path;
    
    // If that file doesn't exist, check alternate locations
    if (!fs.existsSync(ffmpegPath)) {
      this.logger.warn(`FFmpeg not found at installer path: ${ffmpegPath}`);
      
      // Try user's Documents/clippy/bin directory
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const userBinPath = path.join(homeDir, 'Documents', 'clippy', 'bin', 'ffmpeg');
      
      if (fs.existsSync(userBinPath)) {
        ffmpegPath = userBinPath;
        this.logger.log(`Using FFmpeg from user bin directory: ${ffmpegPath}`);
      } else {
        // Try project root bin directory
        const projectBinPath = path.join(__dirname, '../../../bin');
        
        if (fs.existsSync(projectBinPath)) {
          ffmpegPath = projectBinPath;
          this.logger.log(`Using FFmpeg from project bin directory: ${ffmpegPath}`);
        } else {
          // Try backend/bin directory
          const backendBinPath = path.join(__dirname, '../../../bin/ffmpeg');
          
          if (fs.existsSync(backendBinPath)) {
            ffmpegPath = backendBinPath;
            this.logger.log(`Using FFmpeg from backend bin directory: ${ffmpegPath}`);
          } else {
            this.logger.error(`Could not find FFmpeg binary in any location`);
          }
        }
      }
    }
    
    // Set FFmpeg path
    ffmpeg.setFfmpegPath(ffmpegPath);
    this.logger.log(`FFmpeg path set to: ${ffmpegPath}`);
    
    let ffprobePath = '';
    
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
      } else {
        // Try backend/bin directory
        const backendProbePath = path.join(__dirname, '../../../bin/ffprobe');
        
        if (fs.existsSync(backendProbePath)) {
          ffprobePath = backendProbePath;
          this.logger.log(`Using FFprobe from backend bin directory: ${ffprobePath}`);
        } else {
          this.logger.error(`Could not find FFprobe binary in any location`);
        }
      }
    }
    
    // Set FFprobe path
    ffmpeg.setFfprobePath(ffprobePath);
    this.logger.log(`FFprobe path set to: ${ffprobePath}`);
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
          const isVertical = aspectRatio < 1.0;
          
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
          const fileExt = path.parse(fileName).ext;
          const outputFile = path.join(fileDir, `${fileBase}_16x9${fileExt}`);
          
          // Create FFmpeg command
          let command;
          if (isVertical) {
            // For vertical videos, create horizontal 16:9 with blurred pillarboxing
            command = ffmpeg(videoFile)
              .outputOptions([
                '-filter_complex', '[0:v]scale=1920:1080:force_original_aspect_ratio=increase,gblur=sigma=30,crop=1920:1080[bg];[0:v]scale=iw*min(1920/iw\\,1080/ih):ih*min(1920/iw\\,1080/ih)[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p',
                '-pix_fmt', 'yuv420p',
                '-c:v', 'libx264',
                '-b:v', '3M',
                '-c:a', 'aac',
                '-b:a', '128k'
              ])
              .save(outputFile);
          } else {
            // For horizontal videos not in 16:9, create with letterboxing
            command = ffmpeg(videoFile)
              .outputOptions([
                '-filter_complex', '[0:v]scale=1920:1080,gblur=sigma=60[bg]; [0:v]scale=1920:-1[fg]; [bg][fg]overlay=(W-w)/2:(H-h)/2',
                '-c:a', 'copy'
              ])
              .save(outputFile);
          }

          command.on('progress', (progress) => {
            const percent = Math.round((progress.percent || 0) * 100) / 100;
            this.server.emit('processing-progress', { 
              progress: percent,
              task: 'Adjusting aspect ratio'
            });
          });

          command.on('end', () => {
            this.logger.log(`Successfully created 16:9 version with blurred background: ${outputFile}`);
            
            // Delete the original video
            try {
              fs.unlinkSync(videoFile);
              this.logger.log(`Deleted original video: ${videoFile}`);
            } catch (e) {
              this.logger.error('Error deleting original video:', e);
            }
            
            resolve(outputFile);
          });

          command.on('error', (err) => {
            this.logger.error(`Error creating blurred background version: ${err.message}`);
            resolve(null);
          });
        });
      });
    } catch (error) {
      this.logger.error('Error checking aspect ratio:', error);
      return null;
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
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ['10%'], // Take screenshot at 10% of the video duration
            filename: path.basename(outputPath || ''),
            folder: path.dirname(outputPath || ''),
            size: '640x360', // Thumbnail size
          })
          .on('end', () => {
            this.logger.log(`Thumbnail created at: ${outputPath}`);
            resolve(outputPath || null);
          })
          .on('error', (err) => {
            this.logger.error(`Error creating thumbnail: ${err.message}`);
            resolve(null);
          });
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