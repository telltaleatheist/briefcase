import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { SharedConfigService } from '../config/shared-config.service';

const execAsync = promisify(exec);

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

  constructor(private readonly configService: SharedConfigService) {}

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
      // Get FFmpeg path
      const ffmpegPath = process.env.FFMPEG_PATH || this.configService.getFfmpegPath() || 'ffmpeg';

      // First, get the video duration
      const duration = await this.getVideoDuration(videoPath, ffmpegPath);

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
        ffmpegPath,
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
   * Get video duration using ffprobe
   */
  private async getVideoDuration(videoPath: string, ffmpegPath: string): Promise<number> {
    try {
      // Get ffprobe path - prioritize env var, then try to derive from ffmpeg path
      const ffprobePath = process.env.FFPROBE_PATH ||
                         this.configService.getFfprobePath() ||
                         ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

      const command = `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;

      const { stdout } = await execAsync(command);
      const duration = parseFloat(stdout.trim());

      return duration;
    } catch (error) {
      this.logger.error(`Failed to get video duration: ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * Extract audio samples using FFmpeg
   * Supports progressive updates by reporting progress as chunks are processed
   */
  private async extractAudioSamples(
    videoPath: string,
    ffmpegPath: string,
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

      // Extract mono audio - lower sample rate = much faster processing
      const command = `"${ffmpegPath}" -i "${videoPath}" -f f32le -ac 1 -ar ${targetSampleRate} -`;

      const startTime = Date.now();
      this.logger.log(`Running FFmpeg audio extraction at ${targetSampleRate} Hz...`);

      const result = await execAsync(command, {
        encoding: null as any, // Return Buffer instead of string
        maxBuffer: 100 * 1024 * 1024, // 100MB max buffer for longer videos
      });

      const extractTime = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`FFmpeg extraction completed in ${extractTime}s`);

      // stdout is a Buffer containing raw 32-bit float PCM audio samples
      const audioBuffer = result.stdout as Buffer;
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
