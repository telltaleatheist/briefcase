import { describe, expect, it } from '@jest/globals';
import { buildVideoChatSystemPrompt } from '../analysis/prompts/video-chat-prompts';
import { runToolLoop, type ChatMessage, type ChatTransport } from '../tool-harness';
import { addMarkerTool, chatTranscript, placeMarker } from './add-marker-tool';

/**
 * add_marker: the model quotes a passage's first and last words, Briefcase
 * finds them in the transcript and places the marker at those sentences'
 * times. Run through the tool harness as the Ask chat runs it.
 */

const transcript = chatTranscript([
  { text: 'Welcome back to the show, everybody.', start: 0, end: 4 },
  { text: 'Today we start with the budget fight in Congress.', start: 4, end: 9 },
  { text: 'The vote was close, and nobody expected it.', start: 9, end: 15 },
  { text: 'Then Trump posted about the ruling late last night.', start: 600, end: 606 },
  { text: 'He called the judges a disgrace to the country.', start: 606, end: 612 },
  { text: 'That is all for today, thanks for watching.', start: 3700, end: 3705 },
]);
const trump = { title: 'Trump on the ruling', first_words: 'Then Trump posted about the ruling', last_words: 'a disgrace to the country' };
const tag = (args: unknown) => `<tool_use>\n${JSON.stringify({ name: 'add_marker', arguments: args })}\n</tool_use>`;

describe('placeMarker', () => {
  it('exact and fuzzy quotes land on their sentences\' times', () => {
    expect(placeMarker(transcript, { title: 'T', firstWords: 'Then Trump posted about the ruling', lastWords: 'disgrace to the country.', note: null, set: null }))
      .toMatchObject({ startSeconds: 600, endSeconds: 612 });
    expect(placeMarker(transcript, { title: 'B', firstWords: 'today we start with the budjet fight', lastWords: 'nobody expected it', note: null, set: null }))
      .toMatchObject({ startSeconds: 4, endSeconds: 15 });
  });

  it('words that are not in the transcript are not placed', () => {
    expect(placeMarker(transcript, { title: 'X', firstWords: 'the moon landing was faked', lastWords: 'nobody expected it', note: null, set: null })).toBeNull();
  });
});

describe('the add_marker tool', () => {
  it('placed: the model is told where (HH:MM:SS), Briefcase keeps the marker', async () => {
    expect(await addMarkerTool(transcript).execute({ ...trump, note: ' He attacks the judges. ' }, {})).toEqual({
      content: 'placed "Trump on the ruling" at 00:10:00–00:10:12',
      data: { title: 'Trump on the ruling', firstWords: 'Then Trump posted about the ruling', lastWords: 'a disgrace to the country', note: 'He attacks the judges.', set: null, startSeconds: 600, endSeconds: 612 },
    });
  });

  it('the set the model names for its answer is kept with the marker, trimmed', async () => {
    expect((await addMarkerTool(transcript).execute({ ...trump, set: ' Trump mentions ' }, {})).data).toMatchObject({ set: 'Trump mentions' });
    expect((await addMarkerTool(transcript).execute({ ...trump, set: '  ' }, {})).data).toMatchObject({ set: null });
  });

  it('a passage this answer already placed is not placed again; the model is told to finish', async () => {
    const once = addMarkerTool(transcript);
    expect((await once.execute(trump, {})).data).toMatchObject({ startSeconds: 600, endSeconds: 612 });
    expect(await once.execute({ ...trump, title: 'Trump again' }, {})).toEqual({
      content: '"Trump again" is already placed at 00:10:00–00:10:12; do not place it again — finish your answer',
    });
    // Another answer's tool starts fresh.
    expect((await addMarkerTool(transcript).execute(trump, {})).data).toMatchObject({ startSeconds: 600 });
  });

  it('not found: the model is told to quote again, nothing is kept', async () => {
    expect(await addMarkerTool(transcript).execute({ title: 'Moon', first_words: 'the moon landing was faked', last_words: 'by the government' }, {})).toEqual({
      content: 'could not find "the moon landing was faked" … "by the government" (for "Moon") in the transcript — quote again exactly',
    });
  });

  it('arguments missing an anchor are refused by name', async () => {
    await expect(addMarkerTool(transcript).execute({ title: 'T', first_words: 'Then Trump posted' }, {})).rejects.toThrow('the arguments have no last_words');
  });
});

describe('an Ask answer through the harness', () => {
  function scripted(replies: string[]): ChatTransport & { sent: ChatMessage[][] } {
    const sent: ChatMessage[][] = [];
    const transport: ChatTransport = async (messages) => {
      sent.push(messages);
      return { text: replies[sent.length - 1] ?? 'out of script' };
    };
    return Object.assign(transport, { sent });
  }

  it('a missed quote is told, quoted again, placed; the tags never reach the answer', async () => {
    const t = scripted([
      `Yes, there is. ${tag({ title: 'Trump', first_words: 'Trump tweeted about the court', last_words: 'shame on the country' })}`,
      tag(trump),
      'Yes: see "Trump on the ruling".',
    ]);
    const result = await runToolLoop({ transport: t, tools: [addMarkerTool(transcript)], system: buildVideoChatSystemPrompt('Budget night', transcript.sentences), userMessage: 'Trump?' });
    expect(result.finalText).toBe('Yes, there is.\n\nYes: see "Trump on the ruling".');
    expect(result.toolCalls.map((c) => c.data)).toEqual([undefined, expect.objectContaining({ startSeconds: 600, endSeconds: 612 })]);
    const firstResults = t.sent[1][t.sent[1].length - 1].content;
    expect(firstResults).toContain('quote again exactly');
  });
});

describe('the system prompt', () => {
  it('has the title and the transcript, one sentence per line, without a single time', () => {
    const prompt = buildVideoChatSystemPrompt('Budget night', transcript.sentences);
    expect(prompt).toContain('"Budget night"');
    expect(prompt).toContain('Welcome back to the show, everybody.\nToday we start with the budget fight in Congress.');
    expect(prompt).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    // The set is asked for at the end of the results paragraph (see the prompt's note).
    expect(prompt).toMatch(/then finish your answer for the person\. Each marker's set names/);
  });
});
