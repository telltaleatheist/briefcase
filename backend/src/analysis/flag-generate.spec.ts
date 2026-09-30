import { describe, expect, it } from '@jest/globals';
import {
  GENERATE_MAX_PASSAGE_SECONDS,
  splitLongPassage,
  anchorWords,
  buildGenerateFlagsPrompt,
  chunkSentences,
  chunkWords,
  DEFAULT_FLAG_FINDER,
  flagFinderOf,
  generateFlagsSchema,
  GENERATE_CHUNK_CHARS,
  GENERATE_CHUNK_OVERLAP_SENTENCES,
  matchPassage,
  parseGeneratedPassages,
  readFlagFinder,
  resolveCategoryName,
  windowsFromPassages,
} from './flag-generate';
import { buildFlagPlan, SNAP_OPTION_TEXTS, FLAG_PROPOSITIONS } from '../scorer/flags/flag-options';

/**
 * The pure half of "the model reads the transcript for flags": chunks, the
 * prompt and its schema, reading the answer, and finding each passage's words
 * in the transcript.
 */

const sentence = (i: number, len = 100) => ({ text: `S${i} `.padEnd(len - 1, 'x') + '.', start: i * 10, end: i * 10 + 10 });

describe('chunkSentences', () => {
  it('cuts at sentence boundaries, never over the size, two sentences of overlap, and covers everything', () => {
    const sentences = Array.from({ length: 250 }, (_u, i) => sentence(i));
    const chunks = chunkSentences(sentences);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const text = sentences.slice(chunk.from, chunk.to + 1).map((s) => s.text).join('\n');
      expect(text.length).toBe(chunk.chars);
      expect(chunk.chars).toBeLessThanOrEqual(GENERATE_CHUNK_CHARS);
    }
    // 100-char sentences, one per line: 79 of them are 7,978 characters, 80 would be 8,079.
    expect(chunks[0]).toEqual({ from: 0, to: 78, chars: 7978 });
    for (let k = 1; k < chunks.length; k++) {
      expect(chunks[k].from).toBe(chunks[k - 1].to + 1 - GENERATE_CHUNK_OVERLAP_SENTENCES);
    }
    expect(chunks[0].from).toBe(0);
    expect(chunks[chunks.length - 1].to).toBe(sentences.length - 1);
  });

  it('a short transcript is one chunk, and an over-long sentence is a chunk of its own (never split)', () => {
    expect(chunkSentences([sentence(0), sentence(1)])).toEqual([{ from: 0, to: 1, chars: 201 }]);
    const long = [sentence(0), { text: 'y'.repeat(9000) }, sentence(2)];
    const chunks = chunkSentences(long, 8000, 2);
    expect(chunks.map((c) => [c.from, c.to])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('always moves forward, even when the overlap covers a whole chunk', () => {
    const big = Array.from({ length: 6 }, () => ({ text: 'z'.repeat(5000) }));
    const chunks = chunkSentences(big, 8000, 2);
    expect(chunks.map((c) => c.from)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('matchPassage: the passage words, found in the chunk', () => {
  const chunk = [
    'Welcome back to the show, everybody.', // 0
    "The deep state rigged the election, and they're coming for your guns.", // 1
    'I mean it, folks.', // 2
    'Now, the weather in Tulsa.', // 3
  ];
  const words = chunkWords(chunk.map((text) => ({ text })));

  it('exact anchors, case and punctuation ignored', () => {
    expect(matchPassage(words, 'The deep state rigged the election', 'I mean it, folks.')).toEqual({ from: 1, to: 2 });
    expect(matchPassage(words, 'the deep state rigged', "they're coming for your guns")).toEqual({ from: 1, to: 1 });
  });

  it('fuzzy anchors: a misheard word, a dropped apostrophe, a missing word', () => {
    expect(matchPassage(words, 'The deep state riged the elections', 'theyre coming for you guns')).toEqual({ from: 1, to: 1 });
    expect(matchPassage(words, 'deep state rigged election and', 'I mean it folks')).toEqual({ from: 1, to: 2 });
  });

  it('words that are not in the chunk, or that end before the passage starts, are not found (never guessed)', () => {
    expect(matchPassage(words, 'the moon landing was faked by', 'I mean it folks')).toBeNull();
    expect(matchPassage(words, 'I mean it folks', 'welcome back to the show')).toBeNull();
    // A two-word anchor must match exactly.
    expect(matchPassage(words, 'deap stat', 'I mean it')).toBeNull();
  });

  it('a one-sentence passage whose first and last words overlap', () => {
    expect(matchPassage(words, 'I mean it', 'mean it folks')).toEqual({ from: 2, to: 2 });
  });

  it('normalises words the same way on both sides', () => {
    expect(anchorWords("They're — COMING, for “your” guns!")).toEqual(['theyre', 'coming', 'for', 'your', 'guns']);
  });
});

describe('the prompt and its schema', () => {
  const { plan } = buildFlagPlan([
    { name: 'conspiracy' },
    { name: 'hate' },
    { name: 'my-custom', description: 'Talks about lizard people running the bank. Flag loudly.' },
    { name: 'violence', enabled: false },
  ]);

  it('lists the enabled categories by their act descriptions, then the transcript', () => {
    const prompt = buildGenerateFlagsPrompt(plan, 'line one.\nline two.');
    expect(prompt).toContain(`- conspiracy: ${SNAP_OPTION_TEXTS['conspiracy']}`);
    expect(prompt).toContain(`- hate: ${SNAP_OPTION_TEXTS['hate']}`);
    expect(prompt).toContain('- my-custom: Talks about lizard people running the bank.');
    expect(prompt).not.toContain('violence');
    expect(prompt).toMatch(/Mark generously/);
    expect(prompt).toMatch(/first_words/);
    expect(prompt).toMatch(/last_words/);
    expect(prompt.endsWith('TRANSCRIPT:\nline one.\nline two.')).toBe(true);
  });

  it('carries no ban list and no incorrect example (the prompt-hygiene ruling)', () => {
    const prompt = buildGenerateFlagsPrompt(plan, 'x.');
    expect(prompt).not.toMatch(/\b(do not|don't|never|avoid|wrong|incorrect|bad example)\b/i);
  });

  it('the schema pins the shape, and category names to the enabled ones', () => {
    const schema = generateFlagsSchema(plan.map((p) => p.category)) as any;
    expect(schema.required).toEqual(['passages']);
    const item = schema.properties.passages.items;
    expect(item.required).toEqual(['first_words', 'last_words', 'categories']);
    expect(item.properties.categories.items.enum).toEqual(['conspiracy', 'hate', 'my-custom']);
    expect(item.additionalProperties).toBe(false);
  });
});

describe('parseGeneratedPassages', () => {
  it('reads the schema answer, and an empty list is an answer (not a failure)', () => {
    const answer = parseGeneratedPassages('{"passages":[{"first_words":"a b c","last_words":"d e f","categories":["hate"]}]}');
    expect(answer).toEqual({ passages: [{ firstWords: 'a b c', lastWords: 'd e f', categories: ['hate'] }], invalid: 0, whole: true });
    expect(parseGeneratedPassages('{"passages": []}')).toEqual({ passages: [], invalid: 0, whole: true });
    expect(parseGeneratedPassages('[]')).toEqual({ passages: [], invalid: 0, whole: true });
  });

  it('reads a cloud answer with no schema: prose and a fence around the JSON', () => {
    const text = 'Here are the passages I found:\n```json\n{"passages": [{"first_words": "They are vermin", "last_words": "thrown out", "categories": ["hate", "dehumanization"]}]}\n```\nLet me know if you need more.';
    expect(parseGeneratedPassages(text)?.passages).toEqual([
      { firstWords: 'They are vermin', lastWords: 'thrown out', categories: ['hate', 'dehumanization'] },
    ]);
  });

  it('a reply cut off mid-list keeps the passages written whole before the cut, and nothing past it', () => {
    const text = '{"passages":[{"first_words":"one two three","last_words":"four five","categories":["hate"]},{"first_words":"six seven","last_words":"eig';
    expect(parseGeneratedPassages(text)).toEqual({
      passages: [{ firstWords: 'one two three', lastWords: 'four five', categories: ['hate'] }],
      invalid: 0,
      whole: false,
    });
  });

  it('nothing readable is null; an item missing an anchor is counted, never guessed', () => {
    expect(parseGeneratedPassages('I could not find anything.')).toBeNull();
    expect(parseGeneratedPassages('')).toBeNull();
    const answer = parseGeneratedPassages('{"passages":[{"first_words":"a b","categories":["hate"]},{"first_words":"c","last_words":"d","category":"hate"}]}');
    expect(answer).toEqual({ passages: [{ firstWords: 'c', lastWords: 'd', categories: ['hate'] }], invalid: 1, whole: true });
  });

  it('category names are read up to case, spaces and hyphens; anything else is not an enabled category', () => {
    const names = ['political-demonization', 'hate'];
    expect(resolveCategoryName('hate', names)).toBe('hate');
    expect(resolveCategoryName('Political demonization', names)).toBe('political-demonization');
    expect(resolveCategoryName('political_demonization', names)).toBe('political-demonization');
    expect(resolveCategoryName('violence', names)).toBeNull();
  });
});

describe('windowsFromPassages', () => {
  const sentences = Array.from({ length: 30 }, (_u, i) => ({ text: `Sentence ${i}.`, start: i * 4, end: i * 4 + 4 }));
  const { plan } = buildFlagPlan([{ name: 'hate' }, { name: 'conspiracy' }]);

  it('one window per passage, the times from the sentences, propositions from the plan, no score', () => {
    const windows = windowsFromPassages(sentences, [{ from: 20, to: 22, categories: ['conspiracy'] }], plan);
    expect(windows).toHaveLength(1);
    // Context as the snap path's windows get it: two sentences each side, within 25 s.
    expect(windows[0]).toMatchObject({ firedFrom: 20, firedTo: 22, contextFrom: 18, contextTo: 23, score: 0 });
    expect(windows[0].categories).toEqual([
      expect.objectContaining({ category: 'conspiracy', proposition: FLAG_PROPOSITIONS['conspiracy'], score: 0, sentenceIndices: [20, 21, 22], start: 80, end: 92 }),
    ]);
  });

  it('the same passage from two overlapping chunks is one candidate; nearby passages merge category-blind', () => {
    const windows = windowsFromPassages(
      sentences,
      [
        { from: 5, to: 6, categories: ['hate'] },
        { from: 5, to: 6, categories: ['hate'] },
        { from: 7, to: 7, categories: ['conspiracy'] },
        { from: 25, to: 25, categories: ['hate', 'unknown-one'] },
      ],
      plan,
    );
    expect(windows.map((w) => [w.firedFrom, w.firedTo, w.categories.map((c) => c.category)])).toEqual([
      [5, 7, ['hate', 'conspiracy']],
      [25, 25, ['hate']],
    ]);
  });
});

describe('splitLongPassage', () => {
  // A sentence every 10 s.
  const sentences = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, end: i * 10 + 10 }));

  it('keeps a passage within 90 s whole, and cuts a 3-minute one into pieces of at most 90 s between sentences', () => {
    expect(splitLongPassage(sentences, { from: 2, to: 9, categories: ['hate'] })).toEqual([{ from: 2, to: 9, categories: ['hate'] }]);
    const pieces = splitLongPassage(sentences, { from: 0, to: 17, categories: ['hate', 'conspiracy'] });
    expect(pieces).toEqual([
      { from: 0, to: 8, categories: ['hate', 'conspiracy'] },
      { from: 9, to: 17, categories: ['hate', 'conspiracy'] },
    ]);
    for (const p of pieces) expect(sentences[p.to].end - sentences[p.from].start).toBeLessThanOrEqual(GENERATE_MAX_PASSAGE_SECONDS);
  });

  it('a single sentence longer than the cap stays whole', () => {
    expect(splitLongPassage([{ start: 0, end: 200 }], { from: 0, to: 0, categories: ['hate'] })).toEqual([{ from: 0, to: 0, categories: ['hate'] }]);
  });
});

describe('the setting', () => {
  it('generate is the default; snap is kept; anything else is refused by name', () => {
    expect(DEFAULT_FLAG_FINDER).toBe('generate');
    expect(flagFinderOf(undefined)).toBe('generate');
    expect(flagFinderOf('snap')).toBe('snap');
    expect(flagFinderOf('nonsense')).toBe('generate');
    expect(readFlagFinder({ finder: 'snap' })).toBe('snap');
    expect(readFlagFinder({ finder: 'generate' })).toBe('generate');
    expect(readFlagFinder({ finder: 'decide' })).toBe('finder must be "generate" or "snap"');
  });
});
