/**
 * Timeline configuration service
 *
 * Manages timeline configuration, merges user settings with defaults,
 * and provides configuration values to components.
 */

import { Injectable, Inject, Optional } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import {
  TimelineConfig,
  TimelineTheme,
  TimelineSizing,
  TimelinePerformance,
  TimelineSpacing
} from '../config/timeline-config.interface';
import {
  DEFAULT_TIMELINE_CONFIG,
  DEFAULT_TIMELINE_THEME,
  DEFAULT_TIMELINE_SIZING,
  DEFAULT_TIMELINE_PERFORMANCE,
  DEFAULT_TIMELINE_SPACING
} from '../config/timeline-config.defaults';
import { TIMELINE_CONFIG } from '../config/timeline-config.token';

/**
 * Resolved configuration with all auto values computed
 */
export interface ResolvedTimelineConfig {
  theme: TimelineTheme;
  sizing: TimelineSizing;
  performance: TimelinePerformance;
  spacing: TimelineSpacing;
}

@Injectable({
  providedIn: 'root'
})
export class TimelineConfigService {
  private configSubject = new BehaviorSubject<ResolvedTimelineConfig>(
    this.resolveConfig(DEFAULT_TIMELINE_CONFIG)
  );

  /** Observable of current configuration */
  public config$: Observable<ResolvedTimelineConfig> = this.configSubject.asObservable();

  constructor(
    @Optional() @Inject(TIMELINE_CONFIG) private userConfig?: TimelineConfig
  ) {
    // Merge user config with defaults and resolve auto values
    const mergedConfig = this.mergeConfig(DEFAULT_TIMELINE_CONFIG, this.userConfig || {});
    const resolvedConfig = this.resolveConfig(mergedConfig);
    this.configSubject.next(resolvedConfig);
  }

  /**
   * Get current configuration
   */
  getConfig(): ResolvedTimelineConfig {
    return this.configSubject.value;
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig: Partial<TimelineConfig>): void {
    const currentConfig = this.configSubject.value;
    const mergedConfig = this.mergeConfig(currentConfig, newConfig);
    const resolvedConfig = this.resolveConfig(mergedConfig);
    this.configSubject.next(resolvedConfig);
  }

  /**
   * Get theme configuration
   */
  getTheme(): TimelineTheme {
    return this.configSubject.value.theme;
  }

  /**
   * Get sizing configuration
   */
  getSizing(): TimelineSizing {
    return this.configSubject.value.sizing;
  }

  /**
   * Get performance configuration
   */
  getPerformance(): TimelinePerformance {
    return this.configSubject.value.performance;
  }

  /**
   * Get spacing configuration
   */
  getSpacing(): TimelineSpacing {
    return this.configSubject.value.spacing;
  }

  /**
   * Get CSS custom properties object for applying to elements
   */
  getCSSVariables(): Record<string, string> {
    const config = this.configSubject.value;
    const { theme, sizing, spacing } = config;

    return {
      // Theme colors
      '--timeline-primary-color': theme.primaryColor,
      '--timeline-secondary-color': theme.secondaryColor,
      '--timeline-selection-color': theme.selectionColor,
      '--timeline-playhead-color': theme.playheadColor,
      '--timeline-waveform-color': theme.waveformColor,
      '--timeline-background-color': theme.backgroundColor,
      '--timeline-border-color': theme.borderColor,
      '--timeline-text-color': theme.textColor,

      // Sizing
      '--timeline-ruler-height': `${sizing.rulerHeight}px`,
      '--timeline-zoom-bar-height': `${sizing.zoomBarHeight}px`,
      '--timeline-playhead-width': `${sizing.playheadWidth}px`,
      '--timeline-handle-size': `${sizing.handleSize}px`,
      '--timeline-border-width': `${sizing.borderWidth}px`,
      '--timeline-border-radius': `${sizing.borderRadius}px`,
      '--timeline-spacing': `${sizing.spacing}px`,

      // Spacing
      '--timeline-ruler-margin': `${spacing.rulerMargin}px`,
      '--timeline-zoom-bar-margin': `${spacing.zoomBarMargin}px`,
      '--timeline-component-padding': `${spacing.componentPadding}px`,
      '--timeline-handle-offset': `${spacing.handleOffset}px`
    };
  }

  /**
   * Merge user configuration with defaults
   */
  private mergeConfig(
    defaults: Required<TimelineConfig>,
    user: Partial<TimelineConfig>
  ): Required<TimelineConfig> {
    return {
      theme: { ...defaults.theme, ...user.theme },
      sizing: { ...defaults.sizing, ...user.sizing },
      performance: { ...defaults.performance, ...user.performance },
      spacing: { ...defaults.spacing, ...user.spacing }
    };
  }

  /**
   * Resolve auto values in configuration
   */
  private resolveConfig(config: Required<TimelineConfig>): ResolvedTimelineConfig {
    const themeMode = config.theme?.mode || 'auto';
    const isDarkMode = this.isDarkMode(themeMode);

    return {
      theme: this.resolveTheme(config.theme as TimelineTheme, isDarkMode),
      sizing: config.sizing as TimelineSizing,
      performance: config.performance as TimelinePerformance,
      spacing: config.spacing as TimelineSpacing
    };
  }

  /**
   * Resolve theme with auto colors - Creamsicle Design System
   */
  private resolveTheme(theme: TimelineTheme, isDark: boolean): TimelineTheme {
    return {
      ...theme,
      playheadColor: theme.playheadColor === 'auto'
        ? (isDark ? '#ffffff' : '#0f0f0f')        // white / almost-black
        : theme.playheadColor,
      backgroundColor: theme.backgroundColor === 'auto'
        ? (isDark ? '#1a1a1a' : '#f8f9fa')        // bg-secondary dark/light
        : theme.backgroundColor,
      borderColor: theme.borderColor === 'auto'
        ? (isDark ? '#374151' : '#d1d5db')        // border-color dark/light
        : theme.borderColor,
      textColor: theme.textColor === 'auto'
        ? (isDark ? '#ffffff' : '#0f0f0f')        // white / almost-black
        : theme.textColor
    };
  }

  /**
   * Determine if dark mode should be used
   */
  private isDarkMode(mode: 'auto' | 'light' | 'dark'): boolean {
    if (mode === 'light') return false;
    if (mode === 'dark') return true;

    // Auto-detect from document theme attribute (Creamsicle design system)
    if (typeof document !== 'undefined') {
      const themeAttr = document.documentElement.getAttribute('data-theme');
      if (themeAttr === 'dark') return true;
      if (themeAttr === 'light') return false;
    }

    // Fallback to system preference
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    return false;
  }
}
