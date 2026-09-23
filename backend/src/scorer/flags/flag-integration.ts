/**
 * Pure glue between the snap flag ranker and ai-analysis's verifier stage
 * (runRankedFlagStage). No I/O.
 *
 *   mergeSpanSubPassages  after verification: consecutive sub-passages of ONE
 *                         long span that both came back 'flag' become ONE
 *                         section (plan §5.5). The 40 s cap limits what the
 *                         verifier reads, not what the user sees, and two
 *                         abutting markers for one moment is exactly the
 *                         picket fence the operator ruled out.
 *   promoteCachedOverflow before verification: an over-budget window whose
 *                         every question is already in the verdict cache is
 *                         free, so it is verified (from the cache) instead of
 *                         being stored as an unverified candidate. Cache hits
 *                         do not count against the budget (plan §5.5).
 */

import type { FlagWindow, WindowCategory } from '../../analysis/nli-ranker.service';
import type { SnapFlagWindow } from './flag-spans';

export interface VerifiedWindow {
  window: FlagWindow;
  categories: WindowCategory[];
}

function spanIdsOf(w: FlagWindow): number[] {
  return (w as Partial<SnapFlagWindow>).spanIds ?? [];
}

function sharesSpan(a: FlagWindow, b: FlagWindow): boolean {
  const ids = new Set(spanIdsOf(a));
  return spanIdsOf(b).some((id) => ids.has(id));
}

/** One category's evidence over two windows: union of the fired sentences, best score. */
function mergeCategory(a: WindowCategory, b: WindowCategory): WindowCategory {
  const best = b.score > a.score ? b : a;
  return {
    ...best,
    sentenceIndices: [...new Set([...a.sentenceIndices, ...b.sentenceIndices])].sort((x, y) => x - y),
    rescued: a.rescued && b.rescued,
  };
}

/**
 * `all` is every window the verifier was asked about; `verified` maps the ones
 * with at least one 'flag' verdict to their accepted categories. Returns the
 * verified windows in transcript order, with each run of CONSECUTIVE (in `all`,
 * by fired range) same-span windows that were all accepted merged into one
 * entry whose categories are the union. A rejected sub-passage in between
 * breaks the run: those are two findings, not one.
 */
export function mergeSpanSubPassages(all: FlagWindow[], verified: Map<FlagWindow, WindowCategory[]>): VerifiedWindow[] {
  const ordered = [...all].sort((a, b) => a.firedFrom - b.firedFrom || a.firedTo - b.firedTo);
  const out: VerifiedWindow[] = [];
  let prev: FlagWindow | null = null;
  for (const w of ordered) {
    const cats = verified.get(w);
    if (!cats) {
      prev = null;
      continue;
    }
    const last = out[out.length - 1];
    if (prev && last && sharesSpan(prev, w)) {
      const byName = new Map(last.categories.map((c) => [c.category, c]));
      for (const c of cats) {
        const had = byName.get(c.category);
        byName.set(c.category, had ? mergeCategory(had, c) : c);
      }
      last.categories = [...byName.values()].sort((a, b) => b.score - a.score);
      last.window = {
        ...last.window,
        contextTo: Math.max(last.window.contextTo, w.contextTo),
        firedTo: Math.max(last.window.firedTo, w.firedTo),
      };
    } else {
      out.push({ window: w, categories: [...cats] });
    }
    prev = w;
  }
  return out;
}

/**
 * Split over-budget windows into those whose every (window, category) question
 * is already answered in the verdict cache (verify them: free) and the rest
 * (store as unverified candidates). `isCached(window, category)` is the
 * caller's cache probe.
 */
export function promoteCachedOverflow<W extends FlagWindow>(
  overflow: W[],
  isCached: (window: W, category: WindowCategory) => boolean,
): { promoted: W[]; candidates: W[] } {
  const promoted: W[] = [];
  const candidates: W[] = [];
  for (const w of overflow) {
    if (w.categories.length > 0 && w.categories.every((c) => isCached(w, c))) promoted.push(w);
    else candidates.push(w);
  }
  return { promoted, candidates };
}
