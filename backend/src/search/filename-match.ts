/**
 * FILENAME MATCHING: the library search's default (the user, 2026-10-17: "i
 * name files in such a way that i should be able to find them easily by a few
 * keywords. like searching the term pastor props should turn up
 * pastorswithprops in the filename").
 *
 * Word breaks are ignored on both sides. A title and each part of the query
 * are folded the same way (lower case, accents removed, everything that is
 * not a letter or a digit dropped), and a part matches when it is a substring
 * of the folded title: "pastor props" finds "pastorswithprops", "Pastors With
 * Props" and "pastor_props" alike. The query syntax is moment-query.ts's, read
 * for names:
 *   word          a substring (so word* means the same)
 *   "a phrase"    the words run together, a substring
 *   a OR b        either
 *   -word         titles holding it are left out
 * A part the query repeats must appear that many times ("strike and strike"
 * needs two). Matches are ranked by how closely the title holds the query
 * (FilenameRank). No near spellings: a name is typed, not transcribed.
 *
 * A plain scan, no index: folding is the slow part (~10 ms for 6.8k names),
 * so the folded names are kept (foldedOf) and the full fold, with its way
 * back to the original, is made only for the names that match. A search of
 * the clips library (6.8k videos) then takes ~5 ms, most of it reading the names.
 */
import { foldTerm, type ParsedMomentQuery, type QueryTerm } from './moment-query';

/** A title folded for matching, with where each folded character came from. */
export interface FoldedName {
  folded: string;
  /** For each UTF-16 unit of `folded`: the [start, end) of the original character it came from. */
  starts: number[];
  ends: number[];
  /**
   * `breaks[i]`: a word break sits before folded unit i (length + 1 entries).
   * A break is the start or end, anything dropped (a space, punctuation), a
   * lower-to-upper case change ("PastorsWithProps") or a letter-digit change.
   */
  breaks: boolean[];
}

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;
const UPPER = /\p{Lu}/u;
const DIGIT = /\p{N}/u;

type Kind = 'lower' | 'upper' | 'digit';

/** Fold a name for matching, keeping the way back to the original string. */
export function foldName(text: string): FoldedName {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const breaks: boolean[] = [];
  let at = 0;
  let prev: Kind | null = null;
  let dropped = true;
  for (const ch of text) {
    const end = at + ch.length;
    const code = ch.charCodeAt(0);
    let out: string;
    let kind: Kind;
    if (code < 128) {
      // ASCII, the common case, without the Unicode work.
      if (code >= 65 && code <= 90) {
        out = String.fromCharCode(code + 32);
        kind = 'upper';
      } else if (code >= 97 && code <= 122) {
        out = ch;
        kind = 'lower';
      } else if (code >= 48 && code <= 57) {
        out = ch;
        kind = 'digit';
      } else {
        out = '';
        kind = 'lower';
      }
    } else {
      out = foldTerm(ch).replace(NOT_LETTER_OR_DIGIT, '');
      kind = UPPER.test(ch) ? 'upper' : DIGIT.test(ch) ? 'digit' : 'lower';
    }
    if (out.length === 0) {
      dropped = true;
    } else {
      const brk = dropped || prev === null
        || (kind === 'upper' && prev === 'lower')
        || ((kind === 'digit') !== (prev === 'digit'));
      for (let k = 0; k < out.length; k++) {
        starts.push(at);
        ends.push(end);
        breaks.push(k === 0 && brk);
      }
      folded += out;
      prev = kind;
      dropped = false;
    }
    at = end;
  }
  breaks.push(true);
  return { folded, starts, ends, breaks };
}

/** A parsed query as substrings: every group must have one in the title, no excluded one may. */
export interface FilenameQuery {
  groups: string[][];
  excluded: string[];
}

function needleOf(term: QueryTerm): string {
  const text = term.kind === 'phrase' ? term.terms.join('') : term.term;
  return foldName(text).folded;
}

export function filenameQueryOf(parsed: ParsedMomentQuery): FilenameQuery {
  const groups = parsed.groups
    .map((group) => group.map(needleOf).filter((n) => n.length > 0))
    .filter((group) => group.length > 0);
  const excluded = parsed.excluded.map(needleOf).filter((n) => n.length > 0);
  return { groups, excluded };
}

/**
 * How well a title matched, best first:
 *   0  the whole query, run together, appears as words ("strike and strike"
 *      in "Paula White - Strike And Strike")
 *   1  the whole query, run together, appears ("strikeandstrikeagain")
 *   2  every part appears as words, in the query's order
 *   3  every part appears somewhere
 * The library lists better ranks first, whatever it is sorted by.
 */
export type FilenameRank = 0 | 1 | 2 | 3;

export interface FilenameMatch {
  rank: FilenameRank;
  /** The [start, end) ranges of the title that matched, in order, merged. */
  highlights: Array<[number, number]>;
}

/** Non-overlapping occurrences of `needle` in `hay`. */
function countOf(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

const bounded = (name: FoldedName, i: number, len: number) => name.breaks[i] && name.breaks[i + len];

/**
 * The match of `title`, or null when it does not match: every group needs one
 * of its parts in the title, a part the query repeats ("strike and strike")
 * must appear that many times, and no excluded part may appear.
 */
export function matchFilename(title: string, query: FilenameQuery): FilenameMatch | null {
  if (query.groups.length === 0) return null;
  const hay = foldedOf(title);
  if (query.excluded.some((n) => hay.includes(n))) return null;

  // The part each group matched by (its first present one), in query order.
  const chosen: string[] = [];
  for (const group of query.groups) {
    const present = group.find((n) => hay.includes(n));
    if (present === undefined) return null;
    chosen.push(present);
  }
  const needed = new Map<string, number>();
  query.groups.forEach((group, g) => {
    if (group.length === 1) needed.set(chosen[g], (needed.get(chosen[g]) ?? 0) + 1);
  });
  for (const [needle, n] of needed) if (n > 1 && countOf(hay, needle) < n) return null;

  const name = foldName(title);
  return { rank: rankOf(name, chosen), highlights: highlightsOf(name, chosen) };
}

/** Folded names already made, by title; emptied when it outgrows any one library (renames leave old names behind). */
const folded = new Map<string, string>();
const MAX_FOLDED = 50_000;

function foldedOf(title: string): string {
  let f = folded.get(title);
  if (f === undefined) {
    if (folded.size >= MAX_FOLDED) folded.clear();
    f = foldName(title).folded;
    folded.set(title, f);
  }
  return f;
}

function rankOf(name: FoldedName, chosen: string[]): FilenameRank {
  const hay = name.folded;
  const whole = chosen.join('');
  let contiguous = false;
  for (let i = hay.indexOf(whole); i !== -1; i = hay.indexOf(whole, i + 1)) {
    if (bounded(name, i, whole.length)) return 0;
    contiguous = true;
  }
  if (contiguous) return 1;
  // Every part as words, in order: the earliest such place for each part, after the last.
  let from = 0;
  for (const needle of chosen) {
    let i = hay.indexOf(needle, from);
    while (i !== -1 && !bounded(name, i, needle.length)) i = hay.indexOf(needle, i + 1);
    if (i === -1) return 3;
    from = i + needle.length;
  }
  return 2;
}

/** Every place each part matched; where the whole query runs together, the whole run (the gaps too). */
function highlightsOf(name: FoldedName, chosen: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const needle of new Set([...chosen, chosen.join('')])) {
    for (let i = name.folded.indexOf(needle); i !== -1; i = name.folded.indexOf(needle, i + 1)) {
      ranges.push([name.starts[i], name.ends[i + needle.length - 1]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
