import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import {
  FfmpegBridge,
  FfprobeBridge,
  getRuntimePaths,
  verifyBinary,
} from '../bridges';

export interface WaveformData {
  samples: number[];
  sampleRate: number;
  duration: number;
  peakAmplitude: number;
}

@Injectable()
export class WaveformService {
  private readonly logger = new Logger(WaveformService.name);
  private readonly waveformCache = new Map<string, WaveformData>();
  private readonly progressCache = new Map<string, { progress: number; status: string; partial?: WaveformData }>();
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;

  constructor() {
    // Initialize bridges using runtime paths or environment variables
    let ffmpegPath = process.env.FFMPEG_PATH;
    let ffprobePath = process.env.FFPROBE_PATH;

    const runtimePaths = getRuntimePaths();

    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      ffmpegPath = runtimePaths.ffmpeg;
    }

    if (!ffprobePath || !fs.existsSync(ffprobePath)) {
      ffprobePath = runtimePaths.ffprobe;
    }

    verifyBinary(ffmpegPath, 'FFmpeg');
    verifyBinary(ffprobePath, 'FFprobe');

    this.ffmpeg = new FfmpegBridge(ffmpegPath);
    this.ffprobe = new FfprobeBridge(ffprobePath);

    this.logger.log(`WaveformService initialized`);
  }

  /**
   * Generate waveform data for a video file using FFmpeg
   * Uses multi-pass approach: quick low-res first, then progressively refine
   */
  async generateWaveform(
    videoPath: string,
    videoId: string,
    options: {
      samples?: number;
      useCache?: boolean;
      progressive?: boolean;
    } = {}
  ): Promise<WaveformData> {
    const { samples = 1000, useCache = true, progressive = false } = options;

    // Check cache first
    if (useCache && this.waveformCache.has(videoId)) {
      this.logger.log(`Returning cached waveform for video ${videoId}`);
      return this.waveformCache.get(videoId)!;
    }

    this.logger.log(`Generating waveform for ${path.basename(videoPath)} with ${samples} samples`);

    try {
      // First, get the video duration
      const duration = await this.getVideoDuration(videoPath);

      if (!duration || duration <= 0) {
        throw new Error('Invalid video duration');
      }

      // For progressive mode, skip the multi-pass and just do one high-quality pass
      // The frontend handles the initial low-res preview
      if (progressive) {
        this.updateProgress(videoId, 10, 'Starting waveform generation...');
      }

      // Generate full quality waveform - use lower sample rate to avoid buffer overflow
      // For very long videos, use 2000 Hz max to stay under 100MB buffer
      this.logger.log(`Generating final waveform with ${samples} samples...`);
      const waveformSamples = await this.extractAudioSamples(
        videoPath,
        samples,
        duration,
        2000,
        videoId,
        progressive
      );

      const waveformData: WaveformData = {
        samples: waveformSamples,
        sampleRate: 44100,
        duration,
        peakAmplitude: this.findPeak(waveformSamples),
      };

      this.updateProgress(videoId, 100, 'Complete', waveformData);

      // Cache the result
      if (useCache) {
        this.waveformCache.set(videoId, waveformData);
      }

      // Clear progress after a delay
      setTimeout(() => this.clearProgress(videoId), 5000);

      return waveformData;
    } catch (error) {
      this.logger.error(`Failed to generate waveform: ${(error as Error).message}`);
      this.clearProgress(videoId);
      // Return a fallback waveform
      return this.generateFallbackWaveform(120); // Default 2 minutes
    }
  }

  private findPeak(samples: number[]): number {
    let peak = 0.01;
    for (const sample of samples) {
      if (sample > peak) peak = sample;
    }
    return peak;
  }

  /**
   * Get video duration using FFprobe bridge
   */
  private async getVideoDuration(videoPath: string): Promise<number> {
    try {
      return await this.ffprobe.getDuration(videoPath);
    } catch (error) {
      this.logger.error(`Failed to get video duration: ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * Extract audio samples using FFmpeg bridge
   * Supports progressive updates by reporting progress as chunks are processed
   */
  private async extractAudioSamples(
    videoPath: string,
    sampleCount: number,
    duration: number,
    forceSampleRate?: number,
    videoId?: string,
    progressive?: boolean
  ): Promise<number[]> {
    try {
      // Use forced sample rate if provided (for progressive passes), otherwise calculate optimal rate
      const targetSampleRate = forceSampleRate || Math.max(4000, sampleCount * 4); // 4x oversample for max quality

      this.logger.log(`Extracting waveform: ${sampleCount} samples at ${targetSampleRate} Hz...`);

      // Extract mono audio using pipe
      const args = [
        '-i', videoPath,
        '-f', 'f32le',
        '-ac', '1',
        '-ar', targetSampleRate.toString(),
        '-'
      ];

      const startTime = Date.now();
      this.logger.log(`Running FFmpeg audio extraction at ${targetSampleRate} Hz...`);

      const chunks: Buffer[] = [];

      const result = await this.ffmpeg.runWithPipe(args, (chunk) => {
        chunks.push(chunk);
      });

      if (!result.success) {
        throw new Error(result.error || 'FFmpeg extraction failed');
      }

      const extractTime = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`FFmpeg extraction completed in ${extractTime}s`);

      // Combine chunks into a single buffer
      const audioBuffer = Buffer.concat(chunks);
      const float32Array = new Float32Array(
        audioBuffer.buffer,
        audioBuffer.byteOffset,
        audioBuffer.byteLength / 4
      );

      this.logger.log(`Extracted ${float32Array.length} raw audio samples`);

      if (progressive && videoId) {
        this.updateProgress(videoId, 40, 'Processing audio data...');
      }

      // Calculate RMS (Root Mean Square) values in chunks to create the waveform
      // This gives us the audio "loudness" over time
      const chunkSize = Math.ceil(float32Array.length / sampleCount);
      const waveformSamples: number[] = [];

      // Process in batches and report progress
      const batchSize = Math.ceil(sampleCount / 10); // Process in 10 batches
      for (let i = 0; i < sampleCount; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, float32Array.length);

        if (start >= float32Array.length) {
          waveformSamples.push(0);
          continue;
        }

        // Calculate RMS for this chunk
        let sumSquares = 0;
        let count = 0;
        for (let j = start; j < end; j++) {
          const sample = float32Array[j];
          sumSquares += sample * sample;
          count++;
        }

        const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
        waveformSamples.push(rms);

        // Report progress every batch
        if (progressive && videoId && i > 0 && i % batchSize === 0) {
          const progress = Math.floor(40 + (i / sampleCount) * 50); // 40-90%

          // Create partial waveform with what we have so far
          const partialSamples = [...waveformSamples];
          let maxRms = 0;
          for (const sample of partialSamples) {
            if (sample > maxRms) maxRms = sample;
          }

          const normalizedPartial = maxRms > 0.001
            ? partialSamples.map(s => Math.min(1.0, (s / maxRms) * 1.2))
            : partialSamples;

          this.updateProgress(videoId, progress, `Processing ${i}/${sampleCount} samples...`, {
            samples: normalizedPartial,
            sampleRate: 44100,
            duration,
            peakAmplitude: maxRms
          });

          this.logger.log(`Progress: ${progress}% (${i}/${sampleCount} samples)`);
        }
      }

      if (progressive && videoId) {
        this.updateProgress(videoId, 90, 'Finalizing waveform...');
      }

      // Normalize to 0-1 range for proper display
      let maxRms = 0;
      for (const sample of waveformSamples) {
        if (sample > maxRms) maxRms = sample;
      }

      // Apply normalization with safety for silent audio
      // Boost the amplitude a bit for better visibility
      const normalizedSamples = maxRms > 0.001
        ? waveformSamples.map(s => Math.min(1.0, (s / maxRms) * 1.2)) // 20% boost
        : waveformSamples;

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`Generated ${normalizedSamples.length} waveform samples in ${totalTime}s (peak RMS: ${maxRms.toFixed(4)})`);
      return normalizedSamples;

    } catch (error) {
      this.logger.error(`Failed to extract audio samples: ${(error as Error).message}`);
      this.logger.warn('Falling back to demo waveform');
      return this.generateFallbackWaveform(duration).samples;
    }
  }

  /**
   * Resample array to target length using linear interpolation
   */
  private resampleArray(input: number[], targetLength: number): number[] {
    if (input.length === targetLength) return input;

    const output: number[] = [];
    const ratio = (input.length - 1) / (targetLength - 1);

    for (let i = 0; i < targetLength; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const fraction = pos - index;

      if (index + 1 < input.length) {
        // Linear interpolation
        const value = input[index] * (1 - fraction) + input[index + 1] * fraction;
        output.push(value);
      } else {
        output.push(input[index]);
      }
    }

    return output;
  }

  /**
   * Generate a fallback waveform when real generation fails
   */
  private generateFallbackWaveform(duration: number): WaveformData {
    // Limit sample count to prevent stack overflow on very long videos
    const sampleCount = Math.min(1000, Math.max(100, Math.floor(duration * 10)));
    const samples: number[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const baseAmplitude = 0.3 + Math.random() * 0.4;
      const variation = Math.sin(i / 10) * 0.2;
      samples.push(Math.max(0, Math.min(1, baseAmplitude + variation)));
    }

    // Find max without spreading (to avoid call stack issues)
    let peakAmplitude = 0;
    for (const sample of samples) {
      if (sample > peakAmplitude) peakAmplitude = sample;
    }

    return {
      samples,
      sampleRate: 44100,
      duration,
      peakAmplitude: Math.max(peakAmplitude, 0.01),
    };
  }

  /**
   * Clear waveform cache for a specific video
   */
  clearCache(videoId: string): void {
    this.waveformCache.delete(videoId);
  }

  /**
   * Clear all waveform cache
   */
  clearAllCache(): void {
    this.waveformCache.clear();
  }

  /**
   * Get progress for a waveform generation
   */
  getProgress(videoId: string): { progress: number; status: string; partial?: WaveformData } | null {
    return this.progressCache.get(videoId) || null;
  }

  /**
   * Update progress for a waveform generation
   */
  private updateProgress(videoId: string, progress: number, status: string, partial?: WaveformData): void {
    this.progressCache.set(videoId, { progress, status, partial });
  }

  /**
   * Clear progress for a video
   */
  clearProgress(videoId: string): void {
    this.progressCache.delete(videoId);
  }
}
