import { Component, Input, OnChanges, SimpleChanges, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZoomState, WaveformData } from '../../../../models/video-editor.model';

@Component({
  selector: 'app-timeline-waveform',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-waveform.component.html',
  styleUrls: ['./timeline-waveform.component.scss']
})
export class TimelineWaveformComponent implements OnChanges, AfterViewInit {
  @Input() waveformData?: WaveformData;
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() color: string = '#ff6b35';

  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private resizeObserver?: ResizeObserver;

  ngAfterViewInit(): void {
    this.drawWaveform();
    this.setupResizeObserver();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['waveformData']) {
      const current = changes['waveformData'].currentValue;
      console.log(`[Waveform Component] Data changed:`, current?.samples?.length, 'samples');
      this.drawWaveform();
    } else if (changes['zoomState'] || changes['color']) {
      this.drawWaveform();
    }
  }

  private setupResizeObserver(): void {
    if (this.canvasRef?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => {
        this.drawWaveform();
      });
      this.resizeObserver.observe(this.canvasRef.nativeElement.parentElement!);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  private drawWaveform(): void {
    if (!this.canvasRef?.nativeElement || !this.waveformData?.samples?.length) return;

    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    const width = rect.width;
    const height = rect.height;
    const centerY = height / 2;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Calculate visible range
    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;

    // Guard against invalid durations
    if (!isFinite(visibleDuration) || visibleDuration <= 0 || this.waveformData.duration <= 0) {
      return;
    }

    // Calculate sample range to draw
    const samplesPerSecond = this.waveformData.samples.length / this.waveformData.duration;
    const startSample = Math.floor(visibleStart * samplesPerSecond);
    const endSample = Math.ceil((visibleStart + visibleDuration) * samplesPerSecond);

    const visibleSamples = this.waveformData.samples.slice(
      Math.max(0, startSample),
      Math.min(this.waveformData.samples.length, endSample)
    );

    if (visibleSamples.length === 0) return;

    // Draw waveform
    ctx.fillStyle = this.color;
    ctx.globalAlpha = 0.6;

    // Calculate time per sample and pixels per second
    const timePerSample = this.waveformData.duration / this.waveformData.samples.length;
    const pixelsPerSecond = width / visibleDuration;

    visibleSamples.forEach((sample, i) => {
      // Calculate the actual time this sample represents
      const sampleIndex = startSample + i;
      const sampleTime = sampleIndex * timePerSample;

      // Calculate x position based on time offset from visible start
      const timeOffset = sampleTime - visibleStart;
      const x = timeOffset * pixelsPerSecond;

      // Draw the bar
      const barHeight = sample * height * 0.8;
      const y = centerY - barHeight / 2;
      const barWidth = Math.max(1, timePerSample * pixelsPerSecond);

      ctx.fillRect(x, y, barWidth, barHeight);
    });
  }

  generateSvgPath(): string {
    if (!this.waveformData?.samples?.length) return '';

    const samples = this.waveformData.samples;
    const width = 100;
    const height = 40;
    const center = height / 2;
    const stepX = width / samples.length;

    let path = `M 0,${center}`;

    samples.forEach((sample, i) => {
      const x = i * stepX;
      const y = center - (sample * center);
      path += ` L ${x},${y}`;
    });

    // Mirror for bottom half
    for (let i = samples.length - 1; i >= 0; i--) {
      const x = i * stepX;
      const y = center + (samples[i] * center);
      path += ` L ${x},${y}`;
    }

    path += ' Z';
    return path;
  }
}
