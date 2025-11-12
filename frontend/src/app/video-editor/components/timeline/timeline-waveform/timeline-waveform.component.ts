import { Component, Input, OnChanges, SimpleChanges, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WaveformGeneratorService } from '../../../services/waveform-generator.service';
import { ZoomState } from '../../../models';

@Component({
  selector: 'app-timeline-waveform',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-waveform.component.html',
  styleUrls: ['./timeline-waveform.component.scss']
})
export class TimelineWaveformComponent implements OnChanges, AfterViewInit, OnDestroy {
  @ViewChild('waveformCanvas', { static: false }) waveformCanvas?: ElementRef<HTMLCanvasElement>;

  @Input() waveformData: number[] = [];
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() color: string = 'rgba(255, 143, 71, 0.8)';
  @Input() mediaElement?: HTMLVideoElement | HTMLAudioElement;
  @Input() autoGenerate: boolean = true; // Auto-generate waveform when media element provided

  private isGenerating = false;
  private rafId: number | null = null; // Track RAF to cancel it

  constructor(private waveformService: WaveformGeneratorService) {}

  ngAfterViewInit(): void {
    // Auto-generate waveform if media element is provided and autoGenerate is true
    if (this.autoGenerate && this.mediaElement && !this.waveformData.length) {
      this.generateWaveform();
    } else if (this.waveformData.length > 0) {
      this.renderWaveform();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Re-generate waveform when media element changes
    if (changes['mediaElement'] && this.autoGenerate && this.mediaElement && !changes['mediaElement'].firstChange) {
      this.generateWaveform();
    }

    // Re-render when waveform data, duration, or zoom changes
    if ((changes['waveformData'] || changes['duration'] || changes['zoomState']) && this.waveformData.length > 0) {
      // Cancel any pending RAF before scheduling a new one
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
      }
      this.rafId = requestAnimationFrame(() => {
        this.renderWaveform();
        this.rafId = null;
      });
    }
  }

  ngOnDestroy(): void {
    // Cancel any pending RAF callbacks to prevent memory leaks
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Generate waveform from media element
   */
  async generateWaveform(): Promise<void> {
    if (this.isGenerating || !this.mediaElement) {
      return;
    }

    this.isGenerating = true;

    try {
      this.waveformData = await this.waveformService.generateWaveform(this.mediaElement);
      this.renderWaveform();
    } catch (error) {
      console.error('Error generating waveform:', error);
      this.waveformData = [];
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Render waveform to canvas
   */
  private renderWaveform(): void {
    if (!this.waveformCanvas || !this.waveformData.length || !this.duration) {
      return;
    }

    this.waveformService.renderWaveform(
      this.waveformCanvas.nativeElement,
      this.waveformData,
      {
        duration: this.duration,
        zoomLevel: this.zoomState.level,
        zoomOffset: this.zoomState.offset,
        color: this.color
      }
    );
  }

  /**
   * Trigger manual re-render (useful for parent components)
   */
  updateDisplay(): void {
    this.renderWaveform();
  }
}
