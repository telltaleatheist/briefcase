/**
 * Live HLS snapshots — pure functions, no I/O.
 *
 * yt-dlp's --live-from-start only works on a few sites, and without it a live
 * stream records forward until the broadcast ends. A live media playlist already
 * lists every segment the stream still keeps, though, so Briefcase freezes that
 * list: absolute URLs plus an end marker turn it into a finite playlist, and the
 * download stops by itself at "what has streamed so far". See
 * DownloaderService.downloadLiveSnapshot().
 */

/** Below this the stream keeps no real history; a file would be seconds long. */
export const MIN_LIVE_WINDOW_SECONDS = 60;

export interface LiveSnapshot {
  playlist: string;
  segmentCount: number;
  durationSeconds: number;
}

/** yt-dlp selector for one muxed HLS rendition, the only shape a snapshot can hold. */
export function buildLiveFormatSelector(cap: number | null): string {
  return cap === null ? 'best[protocol*=m3u8]' : `best[protocol*=m3u8][height<=${cap}]`;
}

/**
 * Freeze a live media playlist. The segments stay on the CDN, and the snapshot
 * is read from a temp file, so every URI in it has to become absolute.
 */
export function buildLiveSnapshot(playlistText: string, playlistUrl: string): LiveSnapshot {
  const lines = playlistText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (lines[0] !== '#EXTM3U') {
    throw new Error("Briefcase could not read this live stream's playlist (it is not HLS, or the server refused it)");
  }
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'))) {
    throw new Error('Expected a live media playlist but received a master playlist');
  }

  const toAbsolute = (uri: string): string => new URL(uri, playlistUrl).href;

  let segmentCount = 0;
  let durationSeconds = 0;
  const output = lines.map((line) => {
    if (!line.startsWith('#')) {
      segmentCount++;
      return toAbsolute(line);
    }
    if (line.startsWith('#EXTINF:')) {
      durationSeconds += parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
      return line.replace(/URI="([^"]+)"/, (_match, uri: string) => `URI="${toAbsolute(uri)}"`);
    }
    return line;
  });

  if (!output.includes('#EXT-X-ENDLIST')) {
    output.push('#EXT-X-ENDLIST');
  }

  return { playlist: `${output.join('\n')}\n`, segmentCount, durationSeconds };
}

/**
 * Drop a trailing date stamp from a live title when it is `today` (YYYY-MM-DD).
 * A permanent live room names each broadcast after the moment it was fetched
 * ("Alex Jones Live 2026-11-04 13:38"), and the file's date prefix already says
 * the day, so the name would otherwise carry it twice.
 */
export function withoutTodaysStamp(title: string, today: string): string {
  const match = title.match(/^(.*?)[\s\-–—|:,]*(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\s*$/);
  if (!match || match[2] !== today || !match[1].trim()) return title;
  return match[1].trim();
}

/** Refuse a window too short to be worth delivering. */
export function assertLiveWindow(durationSeconds: number): void {
  if (durationSeconds < MIN_LIVE_WINDOW_SECONDS) {
    throw new Error(
      `This live stream keeps no history (only ${Math.round(durationSeconds)} seconds are available), ` +
      'so there is nothing to pull yet. Try again after the broadcast ends.',
    );
  }
}
