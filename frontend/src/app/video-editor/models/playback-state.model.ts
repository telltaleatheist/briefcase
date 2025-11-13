/**
 * Playback state model
 */

export interface PlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
}

export type PlaybackSpeed = 0 | 0.125 | 0.25 | 0.5 | 0.75 | 1 | 1.5 | 2 | 3 | 4 | 8;

export interface PlaybackCommand {
  type: 'play' | 'pause' | 'seek' | 'setSpeed' | 'togglePlayPause';
  payload?: {
    time?: number;
    speed?: PlaybackSpeed;
  };
}
