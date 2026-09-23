/**
 * Viterbi smoothing over per-unit log-probabilities.
 *
 * Port of ContentStudio's segment.py `viterbi()` / `runs()`. Any state may
 * follow any other at a flat cost per switch, so a theme the speaker returns
 * to can recur. The switch cost (in nats) is the granularity dial: higher
 * gives fewer, longer runs. Chapters use ~20; flags tune their own.
 */

/**
 * Best state per unit.
 * @param logProbs  logProbs[i][j] = log P(state j | unit i); every row the same length
 * @param switchCost flat penalty (nats) paid each time the state changes
 * @returns the state index for each unit (empty for no units)
 */
export function viterbi(logProbs: number[][], switchCost: number): number[] {
  const n = logProbs.length;
  if (n === 0) return [];
  const m = logProbs[0].length;
  if (m === 0) throw new Error('viterbi: rows must have at least one state');

  let dp = logProbs[0].slice();
  const back: Int32Array[] = [];
  for (let i = 1; i < n; i++) {
    const row = logProbs[i];
    if (row.length !== m) throw new Error(`viterbi: row ${i} has ${row.length} states, expected ${m}`);
    const bestJ = argmax(dp);
    const bestV = dp[bestJ] - switchCost;
    const next = new Array<number>(m);
    const from = new Int32Array(m);
    for (let j = 0; j < m; j++) {
      if (dp[j] >= bestV) {
        next[j] = dp[j] + row[j];
        from[j] = j;
      } else {
        next[j] = bestV + row[j];
        from[j] = bestJ;
      }
    }
    dp = next;
    back.push(from);
  }

  const path = new Array<number>(n);
  let j = argmax(dp);
  path[n - 1] = j;
  for (let i = n - 2; i >= 0; i--) {
    j = back[i][j];
    path[i] = j;
  }
  return path;
}

/** Maximal runs of `state` in `path`, as [start, endExclusive] unit indices. */
export function runsOf(path: number[], state: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === state) {
      let k = i;
      while (k < path.length && path[k] === state) k++;
      out.push([i, k]);
      i = k;
    } else {
      i++;
    }
  }
  return out;
}

/** Every maximal run in `path`, in order, as {state, start, end (exclusive)}. */
export function segments(path: number[]): Array<{ state: number; start: number; end: number }> {
  const out: Array<{ state: number; start: number; end: number }> = [];
  let i = 0;
  while (i < path.length) {
    let k = i;
    while (k < path.length && path[k] === path[i]) k++;
    out.push({ state: path[i], start: i, end: k });
    i = k;
  }
  return out;
}

function argmax(xs: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}
