import { Injectable, signal } from '@angular/core';
import { VideoJobSettings } from '../../models/video-processing.model';

export type DownloadQuality = NonNullable<VideoJobSettings['downloadQuality']>;

/** Remembered add-flow choices (quality + pipeline steps). */
export interface AddDefaults {
  quality: DownloadQuality;
  trim: boolean;
  transcribe: boolean;
  analyze: boolean;
}

export const QUALITY_OPTIONS: { value: DownloadQuality; label: string }[] = [
  { value: 'best', label: 'Best available' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p — faster' },
  { value: '480', label: '480p — fastest' },
];

const STORAGE_KEY = 'briefcase-add-defaults';
const FALLBACK_DEFAULTS: AddDefaults = { quality: 'best', trim: false, transcribe: true, analyze: false };

/**
 * Single source of truth for the add-flow defaults, shared by the toolbar's
 * Add popover and Settings → Downloads so the two can't drift. Persisted to
 * localStorage under the key the popover has used since Phase 2.
 */
@Injectable({ providedIn: 'root' })
export class AddDefaultsService {
  /** Current defaults; updated whenever either surface saves. */
  readonly defaults = signal<AddDefaults>(this.restore());

  update(partial: Partial<AddDefaults>): void {
    const next = { ...this.defaults(), ...partial };
    this.defaults.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn('[AddDefaults] Failed to persist add defaults', error);
    }
  }

  private restore(): AddDefaults {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...FALLBACK_DEFAULTS };
      const saved = JSON.parse(raw) as Partial<AddDefaults>;
      return {
        quality: saved.quality && QUALITY_OPTIONS.some(o => o.value === saved.quality)
          ? saved.quality
          : FALLBACK_DEFAULTS.quality,
        trim: typeof saved.trim === 'boolean' ? saved.trim : FALLBACK_DEFAULTS.trim,
        transcribe: typeof saved.transcribe === 'boolean' ? saved.transcribe : FALLBACK_DEFAULTS.transcribe,
        analyze: typeof saved.analyze === 'boolean' ? saved.analyze : FALLBACK_DEFAULTS.analyze,
      };
    } catch (error) {
      console.warn('[AddDefaults] Failed to restore add defaults', error);
      return { ...FALLBACK_DEFAULTS };
    }
  }
}
