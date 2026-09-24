// Imported explicitly: the backend tsconfig pins "types": ["node"].
import { describe, expect, it } from '@jest/globals';
import { createHash } from 'crypto';

import { DEFAULT_CATEGORIES } from '../../analysis/prompts/analysis-prompts';
import {
  CUSTOM_OPTION_MAX_CHARS,
  FLAG_PROPOSITIONS,
  FlagPlanError,
  MAX_FLAG_CATEGORIES,
  MISINFORMATION_OPTION_TEXT,
  NONE_OPTION_TEXT,
  SNAP_OPTION_TEXTS,
  buildFlagPlan,
  categoryTitle,
  customOptionText,
} from './flag-options';
import {
  GROUP_UNIT_CHARS,
  buildGroupQuestion,
  clip,
  defaultFlagState,
  flagLegendBlock,
} from './flag-questions';

describe('flag option texts', () => {
  it('has a tuned option text and proposition for every built-in category except misinformation', () => {
    for (const c of DEFAULT_CATEGORIES) {
      if (c.name === 'misinformation') continue;
      expect(SNAP_OPTION_TEXTS[c.name]).toBeTruthy();
      expect(FLAG_PROPOSITIONS[c.name]).toBeTruthy();
    }
    expect(Object.keys(SNAP_OPTION_TEXTS).sort()).toEqual(Object.keys(FLAG_PROPOSITIONS).sort());
  });

  it('keeps every proposition byte-identical to the ones stored verdicts were asked with (the verdict-cache hash depends on it)', () => {
    // Pinned when P7 removed the NLI ranker these were copied from. A change
    // here makes every cached verdict a miss: change the pin only on purpose.
    const entries = Object.entries(FLAG_PROPOSITIONS).sort(([a], [b]) => a.localeCompare(b));
    expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
      'f4374cae73edc0e668230e1bd7b9a8e796fd009bdbf15a48d454f41dd6d50028',
    );
  });

  it('never uses the LLM-instruction descriptions as option text', () => {
    for (const c of DEFAULT_CATEGORIES) {
      const text = SNAP_OPTION_TEXTS[c.name];
      if (!text) continue;
      expect(text).not.toMatch(/NOTE|flag|Do NOT/);
      expect(text).not.toContain('\n');
      expect(text.length).toBeLessThan(140);
    }
  });
});

describe('buildFlagPlan', () => {
  it('keeps the user order, drops disabled categories, and skips misinformation by default', () => {
    const { plan, notes } = buildFlagPlan([
      { name: 'violence' },
      { name: 'hate', enabled: false },
      { name: 'misinformation' },
      { name: 'conspiracy', enabled: true },
    ]);
    expect(plan.map((p) => p.category)).toEqual(['violence', 'conspiracy']);
    expect(plan.every((p) => p.tuned)).toBe(true);
    expect(notes.some((n) => n.includes("'misinformation'"))).toBe(true);
  });

  it('includes misinformation only in the eval arm', () => {
    const { plan } = buildFlagPlan([{ name: 'misinformation', description: 'False claims.' }], {
      includeMisinformation: true,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].optionText).toBe(MISINFORMATION_OPTION_TEXT);
  });

  it('runs a custom category without a hypothesis on the first sentence of its description', () => {
    const description =
      'Claims that   the moon landing was faked. NOTE: do NOT flag documentaries about it. More rules here.';
    const { plan, notes } = buildFlagPlan([{ name: 'moon-hoax', description }]);
    expect(plan).toEqual([
      {
        category: 'moon-hoax',
        optionText: 'Claims that the moon landing was faked.',
        // Same proposition the NLI buildPlan uses, so the verdict cache is shared.
        proposition: description.replace(/\s+/g, ' ').trim(),
        tuned: false,
      },
    ]);
    expect(notes.some((n) => n.includes("'moon-hoax'") && n.includes('no tuned option text'))).toBe(true);
  });

  it('clips a long custom first sentence and skips a custom category with no description', () => {
    const long = 'x'.repeat(400);
    expect(customOptionText(long)).toHaveLength(CUSTOM_OPTION_MAX_CHARS);
    expect(customOptionText(long).endsWith('…')).toBe(true);
    const { plan, notes } = buildFlagPlan([{ name: 'empty-one', description: '  ' }]);
    expect(plan).toEqual([]);
    expect(notes[0]).toContain("'empty-one'");
  });

  it("reserves 'none' and refuses more than 25 categories", () => {
    expect(buildFlagPlan([{ name: 'none', description: 'x.' }]).plan).toEqual([]);
    const many = Array.from({ length: MAX_FLAG_CATEGORIES + 1 }, (_, i) => ({ name: `c${i}`, description: `Cat ${i}.` }));
    expect(() => buildFlagPlan(many)).toThrow(FlagPlanError);
    expect(buildFlagPlan(many.slice(0, MAX_FLAG_CATEGORIES)).plan).toHaveLength(MAX_FLAG_CATEGORIES);
  });
});

describe('questions', () => {
  const { plan } = buildFlagPlan([{ name: 'hate' }, { name: 'conspiracy' }]);

  it('a group, inline layout: the passage QUOTED (never an index), the full option texts, none last', () => {
    const q = buildGroupQuestion(0, ['They are all communists.', 'Every one of them.', 'Lock them up.'], plan, 'inline', 'last');
    expect(q.type).toBe('choice');
    expect(q.instructions).toBe(
      'Passage from the transcript above: "They are all communists. Every one of them. Lock them up."\n' +
        'Which of these does the speaker do in this passage?',
    );
    expect(q.options).toEqual([
      { name: 'hate', description: SNAP_OPTION_TEXTS.hate },
      { name: 'conspiracy', description: SNAP_OPTION_TEXTS.conspiracy },
      { name: 'none', description: NONE_OPTION_TEXT },
    ]);
  });

  it('a group, prefix layout: short labels in the question, full texts once in the state', () => {
    const q = buildGroupQuestion(3, ['a', 'b', 'c'], plan, 'prefix', 'first');
    expect(q.name).toBe('g:3');
    expect(q.instructions).toContain('Which of the categories listed above');
    expect(q.options.map((o) => o.name)).toEqual(['none', 'hate', 'conspiracy']);
    expect(q.options[1].description).toBe('Hate');
    const legend = flagLegendBlock(plan);
    expect(legend).toContain(`- hate: ${SNAP_OPTION_TEXTS.hate}`);
    expect(legend).toContain(`- none: ${NONE_OPTION_TEXT}`);
    expect(defaultFlagState(['a', 'b'], legend)).toBe(`a\nb\n\n${legend}`);
    expect(defaultFlagState(['a', 'b'], null)).toBe('a\nb');
    // The prefix layout's question is much shorter than the inline one.
    const inline = buildGroupQuestion(3, ['a', 'b', 'c'], plan, 'inline', 'first');
    const size = (x: typeof q) => x.instructions.length + x.options.reduce((n, o) => n + o.description.length, 0);
    expect(size(q)).toBeLessThan(size(inline));
  });

  it('clips each quoted unit at GROUP_UNIT_CHARS', () => {
    const q = buildGroupQuestion(1, ['a'.repeat(500), 'b'], plan, 'inline', 'last');
    expect(q.instructions).toContain(`"${'a'.repeat(GROUP_UNIT_CHARS - 1)}… b"`);
    expect(clip('  short   text ', 300)).toBe('short text');
  });

  it('titles category keys for the prefix layout', () => {
    expect(categoryTitle('political-demonization')).toBe('Political demonization');
    expect(categoryTitle('my_custom')).toBe('My custom');
  });
});
