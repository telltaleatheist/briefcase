// ClipChimp/backend/src/ffmpeg/ffmpeg.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as path from 'path';
import * as fs from 'fs';
import { VideoMetadata } from '../common/interfaces/download.interface';
import { MediaEventService } from '../media/media-event.service';
import { SharedConfigService } from '../config/shared-config.service';
import { ThumbnailService } from '../database/thumbnail.service';
import {
  FfmpegBridge,
  FfprobeBridge,
  getRuntimePaths,
  verifyBinary,
  type FfmpegProgress,
  type ProbeResult,
} from '../bridges';

@Injectable()
export class FfmpegService {
  private lastReportedProgress: Map<string, number> = new Map();
  private readonly logger = new Logger(FfmpegService.name);
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;

  constructor(
    private readonly eventService: MediaEventService,
    private readonly configService: SharedConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly thumbnailService: ThumbnailService
  ) {
    try {
      // Try environment variables first (set by Electron), then runtime paths
      let ffmpegPath = process.env.FFMPEG_PATH;
      let ffprobePath = process.env.FFPROBE_PATH;

      // Fall back to runtime paths resolution
      if (!ffmpegPath || !ffprobePath || !fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        const paths = getRuntimePaths();
        ffmpegPath = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : paths.ffmpeg;
        ffprobePath = ffprobePath && fs.existsSync(ffprobePath) ? ffprobePath : paths.ffprobe;
      }

      // Try config service as last resort
      if (!fs.existsSync(ffmpegPath)) {
        try {
          ffmpegPath = this.configService.getFfmpegPath();
        } catch {
          // Ignore config errors
        }
      }
      if (!fs.existsSync(ffprobePath)) {
        try {
          ffprobePath = this.configService.getFfprobePath();
        } catch {
          // Ignore config errors
        }
      }

      // Verify binaries exist
      verifyBinary(ffmpegPath, 'FFmpeg');
      verifyBinary(ffprobePath, 'FFprobe');

      // Initialize bridges
      this.ffmpeg = new FfmpegBridge(ffmpegPath);
      this.ffprobe = new FfprobeBridge(ffprobePath);

      this.logger.log(`FFmpeg path: ${ffmpegPath}`);
      this.logger.log(`FFprobe path: ${ffprobePath}`);
    } catch (error) {
      this.logger.error('Failed to initialize FFmpeg/FFprobe bridges', error);
      throw error;
    }
  }

  async getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
    try {
      const metadata = await this.ffprobe.probe(videoPath);

      const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video');
      const audioStream = metadata.streams?.find((stream) => stream.codec_type === 'audio');

      if (!videoStream && !audioStream) {
        throw new Error('No video or audio stream found');
      }

      const primaryStream = videoStream || audioStream!;

      let fileDuration = 0;
      if (primaryStream.duration) {
        fileDuration = parseFloat(primaryStream.duration);
      }
      if (!fileDuration && metadata.format?.duration) {
        fileDuration = typeof metadata.format.duration === 'string'
          ? parseFloat(metadata.format.duration)
          : metadata.format.duration;
      }

      let fps: number | undefined;
      if (videoStream?.r_frame_rate) {
        const [numerator, denominator] = videoStream.r_frame_rate.split('/').map(Number);
        if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
          fps = numerator / denominator;
        }
      }

      let aspectRatio: string | undefined;
      if (videoStream?.width && videoStream?.height) {
        const gcd = this.calculateGCD(videoStream.width, videoStream.height);
        aspectRatio = `${videoStream.width / gcd}:${videoStream.height / gcd}`;
      }

      return {
        width: videoStream?.width,
        height: videoStream?.height,
        duration: fileDuration,
        codecName: primaryStream.codec_name,
        bitrate: primaryStream.bit_rate ? parseInt(primaryStream.bit_rate) : undefined,
        fps,
        aspectRatio,
      };
    } catch (err: any) {
      this.logger.error(`Error probing video: ${err.message}`);
      throw err;
    }
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
    taskType?: string
  ): Promise<string | null> {
    this.logger.log('Received reencoding options:', JSON.stringify({
      fixAspectRatio: options?.fixAspectRatio,
      normalizeAudio: options?.normalizeAudio,
      audioNormalizationMethod: options?.audioNormalizationMethod
    }, null, 2));

    try {
      const selectedEncoder = 'libx264';
      const metadata = await this.ffprobe.probe(videoFile);
      const videoAnalysis = this.analyzeVideoMetadata(metadata);

      if (!videoAnalysis.isValid) {
        return null;
      }

      const duration = videoAnalysis.duration || 0;
      const needsAspectRatioFix = videoAnalysis.needsAspectRatioFix ?? false;

      const fileDir = path.dirname(videoFile);
      const fileName = path.basename(videoFile);
      const fileBase = path.parse(fileName).name;
      const outputFile = path.join(fileDir, `${fileBase}_reencoded.mov`);
      const progressKey = outputFile;
      const processId = `reencode-${Date.now()}`;

      this.lastReportedProgress.set(progressKey, 0);

      const args = this.buildFfmpegArgs(videoFile, outputFile, needsAspectRatioFix, selectedEncoder, options);

      if (taskType && jobId) {
        this.eventService.emitTaskProgress(jobId, taskType, 0, 'Preparing video re-encoding');
      }

      this.logger.log(`FFmpeg re-encoding command: ${this.ffmpeg.path} ${args.join(' ')}`);

      // Set up progress listener
      const progressHandler = (progress: FfmpegProgress) => {
        if (progress.processId !== processId) return;

        const lastProgress = this.lastReportedProgress.get(progressKey) || 0;
        const boundedPercent = Math.max(5, Math.min(progress.percent, 95));

        if (boundedPercent > lastProgress) {
          this.lastReportedProgress.set(progressKey, boundedPercent);
          const message = `Re-encoding video ${progress.speed ? `(Speed: ${progress.speed}x)` : ''}`;
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, boundedPercent, message);
          }
        }
      };

      this.ffmpeg.on('progress', progressHandler);

      try {
        const result = await this.ffmpeg.run(args, { duration, processId });

        if (!result.success) {
          this.logger.error(`Re-encoding failed: ${result.error}`);
          return null;
        }
      } finally {
        this.ffmpeg.off('progress', progressHandler);
      }

      this.logger.log(`Successfully re-encoded video: ${outputFile}`);

      // Preserve original file timestamps before deletion
      const originalStats = fs.statSync(videoFile);
      const originalAtime = originalStats.atime;
      const originalMtime = originalStats.mtime;

      // Delete original and rename
      if (this.safeDeleteFile(videoFile)) {
        this.logger.log(`Deleted original video: ${videoFile}`);
        try {
          fs.renameSync(outputFile, videoFile);
          fs.utimesSync(videoFile, originalAtime, originalMtime);
          this.logger.log(`Renamed and preserved timestamps`);

          this.lastReportedProgress.set(progressKey, 100);
          if (taskType && jobId) {
            this.eventService.emitTaskProgress(jobId, taskType, 100, 'Video re-encoding completed');
          }
          return videoFile;
        } catch (err: any) {
          this.logger.error(`Failed to rename file: ${err.message}`);
          return outputFile;
        }
      }

      return outputFile;
    } catch (error: any) {
      this.logger.error('CRITICAL: Unexpected error in re-encoding:', error);
      return null;
    }
  }

  private analyzeVideoMetadata(metadata: ProbeResult): {
    isValid: boolean,
    dimensions?: { width: number, height: number },
    duration?: number,
    isVertical?: boolean,
    needsAspectRatioFix?: boolean
  } {
    const stream = metadata.streams?.find((s) => s.codec_type === 'video');
    if (!stream) {
      this.logger.error('CRITICAL: No video stream found');
      return { isValid: false };
    }

    let width = stream.width;
    let height = stream.height;
    let totalDuration = parseFloat(stream.duration || metadata.format?.duration || '0');

    if (!width || !height) {
      this.logger.error('Could not determine video dimensions');
      return { isValid: false };
    }

    const tags = stream.tags || {};
    const rotation = stream.rotation || tags.rotate || 0;

    if (rotation === '90' || rotation === '270' || rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }

    const aspectRatio = width / height;
    const targetAspectRatio = 16 / 9;
    const aspectRatioTolerance = 0.01;
    const needsAspectRatioFix = Math.abs(aspectRatio - targetAspectRatio) > aspectRatioTolerance;
    const isVertical = aspectRatio <= 1.0;

    this.logger.log(`REENCODING ANALYSIS: ${width}x${height}, AR: ${aspectRatio.toFixed(4)}, Vertical: ${isVertical}, NeedsFix: ${needsAspectRatioFix}`);

    return {
      isValid: true,
      dimensions: { width, height },
      duration: totalDuration,
      isVertical,
      needsAspectRatioFix
    };
  }

  private buildFfmpegArgs(
    videoFile: string,
    outputFile: string,
    needsAspectRatioFix: boolean,
    encoder: string,
    options?: {
      fixAspectRatio?: boolean,
      useRmsNormalization?: boolean,
      rmsNormalizationLevel?: number,
      useCompression?: boolean,
      compressionLevel?: number
    }
  ): string[] {
    let filterComplex = '';

    if (options?.fixAspectRatio && needsAspectRatioFix) {
      filterComplex = "[0:v]scale=1920:1920:force_original_aspect_ratio=increase,gblur=sigma=50,crop=1920:1080[bg];" +
                       "[0:v]scale='if(gte(a,16/9),1920,-1)':'if(gte(a,16/9),-1,1080)'[fg];" +
                       "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]";
    } else {
      filterComplex = "[0:v]format=yuv420p[v]";
    }

    const mapOptions = ['-map', '[v]'];

    if (options?.useRmsNormalization || options?.useCompression) {
      let audioFilter = '';

      if (options?.useRmsNormalization) {
        const level = options.rmsNormalizationLevel ?? 0;
        audioFilter = `[0:a]volume=${level}dB`;
        audioFilter += options?.useCompression ? '[a1];[a1]' : '[aout]';
      } else {
        audioFilter = '[0:a]';
      }

      if (options?.useCompression) {
        const level = options.compressionLevel ?? 5;
        audioFilter += `compand=attacks=0.3:decays=0.3:points=-90/-900|-45/-900|-30/-15|0/-6|15/0:gain=${level}[aout]`;
      }

      filterComplex += `;${audioFilter}`;
      mapOptions.push('-map', '[aout]?');
    } else {
      mapOptions.push('-map', '0:a?');
    }

    return [
      '-y',
      '-i', videoFile,
      '-filter_complex', filterComplex,
      ...mapOptions,
      '-pix_fmt', 'yuv420p',
      '-c:v', encoder,
      '-b:v', '3M',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputFile
    ];
  }

  private safeDeleteFile(filePath: string): boolean {
    if (!filePath) return false;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error(`Error deleting file ${filePath}:`, error);
      return false;
    }
  }

  async createThumbnail(videoPath: string, outputPath?: string, videoId?: string): Promise<string | null> {
    if (!fs.existsSync(videoPath)) {
      this.logger.error(`Video file doesn't exist: ${videoPath}`);
      return null;
    }

    try {
      if (!outputPath) {
        if (videoId) {
          try {
            outputPath = this.thumbnailService.getThumbnailPath(videoId);
          } catch (thumbnailError) {
            this.logger.warn(`ThumbnailService not ready, using fallback path`);
            const fileDir = path.dirname(videoPath);
            const fileBase = path.parse(videoPath).name;
            outputPath = path.join(fileDir, `${fileBase}_thumbnail.jpg`);
          }
        } else {
          const fileDir = path.dirname(videoPath);
          const fileBase = path.parse(videoPath).name;
          outputPath = path.join(fileDir, `${fileBase}_thumbnail.jpg`);
        }
      }

      if (!outputPath) {
        this.logger.error('Failed to determine thumbnail output path');
        return null;
      }

      const outputFolder = path.dirname(outputPath);
      if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
      }

      const metadata = await this.getVideoMetadata(videoPath);
      const duration = metadata?.duration || 0;
      const thumbnailTime = Math.max(1, duration * 0.1);

      const args = [
        '-y',
        '-ss', thumbnailTime.toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=-1:360',
        outputPath
      ];

      this.logger.log(`Creating thumbnail: ${this.ffmpeg.path} ${args.join(' ')}`);

      const result = await this.ffmpeg.run(args);

      if (!result.success) {
        this.logger.error(`Thumbnail creation failed: ${result.error}`);
        return null;
      }

      this.logger.log(`Thumbnail created at: ${outputPath}`);
      return outputPath;
    } catch (error: any) {
      this.logger.error('Error creating thumbnail:', error);
      return null;
    }
  }

  private calculateGCD(a: number, b: number): number {
    return b === 0 ? a : this.calculateGCD(b, a % b);
  }

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
      const tempOutputFile = path.join(fileDir, `${fileBase}_temp_normalized${fileExt}`);
      const processId = `normalize-${Date.now()}`;

      // Get duration for progress
      const metadata = await this.getVideoMetadata(filePath);
      const duration = metadata?.duration || 0;

      const args = [
        '-y',
        '-i', filePath,
        '-af', `loudnorm=I=${targetVolume}:TP=-1.5:LRA=11`,
        '-c:v', 'copy',  // Copy video stream without re-encoding
        '-c:a', 'aac',
        '-b:a', '192k',
        tempOutputFile
      ];

      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 0, 'Starting audio normalization');
      }

      this.logger.log(`Audio normalization: ${this.ffmpeg.path} ${args.join(' ')}`);

      // Set up progress listener
      const progressHandler = (progress: FfmpegProgress) => {
        if (progress.processId !== processId) return;
        if (jobId) {
          this.eventService.emitTaskProgress(jobId, 'normalize-audio', progress.percent, `Normalizing audio: ${progress.percent}%`);
        }
      };

      this.ffmpeg.on('progress', progressHandler);

      try {
        const result = await this.ffmpeg.run(args, { duration, processId });

        if (!result.success) {
          this.logger.error(`Audio normalization failed: ${result.error}`);
          return null;
        }
      } finally {
        this.ffmpeg.off('progress', progressHandler);
      }

      this.logger.log(`Successfully normalized audio to temp file: ${tempOutputFile}`);

      if (jobId) {
        this.eventService.emitTaskProgress(jobId, 'normalize-audio', 95, 'Audio normalization complete, finalizing...');
      }

      // Preserve timestamps and replace original
      const originalStats = fs.statSync(filePath);
      const originalAtime = originalStats.atime;
      const originalMtime = originalStats.mtime;

      if (this.safeDeleteFile(filePath)) {
        try {
          fs.renameSync(tempOutputFile, filePath);
          fs.utimesSync(filePath, originalAtime, originalMtime);
          return filePath;
        } catch (err: any) {
          this.logger.error(`Failed to rename file: ${err.message}`);
          return tempOutputFile;
        }
      }

      return tempOutputFile;
    } catch (error: any) {
      this.logger.error('Error in normalizeAudio:', error);
      return null;
    }
  }

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
        if (file.startsWith('._') || file.startsWith('.')) continue;

        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            const ext = path.extname(file).toLowerCase();
            if (mediaExtensions.includes(ext)) {
              mediaFiles.push(filePath);
            }
          }
        } catch {
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

  async generateWaveform(filePath: string, samplesCount: number = 500): Promise<{ samples: number[], duration: number }> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    this.logger.log(`Generating waveform for: ${filePath} (${samplesCount} samples)`);

    const metadata = await this.getVideoMetadata(filePath);
    const duration = metadata.duration || 0;

    if (duration <= 0) {
      return { samples: [], duration: 0 };
    }

    const chunks: Buffer[] = [];

    const args = [
      '-i', filePath,
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      '-'
    ];

    try {
      const result = await this.ffmpeg.runWithPipe(args, (chunk) => {
        chunks.push(chunk);
      });

      if (!result.success) {
        throw new Error(result.error || 'Waveform extraction failed');
      }

      const audioBuffer = Buffer.concat(chunks);
      const int16Array = new Int16Array(
        audioBuffer.buffer,
        audioBuffer.byteOffset,
        Math.floor(audioBuffer.length / 2)
      );

      const samples: number[] = [];
      const samplesPerChunk = Math.max(1, Math.floor(int16Array.length / samplesCount));

      for (let i = 0; i < samplesCount; i++) {
        const start = i * samplesPerChunk;
        const end = Math.min(start + samplesPerChunk, int16Array.length);

        if (start >= int16Array.length) {
          samples.push(0);
          continue;
        }

        let sumSquares = 0;
        for (let j = start; j < end; j++) {
          sumSquares += int16Array[j] * int16Array[j];
        }
        const rms = Math.sqrt(sumSquares / (end - start));
        const normalized = Math.min(1, (rms / 32767) * 4);
        samples.push(normalized);
      }

      this.logger.log(`Generated ${samples.length} waveform samples for ${duration}s video`);
      return { samples, duration };
    } catch (error) {
      this.logger.error(`Waveform extraction error: ${error}`);
      return {
        samples: new Array(samplesCount).fill(0.3),
        duration
      };
    }
  }
}
