import { Component, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  VideoEditorState,
  VideoClip,
  VideoMetadata,
  EditorSettings,
  TimelineMarker
} from '../../models/video-editor.model';

@Component({
  selector: 'app-video-editor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './video-editor.component.html',
  styleUrls: ['./video-editor.component.scss']
})
export class VideoEditorComponent {
  // Editor state
  editorState = signal<VideoEditorState>({
    currentTime: 0,
    duration: 120, // Default 2 minutes for demo
    isPlaying: false,
    volume: 1,
    playbackRate: 1,
    zoom: 1
  });

  // Clips on timeline
  clips = signal<VideoClip[]>([
    {
      id: '1',
      name: 'Sample Video Clip',
      url: '',
      duration: 45,
      startTime: 0,
      endTime: 45,
      track: 0,
      volume: 1,
      waveformData: {
        samples: this.generateDemoWaveform(45),
        sampleRate: 44100,
        duration: 45
      }
    },
    {
      id: '2',
      name: 'Second Clip',
      url: '',
      duration: 30,
      startTime: 50,
      endTime: 80,
      track: 0,
      volume: 0.8,
      waveformData: {
        samples: this.generateDemoWaveform(30),
        sampleRate: 44100,
        duration: 30
      }
    }
  ]);

  // Timeline markers
  markers = signal<TimelineMarker[]>([
    { id: '1', time: 15, label: 'Intro End', color: '#ff6b35' },
    { id: '2', time: 60, label: 'Main Section', color: '#4ecdc4' }
  ]);

  // Video metadata
  metadata = signal<VideoMetadata>({
    filename: 'sample-video.mp4',
    format: 'MP4',
    resolution: '1920x1080',
    frameRate: 30,
    bitrate: '5.2 Mbps',
    codec: 'H.264',
    fileSize: 125829120, // bytes
    duration: 120,
    createdDate: new Date()
  });

  // Editor settings
  settings = signal<EditorSettings>({
    snapToGrid: true,
    gridSize: 1,
    autoSave: true,
    waveformColor: '#ff6b35',
    timelineHeight: 150,
    showThumbnails: true,
    audioMonitoring: false
  });

  // Computed values
  formattedCurrentTime = computed(() => this.formatTime(this.editorState().currentTime));
  formattedDuration = computed(() => this.formatTime(this.editorState().duration));
  timelineProgress = computed(() => {
    const state = this.editorState();
    return (state.currentTime / state.duration) * 100;
  });

  // Sidebar visibility
  showInfoSidebar = signal(true);
  showSettingsSidebar = signal(true);

  // Timeline scroll position (0-100%)
  scrollPosition = 0;

  constructor() {
    // Set up effects for playback
    effect(() => {
      const state = this.editorState();
      if (state.isPlaying) {
        this.startPlayback();
      } else {
        this.stopPlayback();
      }
    }, { allowSignalWrites: true });
  }

  private playbackInterval?: any;

  private startPlayback() {
    this.stopPlayback();
    this.playbackInterval = setInterval(() => {
      const state = this.editorState();
      let newTime = state.currentTime + (0.1 * state.playbackRate);

      if (newTime >= state.duration) {
        newTime = state.duration;
        this.togglePlayPause();
      }

      this.updateCurrentTime(newTime);
    }, 100);
  }

  private stopPlayback() {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = undefined;
    }
  }

  // Playback controls
  togglePlayPause() {
    this.editorState.update(state => ({
      ...state,
      isPlaying: !state.isPlaying
    }));
  }

  updateCurrentTime(time: number) {
    this.editorState.update(state => ({
      ...state,
      currentTime: Math.max(0, Math.min(time, state.duration))
    }));
  }

  seekTo(time: number) {
    this.updateCurrentTime(time);
  }

  skipBackward(seconds: number = 5) {
    const state = this.editorState();
    this.updateCurrentTime(state.currentTime - seconds);
  }

  skipForward(seconds: number = 5) {
    const state = this.editorState();
    this.updateCurrentTime(state.currentTime + seconds);
  }

  setPlaybackRate(rate: number) {
    this.editorState.update(state => ({
      ...state,
      playbackRate: rate
    }));
  }

  setVolume(volume: number) {
    this.editorState.update(state => ({
      ...state,
      volume: Math.max(0, Math.min(1, volume))
    }));
  }

  setZoom(zoom: number) {
    this.editorState.update(state => ({
      ...state,
      zoom: Math.max(0.5, Math.min(4, zoom))
    }));
  }

  // Timeline controls
  zoomIn() {
    const state = this.editorState();
    this.setZoom(state.zoom * 1.2);
  }

  zoomOut() {
    const state = this.editorState();
    this.setZoom(state.zoom / 1.2);
  }

  resetZoom() {
    this.setZoom(1);
  }

  // Clip management
  selectClip(clip: VideoClip) {
    this.editorState.update(state => ({
      ...state,
      selectedClip: clip
    }));
  }

  deleteClip(clipId: string) {
    this.clips.update(clips => clips.filter(c => c.id !== clipId));
  }

  // Settings
  toggleInfoSidebar() {
    this.showInfoSidebar.update(v => !v);
  }

  toggleSettingsSidebar() {
    this.showSettingsSidebar.update(v => !v);
  }

  updateSetting<K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) {
    this.settings.update(s => ({
      ...s,
      [key]: value
    }));
  }

  // Utilities
  formatTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  // Generate demo waveform data
  private generateDemoWaveform(duration: number): number[] {
    const samples: number[] = [];
    const sampleCount = duration * 10; // 10 samples per second for visualization

    for (let i = 0; i < sampleCount; i++) {
      // Generate semi-random waveform data
      const baseAmplitude = 0.3 + Math.random() * 0.4;
      const variation = Math.sin(i / 10) * 0.2;
      samples.push(Math.max(0, Math.min(1, baseAmplitude + variation)));
    }

    return samples;
  }

  // Generate SVG path for waveform visualization
  generateWaveformPath(samples: number[]): string {
    if (!samples || samples.length === 0) return '';

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

  // Expose Math to template
  Math = Math;
}
