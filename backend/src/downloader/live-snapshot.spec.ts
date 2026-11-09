// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import {
  assertLiveWindow,
  buildLiveFormatSelector,
  buildLiveSnapshot,
  withoutTodaysStamp,
} from './live-snapshot';

const PLAYLIST_URL = 'https://cdn.example.com/live/abc/chunklist_DVR.m3u8?token=playlist';

const LIVE_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:3',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXTINF:3.000,',
  'media_100.ts',
  '#EXTINF:2.500,',
  'media_101.ts?sig=xyz',
].join('\n');

describe('buildLiveSnapshot', () => {
  it('freezes the playlist so the download stops at what has streamed so far', () => {
    const { playlist, segmentCount, durationSeconds } = buildLiveSnapshot(LIVE_PLAYLIST, PLAYLIST_URL);

    expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(segmentCount).toBe(2);
    expect(durationSeconds).toBeCloseTo(5.5);
  });

  it('makes segment URLs absolute and keeps their own query tokens', () => {
    const { playlist } = buildLiveSnapshot(LIVE_PLAYLIST, PLAYLIST_URL);

    expect(playlist).toContain('\nhttps://cdn.example.com/live/abc/media_100.ts\n');
    expect(playlist).toContain('\nhttps://cdn.example.com/live/abc/media_101.ts?sig=xyz\n');
  });

  it('makes KEY and MAP URIs absolute', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:3.000,',
      'media_1.m4s',
    ].join('\n');

    const { playlist } = buildLiveSnapshot(text, PLAYLIST_URL);

    expect(playlist).toContain('URI="https://cdn.example.com/live/abc/key.bin",IV=0x1');
    expect(playlist).toContain('#EXT-X-MAP:URI="https://cdn.example.com/live/abc/init.mp4"');
  });

  it('leaves already absolute segment URLs alone', () => {
    const text = '#EXTM3U\n#EXTINF:3.0,\nhttps://other.example.com/a.ts?t=1\n';

    expect(buildLiveSnapshot(text, PLAYLIST_URL).playlist).toContain('\nhttps://other.example.com/a.ts?t=1\n');
  });

  it('does not add a second end marker when the broadcast just ended', () => {
    const { playlist } = buildLiveSnapshot(`${LIVE_PLAYLIST}\n#EXT-X-ENDLIST\n`, PLAYLIST_URL);

    expect(playlist.match(/#EXT-X-ENDLIST/g)).toHaveLength(1);
  });

  it('refuses a master playlist', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n';

    expect(() => buildLiveSnapshot(text, PLAYLIST_URL)).toThrow(/master playlist/);
  });

  it('refuses a response that is not HLS', () => {
    expect(() => buildLiveSnapshot('<MPD></MPD>', PLAYLIST_URL)).toThrow(/not HLS/);
  });
});

describe('assertLiveWindow', () => {
  it('fails a stream that keeps no history rather than delivering seconds of video', () => {
    expect(() => assertLiveWindow(18)).toThrow(/keeps no history \(only 18 seconds/);
    expect(() => assertLiveWindow(59.9)).toThrow(/keeps no history/);
    // The way out is named: recording it from now.
    expect(() => assertLiveWindow(18)).toThrow(/Keep recording live/);
  });

  it('accepts a window of a minute or more', () => {
    expect(() => assertLiveWindow(60)).not.toThrow();
    expect(() => assertLiveWindow(14400)).not.toThrow();
  });
});

describe('buildLiveFormatSelector', () => {
  it('asks for one muxed HLS rendition', () => {
    expect(buildLiveFormatSelector(null)).toBe('best[protocol*=m3u8]');
  });

  it('honours a height cap', () => {
    expect(buildLiveFormatSelector(360)).toBe('best[protocol*=m3u8][height<=360]');
  });
});

describe('withoutTodaysStamp', () => {
  it("drops today's date and time from a live room's title", () => {
    expect(withoutTodaysStamp('Alex Jones Live 2026-11-04 13:38', '2026-11-04')).toBe('Alex Jones Live');
  });

  it('drops a bare date and the separator before it', () => {
    expect(withoutTodaysStamp('Morning Show - 2026-11-04', '2026-11-04')).toBe('Morning Show');
  });

  it('keeps a stamp of another day, which says something the prefix does not', () => {
    expect(withoutTodaysStamp('Alex Jones Live 2026-11-03 13:38', '2026-11-04')).toBe('Alex Jones Live 2026-11-03 13:38');
  });

  it('keeps a title that is only a date', () => {
    expect(withoutTodaysStamp('2026-11-04', '2026-11-04')).toBe('2026-11-04');
  });

  it('keeps a date in the middle of a title', () => {
    expect(withoutTodaysStamp('The 2026-11-04 Election Night', '2026-11-04')).toBe('The 2026-11-04 Election Night');
  });
});
