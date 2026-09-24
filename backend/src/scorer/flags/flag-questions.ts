/**
 * Question and state text for the snap flag ranker. Pure.
 *
 * One kind of question: a GROUP of consecutive units, quoted, asked over the
 * enabled categories + "none" ("do these apply?"). Its probability vector is
 * the rating map's raw material (snap-flag-ranker.ts).
 *
 * TWO LAYOUTS, selectable per run so they can be A/B-tested live (plan §3.2,
 * §6.4, §7):
 *
 *   'inline'  snap's contract layout: every question carries the full
 *             lettered legend of option texts (~330 tokens per question for 10
 *             categories + none). Measured configuration; ~345 s/h in §7.
 *
 *   'prefix'  legend-in-prefix: the option texts are written ONCE into the
 *             primed state, after the transcript, and each question's legend
 *             carries only the short category labels (~100 tokens per
 *             question). §7 estimates ~130 s/h per-unit. Unmeasured for
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

export const CONTENT_FREE_SENTENCE = '(no sentence)';

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

/** The options in label order. Names are the category keys (and 'none'). */
export function groupOptions(plan: FlagOptionPlan[], layout: FlagLayout, nonePosition: NonePosition): ChoiceOption[] {
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

/** How long one quoted unit may be inside a group question. */
export const GROUP_UNIT_CHARS = 300;

/**
 * The group question's instructions. It QUOTES the passage it judges (never an
 * index into the transcript above: a model asked "sentence 212" judges
 * whichever one it lands on), and the whole chunk is in the primed state
 * around it, so the passage is read in context.
 */
export function groupInstructions(texts: string[], layout: FlagLayout): string {
  const passage = texts.map((t) => clip(t, GROUP_UNIT_CHARS)).join(' ');
  const ask =
    layout === 'inline'
      ? 'Which of these does the speaker do in this passage?'
      : 'Which of the categories listed above does the speaker do in this passage?';
  return `Passage from the transcript above: "${passage}"\n${ask}`;
}

export function groupQuestionName(groupIndex: number): string {
  return `g:${groupIndex}`;
}

/** One group of consecutive units, judged together over the categories + "none". */
export function buildGroupQuestion(
  groupIndex: number,
  texts: string[],
  plan: FlagOptionPlan[],
  layout: FlagLayout,
  nonePosition: NonePosition,
): ChoiceQuestion {
  return {
    type: 'choice',
    name: groupQuestionName(groupIndex),
    instructions: groupInstructions(texts, layout),
    options: groupOptions(plan, layout, nonePosition),
  };
}
