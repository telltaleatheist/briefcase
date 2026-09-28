/**
 * TIME WINDOWS: one scorer question per stretch of the video, not per sentence.
 *
 * The user, 2026-09-28: a four-hour show took about two hours to analyse on the
 * Mac (one decide question per sentence for chapters, one per three for flags,
 * ~1.1 s each, one after another), and "we could make the steps 1 minute, 1.5
 * minute sliding window". So chapters and flags can ask about WINDOWS of the
 * transcript instead: each window holds the units that start within
 * `windowSeconds` of its own start, and a new window starts every
 * `stepSeconds`. At 90 s / 60 s neighbouring windows share 30 s, and every
 * unit is in one or two of them.
 *
 * Everything after the questions is unchanged: each UNIT still gets a row, the
 * mean of the answers of the windows it is in (its probabilities averaged, as
 * the flag ranker has always averaged its overlapping groups). So Viterbi, the
 * ad check, chunk stitching, flag spans and the verifier all work on units as
 * before; the rows are simply constant across each stretch the same windows
 * cover, which puts every boundary on a 30 s grid (at 90 / 60).
 *
 * What it costs: a short remark inside a window has to show in the answer
 * about the whole window. Measure it against per-sentence questions on a
 * reference video before trusting it for flags (the setting keeps both).
 */

/** Window length and the step between window starts, in seconds. */
export interface TimeWindows {
  readonly windowSeconds: number;
  readonly stepSeconds: number;
}

/** The user's first setting (2026-09-28): 1.5-minute windows every minute. */
export const DEFAULT_TIME_WINDOWS: TimeWindows = { windowSeconds: 90, stepSeconds: 60 };

/**
 * Windows over units [from, to), as inclusive [first, last] unit indices, in
 * order. A window starting at time t holds the units whose start is in
 * [t, t + windowSeconds); window starts are the first unit's start plus
 * multiples of stepSeconds. A window with no unit is dropped (a long silence),
 * and a unit that no window reaches (a gap wider than the step) opens the next
 * window at its own start, so every unit is in at least one window.
 */
export function timeWindows(
  units: ReadonlyArray<{ start: number }>,
  from: number,
  to: number,
  windows: TimeWindows,
): Array<[number, number]> {
  if (!(windows.windowSeconds > 0) || !(windows.stepSeconds > 0) || windows.stepSeconds > windows.windowSeconds) {
    throw new Error(`time windows must have 0 < step <= window; got window ${windows.windowSeconds}s, step ${windows.stepSeconds}s`);
  }
  const out: Array<[number, number]> = [];
  if (to <= from) return out;
  let t = units[from].start;
  let first = from;
  while (first < to) {
    // The first unit at or after this window's start.
    while (first < to && units[first].start < t) first++;
    if (first >= to) break;
    // Nothing starts in this window: move the window to the next unit.
    if (units[first].start >= t + windows.windowSeconds) {
      t = units[first].start;
    }
    let last = first;
    while (last + 1 < to && units[last + 1].start < t + windows.windowSeconds) last++;
    out.push([first, last]);
    if (last === to - 1) break;
    t += windows.stepSeconds;
  }
  return out;
}

/**
 * Per unit of [from, to): the mean of the probability vectors of the windows
 * that hold it. `windows` are absolute unit ranges (timeWindows), `probs[w]`
 * the answer to window w, every vector the same length.
 */
export function unitMeans(
  from: number,
  to: number,
  windows: ReadonlyArray<[number, number]>,
  probs: ReadonlyArray<ReadonlyArray<number>>,
): number[][] {
  const width = probs[0]?.length ?? 0;
  const sum = Array.from({ length: to - from }, () => new Array<number>(width).fill(0));
  const seen = new Array<number>(to - from).fill(0);
  windows.forEach(([a, b], w) => {
    for (let i = a; i <= b; i++) {
      for (let j = 0; j < width; j++) sum[i - from][j] += probs[w][j];
      seen[i - from] += 1;
    }
  });
  return sum.map((row, i) => {
    if (seen[i] === 0) throw new Error(`unit ${from + i} is in no window`);
    return row.map((v) => v / seen[i]);
  });
}

/**
 * The stored setting (app-config.json `analysisWindows`): `{ mode: 'windows',
 * windowSeconds, stepSeconds }`, or `{ mode: 'sentence' }` for one question per
 * sentence. Absent: DEFAULT_TIME_WINDOWS.
 */
export type AnalysisWindowsSetting =
  | { mode: 'windows'; windowSeconds: number; stepSeconds: number }
  | { mode: 'sentence' };

export const WINDOW_SECONDS_RANGE = { min: 15, max: 600 } as const;

/** The setting as sent, or why it can't be stored. */
export function readWindowsSetting(raw: unknown): AnalysisWindowsSetting | string {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o['mode'] === 'sentence') return { mode: 'sentence' };
  if (o['mode'] !== 'windows') return 'mode must be "windows" or "sentence"';
  const w = o['windowSeconds'];
  const st = o['stepSeconds'];
  const { min, max } = WINDOW_SECONDS_RANGE;
  if (typeof w !== 'number' || !Number.isFinite(w) || w < min || w > max) return `windowSeconds must be ${min} to ${max}`;
  if (typeof st !== 'number' || !Number.isFinite(st) || st < min || st > w) return `stepSeconds must be ${min} to the window length (${w})`;
  return { mode: 'windows', windowSeconds: w, stepSeconds: st };
}

/** What the engine runs with for a stored setting: windows, or null for per sentence. Unreadable: the default. */
export function windowsOf(stored: unknown): TimeWindows | null {
  if (stored === undefined || stored === null) return DEFAULT_TIME_WINDOWS;
  const read = readWindowsSetting(stored);
  if (typeof read === 'string') return DEFAULT_TIME_WINDOWS;
  return read.mode === 'sentence' ? null : { windowSeconds: read.windowSeconds, stepSeconds: read.stepSeconds };
}
