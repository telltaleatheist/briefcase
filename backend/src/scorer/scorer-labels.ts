/**
 * Options -> bare letter labels A..Z, and the startup proof that each letter is
 * ONE token. Port of snap/labels.py.
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

export interface Tokenizer {
  tokenize(text: string): Promise<number[]>;
}

/**
 * letter -> token id, via the engine's own /tokenize. Every letter must be
 * exactly one token (bare, no leading space: it is the first token of the
 * assistant content), and no two letters may share an id.
 */
export async function resolveLabelTokens(engine: Tokenizer): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const letter of LETTERS) {
    const toks = await engine.tokenize(letter);
    if (toks.length !== 1) {
      throw new ScorerError(
        'label_not_single_token',
        `label '${letter}' tokenizes to ${toks.length} tokens [${toks.join(', ')}]; each label must be exactly one token`,
      );
    }
    ids.set(letter, toks[0]);
  }
  if (new Set(ids.values()).size !== ids.size) {
    throw new ScorerError(
      'label_not_single_token',
      `two labels share a token id: ${JSON.stringify(Object.fromEntries(ids))}`,
    );
  }
  return ids;
}
