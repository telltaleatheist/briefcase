import { Injectable } from '@angular/core';
import { TimelineConfigService } from './timeline-config.service';

@Injectable({
  providedIn: 'root'
})
export class WaveformGeneratorService {
  private isGenerating = false;

  constructor(private configService: TimelineConfigService) {}

  /**
   * Generate waveform data from media element using Web Audio API
   * IMPORTANT: Fetches audio data directly from src URL to avoid taking ownership of media element
   */
  async generateWaveform(mediaElement: HTMLVideoElement | HTMLAudioElement): Promise<number[]> {
    if (this.isGenerating) {
      throw new Error('Waveform generation already in progress');
    }

    this.isGenerating = true;

    try {
      const audioContext = new AudioContext();

      // Fetch audio data directly from the source URL
      // DO NOT use createMediaElementSource() as it takes ownership and breaks playback
      const response = await fetch(mediaElement.src);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // Get raw audio data from first channel
      const rawData = audioBuffer.getChannelData(0);
      const samples = this.configService.getPerformance().waveformSamples;
      const blockSize = Math.floor(rawData.length / samples);
      const filteredData: number[] = [];

      // Downsample the audio data
      for (let i = 0; i < samples; i++) {
        const blockStart = blockSize * i;
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(rawData[blockStart + j]);
        }
        filteredData.push(sum / blockSize);
      }

      // Normalize the data
      const max = Math.max(...filteredData);
      const normalizedData = filteredData.map(n => n / max);

      // Close audio context to free resources
      await audioContext.close();

      return normalizedData;
    } catch (error) {
      console.error('Error generating waveform:', error);
      return [];
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Render waveform data to a canvas with high-DPI support
   */
  renderWaveform(
    canvas: HTMLCanvasElement,
    waveformData: number[],
    options: {
      duration: number;
      zoomLevel: number;
      zoomOffset: number;
      color?: string;
    }
  ): void {
    if (!waveformData.length || !options.duration) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get device pixel ratio for sharp rendering on high-DPI displays
    const dpr = window.devicePixelRatio || 1;

    // Get CSS dimensions
    const rect = canvas.getBoundingClientRect();

    // Scale canvas for high-DPI displays
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    // Scale context to match
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const defaultColor = this.configService.getTheme().waveformColor;
    const { duration, zoomLevel, zoomOffset, color = defaultColor } = options;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Calculate visible portion of waveform based on zoom/pan
    const visibleDuration = duration / zoomLevel;
    const startTime = zoomOffset;
    const endTime = Math.min(startTime + visibleDuration, duration);

    // Calculate which portion of waveform data to display
    const startIndex = Math.floor((startTime / duration) * waveformData.length);
    const endIndex = Math.ceil((endTime / duration) * waveformData.length);
    const visibleData = waveformData.slice(startIndex, endIndex);

    if (visibleData.length === 0) {
      return;
    }

    // Draw waveform
    const barWidth = width / visibleData.length;
    ctx.fillStyle = color;

    for (let i = 0; i < visibleData.length; i++) {
      const barHeight = visibleData[i] * height;
      const x = i * barWidth;
      const y = (height - barHeight) / 2;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }

  /**
   * Get a slice of waveform data for a specific time range
   */
  getWaveformSlice(
    waveformData: number[],
    duration: number,
    startTime: number,
    endTime: number
  ): number[] {
    if (!waveformData.length || !duration) {
      return [];
    }

    const startIndex = Math.floor((startTime / duration) * waveformData.length);
    const endIndex = Math.ceil((endTime / duration) * waveformData.length);

    return waveformData.slice(startIndex, endIndex);
  }
}
