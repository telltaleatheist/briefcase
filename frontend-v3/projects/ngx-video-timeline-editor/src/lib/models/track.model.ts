/**
 * Track models for multi-track timeline support
 */

import { TimelineSection } from './timeline.model';

export type TrackType = 'video' | 'audio';

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  sections: TimelineSection[];
  waveformData?: number[];
  enabled: boolean;
  locked: boolean;
  height: number; // Height in pixels
}

export interface VideoTrack extends Track {
  type: 'video';
}

export interface AudioTrack extends Track {
  type: 'audio';
  waveformData: number[];
  volume: number; // 0-1
  muted: boolean;
}
