/**
 * Default timeline configuration values
 */

import { TimelineTheme, TimelineSizing, TimelinePerformance, TimelineSpacing, TimelineConfig } from './timeline-config.interface';

/**
 * Default theme configuration
 */
export const DEFAULT_TIMELINE_THEME: TimelineTheme = {
  primaryColor: '#ff6600',
  secondaryColor: '#ff8833',
  selectionColor: '#ffcc00',
  playheadColor: 'auto', // Will be computed based on theme mode
  waveformColor: 'rgba(255, 143, 71, 0.8)',
  backgroundColor: 'auto', // Will be computed based on theme mode
  borderColor: 'auto', // Will be computed based on theme mode
  textColor: 'auto', // Will be computed based on theme mode
  mode: 'auto'
};

/**
 * Default sizing configuration
 */
export const DEFAULT_TIMELINE_SIZING: TimelineSizing = {
  rulerHeight: 40,
  zoomBarHeight: 24,
  playheadWidth: 2,
  handleSize: 16,
  borderWidth: 2,
  borderRadius: 4,
  spacing: 8
};

/**
 * Default performance configuration
 */
export const DEFAULT_TIMELINE_PERFORMANCE: TimelinePerformance = {
  fps: 30,
  waveformSamples: 1000,
  maxMajorMarkers: 20,
  maxMinorMarkers: 100
};

/**
 * Default spacing configuration
 */
export const DEFAULT_TIMELINE_SPACING: TimelineSpacing = {
  rulerMargin: 8,
  zoomBarMargin: 12,
  componentPadding: 6,
  handleOffset: -8
};

/**
 * Complete default timeline configuration
 */
export const DEFAULT_TIMELINE_CONFIG: Required<TimelineConfig> = {
  theme: DEFAULT_TIMELINE_THEME,
  sizing: DEFAULT_TIMELINE_SIZING,
  performance: DEFAULT_TIMELINE_PERFORMANCE,
  spacing: DEFAULT_TIMELINE_SPACING
};
