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
 *   2. names that hold some of it, where the transcript says the rest
 *      within one window (about 30 s)
 *   3. videos that say all of it within one window, best first; then
 *      videos found only by meaning
 *   4. with 3 or more words, PARTIAL matches: videos whose name and one
 *      window together hold most of the telling words (those not said nearly
 *      everywhere), the most first; misheard or misremembered words then
 *      still leave the clip findable
 * Everything is local SQLite.
 */
import type { Database } from 'better-sqlite3';

import { filenameGroupHighlights, filenameGroups, filenameQueryOf, matchFilename, type FilenameQuery, type FilenameRank } from './filename-match';
import { parseMomentQuery, type ParsedMomentQuery } from './moment-query';
import { meaningIndexCounts, searchLibraryMeaning } from './meaning-search';
import {
  findMomentWindows,
  groupWindows,
  momentsOf,
  spellerFor,
  windowCount,
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

  // 2. Some of it in the name, the rest said in one window: one search per set of parts the names lack.
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

  // 3. All of it said in one window.
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

  // 4. Partial matches, kept aside until meaning has had its say (a video found by meaning is not partial).
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
  for (const p of partial) {
    if (hits.length >= maxVideos) break;
    if (!partialIds.has(p.videoId)) continue;
    hits.push(p);
    momentsPer.set(p.videoId, p.momentCount);
  }

  let momentCount = meaningMoments;
  for (const n of momentsPer.values()) momentCount += n;
  return {
    hits,
    momentCount,
    capped: found.capped,
    spellings,
    ...(options.meaningQuery ? { meaning: meaningIndexCounts(db) } : {}),
  };
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
  const weight = said.counts.map((n) => Math.log((total + 1) / (n + 1)));

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
