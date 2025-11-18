/**
 * Timeline configuration interfaces
 */

/**
 * Theme color configuration
 */
export interface TimelineTheme {
  /** Primary accent color (default: #ff6600) */
  primaryColor: string;

  /** Secondary accent color (default: #ff8833) */
  secondaryColor: string;

  /** Selection/highlight color (default: #ffcc00) */
  selectionColor: string;

  /** Playhead indicator color (default: auto based on theme) */
  playheadColor: string;

  /** Waveform visualization color (default: rgba(255, 143, 71, 0.8)) */
  waveformColor: string;

  /** Background color (default: auto based on theme) */
  backgroundColor: string;

  /** Border color (default: auto based on theme) */
  borderColor: string;

  /** Text color (default: auto based on theme) */
  textColor: string;

  /** Theme mode */
  mode: 'auto' | 'light' | 'dark';
}

/**
 * Sizing configuration in pixels
 */
export interface TimelineSizing {
  /** Ruler height (default: 40) */
  rulerHeight: number;

  /** Zoom bar height (default: 24) */
  zoomBarHeight: number;

  /** Playhead line width (default: 2) */
  playheadWidth: number;

  /** Handle/grip size (default: 16) */
  handleSize: number;

  /** Border width (default: 2) */
  borderWidth: number;

  /** Border radius (default: 4) */
  borderRadius: number;

  /** Component spacing/margin (default: 8) */
  spacing: number;
}

/**
 * Performance and calculation configuration
 */
export interface TimelinePerformance {
  /** Frames per second for time formatting (default: 30) */
  fps: number;

  /** Number of waveform samples to generate (default: 1000) */
  waveformSamples: number;

  /** Maximum number of major time markers (default: 20) */
  maxMajorMarkers: number;

  /** Maximum number of minor time markers (default: 100) */
  maxMinorMarkers: number;
}

/**
 * Spacing configuration in pixels
 */
export interface TimelineSpacing {
  /** Ruler margin (default: 8) */
  rulerMargin: number;

  /** Zoom bar margin (default: 12) */
  zoomBarMargin: number;

  /** Component padding (default: 6) */
  componentPadding: number;

  /** Handle offset (default: -8) */
  handleOffset: number;
}

/**
 * Main timeline configuration
 */
export interface TimelineConfig {
  /** Theme configuration */
  theme?: Partial<TimelineTheme>;

  /** Sizing configuration */
  sizing?: Partial<TimelineSizing>;

  /** Performance configuration */
  performance?: Partial<TimelinePerformance>;

  /** Spacing configuration */
  spacing?: Partial<TimelineSpacing>;
}
