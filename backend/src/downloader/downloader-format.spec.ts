// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import { DownloaderService } from './downloader.service';

/**
 * The generic (no bespoke branch) format selector. Fox News video pages serve
 * only split HLS renditions — video-only `hls-<bitrate>` plus an audio-only
 * `hls-audio-N-en__Main_` — and publish no pre-muxed format, so the previous
 * bare `best` selector failed every Fox link with "Requested format is not
 * available". These tests pin the selector shape against that. The method is
 * pure, so it is exercised via the prototype without constructing the service.
 */

const proto = DownloaderService.prototype as any;

const buildGenericFormatSelector = (quality?: string): string =>
  proto.buildGenericFormatSelector.call(proto, quality);

describe('buildGenericFormatSelector', () => {
  it('merges separate video+audio streams rather than demanding a muxed format', () => {
    // The regression: a bare `best` matches only pre-muxed formats, of which
    // Fox News (and the other Akamai/Brightcove news players) have none.
    const selector = buildGenericFormatSelector(undefined);
    expect(selector).toBe('bestvideo+bestaudio/best');
    expect(selector).not.toBe('best');
  });

  it('treats an explicit "best" the same as no quality at all', () => {
    expect(buildGenericFormatSelector('best')).toBe('bestvideo+bestaudio/best');
  });

  it('aims for the cap on the short side of either orientation, then takes the best available', () => {
    expect(buildGenericFormatSelector('720')).toBe(
      'bestvideo[aspect_ratio>=?1][height<=720]+bestaudio'
        + '/bestvideo[aspect_ratio<1][width<=720]+bestaudio'
        + '/best[aspect_ratio>=?1][height<=720]'
        + '/best[aspect_ratio<1][width<=720]'
        + '/bestvideo+bestaudio/best',
    );
  });

  it('never emits the malformed `height<=undefined` clause', () => {
    for (const quality of [undefined, 'best', '1080']) {
      expect(buildGenericFormatSelector(quality)).not.toContain('undefined');
    }
  });

  it('rejects a corrupt quality rather than silently picking one', () => {
    expect(() => buildGenericFormatSelector('garbage')).toThrow(/Invalid download quality/);
  });
});
