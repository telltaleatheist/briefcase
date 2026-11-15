// Imported explicitly: the backend tsconfig pins "types": ["node"].
import { describe, expect, it } from '@jest/globals';

import { buildFormatSelector, buildMergedFormatSelector, buildMuxedFormatSelector } from './format-selector';

/**
 * A quality is a target. Vertical videos (a Facebook reel is 720x1280 and
 * 1080x1920) matched nothing under the old [height<=720] cap, so every vertical
 * download failed with "Requested format is not available".
 */
describe('buildFormatSelector', () => {
  it('is the plain chain when there is no cap', () => {
    expect(buildMergedFormatSelector(null)).toBe('bestvideo+bestaudio/best');
  });

  it('caps portrait video by width, so a 720x1280 reel counts as 720p', () => {
    const parts = buildMergedFormatSelector(720).split('/');
    expect(parts).toContain('bestvideo[aspect_ratio<1][width<=720]+bestaudio');
    expect(parts).toContain('bestvideo[aspect_ratio>=?1][height<=720]+bestaudio');
  });

  it('ends on the uncapped chain, so nothing small enough means best available, not a failure', () => {
    expect(buildMergedFormatSelector(720).endsWith('/bestvideo+bestaudio/best')).toBe(true);
  });

  it('keeps extra filters on every element', () => {
    const selector = buildFormatSelector(480, {
      video: 'bestvideo[ext=mp4]',
      audio: 'bestaudio[ext=m4a]',
      muxed: ['best[ext=mp4]', 'best'],
    });
    expect(selector.split('/')).toEqual([
      'bestvideo[ext=mp4][aspect_ratio>=?1][height<=480]+bestaudio[ext=m4a]',
      'bestvideo[ext=mp4][aspect_ratio<1][width<=480]+bestaudio[ext=m4a]',
      'best[ext=mp4][aspect_ratio>=?1][height<=480]',
      'best[ext=mp4][aspect_ratio<1][width<=480]',
      'best[aspect_ratio>=?1][height<=480]',
      'best[aspect_ratio<1][width<=480]',
      'bestvideo[ext=mp4]+bestaudio[ext=m4a]',
      'best[ext=mp4]',
      'best',
    ]);
  });

  it('builds a single-format muxed chain', () => {
    expect(buildMuxedFormatSelector(null, 'best')).toBe('best');
    expect(buildMuxedFormatSelector(720, 'best')).toBe(
      'best[aspect_ratio>=?1][height<=720]/best[aspect_ratio<1][width<=720]/best',
    );
  });
});
