/**
 * LIBRARY SEARCH: the one search behind the library's search box (the user,
 * 2026-10-09, replacing the years-old video-level FTS search: "if we need to
 * rip the whole thing out and replace it we can").
 *
 * By default a query is matched against file names only, ignoring word
 * breaks (filename-match.ts; the user, 2026-10-17: "i name files in such a
 * way that i should be able to find them easily by a few keywords"). Deep
 * search adds what is said, with the same syntax:
 *   transcripts  the moments where it is said, with near spellings and
 *                compounds (transcript-moments.ts)
 *   meaning      the moments that mean it (meaning-search.ts)
 *
 * The user, 2026-11-23, could not find a clip with Deep search on: Hank
 * Kunneman (in its file name) on people calling for "resignations" and
 * "accountability" (said), calling himself a "five fold" prophet
 * (transcribed "fivefold"); the transcription had also misheard
 * "resignations". Every word had to be in the name, or all in one stretch of
 * speech, so it never came up. Deep search now lists, in this order:
 *   1. names that hold the whole query, closest first (FilenameRank)
 *   2. with 3 or more words, the CLOSEST matches, whatever words they lack
 *      (closestMatches)
 *   3. names that hold some of it, where the transcript says the rest
 *      within one window (about 30 s)
 *   4. videos that say all of it within one window, best first; then
 *      videos found only by meaning
 *   5. with 3 or more words, PARTIAL matches: videos whose name and one
 *      window together hold most of the telling words (those not said nearly
 *      everywhere), the most first; misheard or misremembered words then
 *      still leave the clip findable
 *
 * The closest matches came on 2026-11-25: "trump never have to vote again"
 * did not list the clip of Trump saying "in four years you don't have to vote
 * again" at all. Only that clip says "have to vote again", but it lacks
 * "never", so videos that scatter all six words over 30 s came first and the
 * cap on partial matches dropped it. Holding every word is weak evidence when
 * the words are ordinary; saying them side by side is strong.
 * Everything is local SQLite.
 */
import type { Database } from 'better-sqlite3';

import { filenameExcluded, filenameGroupHighlights, filenameGroups, filenameQueryOf, matchFilename, type FilenameQuery, type FilenameRank } from './filename-match';
import { parseMomentQuery, type ParsedMomentQuery } from './moment-query';
import { meaningIndexCounts, searchLibraryMeaning } from './meaning-search';
import {
  findMomentWindows,
  groupWindows,
  momentsOf,
  pairWindows,
  spellerFor,
  windowCount,
  windowCountsByVideo,
  windowsById,
  windowsByVideo,
  windowsHolding,
  windowsOfVideos,
  type GroupWindows,
  type Moment,
  type MomentWindow,
} from './transcript-moments';

/** A file name as the library shows it: without its extension. */
export function titleOf(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

export interface LibraryHit {
  videoId: string;
  /** The title as shown, and the ranges of it that matched; empty when only the transcript did. */
  title: string;
  titleHighlights: Array<[number, number]>;
  /** How well the file name matched (filename-match.ts), 0 best; absent unless it holds the whole query. */
  titleRank?: FilenameRank;
  /** In time order, at most the per-video cap. */
  moments: Moment[];
  /** Moments that matched in all, before the cap. */
  momentCount: number;
  /**
   * A partial match (Deep search, 3 or more words): how many of the query's
   * telling words the name and one window hold together, of how many there
   * are. Absent when the video holds the whole query (or was found by meaning).
   */
  partial?: { found: number; of: number };
  /** One of the closest matches (Deep search, 3 or more words): its place among them, from 0. */
  closest?: number;
}

export interface LibrarySearchResult {
  hits: LibraryHit[];
  /** Moments across all videos, before the per-video cap. */
  momentCount: number;
  /** More transcript windows matched than were read: momentCount is a floor. */
  capped: boolean;
  /** The words each plain query word also matched (near spellings, compounds; a spelling with a space is a phrase). */
  spellings: Record<string, string[]>;
  /** With Deep search: the transcripts searched by meaning, of those there are (the index fills in the background). */
  meaning?: { indexed: number; total: number };
}

export interface LibrarySearchOptions {
  /** Deep search: also near spellings and compounds of the words in the transcripts (default true). */
  fuzzy?: boolean;
  /** Most videos returned (default 300). */
  maxVideos?: number;
  /**
   * Deep search: also the transcripts, where it is said. Off, only file names
   * are matched and the transcripts are not read at all.
   */
  deep?: boolean;
  /**
   * Deep search: the query embedded by the meaning model (unit length).
   * Meaning moments (meaning-search.ts) join the word results: added under a
   * video that matched by name or words where they do not overlap its
   * moments, and videos found only by meaning listed after, best first.
   * Ignored without `deep`.
   */
  meaningQuery?: Float32Array;
}

/** Partial matches are looked for in queries of this many parts or more. */
export const PARTIAL_MIN_GROUPS = 3;
/**
 * A part said in more than this share of the library's windows ("the",
 * "and", "people") is not a telling word: it neither counts towards a partial
 * match nor is read for one (it would cost the most). "trump" (6% of the
 * clips library's windows) still tells; "god" (17%) does not.
 */
export const COMMON_SHARE = 0.1;
/** The most partial matches listed. */
export const MAX_PARTIAL_VIDEOS = 100;
/** The most closest matches listed, and the least score (of the best one's) to be one. */
export const MAX_CLOSEST_VIDEOS = 10;
export const CLOSEST_SHARE = 0.5;
/**
 * What the closest-match score counts, as shares of a word's weight (its
 * rarity). Measured on the clips library (2026-11-25): 1,500 half-remembered
 * searches made from real names and transcripts, the weights chosen on one
 * half and checked on the other.
 *   NAME_WEIGHT       a word the name holds: names are written to be found
 *   PAIR_WEIGHT       two words said side by side as typed (the pair's rarity)
 *   ELSEWHERE_WEIGHT  a word said in the video, outside its best window
 */
export const NAME_WEIGHT = 1.5;
export const PAIR_WEIGHT = 0.6;
export const ELSEWHERE_WEIGHT = 0.5;

/** A video's name against the query: which parts it holds, and its match when it holds them all. */
interface NameParts {
  videoId: string;
  title: string;
  downloaded: string;
  held: boolean[];
  match: ReturnType<typeof matchFilename>;
}

const byName = (a: { match: NonNullable<NameParts['match']>; downloaded: string; title: string }, b: typeof a) =>
  a.match.rank - b.match.rank || b.downloaded.localeCompare(a.downloaded) || a.title.localeCompare(b.title);

function videoNames(db: Database) {
  return db.prepare('SELECT id, filename, download_date FROM videos').all() as Array<{ id: string; filename: string; download_date: string | null }>;
}

/** Videos by file name, best match first and then newest download first. */
function matchTitles(db: Database, query: FilenameQuery) {
  return videoNames(db)
    .flatMap((v) => {
      const title = titleOf(v.filename);
      const match = matchFilename(title, query);
      return match ? [{ videoId: v.id, title, downloaded: v.download_date ?? '', match }] : [];
    })
    .sort(byName);
}

/** Every video whose name holds some part of the query (and no excluded one), with what it holds. */
function nameParts(db: Database, query: FilenameQuery): Map<string, NameParts> {
  const out = new Map<string, NameParts>();
  for (const v of videoNames(db)) {
    const title = titleOf(v.filename);
    const held = filenameGroups(title, query);
    if (!held) continue;
    out.set(v.id, { videoId: v.id, title, downloaded: v.download_date ?? '', held, match: held.every(Boolean) ? matchFilename(title, query) : null });
  }
  return out;
}

const countOf = (held: readonly boolean[]) => held.reduce((n, h) => n + (h ? 1 : 0), 0);

export function searchLibrary(db: Database, query: string, options: LibrarySearchOptions = {}): LibrarySearchResult {
  const parsed = parseMomentQuery(query);
  const nameQuery = filenameQueryOf(parsed);
  if (nameQuery.groups.length === 0) return { hits: [], momentCount: 0, capped: false, spellings: {} };
  const maxVideos = options.maxVideos ?? 300;

  if (!options.deep) {
    const hits = matchTitles(db, nameQuery).slice(0, maxVideos).map((v): LibraryHit => ({
      videoId: v.videoId,
      title: v.title,
      titleHighlights: v.match.highlights,
      titleRank: v.match.rank,
      moments: [],
      momentCount: 0,
    }));
    return { hits, momentCount: 0, capped: false, spellings: {} };
  }

  const { spell, spellings } = spellerFor(db, options.fuzzy ?? true, parsed);
  const names = nameParts(db, nameQuery);
  const found = findMomentWindows(db, parsed, spell);
  const windowsOf = new Map(found.ranked.map((r) => [r.videoId, r.windows]));
  /** Windows matched per video (moments before the cap), for the total. */
  const momentsPer = new Map(found.ranked.map((r) => [r.videoId, r.windows.length]));

  // 1. The whole query in the name (best match, then most spoken).
  const named = [...names.values()]
    .flatMap((v) => (v.match ? [{ ...v, match: v.match, windows: windowsOf.get(v.videoId) ?? [] }] : []))
    .sort((a, b) => a.match.rank - b.match.rank || b.windows.length - a.windows.length || byName(a, b));
  const listed = new Set(named.map((v) => v.videoId));

  // Where each part is said, and which parts tell videos apart (not said nearly everywhere).
  // Read only when a name holds part of the query or there are enough parts for partial matches.
  const total = windowCount(db);
  const someNamed = [...names.values()].some((v) => !v.match);
  const said: GroupWindows | null =
    someNamed || parsed.groups.length >= PARTIAL_MIN_GROUPS ? groupWindows(db, parsed, spell, Math.floor(total * COMMON_SHARE)) : null;
  const telling = said ? said.windows.map((w) => w !== null) : [];

  // 3. Some of it in the name, the rest said in one window: one search per set of parts the names lack.
  // A name holding only common parts ("for" is in "before") says nothing about the video.
  const lacking = new Map<string, NameParts[]>();
  for (const v of names.values()) {
    if (v.match || !v.held.some((h, g) => h && telling[g])) continue;
    const key = v.held.map((h) => (h ? '1' : '0')).join('');
    lacking.set(key, [...(lacking.get(key) ?? []), v]);
  }
  const mixed: Array<NameParts & { windows: MomentWindow[] }> = [];
  for (const group of lacking.values()) {
    const held = group[0].held;
    const rest: ParsedMomentQuery = { groups: parsed.groups.filter((_, g) => !held[g]), excluded: parsed.excluded };
    const videoIds = group.map((v) => v.videoId);
    // The windows saying every telling part the names lack are known: those that also say the rest are read off
    // their words. Only when every part lacked is common does the index have to be asked.
    const known = said!.windows.filter((ids, g): ids is Set<number> => !held[g] && ids !== null);
    const restSaid = known.length
      ? windowsByVideo(windowsHolding(db, windowsOfVideos(db, videoIds).filter((w) => known.every((ids) => ids.has(w.id))), rest, spell))
      : new Map(findMomentWindows(db, rest, spell, videoIds).ranked.map((r) => [r.videoId, r.windows]));
    for (const [videoId, windows] of restSaid) {
      mixed.push({ ...names.get(videoId)!, windows });
      momentsPer.set(videoId, windows.length);
    }
  }
  // Most of the query in the name first, then most said (the two ways of finding the rest score differently).
  mixed.sort((a, b) => countOf(b.held) - countOf(a.held) || b.windows.length - a.windows.length || b.downloaded.localeCompare(a.downloaded));
  for (const v of mixed) listed.add(v.videoId);

  // 4. All of it said in one window.
  const filenameOf = db.prepare('SELECT filename FROM videos WHERE id = ?');
  const spoken = found.ranked
    .filter((r) => !listed.has(r.videoId))
    .slice(0, Math.max(0, maxVideos - named.length - mixed.length))
    .flatMap((r) => {
      const row = filenameOf.get(r.videoId) as { filename: string } | undefined;
      return row ? [{ videoId: r.videoId, title: titleOf(row.filename), windows: r.windows }] : [];
    });
  // Past the cap or not, a video that says it all is no partial match.
  for (const r of found.ranked) listed.add(r.videoId);

  const hit = (v: { videoId: string; title: string; windows: MomentWindow[] }, focus?: boolean[]): LibraryHit => ({
    videoId: v.videoId,
    title: v.title,
    titleHighlights: [],
    moments: momentsOf(db, v.windows, parsed, spell, focus),
    momentCount: v.windows.length,
  });
  const hits: LibraryHit[] = [
    ...named.slice(0, maxVideos).map((v) => ({ ...hit(v), titleHighlights: v.match.highlights, titleRank: v.match.rank })),
    ...mixed.slice(0, Math.max(0, maxVideos - named.length)).map((v) => ({
      ...hit(v, v.held.map((h) => !h)),
      titleHighlights: filenameGroupHighlights(v.title, nameQuery, v.held),
    })),
    ...spoken.map((v) => hit(v)),
  ];
  const byId = new Map(hits.map((h) => [h.videoId, h]));

  // 5. Partial matches, kept aside until meaning has had its say (a video found by meaning is not partial).
  const partial = said && parsed.groups.length >= PARTIAL_MIN_GROUPS ? partialMatches(db, parsed, spell, said, total, nameQuery, names, listed) : [];
  const partialIds = new Set(partial.map((p) => p.videoId));

  let meaningMoments = 0;
  if (options.meaningQuery) {
    const meaning = searchLibraryMeaning(db, options.meaningQuery);
    const partialOf = new Map(partial.map((p) => [p.videoId, p]));
    for (const v of meaning.videos) {
      const existing = byId.get(v.videoId) ?? partialOf.get(v.videoId);
      if (existing) {
        if (partialIds.delete(v.videoId)) {
          // Meant as well as partly said: listed with the videos found by meaning.
          delete existing.partial;
          hits.push(existing);
          byId.set(existing.videoId, existing);
          momentsPer.set(existing.videoId, existing.momentCount);
        }
        const fresh = v.moments.filter((m) => existing.moments.every((w) => m.end <= w.start || m.start >= w.end));
        existing.moments = [...existing.moments, ...fresh].sort((a, b) => a.start - b.start);
        existing.momentCount += fresh.length;
        meaningMoments += fresh.length;
        continue;
      }
      if (hits.length >= maxVideos) continue;
      const row = filenameOf.get(v.videoId) as { filename: string } | undefined;
      if (!row) continue;
      const added: LibraryHit = { videoId: v.videoId, title: titleOf(row.filename), titleHighlights: [], moments: v.moments, momentCount: v.moments.length };
      hits.push(added);
      byId.set(v.videoId, added);
      meaningMoments += v.moments.length;
    }
  }

  // 2. The closest, wherever they would have listed; their best stretch is among their moments.
  const closest = said && parsed.groups.length >= PARTIAL_MIN_GROUPS ? closestMatches(db, parsed, said, total, names) : [];
  const first: LibraryHit[] = [];
  const partialById = new Map(partial.map((p) => [p.videoId, p]));
  for (const c of closest) {
    const row = filenameOf.get(c.videoId) as { filename: string } | undefined;
    if (!row) continue;
    const title = titleOf(row.filename);
    if (filenameExcluded(title, nameQuery)) continue;
    const held = names.get(c.videoId)?.held;
    const existing: LibraryHit = byId.get(c.videoId) ?? partialById.get(c.videoId) ?? {
      videoId: c.videoId,
      title,
      titleHighlights: held ? filenameGroupHighlights(title, nameQuery, held) : [],
      moments: [],
      momentCount: 0,
      ...(listed.has(c.videoId) ? {} : { partial: { found: c.found, of: countOf(telling) } }),
    };
    partialIds.delete(c.videoId);
    if (c.window) {
      const whole = !existing.partial && parsed.groups.every((_, g) => c.says[g] || held?.[g]);
      const [moment] = momentsOf(db, [c.window], parsed, spell, c.says.some(Boolean) ? c.says : undefined);
      if (existing.moments.every((m) => moment.end <= m.start || moment.start >= m.end)) {
        existing.moments = [...existing.moments, whole ? moment : { ...moment, partial: true }].sort((a, b) => a.start - b.start);
        existing.momentCount += 1;
        momentsPer.set(c.videoId, existing.momentCount);
      }
    }
    existing.closest = first.length;
    first.push(existing);
  }
  const ordered = [
    ...hits.filter((h) => h.titleRank !== undefined),
    ...first,
    ...hits.filter((h) => h.titleRank === undefined && h.closest === undefined),
    ...partial.filter((p) => partialIds.has(p.videoId)),
  ].slice(0, maxVideos);
  for (const h of ordered) if (h.partial && !momentsPer.has(h.videoId)) momentsPer.set(h.videoId, h.momentCount);

  let momentCount = meaningMoments;
  for (const n of momentsPer.values()) momentCount += n;
  return {
    hits: ordered,
    momentCount,
    capped: found.capped,
    spellings,
    ...(options.meaningQuery ? { meaning: meaningIndexCounts(db) } : {}),
  };
}

/** How much a word or pair said in `count` of `total` windows tells: its rarity. */
const rarity = (total: number, count: number) => Math.log((total + 1) / (count + 1));

/** A video by how close its name and speech come to the query. */
interface Closest {
  videoId: string;
  /** Telling words its name and best window hold. */
  found: number;
  /** The window that comes closest, and the parts it says; null when only the name does. */
  window: MomentWindow | null;
  says: boolean[];
}

/**
 * The videos that come closest to the query, whichever of its words they
 * lack. A video scores by its best window: each telling word the name or the
 * window holds, by its rarity; each two words said side by side as typed, by
 * the pair's; and, for less, words said elsewhere in the video, by how
 * unlikely that is in a video so long (a four-hour stream says most words
 * somewhere, a one-minute clip does not). Names that hold the whole query are
 * left out: they list before these.
 */
function closestMatches(
  db: Database,
  parsed: ParsedMomentQuery,
  said: GroupWindows,
  total: number,
  names: ReadonlyMap<string, NameParts>,
): Closest[] {
  const weight = said.windows.map((ids, g) => (ids ? rarity(total, said.counts[g]) : 0));
  const none = parsed.groups.map(() => false);

  // What each window says: the telling parts, and the pairs' weight.
  const inWindow = new Map<number, { says: number[]; pairs: number }>();
  const at = (id: number) => {
    let w = inWindow.get(id);
    if (!w) inWindow.set(id, (w = { says: [], pairs: 0 }));
    return w;
  };
  said.windows.forEach((ids, g) => {
    for (const id of ids ?? []) at(id).says.push(g);
  });
  for (const pair of pairWindows(db, parsed, Math.floor(total * COMMON_SHARE))) {
    const w = PAIR_WEIGHT * rarity(total, pair.count);
    for (const id of pair.ids) at(id).pairs += w;
  }
  for (const id of said.excluded) inWindow.delete(id);

  // Each video's telling words in its name, what it says anywhere, and its best window.
  interface Scored { named: boolean[]; nameScore: number; anywhere: boolean[]; score: number; pairs: number; says: number[]; window: MomentWindow | null }
  const best = new Map<string, Scored>();
  const start = (named: boolean[]): Scored => {
    const nameScore = named.reduce((sum, h, g) => sum + (h ? NAME_WEIGHT * weight[g] : 0), 0);
    return { named, nameScore, anywhere: [...none], score: nameScore, pairs: 0, says: [], window: null };
  };
  for (const v of names.values()) {
    if (v.match) continue;
    const named = v.held.map((h, g) => h && weight[g] > 0);
    if (named.some(Boolean)) best.set(v.videoId, start(named));
  }
  for (const window of windowsById(db, [...inWindow.keys()])) {
    let video = best.get(window.videoId);
    if (!video) {
      if (names.get(window.videoId)?.match) continue;
      best.set(window.videoId, (video = start(none)));
    }
    const { says, pairs } = inWindow.get(window.id)!;
    let score = video.nameScore + pairs;
    for (const g of says) {
      video.anywhere[g] = true;
      if (!video.named[g]) score += weight[g];
    }
    if (video.window && video.score >= score) continue;
    Object.assign(video, { score, pairs, says, window });
  }

  const lengths = windowCountsByVideo(db);
  const scored = [...best.entries()].map(([videoId, v]) => {
    const says = [...none];
    for (const g of v.says) says[g] = true;
    const held = says.map((s, g) => s || v.named[g]);
    let score = v.score;
    v.anywhere.forEach((s, g) => {
      if (!s || held[g]) return;
      const chance = 1 - Math.pow(1 - Math.exp(-weight[g]), lengths.get(videoId) ?? 1);
      score -= ELSEWHERE_WEIGHT * Math.log(chance);
    });
    return { videoId, score, found: countOf(held), pairs: v.pairs, window: v.window, says };
  });
  // One word alone is not close to three.
  const close = scored.filter((v) => v.found >= 2 || v.pairs > 0).sort((a, b) => b.score - a.score || (a.videoId < b.videoId ? -1 : 1));
  return close.filter((v) => v.score >= CLOSEST_SHARE * close[0].score).slice(0, MAX_CLOSEST_VIDEOS);
}

/**
 * Videos not already listed whose name and one window together hold most of
 * the query's telling words: more than half of them, and at least two. Most
 * found first, then the rarer words found (a word said in few windows tells
 * more), then the newest download.
 */
function partialMatches(
  db: Database,
  parsed: ParsedMomentQuery,
  spell: (term: string) => string[],
  said: GroupWindows,
  total: number,
  nameQuery: FilenameQuery,
  names: ReadonlyMap<string, NameParts>,
  listed: ReadonlySet<string>,
): LibraryHit[] {
  const telling = parsed.groups.map((_, g) => said.windows[g] !== null);
  const of = countOf(telling);
  // More than half: "kenneth copeland private jet" does not list every video named for Kenneth Copeland.
  const need = Math.max(2, Math.floor(of / 2) + 1);
  if (of < need) return [];
  const weight = said.counts.map((n) => rarity(total, n));

  // The telling groups each window says.
  const saysOf = new Map<number, number[]>();
  said.windows.forEach((ids, g) => {
    for (const id of ids ?? []) {
      if (said.excluded.has(id)) continue;
      const list = saysOf.get(id);
      if (list) list.push(g);
      else saysOf.set(id, [g]);
    }
  });

  // Each video's best: the most telling groups its name and one window hold, and the windows that do.
  interface Best { held: boolean[]; found: number; weight: number; windows: MomentWindow[]; focus: boolean[] }
  const best = new Map<string, Best>();
  const nameHeld = (videoId: string) => names.get(videoId)?.held.map((h, g) => h && telling[g]) ?? telling.map(() => false);
  const consider = (videoId: string, held: boolean[], window: MomentWindow | null, says: number[]) => {
    const found = countOf(held);
    if (found < need) return;
    const w = held.reduce((sum, h, g) => sum + (h ? weight[g] : 0), 0);
    const current = best.get(videoId);
    if (current && (current.found > found || (current.found === found && current.weight > w))) return;
    if (current && current.found === found && current.weight === w) {
      if (window) {
        current.windows.push(window);
        for (const g of says) current.focus[g] = true;
      }
      return;
    }
    const focus = parsed.groups.map(() => false);
    for (const g of says) focus[g] = true;
    best.set(videoId, { held, found, weight: w, windows: window ? [window] : [], focus });
  };
  for (const window of windowsById(db, [...saysOf.keys()])) {
    if (listed.has(window.videoId)) continue;
    const says = saysOf.get(window.id)!;
    const held = nameHeld(window.videoId);
    for (const g of says) held[g] = true;
    // Scored by its own words, so a video's moments list its best stretches first.
    consider(window.videoId, held, { ...window, score: says.reduce((sum, g) => sum + weight[g], 0) }, says);
  }
  for (const v of names.values()) {
    if (!listed.has(v.videoId)) consider(v.videoId, nameHeld(v.videoId), null, []);
  }

  const filenameOf = db.prepare('SELECT filename, download_date FROM videos WHERE id = ?');
  return [...best.entries()]
    .flatMap(([videoId, b]) => {
      const row = filenameOf.get(videoId) as { filename: string; download_date: string | null } | undefined;
      return row ? [{ videoId, b, title: titleOf(row.filename), downloaded: row.download_date ?? '' }] : [];
    })
    .sort((x, y) => y.b.found - x.b.found || y.b.weight - x.b.weight || y.downloaded.localeCompare(x.downloaded))
    .slice(0, MAX_PARTIAL_VIDEOS)
    .map(({ videoId, b, title }): LibraryHit => {
      const windows = windowsByVideo(b.windows).get(videoId) ?? [];
      const held = names.get(videoId)?.held;
      return {
        videoId,
        title,
        titleHighlights: held ? filenameGroupHighlights(title, nameQuery, held) : [],
        moments: momentsOf(db, windows, parsed, spell, b.focus).map((m) => ({ ...m, partial: true })),
        momentCount: windows.length,
        partial: { found: b.found, of },
      };
    });
}
