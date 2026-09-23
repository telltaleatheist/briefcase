/**
 * Pure parts of the snap chaptering pipeline — a port of ContentStudio's
 * segment.py (outline parsing, assign questions, confirm_plugs, boundaries)
 * plus the mapping from a Viterbi path to chapters. No I/O here: the scorer
 * calls are injected, so all of it is unit-testable with a fake.
 */

import { viterbi, runsOf } from '../scorer-viterbi';
import { ChoiceOption, ChoiceQuestion } from '../scorer.types';
import { AD_TITLE, MAX_ITEMS, START_OF_VIDEO, assignInstructions, clip } from './snap-prompts';
import { SentenceUnit } from './units';

/** segment.py:80 — log(max(p, 1e-12)). */
export const LOG_FLOOR = Math.log(1e-12);

/** segment.py:103 — the plug column of a rejected stretch. */
export const REJECTED = -1e9;

/** Longest outline label kept (plan §4.1 defensive addition). */
export const MAX_LABEL_CHARS = 120;

export class OutlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineError';
  }
}

// --------------------------------------------------------------------------- outline

/** Python str.splitlines() line breaks. */
const SPLITLINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python str.strip(chars). */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

const STRIP = ' -*•\t';

/**
 * segment.py:49-58: strip " -*•\t" from each line, drop empties, de-duplicate
 * case-insensitively (first occurrence wins, order kept), cap at `maxItems`,
 * and refuse fewer than 2 items.
 *
 * Plan §4.1 defensive additions (no effect on what the measured model writes):
 * a leading "1." / "2)" and markdown "**" are also removed, and labels are
 * clipped to 120 characters.
 */
export function parseOutline(content: string, maxItems: number = MAX_ITEMS): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(SPLITLINES)) {
    let l = stripChars(raw, STRIP);
    l = l.replace(/^\d+[.)]\s*/, '').replace(/\*\*/g, '');
    l = clip(stripChars(l, STRIP), MAX_LABEL_CHARS);
    const key = l.toLowerCase();
    if (l && !seen.has(key)) {
      items.push(l);
      seen.add(key);
    }
  }
  const capped = items.slice(0, maxItems);
  if (capped.length < 2) {
    throw new OutlineError(`outline came back with ${capped.length} items: ${JSON.stringify(content.slice(0, 300))}`);
  }
  return capped;
}

// --------------------------------------------------------------------------- assign

/** segment.py:62 — {"section k": item} for k = 1..n, in order (label A = section 1). */
export function assignOptions(items: string[]): ChoiceOption[] {
  return items.map((item, k) => ({ name: `section ${k + 1}`, description: item }));
}

/**
 * The choice questions for units [from, to) of `texts` (segment.py:64-75).
 * `prevBefore` is the sentence before texts[0]: the real previous unit when a
 * chunk starts mid-video, else "(start of the video)".
 */
export function assignQuestions(
  texts: string[],
  from: number,
  to: number,
  options: ChoiceOption[],
  prevBefore: string = START_OF_VIDEO,
): ChoiceQuestion[] {
  const out: ChoiceQuestion[] = [];
  for (let i = from; i < to; i++) {
    const prev = i ? texts[i - 1] : prevBefore;
    out.push({ type: 'choice', name: `s${i}`, instructions: assignInstructions(texts[i], prev), options });
  }
  return out;
}

/** One row of L: log P(item | sentence), floored at log(1e-12). */
export function logRow(logProbs: number[]): number[] {
  return logProbs.map((lp) => (Number.isFinite(lp) ? Math.max(lp, LOG_FLOOR) : LOG_FLOOR));
}

// --------------------------------------------------------------------------- plugs

export interface PlugVerdict {
  /** Unit range [start, end) within the matrix. */
  start: number;
  end: number;
  /** p(yes, this stretch is an ad). */
  p: number;
}

/**
 * segment.py:87-103 `confirm_plugs`. Repeat until nothing is left unchecked:
 * run Viterbi; ask `ask(a, b)` about every run of the plug item not yet
 * checked; a stretch with p < 0.5 gets its plug column set to -1e9, which
 * re-segments it without the ad option on the next pass. `L` is not mutated.
 */
export async function confirmPlugs(
  L: number[][],
  plug: number,
  switchCost: number,
  ask: (start: number, end: number) => Promise<number>,
): Promise<{ path: number[]; verdicts: PlugVerdict[]; logProbs: number[][] }> {
  const M = L.map((row) => row.slice());
  const checked = new Set<string>();
  const verdicts: PlugVerdict[] = [];
  for (;;) {
    const path = viterbi(M, switchCost);
    const todo = runsOf(path, plug).filter(([a, b]) => !checked.has(`${a}:${b}`));
    if (todo.length === 0) return { path, verdicts, logProbs: M };
    for (const [a, b] of todo) {
      const p = await ask(a, b);
      checked.add(`${a}:${b}`);
      verdicts.push({ start: a, end: b, p });
      if (p < 0.5) for (let i = a; i < b; i++) M[i][plug] = REJECTED;
    }
  }
}

// --------------------------------------------------------------------------- chapters

/** segment.py:160 — indices where the item changes. */
export function boundaries(path: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < path.length; i++) if (path[i] !== path[i - 1]) out.push(i);
  return out;
}

/** A stretch of units with one outline item: the unit of stitching and of chapters. */
export interface Piece {
  /** Global unit range [start, end). */
  start: number;
  end: number;
  /** The outline item (the plug text for an ad). */
  label: string;
  isAd: boolean;
  /** Which chunk's outline the label came from. */
  chunk: number;
  /** Index of the label in that chunk's item list. */
  itemIndex: number;
}

/** Runs of `path` over units [lo, hi) of a chunk whose first unit is global `offset`. */
export function pathPieces(
  path: number[],
  items: string[],
  plug: number,
  offset: number,
  chunk: number,
  lo = 0,
  hi = path.length,
): Piece[] {
  const out: Piece[] = [];
  let i = lo;
  while (i < hi) {
    let k = i;
    while (k < hi && path[k] === path[i]) k++;
    const j = path[i];
    out.push({ start: offset + i, end: offset + k, label: items[j], isAd: j === plug, chunk, itemIndex: j });
    i = k;
  }
  return out;
}

export interface SnapChapter {
  /** Seconds. The first chapter starts at 0 so chapters cover the whole timeline. */
  startSeconds: number;
  /** Seconds: the next chapter's start, or the end of the transcript. */
  endSeconds: number;
  /** What to show: the outline label, "Sponsor / self-promotion" for an ad, "(continued)" on a return. */
  title: string;
  /** The raw outline item. */
  label: string;
  /** Unit range [start, end) — indices into the units the pipeline was given. */
  sentenceRange: [number, number];
  isAd: boolean;
}

/**
 * Pieces (contiguous, covering every unit, in order) -> chapters (plan §4.5).
 * Adjacent ad pieces (e.g. from two chunks) become one chapter. A subject the
 * video returns to keeps its label and is titled "<label> (continued)".
 */
export function piecesToChapters(pieces: Piece[], units: SentenceUnit[], totalSeconds?: number): SnapChapter[] {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.end === p.start && last.isAd && p.isAd) last.end = p.end;
    else merged.push({ ...p });
  }
  const end = totalSeconds ?? (units.length ? units[units.length - 1].end : 0);
  const seen = new Set<string>();
  return merged.map((p, c) => {
    let title = p.label;
    if (p.isAd) title = AD_TITLE;
    else {
      const key = p.label.toLowerCase();
      if (seen.has(key)) title = `${p.label} (continued)`;
      seen.add(key);
    }
    const startSeconds = c === 0 ? 0 : units[p.start].start;
    const next = merged[c + 1];
    return {
      startSeconds,
      endSeconds: next ? units[next.start].start : Math.max(end, startSeconds),
      title,
      label: p.label,
      sentenceRange: [p.start, p.end] as [number, number],
      isAd: p.isAd,
    };
  });
}

/** HH:MM:SS, as ai-analysis.service's formatDisplayTime. */
export function formatHms(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * The shape ai-analysis.service's `Chapter` has (sequence, start_time,
 * end_time, title, summary?), for the integration phase to drop in. Summaries
 * are left out: the plan keeps the existing per-chapter LLM call for them.
 */
export function toAnalysisChapters(
  chapters: SnapChapter[],
): Array<{ sequence: number; start_time: string; end_time: string; title: string }> {
  return chapters.map((c, i) => ({
    sequence: i + 1,
    start_time: formatHms(c.startSeconds),
    end_time: formatHms(c.endSeconds),
    title: c.title,
  }));
}
