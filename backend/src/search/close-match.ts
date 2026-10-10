/**
 * CLOSE MATCH: find where a transcript says something CLOSE to what was typed.
 * Pure (no Node, no DB): the backend and Scout (the frontend's video viewer,
 * via the @search alias) run the same code.
 *
 * The user, 2026-10-10: "im usually trying to find something close to what it
 * said. 'black lives matter is demon spawns from satan', when really what it
 * said is 'black lives matter are demon spawns from hell' ... i dont want to
 * get hung up on spelling. and i want to be able to search for full phrases or
 * just individual words."
 *
 * So instead of every word being required, each stretch of speech is SCORED:
 *   - every query word that appears in it counts (its near spellings and, for
 *     3+ letters, the words it starts count too: moment-query.ts);
 *   - small words ("is", "from") count a quarter, so one wrong small word
 *     does not sink a quote;
 *   - words in the query's order score a little higher than the same words
 *     scattered;
 *   - a quoted "phrase" must be there exactly; a -word must not.
 * A single word lists every place it is said, in time order. Several words
 * list the closest stretches first; one that holds too little of the query
 * (under MIN_SCORE of its weight, or only one of its bigger words) is left out.
 */
import {
  buildVocabulary,
  nearSpellings,
  parseMomentQuery,
  tokenize,
  type QueryTerm,
  type TextToken,
} from './moment-query';

export interface CloseMatchSegment {
  start: number;
  end: number;
  text: string;
}

export interface CloseMatchHit {
  /** The segment the match starts in, and the one it ends in. */
  first: number;
  last: number;
  /** Where to play from (the first segment's start). */
  start: number;
  /** 0..1: the share of the query's weight found, nudged by word order. */
  score: number;
  /** [segment index, start, end) character ranges that matched, for highlighting. */
  highlights: Array<[number, number, number]>;
}

/** Below this share of the query's weight a stretch is not a match. */
export const MIN_SCORE = 0.6;

/** Small words that carry little of a quote. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'for', 'from', 'had', 'has', 'have', 'he', 'her',
  'him', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 's', 'she', 'so', 't',
  'that', 'the', 'their', 'them', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will',
  'with', 'you', 'your',
]);
const SMALL_WEIGHT = 0.25;

interface Unit {
  /** Any of these terms matches the unit (an OR group). */
  terms: QueryTerm[];
  weight: number;
  /** A quoted phrase: the stretch must hold it. */
  required: boolean;
}

interface Token extends TextToken {
  segment: number;
}

/** Find the closest stretches of `segments` to `query`, best first (a single word: in time order). */
export function closeMatches(segments: readonly CloseMatchSegment[], query: string): CloseMatchHit[] {
  const parsed = parseMomentQuery(query);
  if (parsed.groups.length === 0) return [];

  const tokens: Token[] = [];
  segments.forEach((s, segment) => {
    for (const t of tokenize(s.text)) tokens.push({ ...t, segment });
  });
  if (tokens.length === 0) return [];

  // Near spellings come from this transcript's own words (a word it rarely or never says is widened).
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.term, (counts.get(t.term) ?? 0) + 1);
  const vocab = buildVocabulary([...counts].map(([term, docs]) => ({ term, docs })));
  const spellings = new Map<string, Set<string>>();
  const spell = (term: string) => {
    let set = spellings.get(term);
    if (!set) spellings.set(term, (set = new Set(nearSpellings(term, vocab))));
    return set;
  };

  const units: Unit[] = parsed.groups.map((group) => {
    const required = group.length === 1 && group[0].kind === 'phrase';
    const small = group.every((t) => t.kind === 'word' && SMALL_WORDS.has(t.term));
    const weight = required ? (group[0] as { terms: string[] }).terms.length : small ? SMALL_WEIGHT : 1;
    return { terms: group, weight, required };
  });
  const totalWeight = units.reduce((s, u) => s + u.weight, 0);
  const bigUnits = units.filter((u) => u.weight >= 1).length;

  /**
   * Whether a term matches at token i: how many tokens it covers, and how good
   * the match is (the word itself 1, a word it starts 0.9, a near spelling
   * 0.85), so an exact word wins over a near one close by.
   */
  const termAt = (term: QueryTerm, i: number): { length: number; quality: number } | null => {
    if (term.kind === 'phrase') {
      if (i + term.terms.length > tokens.length) return null;
      return term.terms.every((w, k) => tokens[i + k].term === w) ? { length: term.terms.length, quality: 1 } : null;
    }
    const word = tokens[i].term;
    if (term.kind === 'prefix') return word.startsWith(term.term) ? { length: 1, quality: 1 } : null;
    if (word === term.term) return { length: 1, quality: 1 };
    if (term.starts && word.startsWith(term.term)) return { length: 1, quality: 0.9 };
    if (spell(term.term).has(word)) return { length: 1, quality: 0.85 };
    return null;
  };
  const unitAt = (u: Unit, i: number): { length: number; quality: number } | null => {
    let best: { length: number; quality: number } | null = null;
    for (const term of u.terms) {
      const m = termAt(term, i);
      if (m && (!best || m.quality > best.quality)) best = m;
    }
    return best;
  };
  const excludedAt = (i: number): boolean => parsed.excluded.some((term) => termAt(term, i) !== null);

  // Each token, the units that match there (how many tokens they cover, and how well).
  const matchesAt: Array<Array<{ unit: number; length: number; quality: number }>> = tokens.map((_, i) =>
    units.flatMap((u, unit) => {
      const m = unitAt(u, i);
      return m ? [{ unit, ...m }] : [];
    }),
  );

  // A stretch is as long as the query, with room for words said differently.
  const span = Math.max(12, Math.ceil(units.reduce((s, u) => s + (u.required ? u.weight : 1), 0) * 2.5));
  const candidates: Array<{ from: number; to: number; score: number }> = [];
  for (let a = 0; a < tokens.length; a++) {
    if (matchesAt[a].length === 0) continue;
    const to = Math.min(tokens.length, a + span);
    // Each unit's best match in the stretch (the earliest of equally good ones).
    const best = new Map<number, { at: number; length: number; quality: number }>();
    let excluded = false;
    for (let i = a; i < to; i++) {
      if (excludedAt(i)) excluded = true;
      for (const m of matchesAt[i]) {
        const prev = best.get(m.unit);
        if (!prev || m.quality > prev.quality) best.set(m.unit, { at: i, length: m.length, quality: m.quality });
      }
    }
    if (excluded) continue;
    const firstPos = new Map([...best].map(([unit, m]) => [unit, m.at]));
    const from = Math.min(...[...best.values()].map((m) => m.at));
    const last = Math.max(...[...best.values()].map((m) => m.at + m.length - 1));
    if (units.some((u, k) => u.required && !firstPos.has(k))) continue;
    const found = units.reduce((s, u, k) => s + (best.has(k) ? u.weight * best.get(k)!.quality : 0), 0);
    const bigFound = units.filter((u, k) => u.weight >= 1 && firstPos.has(k)).length;
    if (bigUnits > 1 && bigFound < 2) continue;
    // Order: the longest run of found units in the query's own order.
    const order = [...firstPos.entries()].sort((x, y) => x[1] - y[1]).map(([unit]) => unit);
    const lis: number[] = [];
    for (const u of order) {
      let lo = 0, hi = lis.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (lis[mid] < u) lo = mid + 1; else hi = mid; }
      lis[lo] = u;
    }
    const coverage = found / totalWeight;
    if (units.length > 1 && coverage < MIN_SCORE) continue;
    const orderShare = order.length ? lis.length / order.length : 1;
    candidates.push({ from, to: last + 1, score: coverage * (0.85 + 0.15 * orderShare) });
  }

  // Best stretch first (then the tightest); an overlapping weaker one is the same place.
  candidates.sort((x, y) => y.score - x.score || (x.to - x.from) - (y.to - y.from) || x.from - y.from);
  const kept: typeof candidates = [];
  for (const c of candidates) if (kept.every((k) => c.to <= k.from || c.from >= k.to)) kept.push(c);

  const hits = kept.map((c): CloseMatchHit => {
    const highlights: Array<[number, number, number]> = [];
    for (let i = c.from; i < c.to; i++) {
      for (const m of matchesAt[i]) {
        const end = tokens[i + m.length - 1];
        if (end.segment === tokens[i].segment) highlights.push([tokens[i].segment, tokens[i].start, end.end]);
        else for (let k = 0; k < m.length; k++) highlights.push([tokens[i + k].segment, tokens[i + k].start, tokens[i + k].end]);
      }
    }
    const first = tokens[c.from].segment;
    return { first, last: tokens[c.to - 1].segment, start: segments[first].start, score: Math.round(c.score * 1000) / 1000, highlights };
  });
  // One word or one phrase: every place, in time order. Several: the closest first.
  if (units.length === 1) return hits.sort((x, y) => x.start - y.start);
  return hits.sort((x, y) => y.score - x.score || x.start - y.start);
}
