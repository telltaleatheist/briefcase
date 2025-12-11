/**
 * FFprobe Bridge - Process wrapper for FFprobe binary
 * Probes media files for metadata and stream information
 */

import { spawn } from 'child_process';
import { Logger } from '@nestjs/common';

export interface StreamInfo {
  index: number;
  codec_name?: string;
  codec_long_name?: string;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data';
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  bit_rate?: string;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  rotation?: number | string;
  tags?: Record<string, string>;
  [key: string]: any;
}

export interface FormatInfo {
  filename: string;
  nb_streams: number;
  format_name: string;
  format_long_name: string;
  start_time?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  [key: string]: any;
}

export interface ProbeResult {
  streams: StreamInfo[];
  format: FormatInfo;
}

export interface MediaInfo {
  duration: number;         // Duration in seconds
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  format: string;
  filename: string;
  rotation?: number;
}

export class FfprobeBridge {
  private binaryPath: string;
  private readonly logger = new Logger(FfprobeBridge.name);

  constructor(ffprobePath: string) {
    this.binaryPath = ffprobePath;
    this.logger.log(`Initialized with binary: ${ffprobePath}`);
  }

  /**
   * Get the binary path
   */
  get path(): string {
    return this.binaryPath;
  }

  /**
   * Probe a media file and return raw JSON result
   */
  probe(filePath: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ];

      this.logger.log(`Probing: ${filePath}`);

      const proc = spawn(this.binaryPath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`Failed with code ${code}: ${stderr}`);
          reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          this.logger.log(`Probe complete: ${result.streams?.length || 0} streams`);
          resolve(result);
        } catch (e) {
          this.logger.error(`Failed to parse output: ${e}`);
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      proc.on('error', (err) => {
        this.logger.error(`Spawn error: ${err.message}`);

        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`FFprobe binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`FFprobe binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Get simplified media info
   */
  async getMediaInfo(filePath: string): Promise<MediaInfo> {
    const result = await this.probe(filePath);

    const videoStream = result.streams.find(s => s.codec_type === 'video');
    const audioStream = result.streams.find(s => s.codec_type === 'audio');

    // Parse duration from format or stream
    let duration = 0;
    if (result.format.duration) {
      duration = parseFloat(result.format.duration);
    } else if (videoStream?.duration) {
      duration = parseFloat(videoStream.duration);
    } else if (audioStream?.duration) {
      duration = parseFloat(audioStream.duration);
    }

    // Parse frame rate
    let fps: number | undefined;
    if (videoStream?.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      if (den && den > 0) {
        fps = Math.round((num / den) * 100) / 100;
      }
    }

    // Parse rotation
    let rotation: number | undefined;
    if (videoStream?.rotation) {
      rotation = typeof videoStream.rotation === 'string'
        ? parseInt(videoStream.rotation)
        : videoStream.rotation;
    } else if (videoStream?.tags?.rotate) {
      rotation = parseInt(videoStream.tags.rotate);
    }

    return {
      duration,
      hasVideo: !!videoStream,
      hasAudio: !!audioStream,
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      width: videoStream?.width,
      height: videoStream?.height,
      fps,
      sampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate) : undefined,
      channels: audioStream?.channels,
      bitrate: result.format.bit_rate ? parseInt(result.format.bit_rate) : undefined,
      format: result.format.format_name,
      filename: result.format.filename,
      rotation,
    };
  }

  /**
   * Get just the duration in seconds
   */
  async getDuration(filePath: string): Promise<number> {
    const info = await this.getMediaInfo(filePath);
    return info.duration;
  }

  /**
   * Check if file has audio
   */
  async hasAudio(filePath: string): Promise<boolean> {
    const result = await this.probe(filePath);
    return result.streams.some(s => s.codec_type === 'audio');
  }

  /**
   * Check if file has video
   */
  async hasVideo(filePath: string): Promise<boolean> {
    const result = await this.probe(filePath);
    return result.streams.some(s => s.codec_type === 'video');
  }
}
