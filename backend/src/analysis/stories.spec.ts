import { describe, expect, it } from '@jest/globals';
import type { RankedSentence } from './flag-windows';
import { AnalysisCancelledError } from './cancellation';
import {
  buildStoriesPrompt,
  buildStoryPairPrompt,
  buildStoryTitlePrompt,
  findStories,
  mapStoryQuotes,
  oneStory,
  parsePairAnswer,
  parseStoryAnswer,
  parseStoryTitle,
  runtimePhrase,
  storyBand,
  storyCallBudget,
  storySpans,
  storyWindows,
  STORY_MIN_GAP_SECONDS,
  StoryGenerateResult,
} from './stories';

/** A 20-minute show: four subjects, 5 minutes each, one sentence every 20 s. */
const SUBJECTS = [
  ['The city council voted on the new stadium deal last night', 'stadium'],
  ['Now over to the weather service and the storm warning for the coast', 'storm'],
  ['Our next story is about the school board and its book ban vote', 'school'],
  ['Finally a word about the county fair and its giant pumpkin contest', 'fair'],
] as const;

function show(): RankedSentence[] {
  const out: RankedSentence[] = [];
  SUBJECTS.forEach(([opener, word], k) => {
    for (let i = 0; i < 15; i++) {
      const t = k * 300 + i * 20;
      out.push({ start: t, end: t + 20, text: i === 0 ? `${opener}.` : `${word} ${word} remark ${i} on the ${word} ${word} matter.` });
    }
  });
  return out;
}

const answer = (text: string, truncated = false): StoryGenerateResult => ({ text, truncated });

describe('the story prompt', () => {
  it('states the runtime once, gives no timestamps, and asks for titles and verbatim first sentences', () => {
    const p = buildStoriesPrompt('line one\nline two', 42 * 60);
    expect(p).toContain('Below is the complete transcript of one video, with no timestamps. The video runs 42 minutes.');
    expect(p).toContain('TRANSCRIPT:\nline one\nline two');
    expect(p).toContain('the way the next video in a playlist would start');
    expect(p).toContain('Each item of a news broadcast is its own story.');
    expect(p).toContain('A sponsor read or a plug belongs to the story around it.');
    expect(p).toContain('OPENING: <a short title for it>');
    expect(p).toContain('copied from the transcript above EXACTLY as it appears there, word for word, at least 6 words long');
    expect(p).toContain('usually holds 1 to 8 stories, and one that stays on one subject is one story');
    expect(p).not.toMatch(/\d\d:\d\d/);
  });

  it('a window is told it is one part, and its own runtime', () => {
    const p = buildStoriesPrompt('x', 70 * 60, { index: 2, total: 3 });
    expect(p).toContain('Below is part 2 of 3 of one video\'s transcript, with no timestamps. This part runs 1 hour 10 minutes.');
    expect(p).toContain('List the stories this part tells');
  });

  it('a loose band by runtime, one story always allowed below 90 minutes', () => {
    expect(storyBand(15 * 60)).toBe('1 to 4 stories');
    expect(storyBand(60 * 60)).toBe('1 to 8 stories');
    expect(storyBand(4 * 3600)).toBe('3 to 15 stories');
    expect(runtimePhrase(3600)).toBe('1 hour');
    expect(runtimePhrase(59)).toBe('1 minute');
  });
});

describe('reading the answer', () => {
  it('reads the OPENING line and "title | sentence" lines, tolerating numbering, bold and quotes', () => {
    const a = parseStoryAnswer(
      '```\n**OPENING:** Stadium deal\n1. Storm warning | "Now over to the weather service and the storm warning for the coast."\n- School board | Our next story is about the school board\nHere you go!\n```',
    );
    expect(a).toEqual({
      opening: 'Stadium deal',
      stories: [
        { title: 'Storm warning', quote: 'Now over to the weather service and the storm warning for the coast.' },
        { title: 'School board', quote: 'Our next story is about the school board' },
      ],
      unreadable: ['Here you go!'],
    });
  });

  it('an answer with neither form is unreadable (null); OPENING alone is one story', () => {
    expect(parseStoryAnswer('I cannot do that.')).toBeNull();
    expect(parseStoryAnswer('')).toBeNull();
    expect(parseStoryAnswer('OPENING: The only subject')).toEqual({ opening: 'The only subject', stories: [], unreadable: [] });
  });
});

describe('quote mapping (forward cursor)', () => {
  const s = show();

  it('an exact quote maps to its sentence', () => {
    const { starts, dropped } = mapStoryQuotes(s, [{ title: 'Storm', quote: 'Now over to the weather service and the storm warning for the coast.' }]);
    expect(dropped).toEqual([]);
    expect(starts).toEqual([{ sentence: 15, title: 'Storm', quote: 'Now over to the weather service and the storm warning for the coast.' }]);
  });

  it('a fuzzy quote (ASR spelling, punctuation, case) maps to the same sentence', () => {
    const { starts } = mapStoryQuotes(s, [{ title: 'School', quote: 'our next story is about the skool board, and its book-ban vote' }]);
    expect(starts.map((x) => x.sentence)).toEqual([30]);
  });

  it('an unplaceable quote is dropped and named, never approximated', () => {
    const { starts, dropped } = mapStoryQuotes(s, [
      { title: 'Invented', quote: 'The submarine fleet departed Reykjavik before dawn today' },
      { title: 'Short', quote: 'The fair' },
    ]);
    expect(starts).toEqual([]);
    expect(dropped.map((d) => [d.title, d.reason])).toEqual([
      ['Invented', 'not found'],
      ['Short', 'too short'],
    ]);
  });

  it('a quote found only before the previous start is dropped as out of order', () => {
    const { starts, dropped } = mapStoryQuotes(s, [
      { title: 'School', quote: 'Our next story is about the school board and its book ban vote' },
      { title: 'Storm', quote: 'Now over to the weather service and the storm warning for the coast' },
      { title: 'Fair', quote: 'Finally a word about the county fair and its giant pumpkin contest' },
    ]);
    expect(starts.map((x) => [x.title, x.sentence])).toEqual([
      ['School', 30],
      ['Fair', 45],
    ]);
    expect(dropped).toEqual([{ title: 'Storm', quote: expect.any(String), reason: 'out of order' }]);
  });
});

describe('tiling the stories', () => {
  const s = show();

  it('the opening story starts at 0, each ends where the next starts, the last at the video end', () => {
    const { stories, merged } = storySpans(s, [
      { sentence: 15, title: 'Storm', quote: 'q1' },
      { sentence: 45, title: 'Fair', quote: 'q3' },
    ], 'Stadium', 1200);
    expect(merged).toBe(0);
    expect(stories).toEqual([
      { title: 'Stadium', startSentence: 0, startSeconds: 0, endSeconds: 300 },
      { title: 'Storm', startSentence: 15, startSeconds: 300, endSeconds: 900, quote: 'q1' },
      { title: 'Fair', startSentence: 45, startSeconds: 900, endSeconds: 1200, quote: 'q3' },
    ]);
  });

  it(`a start within ${STORY_MIN_GAP_SECONDS}s of the one before, or the opening quoted again, is not doubled`, () => {
    const { stories, merged } = storySpans(s, [
      { sentence: 0, title: 'Stadium again', quote: 'q0' },
      { sentence: 15, title: 'Storm', quote: 'q1' },
      { sentence: 16, title: 'Storm again', quote: 'q1b' },
    ], null, 1200);
    expect(merged).toBe(2);
    expect(stories.map((x) => [x.title, x.startSeconds, x.endSeconds])).toEqual([
      ['Stadium again', 0, 300],
      ['Storm', 300, 1200],
    ]);
  });

  it('oneStory spans the video, untitled', () => {
    expect(oneStory(480)).toEqual([{ title: '', startSentence: 0, startSeconds: 0, endSeconds: 480 }]);
  });
});

describe('windows', () => {
  it('one window when it fits; overlapping windows at sentence boundaries when not', () => {
    const s = show();
    const total = s.reduce((n, x) => n + x.text.length + 1, 0);
    expect(storyWindows(s, total + 10)).toEqual([{ from: 0, to: 59, chars: total - 1 }]);
    const w = storyWindows(s, 1200, 0.25);
    expect(w.length).toBeGreaterThan(2);
    expect(w[0].from).toBe(0);
    expect(w[w.length - 1].to).toBe(59);
    for (let k = 1; k < w.length; k++) {
      expect(w[k].from).toBeLessThanOrEqual(w[k - 1].to); // overlap
      expect(w[k].from).toBeGreaterThan(w[k - 1].from); // forward
      expect(w[k].chars).toBeLessThanOrEqual(1200);
    }
  });

  it('the budget: Claude takes a 4-hour transcript in one call; a small window leaves a quarter for output', () => {
    expect(storyCallBudget(128000).maxChars).toBeGreaterThan(220000);
    expect(storyCallBudget(128000).maxOutputTokens).toBe(8192);
    expect(storyCallBudget(4096)).toEqual({ maxChars: (4096 - 1024 - 1024) * 3, maxOutputTokens: 1024 });
  });
});

describe('findStories', () => {
  const s = show();

  it('one call reads the whole transcript; the quotes become the stories', async () => {
    const prompts: string[] = [];
    const found = await findStories(s, 1200, {
      maxChars: 100000,
      maxOutputTokens: 8192,
      generate: async (prompt) => {
        prompts.push(prompt);
        return answer(
          'OPENING: Stadium deal\n' +
            'Storm warning | Now over to the weather service and the storm warning for the coast.\n' +
            'School board | Our next story is about the school board and its book ban vote.\n' +
            'County fair | Finally a word about the county fair and its giant pumpkin contest.',
        );
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('The video runs 20 minutes.');
    expect(found.stories.map((x) => [x.title, x.startSeconds, x.endSeconds])).toEqual([
      ['Stadium deal', 0, 300],
      ['Storm warning', 300, 600],
      ['School board', 600, 900],
      ['County fair', 900, 1200],
    ]);
    expect(found.warnings).toEqual([]);
    expect(found.pairQuestions).toBe(0);
  });

  it('dropped quotes are named in the warnings; a cut-off answer is a named warning', async () => {
    const found = await findStories(s, 1200, {
      maxChars: 100000,
      maxOutputTokens: 8192,
      generate: async () =>
        answer('OPENING: Stadium\nStorm | Now over to the weather service and the storm warning for the coast.\nMade up | The submarine fleet departed Reykjavik before dawn', true),
    });
    expect(found.stories.map((x) => x.title)).toEqual(['Stadium', 'Storm']);
    expect(found.warnings).toEqual([
      'Stories: the story list reached the model\'s output limit (8192 tokens) in the transcript; stories after the cut were not listed.',
      'Stories: 1 of the 2 story starts the model gave could not be placed in the transcript and were dropped: "Made up" (not found: "The submarine fleet departed Reykjavik before dawn")',
    ]);
  });

  it('every start dropped: one story spanning the video, NAMED in the warnings', async () => {
    const found = await findStories(s, 1200, {
      maxChars: 100000,
      maxOutputTokens: 8192,
      generate: async () => answer('OPENING: Everything\nMade up | The submarine fleet departed Reykjavik before dawn'),
    });
    expect(found.stories).toEqual([{ title: 'Everything', startSentence: 0, startSeconds: 0, endSeconds: 1200 }]);
    expect(found.warnings[found.warnings.length - 1]).toBe(
      'Stories: none of the 1 story starts the model gave could be placed, so the whole video is one story.',
    );
  });

  it('an unreadable answer or a failed call fails the stage with the reason; a cancel propagates as it is', async () => {
    const base = { maxChars: 100000, maxOutputTokens: 8192 };
    await expect(findStories(s, 1200, { ...base, generate: async () => answer('Sorry, no.') })).rejects.toThrow(
      'the stories could not be found: the answer held no story lines',
    );
    await expect(
      findStories(s, 1200, {
        ...base,
        generate: async () => {
          throw new Error('upstream 500');
        },
      }),
    ).rejects.toThrow('the stories could not be found: upstream 500');
    await expect(
      findStories(s, 1200, {
        ...base,
        generate: async () => {
          throw new AnalysisCancelledError('stop');
        },
      }),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
  });

  it('windowed reading: starts from each window, overlap duplicates merged, then adjacent pairs asked and merged while same', async () => {
    const calls: Array<{ kind: string; prompt: string }> = [];
    // Each window reports every subject opener it holds (the overlap repeats some)
    // and, being windowed, invents a split inside the school story.
    const found = await findStories(s, 1200, {
      maxChars: 2000,
      maxOutputTokens: 8192,
      generate: async (prompt, kind) => {
        calls.push({ kind, prompt });
        if (kind === 'pair') {
          // Part B's head is the school story's middle: the same story as A.
          return answer(prompt.includes('PART B (its start):\nschool school remark 8') ? 'same' : 'different');
        }
        const found: Array<[number, string]> = [];
        for (const [opener, word] of SUBJECTS) if (prompt.includes(opener)) found.push([prompt.indexOf(opener), `${word} | ${opener}.`]);
        const extra = 'school school remark 8 on the school school matter.';
        if (prompt.includes(extra)) found.push([prompt.indexOf(extra), `school, part two | ${extra}`]);
        const lines = ['OPENING: whatever this part opens with', ...found.sort((a, b) => a[0] - b[0]).map(([, line]) => line)];
        return answer(lines.join('\n'));
      },
    });
    const reads = calls.filter((c) => c.kind === 'stories');
    expect(reads.length).toBe(found.windows);
    expect(found.windows).toBeGreaterThan(1);
    expect(reads[0].prompt).toContain(`part 1 of ${found.windows}`);
    expect(found.stories.map((x) => [x.title, x.startSeconds, x.endSeconds])).toEqual([
      ['whatever this part opens with', 0, 300],
      ['storm', 300, 600],
      ['school', 600, 900],
      ['fair', 900, 1200],
    ]);
    expect(found.pairMerges).toBe(1);
    expect(found.pairQuestions).toBe(calls.filter((c) => c.kind === 'pair').length);
    expect(found.pairQuestions).toBe(4);
  });

  it('the pair prompt quotes A\'s tail and B\'s head; its answer is read by its first word', () => {
    const p = buildStoryPairPrompt('end of a', 'start of b');
    expect(p).toContain('PART A (its end):\nend of a');
    expect(p).toContain('PART B (its start):\nstart of b');
    expect(p).toContain('Answer with one word: same or different.');
    expect(parsePairAnswer('Same.')).toBe('same');
    expect(parsePairAnswer('<think>x</think>different')).toBe('different');
    expect(parsePairAnswer('maybe')).toBeNull();
  });
});

describe('a story titled from its chapters', () => {
  it('lists the chapters with their summaries and reads one line back', () => {
    const p = buildStoryTitlePrompt([{ title: 'A', summary: 'first' }, { title: 'B', summary: '' }]);
    expect(p).toContain('1. A: first\n2. B');
    expect(parseStoryTitle('\n**Title:** "The stadium deal"\n')).toBe('The stadium deal');
    expect(parseStoryTitle('   ')).toBeNull();
  });
});
