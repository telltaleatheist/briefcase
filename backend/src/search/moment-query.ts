/**
 * MOMENT SEARCH QUERIES: what the user typed, read into terms the transcript
 * window index can match, and the pieces of a moment's text that matched.
 *
 * The syntax is the library search's, kept small:
 *   word          the word, and (3+ letters) any word it starts, so the
 *                 search follows typing ("sha" finds "shane"); a word the
 *                 transcripts rarely or never hold also matches near
 *                 spellings (transcription slips: "somalies" finds
 *                 "somalis"); a word under 3 letters is exact
 *   "a phrase"    those words in that order, exactly
 *   word*         any word starting with it
 *   a OR b        either
 *   -word         windows holding it are left out
 * Every other term must appear in the same window (about 30 s of speech).
 *
 * Words are split and folded the way SQLite's unicode61 tokenizer (with
 * remove_diacritics 2) splits them, so a term found here is a term in the
 * index, and a highlight lands on the word the index matched.
 */

/** One word of text: its folded form and where it sits in the original string. */
export interface TextToken {
  term: string;
  start: number;
  end: number;
}

/** Fold a word the way the index does: lower case, accents removed. */
export function foldTerm(word: string): string {
  return word.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The words of `text` with their offsets, split as unicode61 splits them. */
export function tokenize(text: string): TextToken[] {
  const out: TextToken[] = [];
  const re = /[\p{L}\p{N}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const term = foldTerm(m[0]);
    if (term) out.push({ term, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** A matchable piece of the query. */
export type QueryTerm =
  /** `starts`: also any word this one starts (plain words of MIN_PREFIX_LETTERS or more). */
  | { kind: 'word'; term: string; starts?: boolean }
  | { kind: 'prefix'; term: string }
  | { kind: 'phrase'; terms: string[] };

export interface ParsedMomentQuery {
  /** Every group must match; a group matches when any of its terms does. */
  groups: QueryTerm[][];
  /** Windows holding any of these are left out (exact words and phrases). */
  excluded: QueryTerm[];
}

/** A plain word this long or longer also matches the words it starts. */
export const MIN_PREFIX_LETTERS = 3;

/** Read the query. An empty `groups` means there is nothing to search for. */
export function parseMomentQuery(query: string): ParsedMomentQuery {
  const groups: QueryTerm[][] = [];
  const excluded: QueryTerm[] = [];
  let joinNext = false;
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m[3] === 'OR') {
      joinNext = groups.length > 0;
      continue;
    }
    let negate = m[1] === '-';
    let term: QueryTerm | null;
    if (m[2] !== undefined) {
      const words = tokenize(m[2]).map((t) => t.term);
      term = words.length === 0 ? null : words.length === 1 ? { kind: 'word', term: words[0] } : { kind: 'phrase', terms: words };
      if (term?.kind === 'word' && !negate) term = { kind: 'phrase', terms: [term.term] };
    } else {
      let raw = m[3];
      if (raw.startsWith('-') && raw.length > 1) {
        negate = true;
        raw = raw.slice(1);
      }
      const prefix = raw.endsWith('*');
      const words = tokenize(raw).map((t) => t.term);
      if (words.length === 0) term = null;
      else if (words.length > 1) term = { kind: 'phrase', terms: words };
      else if (prefix) term = { kind: 'prefix', term: words[0] };
      else term = { kind: 'word', term: words[0], ...(!negate && [...words[0]].length >= MIN_PREFIX_LETTERS ? { starts: true } : {}) };
    }
    if (!term) {
      joinNext = false;
      continue;
    }
    if (negate) {
      excluded.push(term);
      joinNext = false;
      continue;
    }
    if (joinNext) groups[groups.length - 1].push(term);
    else groups.push([term]);
    joinNext = false;
  }
  return { groups, excluded };
}

// =============================================================================
// NEAR SPELLINGS
// =============================================================================

/** How far a word may be from an indexed word and still match it. */
export function allowedDistance(term: string): number {
  const n = [...term].length;
  if (n < 4) return 0;
  if (n < 8) return 1;
  return 2;
}

/** Levenshtein distance, or `max + 1` as soon as it is certainly over `max`. */
export function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > max) return max + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[y.length];
}

/** The index's words, for finding near spellings. */
export interface Vocabulary {
  /** Words by length, each with the number of windows holding it. */
  byLength: Map<number, Array<{ term: string; docs: number }>>;
  /** Windows holding each word. */
  docs: Map<string, number>;
}

export function buildVocabulary(rows: Iterable<{ term: string; docs: number }>): Vocabulary {
  const byLength = new Map<number, Array<{ term: string; docs: number }>>();
  const docs = new Map<string, number>();
  for (const row of rows) {
    const n = [...row.term].length;
    let list = byLength.get(n);
    if (!list) byLength.set(n, (list = []));
    list.push(row);
    docs.set(row.term, row.docs);
  }
  return { byLength, docs };
}

/**
 * A word the index holds in at least this many windows is taken as spelled
 * right and searched exactly. Widening is for slips, which are rare: on the
 * clips library "logan" (common) was widened to rogan, slogan and hogan,
 * while "somalies" (a slip) needs somalis and somali.
 */
export const WIDEN_BELOW_WINDOWS = 20;

/** The most near spellings one word may stand for (the commonest are kept). */
export const MAX_SPELLINGS = 12;

/**
 * The indexed words a typed word matches: itself, and, when the index holds
 * it rarely or not at all, words within its allowed distance, the commonest
 * first. The word itself is always kept, even
 * when the index does not hold it, so an exact search still reads as asked.
 */
export function nearSpellings(term: string, vocab: Vocabulary): string[] {
  const max = allowedDistance(term);
  if (max === 0 || (vocab.docs.get(term) ?? 0) >= WIDEN_BELOW_WINDOWS) return [term];
  const n = [...term].length;
  const found: Array<{ term: string; docs: number; d: number }> = [];
  for (let len = n - max; len <= n + max; len++) {
    for (const row of vocab.byLength.get(len) ?? []) {
      if (row.term === term) continue;
      const d = boundedDistance(term, row.term, max);
      if (d <= max) found.push({ ...row, d });
    }
  }
  found.sort((a, b) => a.d - b.d || b.docs - a.docs);
  return [term, ...found.slice(0, MAX_SPELLINGS - 1).map((f) => f.term)];
}

// =============================================================================
// THE FTS5 EXPRESSION
// =============================================================================

const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;

function expressionOf(term: QueryTerm, spell: (term: string) => string[]): string {
  if (term.kind === 'phrase') return quote(term.terms.join(' '));
  if (term.kind === 'prefix') return `${quote(term.term)}*`;
  const parts = spell(term.term).map(quote);
  if (term.starts) parts.push(`${quote(term.term)}*`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/**
 * The MATCH expression for a parsed query, with each plain word widened to
 * its near spellings by `spell` (pass `(t) => [t]` for exact words).
 */
export function matchExpression(query: ParsedMomentQuery, spell: (term: string) => string[]): string {
  const groups = query.groups.map((group) => {
    const parts = group.map((term) => expressionOf(term, spell));
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  });
  let expr = groups.join(' AND ');
  for (const term of query.excluded) expr += ` NOT ${expressionOf(term, (t) => [t])}`;
  return expr;
}

// =============================================================================
// WHAT MATCHED
// =============================================================================

/** What a moment's words are checked against: single words, prefixes and phrases. */
export interface Matcher {
  words: Set<string>;
  prefixes: string[];
  phrases: string[][];
}

export function matcherOf(query: ParsedMomentQuery, spell: (term: string) => string[]): Matcher {
  const words = new Set<string>();
  const prefixes: string[] = [];
  const phrases: string[][] = [];
  for (const group of query.groups) {
    for (const term of group) {
      if (term.kind === 'word') {
        for (const w of spell(term.term)) words.add(w);
        if (term.starts) prefixes.push(term.term);
      }
      else if (term.kind === 'prefix') prefixes.push(term.term);
      else phrases.push(term.terms);
    }
  }
  return { words, prefixes, phrases };
}

/** The [start, end) character ranges of `text` that matched, in order, merged. */
export function highlightRanges(text: string, matcher: Matcher): Array<[number, number]> {
  const tokens = tokenize(text);
  const ranges: Array<[number, number]> = [];
  tokens.forEach((t, i) => {
    if (matcher.words.has(t.term) || matcher.prefixes.some((p) => t.term.startsWith(p))) ranges.push([t.start, t.end]);
    for (const phrase of matcher.phrases) {
      if (i + phrase.length > tokens.length) continue;
      if (phrase.every((w, k) => tokens[i + k].term === w)) ranges.push([t.start, tokens[i + phrase.length - 1].end]);
    }
  });
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
