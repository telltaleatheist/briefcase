/**
 * Flag option texts for the snap ranker, and the per-run plan built from the
 * user's (editable) category list.
 *
 * TWO DIFFERENT STRINGS PER CATEGORY, for two different readers:
 *
 *   option text   What the SCORER reads in pass 1 / pass 2: a short,
 *                 discriminating description of the ACT, one line. Derived
 *                 from the tuned NLI hypotheses (nli-ranker.service.ts
 *                 HYPOTHESES), never from DEFAULT_CATEGORIES' descriptions:
 *                 those are LLM instructions ("flag even if quoted", "NOTE: do
 *                 NOT flag…"), and a scorer reads an instruction as content.
 *                 Multi-hypothesis categories collapse their alternatives into
 *                 one disjunction, since a choice option can hold one.
 *
 *   proposition   What the VERIFIER tests. MUST be byte-identical to the NLI
 *                 ranker's PROPOSITIONS: it is part of the verdict-cache
 *                 question hash, so a snap window whose passage matches an NLI
 *                 window's is a free cache hit only if the proposition matches
 *                 too. flag-options.spec.ts asserts every string below appears
 *                 verbatim in nli-ranker.service.ts.
 *
 * DEVIATION (plan §5.1): the plan moves HYPOTHESES/PROPOSITIONS into
 * analysis/flag-categories.ts shared by both rankers. That touches
 * nli-ranker.service.ts, which this phase must not edit, so the propositions
 * are COPIED here and pinned by a spec; the move is an integration-phase task.
 */

import { AnalysisCategory } from '../../analysis/prompts/analysis-prompts';

/** The option key for "none of these". Categories may not use it as a name. */
export const NONE_KEY = 'none';

/** Pass-1 option text for the none option. Topic-phrased, not stance-phrased (plan §5.1). */
export const NONE_OPTION_TEXT = 'None of these: ordinary talk about something else';

/** Plan §5.1 option texts, one line each. */
export const SNAP_OPTION_TEXTS: Readonly<Record<string, string>> = {
  'political-demonization': 'Calls political opponents communists, Marxists, or enemies of the country',
  hate: 'Shows hostility or mockery toward a group because of race, religion, ethnicity, sexuality, or identity',
  dehumanization:
    "Describes people as vermin, disease, zombies, or less than human, or calls opponents' politics a mental illness",
  conspiracy: 'Presents a conspiracy theory (stolen election, deep state, a hidden plot) as true',
  violence: 'Calls for, threatens, or glorifies violence',
  'political-violence': 'Defends or downplays a political attack, riot, or insurrection',
  extremism: 'Defends oppression, supremacy, ethnic cleansing, or authoritarian rule',
  'christian-nationalism':
    'Says Christianity or the church should run government, or that God is directing the nation or its leaders',
  'false-prophecy': 'Claims God spoke to them or someone they cite, or announces a prophecy or revelation',
  'prosperity-gospel': 'Asks followers for money as a religious duty, or promises blessing in return for giving',
};

/**
 * Eval-arm only (plan §5.7): misinformation is excluded by default, for parity
 * with NLI. `includeMisinformation: true` adds it with this text.
 */
export const MISINFORMATION_OPTION_TEXT =
  'States as fact something that is widely known to be false (debunked medical, scientific, or historical claims)';

/** Verifier propositions. VERBATIM copies of nli-ranker.service.ts PROPOSITIONS (see header). */
export const FLAG_PROPOSITIONS: Readonly<Record<string, string>> = {
  hate: 'a group of people deserves hostility, contempt, or mockery because of their race, ethnicity, religion, national origin, immigration status, gender, or sexuality',
  conspiracy:
    'a conspiracy theory is true — a secret coordinated plot by a hidden group (election fraud, deep state, globalists, New World Order, and the like)',
  'false-prophecy':
    'God has spoken to the speaker or to someone they cite, or a divine revelation or prophecy has been received',
  violence: 'violence against people is justified, deserved, or something to look forward to',
  'christian-nationalism': 'Christianity should direct government, law, or politics',
  'prosperity-gospel':
    'followers should give money to a religious leader or ministry in order to receive blessing or wealth',
  extremism: 'oppression, supremacy, ethnic cleansing, or authoritarian rule is justified',
  'political-violence':
    'a political attack, riot, or insurrection was justified, was staged, or was not a serious wrong',
  'political-demonization':
    'political opponents are communists, Marxists, socialists, or enemies within — a label applied to the people themselves rather than a critique of a specific policy',
  dehumanization:
    "a group of people is vermin, disease, infestation, zombies, animals, or otherwise less than human — or that opponents' politics are the product of mental illness or personal damage rather than sincere belief",
};

/** 26 letters, one reserved for none. */
export const MAX_FLAG_CATEGORIES = 25;

/** Custom categories: first sentence of the description, clipped to this many chars. */
export const CUSTOM_OPTION_MAX_CHARS = 140;

export interface FlagOptionPlan {
  /** The category name as the user has it; also the option key the scorer sees. */
  category: string;
  /** One-line act description the scorer reads. */
  optionText: string;
  /** What the verifier tests (see header). */
  proposition: string;
  /** True for a built-in text; false for a custom category's clipped description. */
  tuned: boolean;
}

export interface FlagPlanResult {
  plan: FlagOptionPlan[];
  /** Human-readable notes for the run log (skips, untuned fallbacks). */
  notes: string[];
}

export interface FlagPlanOptions {
  /** Eval arm (plan §5.7). Default false: misinformation is skipped even when enabled. */
  includeMisinformation?: boolean;
}

export class FlagPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagPlanError';
  }
}

function normalise(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * The first sentence of a description, clipped. Custom categories only: a
 * user's description is usually written as an instruction to an LLM, and its
 * first sentence is the closest thing to an act description it carries.
 */
export function customOptionText(description: string, maxChars = CUSTOM_OPTION_MAX_CHARS): string {
  const text = normalise(description);
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  let first = (m ? m[0] : text).trim();
  if (first.length > maxChars) first = first.slice(0, maxChars - 1).trimEnd() + '…';
  return first;
}

/**
 * The (category -> option text, proposition) plan for a run, in the user's
 * category order. Disabled categories drop; misinformation drops unless the
 * eval arm asks for it; a custom category runs on its clipped description
 * (logged as untuned); more than 25 enabled categories is refused.
 */
export function buildFlagPlan(categories: AnalysisCategory[], options: FlagPlanOptions = {}): FlagPlanResult {
  const plan: FlagOptionPlan[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const category of categories || []) {
    const name = normalise(category?.name);
    if (!name || category.enabled === false) continue;
    if (seen.has(name)) {
      notes.push(`Skipping duplicate category '${name}'`);
      continue;
    }
    if (name.toLowerCase() === NONE_KEY) {
      notes.push(`Skipping category '${name}': the name is reserved for the "none of these" option`);
      continue;
    }

    if (name === 'misinformation') {
      if (!options.includeMisinformation) {
        notes.push(
          "Skipping category 'misinformation' (parity with NLI, plan §5.7); it runs only as an eval arm " +
            '(includeMisinformation). BRIEFCASE_FLAGS_DISCOVERY=1 remains the misinformation path.',
        );
        continue;
      }
      const proposition = normalise(category.description) || MISINFORMATION_OPTION_TEXT;
      plan.push({ category: name, optionText: MISINFORMATION_OPTION_TEXT, proposition, tuned: true });
      seen.add(name);
      continue;
    }

    const tuned = SNAP_OPTION_TEXTS[name];
    if (tuned) {
      plan.push({ category: name, optionText: tuned, proposition: FLAG_PROPOSITIONS[name], tuned: true });
      seen.add(name);
      continue;
    }

    const description = normalise(category.description);
    if (!description) {
      notes.push(`Skipping category '${name}': no tuned option text and no description to fall back to`);
      continue;
    }
    const optionText = customOptionText(description);
    notes.push(
      `Category '${name}' has no tuned option text; running on the first sentence of its description ` +
        `(${JSON.stringify(optionText)}). Its hotness is uncalibrated.`,
    );
    // Same proposition the NLI ranker's buildPlan would use, so the verdict
    // cache is shared across rankers for custom categories too.
    plan.push({ category: name, optionText, proposition: description, tuned: false });
    seen.add(name);
  }

  if (plan.length > MAX_FLAG_CATEGORIES) {
    throw new FlagPlanError(
      `${plan.length} flag categories are enabled; the snap ranker supports at most ${MAX_FLAG_CATEGORIES} ` +
        `(26 answer letters, one reserved for "none"). Disable some categories or use the NLI ranker.`,
    );
  }
  return { plan, notes };
}

/** "political-demonization" -> "Political demonization" (the prefix layout's per-question option label). */
export function categoryTitle(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : name;
}
