/**
 * Scoring units and chunks for the snap flag ranker (plan §3.1, §3.3).
 *
 * UNITS are what the scorer asks about; SENTENCES (assembleSentences, the NLI
 * splitter, unchanged) are what the rest of the flag pipeline indexes: windows,
 * the verifier's passages and the stored sections all use sentence indices.
 * Every unit therefore records the inclusive sentence range it came from, and
 * every span maps back to whole sentences. A unit's times are its sentences'
 * times, which are whisper segment times; nothing is interpolated.
 *
 * DEVIATION (plan §3.1): the plan's run-on cap splits "at segment boundaries".
 * The ranker's input is the sentence list the verifier stage already has, not
 * the raw segments, so a run-on is split by word count instead, and each piece
 * keeps the times of the sentence(s) it lies in (never an interpolated time).
 * The pieces exist only to give the scorer shorter questions; the spans they
 * produce still resolve to whole sentences.
 */

import type { RankedSentence } from '../../analysis/nli-ranker.service';

export interface FlagUnit {
  index: number;
  text: string;
  /** Inclusive sentence-index range this unit covers. */
  sentenceFrom: number;
  sentenceTo: number;
  /** Segment times: sentences[sentenceFrom].start / sentences[sentenceTo].end. */
  start: number;
  end: number;
}

export interface UnitOptions {
  /** Sentences under this many words fold into the next one (ContentStudio min_words). */
  minWords?: number;
  /** A unit over this many words, or over maxSeconds with more than pieceWords words, is split. */
  maxWords?: number;
  maxSeconds?: number;
  /** Target words per piece when splitting a run-on. */
  pieceWords?: number;
}

export const DEFAULT_UNIT_OPTIONS: Required<UnitOptions> = {
  minWords: 4,
  maxWords: 60,
  maxSeconds: 30,
  pieceWords: 30,
};

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Fold short sentences forward, then cap run-ons. Pure.
 */
export function buildFlagUnits(sentences: RankedSentence[], options: UnitOptions = {}): FlagUnit[] {
  const o = { ...DEFAULT_UNIT_OPTIONS, ...options };

  // 1. Fold: accumulate sentences until the group reaches minWords.
  const groups: Array<{ from: number; to: number }> = [];
  let open: { from: number; to: number; words: number } | null = null;
  for (let i = 0; i < sentences.length; i++) {
    const n = wordsOf(sentences[i].text).length;
    if (!open) open = { from: i, to: i, words: n };
    else {
      open.to = i;
      open.words += n;
    }
    if (open.words >= o.minWords) {
      groups.push({ from: open.from, to: open.to });
      open = null;
    }
  }
  if (open) {
    // A short tail folds into the previous unit (there is no following one).
    if (groups.length) groups[groups.length - 1].to = open.to;
    else groups.push({ from: open.from, to: open.to });
  }

  // 2. Cap run-ons, splitting by words; each piece keeps its sentences' times.
  const units: FlagUnit[] = [];
  const push = (text: string, from: number, to: number) =>
    units.push({
      index: units.length,
      text,
      sentenceFrom: from,
      sentenceTo: to,
      start: sentences[from].start,
      end: sentences[to].end,
    });

  for (const g of groups) {
    const words: Array<{ w: string; s: number }> = [];
    for (let s = g.from; s <= g.to; s++) for (const w of wordsOf(sentences[s].text)) words.push({ w, s });
    const seconds = sentences[g.to].end - sentences[g.from].start;
    const tooLong = words.length > o.maxWords || (seconds > o.maxSeconds && words.length > o.pieceWords);
    if (!tooLong) {
      const text = sentences
        .slice(g.from, g.to + 1)
        .map((s) => s.text.trim())
        .join(' ');
      push(text, g.from, g.to);
      continue;
    }
    const pieces = Math.ceil(words.length / o.pieceWords);
    const size = Math.ceil(words.length / pieces);
    for (let k = 0; k < words.length; k += size) {
      const slice = words.slice(k, k + size);
      push(slice.map((x) => x.w).join(' '), slice[0].s, slice[slice.length - 1].s);
    }
  }
  return units;
}

// --------------------------------------------------------------------------- chunks

export interface FlagChunk {
  /** Units this chunk OWNS (scored here and nowhere else): [coreFrom, coreTo). */
  coreFrom: number;
  coreTo: number;
  /** Units in the chunk's state (core plus overlap context): [contextFrom, contextTo). */
  contextFrom: number;
  contextTo: number;
}

export interface ChunkOptions {
  /** A transcript at or under this many tokens is one chunk. */
  singleChunkMaxTokens?: number;
  /** Otherwise: equal cores of at most this many tokens... */
  coreMaxTokens?: number;
  /** ...each with this much overlap context on either side. */
  overlapTokens?: number;
  /**
   * Token count of one unit's text (plus its joining newline). Default is a
   * chars/3.6 estimate; integration should pass real /tokenize counts
   * (plan §3.3), which this module cannot fetch without the engine.
   */
  tokensOf?: (text: string) => number;
}

export const DEFAULT_CHUNK_OPTIONS = {
  singleChunkMaxTokens: 16_000,
  coreMaxTokens: 12_000,
  overlapTokens: 2_000,
};

export function estimateTokens(text: string): number {
  return Math.ceil((text.length + 1) / 3.6);
}

/**
 * Plan §3.3: one chunk up to 16k tokens; beyond that, equal cores of <= 12k
 * with 2k of context on each side. Every unit is owned by exactly one core.
 */
export function planFlagChunks(units: FlagUnit[], options: ChunkOptions = {}): FlagChunk[] {
  const n = units.length;
  if (n === 0) return [];
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const tokensOf = options.tokensOf ?? estimateTokens;
  const tok = units.map((u) => tokensOf(u.text));
  const total = tok.reduce((a, b) => a + b, 0);
  if (total <= o.singleChunkMaxTokens) return [{ coreFrom: 0, coreTo: n, contextFrom: 0, contextTo: n }];

  const cores = Math.ceil(total / o.coreMaxTokens);
  const target = total / cores;
  const bounds: Array<[number, number]> = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += tok[i];
    const remainingCores = cores - bounds.length - 1;
    if (acc >= target && remainingCores > 0 && n - (i + 1) >= remainingCores) {
      bounds.push([from, i + 1]);
      from = i + 1;
      acc = 0;
    }
  }
  bounds.push([from, n]);

  return bounds.map(([a, b]) => {
    let lo = a;
    let t = 0;
    while (lo > 0 && t + tok[lo - 1] <= o.overlapTokens) t += tok[--lo];
    let hi = b;
    t = 0;
    while (hi < n && t + tok[hi] <= o.overlapTokens) t += tok[hi++];
    return { coreFrom: a, coreTo: b, contextFrom: lo, contextTo: hi };
  });
}
