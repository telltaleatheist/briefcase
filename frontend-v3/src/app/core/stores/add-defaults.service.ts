import { Injectable, signal } from '@angular/core';
import { VideoJobSettings } from '../../models/video-processing.model';

export type DownloadQuality = NonNullable<VideoJobSettings['downloadQuality']>;

/**
 * Remembered download-time choices (quality + trim). The pipeline steps are NO
 * longer remembered here — the Add popover embeds process-config, whose steps
 * are sticky through PipelinePresetsService (one shared last-used composition
 * with the inspector). So this bag is download-specific only.
 */
export interface AddDefaults {
  quality: DownloadQuality;
  trim: boolean;
  /** Seconds to remove from the START of each item after download. */
  trimStartSeconds: number;
  /** Seconds to remove from the END of each item after download (a
   *  duration cut off the tail, resolved against real duration by the backend). */
  trimEndSeconds: number;
}

export const QUALITY_OPTIONS: { value: DownloadQuality; label: string }[] = [
  { value: 'best', label: 'Best available' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p — faster' },
  { value: '480', label: '480p — fastest' },
];

const STORAGE_KEY = 'briefcase-add-defaults';
const FALLBACK_DEFAULTS: AddDefaults = {
  quality: 'best',
  trim: false,
  trimStartSeconds: 0,
  trimEndSeconds: 0,
};

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
      // Justified quiet path (fallback-audit KEEP verdict): only remembered
      // last-used choices are affected; the in-memory signal keeps them for
      // this session and no user data is at risk.
      // eslint-disable-next-line no-restricted-syntax -- audited: prefs-only, no data loss
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
        trimStartSeconds: typeof saved.trimStartSeconds === 'number' && saved.trimStartSeconds >= 0
          ? saved.trimStartSeconds
          : FALLBACK_DEFAULTS.trimStartSeconds,
        trimEndSeconds: typeof saved.trimEndSeconds === 'number' && saved.trimEndSeconds >= 0
          ? saved.trimEndSeconds
          : FALLBACK_DEFAULTS.trimEndSeconds,
      };
    } catch (error) {
      console.warn('[AddDefaults] Failed to restore add defaults', error);
      return { ...FALLBACK_DEFAULTS };
    }
  }
}
