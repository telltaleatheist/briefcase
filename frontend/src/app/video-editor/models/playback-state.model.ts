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

export type PlaybackSpeed = -8 | -4 | -2 | -1 | 0 | 1 | 2 | 4 | 8;

export interface PlaybackCommand {
  type: 'play' | 'pause' | 'seek' | 'setSpeed' | 'togglePlayPause';
  payload?: {
    time?: number;
    speed?: PlaybackSpeed;
  };
}
