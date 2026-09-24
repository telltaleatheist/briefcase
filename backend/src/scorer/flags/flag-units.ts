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
 * ONE UNIT BUILDER (chapters/units.ts) serves chapters and flags, so the two
 * passes ask about the same units against the same state and share one primed
 * checkpoint (plan §3.2). In the analysis pipeline the units come from
 * `assembleUnits(segments)` (run-ons cut at segment boundaries) and are passed
 * in; `buildFlagUnits(sentences)` is the standalone entry for callers that only
 * hold sentences (the eval), where a run-on is cut by word count instead.
 */

import type { RankedSentence } from '../../analysis/flag-windows';
import type { Chunk } from '../chapters/chunks';
import { AssembleUnitsOptions, DEFAULT_UNIT_OPTIONS as UNIT_DEFAULTS, SnapUnit, unitsFromSentences } from '../chapters/units';

/** A flag unit is a snap unit: index, text, inclusive sentence range, segment times. */
export type FlagUnit = SnapUnit;

export type UnitOptions = AssembleUnitsOptions;

export const DEFAULT_UNIT_OPTIONS: Required<UnitOptions> = UNIT_DEFAULTS;

/** Fold short sentences forward, then cap run-ons (by word count). Pure. */
export function buildFlagUnits(sentences: RankedSentence[], options: UnitOptions = {}): FlagUnit[] {
  return unitsFromSentences(sentences, options);
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

/** The chapter pipeline's chunk plan in the flag ranker's terms (same units, same state). */
export function flagChunksFromPlan(chunks: Chunk[]): FlagChunk[] {
  return chunks.map((c) => ({ coreFrom: c.coreStart, coreTo: c.coreEnd, contextFrom: c.start, contextTo: c.end }));
}
