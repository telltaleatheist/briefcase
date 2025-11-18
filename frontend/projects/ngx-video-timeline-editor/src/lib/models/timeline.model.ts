/**
 * Timeline models and interfaces
 */

export interface TimelineSection {
  startTime: number;
  endTime: number;
  category: string;
  description: string;
  color: string;
}

export interface TimelineSelection {
  startTime: number;
  endTime: number;
}

export type TimelineTool = 'cursor' | 'highlight';

export interface CategoryFilter {
  category: string;
  label: string;
  color: string;
  enabled: boolean;
}

export interface TimeMarker {
  position: number;
  label: string;
  isMajor: boolean;
  showLabel: boolean;
}

export interface ZoomState {
  level: number;      // 1 = 100%, 2 = 200%, etc.
  offset: number;     // Offset in seconds for panning when zoomed
}

export interface TimelineState {
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  selection: TimelineSelection;
  sections: TimelineSection[];
  categoryFilters: CategoryFilter[];
  zoomState: ZoomState;
  selectedTool: TimelineTool;
  autoFollowPlayhead: boolean;
}
