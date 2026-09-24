/**
 * TRANSCRIPT SENTENCES AND FLAG VERIFICATION WINDOWS, the shapes the snap flag
 * pipeline ranks into and the verifier stage reads.
 *
 * These lived in the NLI ranker (analysis/nli-ranker.service.ts) until P7
 * removed it: the snap engine kept its sentence assembly, its candidate and
 * window types and its window builder, so they live here now, with nothing
 * NLI-specific left in them.
 */

// =============================================================================
// TYPES
// =============================================================================

/** One transcript sentence with the times of the segments it spans. */
export interface RankedSentence {
  start: number;
  end: number;
  text: string;
}

/**
 * One (span, category) pair a ranker kept: the snap flag ranker's sub-passages
 * (flag-spans.ts), `sentenceIndex` a representative sentence for logging.
 */
export interface FlagCandidate {
  sentenceIndex: number;
  /** Inclusive sentence-index range this candidate covers. */
  spanFrom: number;
  spanTo: number;
  start: number;
  end: number;
  text: string;
  category: string;
  score: number;
  /** The stance proposition the verifier will test this candidate against. */
  proposition: string;
  /** Which pass produced it — sentence-level scoring or sliding-window scoring. */
  source: 'sentence' | 'window';
  /**
   * True when this pair never cleared a threshold on its own and exists only
   * because corroborating categories fired near it (a stored field; the snap
   * ranker never sets it).
   */
  rescued: boolean;
}

/** One category's evidence inside a verification window. */
export interface WindowCategory {
  category: string;
  proposition: string;
  /** The window's BEST score for this category... */
  score: number;
  /** ...and the sentence that scored it. */
  sentenceIndex: number;
  text: string;
  start: number;
  end: number;
  /** Every sentence in the window that fired this category, in transcript order. */
  sentenceIndices: number[];
  /** True only when EVERY firing of this category in the window was a rescue. */
  rescued: boolean;
}

/**
 * A paragraph-sized passage of transcript that the verifier judges as a whole.
 *
 * Scoring stays at SENTENCE granularity (that is what fixed stretch-level
 * dilution and it is not changed here). A window is what happens AFTER
 * thresholding: each hot sentence is expanded to the sentences around it, and
 * overlapping or near-adjacent expansions are merged into one passage
 * regardless of category. The window then carries the UNION of its sentences'
 * fired categories, and one verification call is made per (window, category) —
 * so a passage where three categories fired costs three calls, not one per
 * (sentence, category) pair.
 */
export interface FlagWindow {
  /** Inclusive sentence-index range of the passage the verifier is shown. */
  contextFrom: number;
  contextTo: number;
  /** Inclusive sentence-index range of the sentences that actually fired. */
  firedFrom: number;
  firedTo: number;
  /** Union of the fired categories, strongest first. */
  categories: WindowCategory[];
  /** Noisy-OR over the per-category best scores — the ranking score. */
  score: number;
}

/**
 * VERIFICATION WINDOWS — the parameters that turn hot sentences into passages.
 *
 * THE PROBLEM THEY SOLVE, from a real run: a speaker spends four sentences on
 * one bit, the ranker scores each sentence separately and each one clears the
 * threshold, and the timeline came back with four back-to-back single-sentence
 * flags for what a viewer experiences as ONE moment. Per-category merging after
 * verification could not fix that, because the four sentences were not all the
 * same category.
 *
 * So the unit of VERIFICATION (and therefore of the stored section) is the
 * passage, while the unit of SCORING stays the sentence.
 *
 *   WINDOW_CONTEXT_SENTENCES     +/-2 around the hot sentence, so an unmerged
 *                                window is up to 5 sentences — the same +/-2 the
 *                                measured verification runs already showed the
 *                                model as context, now the thing being judged.
 *   WINDOW_MAX_CONTEXT_SECONDS   A hard stop on that expansion. Sentences run
 *                                3-6s in these transcripts, so 5 of them is
 *                                normally 15-25s; the cap is what keeps a
 *                                window that lands next to a 40-second monologue
 *                                sentence from becoming a page.
 *   WINDOW_MERGE_GAP_*           Two windows join when at most one sentence or
 *                                5 seconds separates them. Merging is
 *                                deliberately CATEGORY-BLIND: the four-flag run
 *                                above was three different categories, and
 *                                merging per category would have left it split.
 *   WINDOW_MAX_MERGED_SECONDS    Chaining has to stop somewhere. Without a cap,
 *                                a dense five-minute rant merges into a single
 *                                section that is useless to scrub to and a
 *                                prompt that no longer fits the pinned num_ctx.
 *                                MEASURED: at 60s the verifier answered "skip"
 *                                for the SECOND category of two long merged
 *                                passages on the reference video and cost two
 *                                hand-audited category labels (the moments were
 *                                still flagged, under the other category); at
 *                                40s both came back and the four-back-to-back
 *                                run the operator reported still coalesces.
 *                                40s is roughly 100-130 spoken words: a
 *                                paragraph, which is what a passage judgment
 *                                can carry without diluting the weaker claim.
 */
const WINDOW_CONTEXT_SENTENCES = 2;
const WINDOW_MAX_CONTEXT_SECONDS = 25;
const WINDOW_MERGE_GAP_SENTENCES = 1;
const WINDOW_MERGE_GAP_SECONDS = 5;
const WINDOW_MAX_MERGED_SECONDS = 40;

// =============================================================================
// SENTENCE ASSEMBLY
// =============================================================================

/**
 * Merge transcript segments into sentences.
 *
 * Whisper segments are breath-length fragments, not sentences: scoring them
 * directly gives a model half a clause and no stance. This concatenates
 * every segment into one character stream, splits it on terminal punctuation,
 * and maps each sentence back to the FIRST and LAST segment it overlaps — so
 * the sentence's timestamps are measured segment times, never interpolated.
 *
 * Ported verbatim in behavior from proto_stage12.py.
 */
export function assembleSentences(
  segments: Array<{ start: number; end: number; text: string }>,
): RankedSentence[] {
  const spans: Array<{ lo: number; hi: number; start: number; end: number }> = [];
  const parts: string[] = [];
  let pos = 0;

  for (const seg of segments) {
    const text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (parts.length > 0) {
      parts.push(' ');
      pos += 1;
    }
    parts.push(text);
    spans.push({ lo: pos, hi: pos + text.length, start: seg.start, end: seg.end });
    pos += text.length;
  }

  const full = parts.join('');
  if (!full) return [];

  // Sentence boundaries: . ! ? possibly followed by a closing quote/bracket,
  // then whitespace or end of stream.
  const bounds: number[] = [];
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full)) !== null) bounds.push(m.index + m[0].length);
  if (bounds.length === 0 || bounds[bounds.length - 1] < full.length) bounds.push(full.length);

  const out: RankedSentence[] = [];
  let cursor = 0;
  for (const bound of bounds) {
    const text = full.slice(cursor, bound).trim();
    if (text) {
      const hits = spans.filter((s) => s.lo < bound && s.hi > cursor);
      if (hits.length > 0) {
        out.push({ start: hits[0].start, end: hits[hits.length - 1].end, text });
      }
    }
    cursor = bound;
  }
  return out;
}

// =============================================================================
// VERIFICATION WINDOWS
// =============================================================================

/** The per-category evidence one hot span contributes to a window. */
function categoriesFromSpan(candidates: FlagCandidate[]): WindowCategory[] {
  return candidates.map((candidate) => ({
    category: candidate.category,
    proposition: candidate.proposition,
    score: candidate.score,
    sentenceIndex: candidate.sentenceIndex,
    text: candidate.text,
    start: candidate.start,
    end: candidate.end,
    sentenceIndices: Array.from(
      { length: candidate.spanTo - candidate.spanFrom + 1 },
      (_unused, offset) => candidate.spanFrom + offset,
    ),
    rescued: candidate.rescued,
  }));
}

/**
 * Union two windows' category evidence. A category present in both keeps its
 * BEST-scoring sentence (that is the quote the verdict is really about) and the
 * union of every sentence that fired it (that is what the section's span is
 * measured from).
 */
function mergeWindowCategories(a: WindowCategory[], b: WindowCategory[]): WindowCategory[] {
  const out = new Map<string, WindowCategory>();
  for (const entry of [...a, ...b]) {
    const existing = out.get(entry.category);
    if (!existing) {
      out.set(entry.category, { ...entry, sentenceIndices: [...entry.sentenceIndices] });
      continue;
    }
    const best = entry.score > existing.score ? entry : existing;
    const indices = new Set([...existing.sentenceIndices, ...entry.sentenceIndices]);
    out.set(entry.category, {
      ...best,
      sentenceIndices: [...indices].sort((x, y) => x - y),
      // One threshold-clearing firing anywhere in the window means the category
      // is not resting on the rescue rule.
      rescued: existing.rescued && entry.rescued,
    });
  }
  return [...out.values()];
}

/**
 * Turn ranked (span, category) candidates into merged verification windows.
 *
 * Pure. Candidates must be in transcript order (ascending spanFrom, then
 * spanTo), which is what the snap flag ranker hands it.
 *
 * MULTI-CATEGORY BOOST. A window's ranking score is the noisy-OR of its
 * categories' best scores, 1 - PROD(1 - s_i). Two independent hypotheses at
 * 0.95 and 0.93 give 0.9965, which outranks any single 0.99 — which is the
 * point: a passage that is demonizing AND hateful is worse content than a
 * passage that is very confidently one thing, and the operator should see it
 * first. The score orders VERIFICATION, it does not gate it; every window and
 * every one of its categories is still verified.
 */
export function buildWindows(sentences: RankedSentence[], candidates: FlagCandidate[]): FlagWindow[] {
  if (candidates.length === 0 || sentences.length === 0) return [];

  const bySpan = new Map<string, FlagCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.spanFrom}:${candidate.spanTo}`;
    const list = bySpan.get(key);
    if (list) list.push(candidate);
    else bySpan.set(key, [candidate]);
  }
  const hot = [...bySpan.values()].sort(
    (a, b) => a[0].spanFrom - b[0].spanFrom || a[0].spanTo - b[0].spanTo,
  );

  // 1. Expand every hot span into a passage, alternating sides so a window at a
  //    hard time cap is still balanced around the span that fired.
  const expanded: FlagWindow[] = hot.map((group) => {
    let from = group[0].spanFrom;
    let to = group[0].spanTo;
    for (let step = 0; step < WINDOW_CONTEXT_SENTENCES; step++) {
      if (from > 0 && sentences[to].end - sentences[from - 1].start <= WINDOW_MAX_CONTEXT_SECONDS) from--;
      if (
        to + 1 < sentences.length &&
        sentences[to + 1].end - sentences[from].start <= WINDOW_MAX_CONTEXT_SECONDS
      ) {
        to++;
      }
    }
    return {
      contextFrom: from,
      contextTo: to,
      firedFrom: group[0].spanFrom,
      firedTo: group[0].spanTo,
      categories: categoriesFromSpan(group),
      score: 0,
    };
  });

  // 2. Merge overlapping / near-adjacent passages, category-blind.
  const merged: FlagWindow[] = [];
  for (const window of expanded) {
    const previous = merged[merged.length - 1];
    if (previous) {
      // Overlapping and nested windows give a negative gap, which both tests
      // accept — that is the intent, they are the same passage.
      const sentenceGap = window.contextFrom - previous.contextTo - 1;
      const secondsGap = sentences[window.contextFrom].start - sentences[previous.contextTo].end;
      const joinedFrom = Math.min(previous.contextFrom, window.contextFrom);
      const joinedTo = Math.max(previous.contextTo, window.contextTo);
      const joinedSpan = sentences[joinedTo].end - sentences[joinedFrom].start;
      const close = sentenceGap <= WINDOW_MERGE_GAP_SENTENCES || secondsGap <= WINDOW_MERGE_GAP_SECONDS;
      if (close && joinedSpan <= WINDOW_MAX_MERGED_SECONDS) {
        previous.contextFrom = joinedFrom;
        previous.contextTo = joinedTo;
        previous.firedFrom = Math.min(previous.firedFrom, window.firedFrom);
        previous.firedTo = Math.max(previous.firedTo, window.firedTo);
        previous.categories = mergeWindowCategories(previous.categories, window.categories);
        continue;
      }
    }
    merged.push({ ...window, categories: [...window.categories] });
  }

  // 3. Score and order the evidence inside each window.
  for (const window of merged) {
    window.categories.sort((x, y) => y.score - x.score);
    window.score = 1 - window.categories.reduce((product, c) => product * (1 - c.score), 1);
  }
  return merged;
}
