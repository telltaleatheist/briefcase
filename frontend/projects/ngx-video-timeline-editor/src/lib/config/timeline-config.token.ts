/**
 * Angular DI tokens for timeline configuration
 */

import { InjectionToken } from '@angular/core';
import { TimelineConfig } from './timeline-config.interface';

/**
 * Injection token for timeline configuration
 *
 * @example
 * ```typescript
 * providers: [
 *   {
 *     provide: TIMELINE_CONFIG,
 *     useValue: {
 *       theme: { primaryColor: '#0066ff' },
 *       performance: { fps: 60 }
 *     }
 *   }
 * ]
 * ```
 */
export const TIMELINE_CONFIG = new InjectionToken<TimelineConfig>(
  'TIMELINE_CONFIG',
  {
    providedIn: 'root',
    factory: () => ({})
  }
);
