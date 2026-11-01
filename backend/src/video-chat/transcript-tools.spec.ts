import { describe, expect, it } from '@jest/globals';
import { chatTranscript, Coverage, type StoredChapter } from './chat-transcript';
import { outlineTool, READ_PAGE_CHARS, readTool, SEARCH_PAGE_HITS, searchTool } from './transcript-tools';

/**
 * The reading tools Ask gives every answer: outline (chapters, or ten-minute
 * parts), search (paging, whole words, regex, the spread over chapters) and
 * read (paging, by chapter), with the coverage line Briefcase keeps.
 */

/** A long video: one sentence every 30 s for `minutes`, every tenth naming Trump, one with an apostrophe. */
function longVideo(minutes: number) {
  return Array.from({ length: minutes * 2 }, (_u, i) => ({
    start: i * 30,
    end: i * 30 + 28,
    text: i % 10 === 0 ? `Sentence ${i + 1} is about Trump and the court.` : i === 7 ? "We don't start until the art department arrives." : `Sentence ${i + 1} is about the budget and nothing else at all.`,
  }));
}

const chapters: StoredChapter[] = [
  { title: 'Cold open', summary: 'The hosts say hello.', start: 0, end: 600 },
  { title: 'The budget', summary: 'The budget fight in Congress, at length.', start: 600, end: 2400 },
  { title: 'The ruling', summary: null, start: 2400, end: 3600 },
];

const run = (tool: { execute: (args: Record<string, unknown>, ctx: object) => Promise<{ content: string; data?: unknown }> }, args: Record<string, unknown>) =>
  tool.execute(args, {});

describe('outline', () => {
  it('with stored chapters: title, summary, times and sentence numbers, plus the length and count', async () => {
    const transcript = chatTranscript(longVideo(60), { chapters, duration: 3600 });
    const { content } = await run(outlineTool(transcript, 'Budget night'), {});
    expect(content).toContain('"Budget night": 1 hour (00:00:00–01:00:00), 120 sentences.');
    expect(content).toContain('Chapters:');
    expect(content).toContain('1. 00:00:00–00:10:00, sentences 1–20: "Cold open" — The hosts say hello.');
    expect(content).toContain('2. 00:10:00–00:40:00, sentences 21–80: "The budget" — The budget fight in Congress, at length.');
    expect(content).toContain('3. 00:40:00–01:00:00, sentences 81–120: "The ruling"');
  });

  it('without chapters: even ten-minute parts, each shown by its first sentence; a silent stretch is left out', async () => {
    const sentences = longVideo(30).filter((s) => s.start < 600 || s.start >= 1200);
    const transcript = chatTranscript(sentences, { duration: 1800 });
    const { content } = await run(outlineTool(transcript, 'Budget night'), {});
    expect(content).toContain('This video has no chapters; here it is in ten-minute parts');
    expect(content).toContain('1. 00:00:00–00:10:00, sentences 1–20: "Sentence 1 is about Trump and the court."');
    expect(content).toContain('2. 00:20:00–00:30:00, sentences 21–40: "Sentence 41 is about Trump and the court."');
    expect(content).not.toContain('3. ');
  });
});

describe('search', () => {
  const transcript = chatTranscript(longVideo(240), { chapters, duration: 14400 });

  it('every match, numbered and timed, with the count and how they spread over the chapters', async () => {
    const { content } = await run(searchTool(chatTranscript(longVideo(60), { chapters })), { pattern: 'trump' });
    expect(content).toContain('"trump" (case-insensitive) matches 12 sentences. By chapter: 1 "Cold open" ×2, 2 "The budget" ×6, 3 "The ruling" ×4.');
    expect(content).toContain('[11] 00:05:00 Sentence 11 is about Trump and the court.');
    expect(content).toContain('That is every match.');
  });

  it(`pages of ${SEARCH_PAGE_HITS}: says how many remain, and offset lists them`, async () => {
    const first = (await run(searchTool(transcript), { pattern: 'Trump' })).content;
    expect(first).toContain('matches 48 sentences');
    const many = (await run(searchTool(transcript), { pattern: 'budget' })).content;
    expect(many).toContain('matches 431 sentences');
    expect(many).toContain('Matches 1–50:');
    expect(many).toContain('381 more: search again with offset 50.');
    const next = (await run(searchTool(transcript), { pattern: 'budget', offset: 50 })).content;
    expect(next).toContain('Matches 51–100:');
    expect((await run(searchTool(transcript), { pattern: 'budget', offset: 500 })).content).toContain('offset 500 is past them all');
  });

  it('whole words, a literal apostrophe either way, and a regular expression', async () => {
    const t = chatTranscript(longVideo(10));
    expect((await run(searchTool(t), { pattern: 'art' })).content).toContain('matches 1 sentences');
    expect((await run(searchTool(t), { pattern: 'art', whole_word: true })).content).toContain('[8] 00:03:30 We don');
    expect((await run(searchTool(t), { pattern: 'tar', whole_word: true })).content).toMatch(/^No sentence matches "tar" \(case-insensitive, whole words\)/);
    expect((await run(searchTool(t), { pattern: 'don’t' })).content).toContain('matches 1 sentences');
    expect((await run(searchTool(t), { pattern: 'trump|art department', regex: true })).content).toContain('matches 3 sentences');
    // Without regex, the pattern is text: its | is a character.
    expect((await run(searchTool(t), { pattern: 'trump|art' })).content).toMatch(/^No sentence matches/);
  });

  it('a regular expression that does not compile, or no pattern, is refused naming why', async () => {
    await expect(run(searchTool(transcript), { pattern: 'trump(', regex: true })).rejects.toThrow(/"trump\(" is not a regular expression this search can read \(.+\)/);
    await expect(run(searchTool(transcript), { pattern: '  ' })).rejects.toThrow('the arguments have no pattern');
    await expect(run(searchTool(transcript), { pattern: 'x', offset: -1 })).rejects.toThrow('offset must be');
  });
});

describe('read', () => {
  const transcript = chatTranscript(longVideo(240), { chapters, duration: 14400 });

  it(`a page of at most ${READ_PAGE_CHARS} characters, numbered and timed, saying where to continue; marked read`, async () => {
    const coverage = new Coverage(transcript, false);
    const page = await run(readTool(transcript, coverage), { from: 1 });
    const lines = page.content.split('\n');
    expect(lines[0]).toMatch(/^Sentences 1–\d+ of 480 \(00:00:00–\d{2}:\d{2}:\d{2}\):$/);
    expect(lines[1]).toBe('[1] 00:00:00 Sentence 1 is about Trump and the court.');
    expect(lines.slice(1, -1).join('\n').length).toBeLessThanOrEqual(READ_PAGE_CHARS);
    const last = (page.data as { to: number }).to;
    expect(lines[lines.length - 1]).toBe(`The page ends here; continue with read from ${last + 2}.`);
    expect(coverage.line()).toBe(`Read so far: sentences 1–${last + 1} (00:00:00–${lines[0].match(/–(\d{2}:\d{2}:\d{2})\)/)![1]}) of 480. Unread: ${last + 2}–480.`);
  });

  it('count limits a page; the last page says it is the end', async () => {
    const coverage = new Coverage(transcript, false);
    const short = await run(readTool(transcript, coverage), { from: 10, count: 3 });
    expect(short.content.split('\n')).toEqual([
      'Sentences 10–12 of 480 (00:04:30–00:05:58):',
      '[10] 00:04:30 Sentence 10 is about the budget and nothing else at all.',
      '[11] 00:05:00 Sentence 11 is about Trump and the court.',
      '[12] 00:05:30 Sentence 12 is about the budget and nothing else at all.',
      'Next: read from 13.',
    ]);
    const end = await run(readTool(transcript, coverage), { from: 479 });
    expect(end.content).toMatch(/This is the end of the transcript\.$/);
    expect(coverage.line()).toBe('Read so far: sentences 10–12 (00:04:30–00:05:58), 479–480 (03:59:00–03:59:58) of 480. Unread: 1–9, 13–478.');
  });

  it('a chapter from its start, paged within it', async () => {
    const coverage = new Coverage(transcript, false);
    const opening = await run(readTool(transcript, coverage), { chapter: 1 });
    expect(opening.content.split('\n')[0]).toBe('Sentences 1–20 of 480 (00:00:00–00:09:58), in chapter 1 "Cold open":');
    expect(opening.content).toMatch(/Next: read from 21\.$/);
    // The last chapter runs to the end of the transcript (sentences 81–480): more than a page.
    const ruling = await run(readTool(transcript, coverage), { chapter: 3 });
    expect(ruling.content).toMatch(/^Sentences 81–\d+ of 480 .*, in chapter 3 "The ruling":/);
    expect(ruling.content).toMatch(/The page ends here; continue with read from \d+ \(this chapter ends at sentence 480\)\.$/);
  });

  it('a sentence or chapter that does not exist, or no start, is refused naming why', async () => {
    const tool = readTool(transcript, new Coverage(transcript, false));
    await expect(run(tool, { from: 481 })).rejects.toThrow('there is no sentence 481; the sentences are 1–480');
    await expect(run(tool, { chapter: 4 })).rejects.toThrow('there is no chapter 4; the chapters are 1–3');
    await expect(run(tool, {})).rejects.toThrow('the arguments need from');
    await expect(run(tool, { from: 2.5 })).rejects.toThrow('from must be a whole number');
  });
});

describe('the coverage line', () => {
  const transcript = chatTranscript(longVideo(60));

  it('nothing, some, all: read ranges with their times, unread ones by number', () => {
    const coverage = new Coverage(transcript, false);
    expect(coverage.line()).toBe('Read so far: none of the 120 sentences. Unread: 1–120.');
    coverage.mark(0, 39);
    expect(coverage.line()).toBe('Read so far: sentences 1–40 (00:00:00–00:19:58) of 120. Unread: 41–120.');
    coverage.mark(40, 119);
    expect(coverage.line()).toBe('Read so far: all 120 sentences.');
    expect(new Coverage(transcript, true).line()).toBe('Read so far: all 120 sentences.');
  });

  it('many scattered ranges are listed up to six, the rest counted', () => {
    const coverage = new Coverage(transcript, false);
    for (let i = 0; i < 20; i += 2) coverage.mark(i, i);
    expect(coverage.line()).toMatch(/^Read so far: sentences 1 \(00:00:00–00:00:28\), 3 .* and 4 more ranges of 120\. Unread: 2, 4, 6, 8, 10, 12 and 4 more ranges\.$/);
  });
});
