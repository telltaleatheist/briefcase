/**
 * Options -> bare letter labels A..Z. Port of snap/labels.py. (The startup
 * proof that each letter is one token belonged to the scorer's own
 * llama-server, removed in P7; Crucible's decision door makes its own.)
 */

import { ScorerError } from './scorer.types';

export const LETTERS: readonly string[] = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
export const MAX_OPTIONS = LETTERS.length; // 26

/** A = Yes, B = No. */
export const YESNO_OPTIONS: readonly [string, string] = ['Yes', 'No'];

/** [letter, optionName] in label order. */
export type Label = [letter: string, name: string];

/** [[letter, optionName]] in the given order. More than 26 -> too_many_options. */
export function assignLabels(names: string[], question: string): Label[] {
  if (names.length > MAX_OPTIONS) {
    throw new ScorerError(
      'too_many_options',
      `question '${question}' has ${names.length} options; the label set is A..Z (${MAX_OPTIONS})`,
    );
  }
  if (new Set(names).size !== names.length) {
    throw new ScorerError('bad_request', `question '${question}' has duplicate option names`);
  }
  return names.map((name, i) => [LETTERS[i], name]);
}

export function yesnoLabels(): Label[] {
  return YESNO_OPTIONS.map((name, i) => [LETTERS[i], name]);
}
