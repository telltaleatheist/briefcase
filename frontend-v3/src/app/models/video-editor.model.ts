export interface VideoEditorState {
  currentTime: number; // seconds
  duration: number; // seconds
  isPlaying: boolean;
  volume: number; // 0-1
  playbackRate: number; // 0.5, 1, 1.5, 2, etc.
  zoom: number; // timeline zoom level (1 = default)
  selectedClip?: VideoClip;
}

export interface VideoClip {
  id: string;
  name: string;
  url: string;
  thumbnailUrl?: string;
  duration: number;
  startTime: number; // position on timeline
  endTime: number;
  trimStart?: number; // trim from beginning
  trimEnd?: number; // trim from end
  track: number; // which track it's on
  volume: number;
  waveformData?: WaveformData;
}

export interface WaveformData {
  samples: number[]; // amplitude values 0-1
  sampleRate: number;
  duration: number;
}

export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  color?: string;
}

export interface VideoMetadata {
  filename: string;
  format: string;
  resolution: string;
  frameRate: number;
  bitrate: string;
  codec: string;
  fileSize: number;
  duration: number;
  createdDate: Date;
}

export interface EditorSettings {
  snapToGrid: boolean;
  gridSize: number; // seconds
  autoSave: boolean;
  waveformColor: string;
  timelineHeight: number;
  showThumbnails: boolean;
  audioMonitoring: boolean;
}

export interface TimelineZoom {
  level: number; // 1 = 1 second = 100px, 2 = 1 second = 200px, etc.
  min: number;
  max: number;
}

export interface PlayheadPosition {
  time: number;
  pixelPosition: number;
}
