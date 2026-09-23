/**
 * Question and state text for the snap flag ranker. Pure.
 *
 * TWO LAYOUTS, selectable per run so they can be A/B-tested live (plan §3.2,
 * §6.4, §7):
 *
 *   'inline'  snap's contract layout: every pass-1 question carries the full
 *             lettered legend of option texts (~330 tokens per question for 10
 *             categories + none). Measured configuration; ~345 s/h in §7.
 *
 *   'prefix'  legend-in-prefix: the option texts are written ONCE into the
 *             primed state, after the transcript, and each question's legend
 *             carries only the short category labels (~100 tokens per
 *             question). §7 estimates ~130 s/h for pass 1. Unmeasured for
 *             accuracy; the default until §6.4 says otherwise is 'prefix',
 *             because only it fits the 9 min/h budget.
 *
 * The prefix layout needs NO new scorer entry point (the plan's
 * decideWithPrefix): the legend is simply part of the state string, which
 * snap primes and reuses like any other state. For chapters and flags to share
 * one primed checkpoint, both must build the identical state; the ranker takes
 * a `stateBuilder` so integration can put the chapter legend in too.
 */

import type { ChoiceOption, ChoiceQuestion } from '../scorer.types';
import { FlagOptionPlan, NONE_KEY, NONE_OPTION_TEXT, categoryTitle } from './flag-options';

export type FlagLayout = 'inline' | 'prefix';
export type NonePosition = 'first' | 'last';

export const START_OF_VIDEO = '(start of the video)';
export const CONTENT_FREE_SENTENCE = '(no sentence)';

/** Pass-2 option names. q_{i,c} = P(FITS). */
export const FITS = 'Fits';
export const DOES_NOT_FIT = 'Does not fit';

/** Truncate to `max` characters, marking the cut with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/** The category legend written into the state in the prefix layout. */
export function flagLegendBlock(plan: FlagOptionPlan[]): string {
  const lines = plan.map((p) => `- ${p.category}: ${p.optionText}`);
  lines.push(`- ${NONE_KEY}: ${NONE_OPTION_TEXT}`);
  return 'Categories (the options in the questions below):\n' + lines.join('\n');
}

/** Default state: the chunk's units one per line (segment.py's "\n".join), plus the legend in the prefix layout. */
export function defaultFlagState(unitTexts: string[], legend: string | null): string {
  const transcript = unitTexts.join('\n');
  return legend ? `${transcript}\n\n${legend}` : transcript;
}

/** Pass-1 options in label order. Names are the category keys (and 'none'). */
export function pass1Options(plan: FlagOptionPlan[], layout: FlagLayout, nonePosition: NonePosition): ChoiceOption[] {
  const cats: ChoiceOption[] = plan.map((p) => ({
    name: p.category,
    description: layout === 'inline' ? p.optionText : categoryTitle(p.category),
  }));
  const none: ChoiceOption = {
    name: NONE_KEY,
    description: layout === 'inline' ? NONE_OPTION_TEXT : 'None of these',
  };
  return nonePosition === 'first' ? [none, ...cats] : [...cats, none];
}

function sentenceLines(cur: string, prev: string): string {
  return `Sentence from the transcript above: "${clip(cur, 300)}"\n(The sentence just before it: "${clip(prev, 200)}")`;
}

export function pass1Instructions(cur: string, prev: string, layout: FlagLayout): string {
  const ask =
    layout === 'inline'
      ? 'Which of these does the speaker do in this sentence?'
      : 'Which of the categories listed above does the speaker do in this sentence?';
  return `${sentenceLines(cur, prev)}\n${ask}`;
}

export function pass1QuestionName(unitIndex: number): string {
  return `p1:${unitIndex}`;
}

export function buildPass1Question(
  unitIndex: number,
  cur: string,
  prev: string,
  plan: FlagOptionPlan[],
  layout: FlagLayout,
  nonePosition: NonePosition,
): ChoiceQuestion {
  return {
    type: 'choice',
    name: pass1QuestionName(unitIndex),
    instructions: pass1Instructions(cur, prev, layout),
    options: pass1Options(plan, layout, nonePosition),
  };
}

/**
 * Pass 2 (plan §5.2): a two-option choice with both sides stated positively,
 * the form that fixed acquiescence in ContentStudio. NOT a yesno.
 */
export function buildPass2Question(unitIndex: number, cur: string, prev: string, entry: FlagOptionPlan): ChoiceQuestion {
  return {
    type: 'choice',
    name: pass2QuestionName(unitIndex, entry.category),
    instructions:
      `${sentenceLines(cur, prev)}\n` +
      `Does this sentence fit the description below?\n` +
      `Description: ${entry.optionText}`,
    options: [
      { name: FITS, description: 'the speaker does what the description says in this sentence' },
      { name: DOES_NOT_FIT, description: 'the sentence is about something else' },
    ],
  };
}

export function pass2QuestionName(unitIndex: number, category: string): string {
  return `p2:${unitIndex}:${category}`;
}
