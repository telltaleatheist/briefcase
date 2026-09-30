import { describe, expect, it, jest } from '@jest/globals';
import { AnalysisCancelledError } from './cancellation';
import {
  buildStoryGroupingPrompt,
  groupStories,
  parseStoryGrouping,
  runtimePhrase,
  storiesFromGrouping,
  StoryChapter,
} from './stories';

const ch = (startSeconds: number, endSeconds: number, title: string, summary = `About ${title}.`, isAd = false): StoryChapter =>
  ({ startSeconds, endSeconds, title, summary, isAd });

/** A 40-minute show shaped like the user's example: an intro and an argument, a sponsor, then new subjects. */
const SHOW = [
  ch(0, 120, 'Introduction and welcome'),
  ch(120, 600, 'Prophetic timeline and 9/11'),
  ch(600, 900, 'The Purim pattern and the book of Esther'),
  ch(900, 990, 'Sponsor / self-promotion', 'A sponsor read.', true),
  ch(990, 1500, 'The midterms'),
  ch(1500, 2000, 'AI'),
  ch(2000, 2400, 'Book promotion', 'Promoting the new book.', true),
];

describe('the grouping prompt', () => {
  it('lists every chapter with its times, sponsor mark and summary, states the runtime, and asks for no count', () => {
    const prompt = buildStoryGroupingPrompt(SHOW, 2400);
    expect(prompt).toContain('The video runs 40 minutes.');
    expect(prompt).toContain('1. [00:00:00-00:02:00] Introduction and welcome\n   About Introduction and welcome.');
    expect(prompt).toContain('4. [00:15:00-00:16:30] [SPONSOR] Sponsor / self-promotion\n   A sponsor read.');
    expect(prompt).toContain('<number of its first chapter> | <a short title for the story> | <one or two sentences on what the story covers>');
    // Models anchor on counts: none is given.
    expect(prompt).not.toMatch(/\b\d+ (?:to|-) \d+ stories\b/);
    expect(prompt).toContain('There is no expected number of stories');
  });

  it('a chapter with no summary is its title line alone', () => {
    expect(buildStoryGroupingPrompt([ch(0, 700, 'Only', ''), ch(700, 800, 'Next')], 800)).toContain('1. [00:00:00-00:11:40] Only\n2.');
  });

  it('runtimes read as a person says them', () => {
    expect(runtimePhrase(30)).toBe('1 minute');
    expect(runtimePhrase(2400)).toBe('40 minutes');
    expect(runtimePhrase(3900)).toBe('1 hour 5 minutes');
    expect(runtimePhrase(7200)).toBe('2 hours');
  });
});

describe('parseStoryGrouping', () => {
  it('reads story lines, tolerant of bullets, bold, fences, "Chapter 3" and a missing summary', () => {
    const read = parseStoryGrouping('```\n- **1 | The timeline | Why it lines up.**\nChapter 4 | Sponsor\n5 | "The midterms" | What they mean. | And more.\n```', 7);
    expect(read).toEqual({
      lines: [
        { firstChapter: 1, title: 'The timeline', summary: 'Why it lines up.' },
        { firstChapter: 4, title: 'Sponsor', summary: '' },
        { firstChapter: 5, title: 'The midterms', summary: 'What they mean. | And more.' },
      ],
    });
  });

  it('ignores lines that are not story lines', () => {
    expect(parseStoryGrouping('Here are the stories:\n1 | A | a.', 3)).toEqual({ lines: [{ firstChapter: 1, title: 'A', summary: 'a.' }] });
  });

  it('names what makes an answer unusable', () => {
    expect(parseStoryGrouping('', 3)).toEqual({ problem: 'it was empty' });
    expect(parseStoryGrouping('I cannot help with that.', 3)).toEqual({ problem: expect.stringContaining('no line had the form') });
    expect(parseStoryGrouping('2 | A | a.', 3)).toEqual({ problem: 'the first story must start at chapter 1, not 2' });
    expect(parseStoryGrouping('1 | A | a.\n3 | B | b.\n2 | C | c.', 3)).toEqual({ problem: expect.stringContaining('must be in order') });
    expect(parseStoryGrouping('1 | A | a.\n3 | B | b.\n3 | C | c.', 3)).toEqual({ problem: expect.stringContaining('must be in order') });
    expect(parseStoryGrouping('1 | A | a.\n9 | B | b.', 3)).toEqual({ problem: 'story "B" starts at chapter 9, but there are only 3 chapters' });
  });
});

describe('storiesFromGrouping', () => {
  it('the model\'s groups, each sponsor chapter its own story named by the chapter, the subject after it a new story', () => {
    const stories = storiesFromGrouping(SHOW, [
      { firstChapter: 1, title: 'The prophetic timeline', summary: 'Timeline.' },
      // The model kept the sponsor and the midterms together: code splits them.
      { firstChapter: 4, title: 'The midterms', summary: 'Midterms.' },
      { firstChapter: 6, title: 'AI', summary: 'AI.' },
    ]);
    expect(stories.map((s) => [s.title, s.firstChapter, s.lastChapter, s.startSeconds, s.endSeconds, s.isAd])).toEqual([
      ['The prophetic timeline', 0, 2, 0, 900, false],
      ['Sponsor / self-promotion', 3, 3, 900, 990, true],
      ['The midterms', 4, 4, 990, 1500, false],
      ['AI', 5, 5, 1500, 2000, false],
      ['Book promotion', 6, 6, 2000, 2400, true],
    ]);
    expect(stories[1].summary).toBe('A sponsor read.');
  });

  it('a subject either side of a sponsor inside one group is two stories with the group\'s title', () => {
    const stories = storiesFromGrouping(SHOW.slice(0, 5), [{ firstChapter: 1, title: 'All of it', summary: 's' }]);
    expect(stories.map((s) => [s.title, s.firstChapter, s.lastChapter])).toEqual([
      ['All of it', 0, 2],
      ['Sponsor / self-promotion', 3, 3],
      ['All of it', 4, 4],
    ]);
  });

  it('the stories tile the chapters', () => {
    const stories = storiesFromGrouping(SHOW, [{ firstChapter: 1, title: 'A', summary: '' }, { firstChapter: 3, title: 'B', summary: '' }]);
    for (let k = 1; k < stories.length; k++) expect(stories[k].firstChapter).toBe(stories[k - 1].lastChapter + 1);
    expect(stories[0].firstChapter).toBe(0);
    expect(stories[stories.length - 1].lastChapter).toBe(SHOW.length - 1);
  });
});

describe('groupStories', () => {
  it('under 10 minutes, or one chapter, is one story with no call', async () => {
    const generate = jest.fn(async () => ({ text: '', truncated: false }));
    for (const [list, total] of [[SHOW.slice(0, 3), 599], [[ch(0, 2400, 'Only')], 2400]] as const) {
      const res = await groupStories([...list], total, { generate });
      expect(res).toEqual({ calls: 0, stories: [expect.objectContaining({ firstChapter: 0, lastChapter: list.length - 1, isAd: false })] });
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('one call when the answer reads', async () => {
    const prompts: string[] = [];
    const res = await groupStories(SHOW, 2400, {
      generate: async (p) => {
        prompts.push(p);
        return { text: '1 | Timeline | t.\n5 | Midterms | m.\n6 | AI | a.', truncated: false };
      },
    });
    expect(prompts).toHaveLength(1);
    expect(res.calls).toBe(1);
    expect(res.stories.map((s) => s.title)).toEqual(['Timeline', 'Sponsor / self-promotion', 'Midterms', 'AI', 'Book promotion']);
  });

  it('an unusable answer is asked again with its problem; a second failure throws the reason', async () => {
    const prompts: string[] = [];
    const answers = ['9 | Late | x.', 'still nothing'];
    const err = await groupStories(SHOW, 2400, {
      generate: async (p) => {
        prompts.push(p);
        return { text: answers.shift()!, truncated: false };
      },
    }).catch((e) => e);
    expect(prompts[1]).toContain('Your previous answer could not be used: the first story must start at chapter 1, not 9.');
    expect((err as Error).message).toMatch(/^the stories could not be found: .*Last problem: no line had the form/);
  });

  it('a cut-off answer that reads is used; one that does not says it was cut off', async () => {
    const answers = [{ text: '1 | A | cut', truncated: true }];
    expect((await groupStories(SHOW, 2400, { generate: async () => answers.shift()! })).stories[0].title).toBe('A');
    const err = await groupStories(SHOW, 2400, { generate: async () => ({ text: '', truncated: true }) }).catch((e) => e);
    expect((err as Error).message).toContain('(the answer was cut off at the output limit)');
  });

  it('a model error fails with its message; a cancel propagates as it is', async () => {
    await expect(groupStories(SHOW, 2400, { generate: async () => { throw new Error('upstream 500'); } }))
      .rejects.toThrow('the stories could not be found: upstream 500');
    const cancel = new AnalysisCancelledError('cancelled');
    await expect(groupStories(SHOW, 2400, { generate: async () => { throw cancel; } })).rejects.toBe(cancel);
  });
});
