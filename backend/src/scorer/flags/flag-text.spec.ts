// Imported explicitly: the backend tsconfig pins "types": ["node"].
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

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
  DOES_NOT_FIT,
  FITS,
  START_OF_VIDEO,
  buildPass1Question,
  buildPass2Question,
  clip,
  defaultFlagState,
  flagLegendBlock,
} from './flag-questions';

const NLI_SOURCE = fs.readFileSync(path.join(__dirname, '../../analysis/nli-ranker.service.ts'), 'utf8');

describe('flag option texts', () => {
  it('has a tuned option text and proposition for every built-in category except misinformation', () => {
    for (const c of DEFAULT_CATEGORIES) {
      if (c.name === 'misinformation') continue;
      expect(SNAP_OPTION_TEXTS[c.name]).toBeTruthy();
      expect(FLAG_PROPOSITIONS[c.name]).toBeTruthy();
    }
    expect(Object.keys(SNAP_OPTION_TEXTS).sort()).toEqual(Object.keys(FLAG_PROPOSITIONS).sort());
  });

  it('keeps every proposition byte-identical to the NLI ranker (the verdict-cache hash depends on it)', () => {
    for (const text of Object.values(FLAG_PROPOSITIONS)) {
      expect(NLI_SOURCE.includes(`'${text}'`) || NLI_SOURCE.includes(`"${text}"`)).toBe(true);
    }
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

  it('pass 1, inline layout: the plan text verbatim, the full option texts, none last', () => {
    const q = buildPass1Question(0, 'They are all communists.', START_OF_VIDEO, plan, 'inline', 'last');
    expect(q.type).toBe('choice');
    expect(q.instructions).toBe(
      'Sentence from the transcript above: "They are all communists."\n' +
        '(The sentence just before it: "(start of the video)")\n' +
        'Which of these does the speaker do in this sentence?',
    );
    expect(q.options).toEqual([
      { name: 'hate', description: SNAP_OPTION_TEXTS.hate },
      { name: 'conspiracy', description: SNAP_OPTION_TEXTS.conspiracy },
      { name: 'none', description: NONE_OPTION_TEXT },
    ]);
  });

  it('pass 1, prefix layout: short labels in the question, full texts once in the state', () => {
    const q = buildPass1Question(3, 'cur', 'prev', plan, 'prefix', 'first');
    expect(q.name).toBe('p1:3');
    expect(q.instructions).toContain('Which of the categories listed above');
    expect(q.options.map((o) => o.name)).toEqual(['none', 'hate', 'conspiracy']);
    expect(q.options[1].description).toBe('Hate');
    const legend = flagLegendBlock(plan);
    expect(legend).toContain(`- hate: ${SNAP_OPTION_TEXTS.hate}`);
    expect(legend).toContain(`- none: ${NONE_OPTION_TEXT}`);
    expect(defaultFlagState(['a', 'b'], legend)).toBe(`a\nb\n\n${legend}`);
    expect(defaultFlagState(['a', 'b'], null)).toBe('a\nb');
    // The prefix layout's question is much shorter than the inline one.
    const inline = buildPass1Question(3, 'cur', 'prev', plan, 'inline', 'first');
    const size = (x: typeof q) => x.instructions.length + x.options.reduce((n, o) => n + o.description.length, 0);
    expect(size(q)).toBeLessThan(size(inline));
  });

  it('pass 2 is a two-option choice with both sides stated positively, never a yesno', () => {
    const q = buildPass2Question(7, 'cur', 'prev', plan[1]);
    expect(q.type).toBe('choice');
    expect(q.name).toBe('p2:7:conspiracy');
    expect(q.instructions).toContain(`Description: ${SNAP_OPTION_TEXTS.conspiracy}`);
    expect(q.instructions).toContain('Does this sentence fit the description below?');
    expect(q.options.map((o) => o.name)).toEqual([FITS, DOES_NOT_FIT]);
  });

  it('clips the sentence at 300 and the previous sentence at 200 chars', () => {
    const q = buildPass1Question(1, 'a'.repeat(500), 'b'.repeat(500), plan, 'inline', 'last');
    expect(q.instructions).toContain(`"${'a'.repeat(299)}…"`);
    expect(q.instructions).toContain(`"${'b'.repeat(199)}…"`);
    expect(clip('  short   text ', 300)).toBe('short text');
  });

  it('titles category keys for the prefix layout', () => {
    expect(categoryTitle('political-demonization')).toBe('Political demonization');
    expect(categoryTitle('my_custom')).toBe('My custom');
  });
});
