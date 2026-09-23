/**
 * Prompt text for snap chaptering — VERBATIM from ContentStudio's segment.py.
 *
 * These strings are part of the measured result (YTSeg F1@±1 0.72 at switch
 * cost 20). Do not reword them; any change must bump SEGMENT_PROMPT_VERSION
 * and be re-benchmarked (docs/snap-analysis-plan.md §6.3).
 */

import { MAX_OPTIONS } from '../scorer-labels';

/** Bump whenever any string in this file changes. */
export const SEGMENT_PROMPT_VERSION = 'segment-py-1';

/** segment.py:23 — the fixed ad / self-promotion item appended to every outline. */
export const PLUG =
  'An ad, sponsor read or self-promotion (Patreon, merch, a book, asking viewers to subscribe or support)';

/** segment.py:24 — 25 outline items + the plug item = 26 letters. */
export const MAX_ITEMS = MAX_OPTIONS - 1;

/** segment.py:25 — sentences per decide request (each request primes the shared transcript once). */
export const BATCH = 64;

/** segment.py:65 — the previous-sentence stand-in for the very first sentence of the video. */
export const START_OF_VIDEO = '(start of the video)';

/** Display title for a chapter assigned to the plug item (plan §4.5). */
export const AD_TITLE = 'Sponsor / self-promotion';

/**
 * segment.py:28 `clip`: keep `s` if it is at most `n` characters, else its
 * first n-1 characters plus an ellipsis. Counts code points, as Python does.
 */
export function clip(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n - 1).join('') + '…';
}

/** segment.py:40-43 — the outline generation prompt. */
export function outlinePrompt(text: string, maxItems: number = MAX_ITEMS): string {
  return (
    'Here is a transcript of a video.\n\n' +
    text +
    '\n\n' +
    'List the sections of this video in the order they happen. A new section starts wherever ' +
    'the video moves to a different subject, story, clip, ad or aside. Write one short, specific ' +
    `label per line (at most ${maxItems} lines), with no numbering and nothing else.`
  );
}

/** segment.py:44-47 — the outline request's output cap. */
export const OUTLINE_MAX_TOKENS = 1000;

/** segment.py:71-73 — the per-sentence assign question. */
export function assignInstructions(sentence: string, prev: string): string {
  return (
    `Sentence from the transcript above: "${clip(sentence, 300)}"\n` +
    `(The sentence just before it: "${clip(prev, 200)}")\n` +
    'Which section of the video is this sentence part of?'
  );
}

/** segment.py:94-96 — the yes/no statement that confirms a stretch assigned to the plug item. */
export function plugStatement(sentences: string[]): string {
  const passage = clip(sentences.join(' '), 700);
  return (
    `Passage from the transcript above: "${passage}"\nIn this passage the speaker ` +
    'is advertising or promoting something: a sponsor, their own Patreon, merch, a ' +
    'book, or asking viewers to subscribe, follow or support them.'
  );
}
