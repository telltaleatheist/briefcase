/**
 * yt-dlp format selectors for a quality target — pure functions, no I/O.
 *
 * A quality like "720" is a TARGET, not a hard limit: take the best rendition
 * at or under it, and when the site has nothing that small, take the best it
 * has rather than failing the download.
 *
 * "720p" names the SHORT side of the frame. For a landscape video that is the
 * height, but a vertical video (Facebook reels, YouTube Shorts, TikTok) is
 * 720x1280 at "720p" — a bare [height<=720] matched none of its renditions and
 * every vertical download failed with "Requested format is not available".
 * So each capped selector is tried twice: landscape/square formats by height,
 * then portrait formats by width. A video's renditions share an orientation, so
 * only one of the two branches ever matches. Formats with no known size fail
 * both filters and are reached only through the uncapped fallback.
 */

/** The cap filters for one selector: landscape by height, then portrait by width. */
function capFilters(cap: number): [string, string] {
  return [`[aspect_ratio>=?1][height<=${cap}]`, `[aspect_ratio<1][width<=${cap}]`];
}

export interface SelectorParts {
  /** Video-only selector with any extra filters, e.g. `bestvideo[ext=mp4]`. */
  video: string;
  /** Audio selector to merge with the video, e.g. `bestaudio[ext=m4a]`. */
  audio: string;
  /** Pre-muxed fallbacks, tried in order after the merged pair, e.g. `best[ext=mp4]`. */
  muxed: string[];
}

/**
 * The selector for a target `cap` (null = best available). Uncapped, it is the
 * plain `video+audio/muxed...` chain; capped, every element is tried at or under
 * the cap first (both orientations), then the uncapped chain as the fallback.
 */
export function buildFormatSelector(cap: number | null, parts: SelectorParts): string {
  const uncapped = [`${parts.video}+${parts.audio}`, ...parts.muxed];
  if (cap === null) return uncapped.join('/');

  const [landscape, portrait] = capFilters(cap);
  const capped = [
    `${parts.video}${landscape}+${parts.audio}`,
    `${parts.video}${portrait}+${parts.audio}`,
    ...parts.muxed.flatMap((muxed) => [`${muxed}${landscape}`, `${muxed}${portrait}`]),
  ];
  return [...capped, ...uncapped].join('/');
}

/** Split video+audio merged, falling back to a pre-muxed format — the common case. */
export function buildMergedFormatSelector(cap: number | null): string {
  return buildFormatSelector(cap, { video: 'bestvideo', audio: 'bestaudio', muxed: ['best'] });
}

/** One muxed rendition chosen from a list of single-format selectors (no merge). */
export function buildMuxedFormatSelector(cap: number | null, muxed: string): string {
  if (cap === null) return muxed;
  const [landscape, portrait] = capFilters(cap);
  return [`${muxed}${landscape}`, `${muxed}${portrait}`, muxed].join('/');
}
