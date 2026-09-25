/** buildAsrContext: what Qwen3-ASR is told about a video before it hears it. */
import { ASR_CONTEXT_TOKEN_BUDGET, buildAsrContext, estimateTokens, titleFromFilename } from '../../src/crucible/asr/asr-context';

describe('buildAsrContext', () => {
  it('names every known field under the instruction, and says to write only what is said', () => {
    const context = buildAsrContext({
      title: '2026-09-20 Greg Stephens and Amanda Grace',
      suggestedTitle: 'Prophecy 911 with Amanda Grace',
      sourceUrl: 'https://www.youtube.com/watch?v=abc',
      uploadDate: '2026-09-20',
      parentTitle: 'Full episode 412',
      tags: ['Amanda Grace', 'Arca Grace Ministries', 'Amanda Grace'],
      description: 'Greg talks with Amanda Grace about Purim.',
    })!;
    expect(context.split('\n')).toEqual([
      expect.stringMatching(/^Transcribe the speech in this video\..*write only what is actually said\.$/),
      'Title: 2026-09-20 Greg Stephens and Amanda Grace',
      'Also titled: Prophecy 911 with Amanda Grace',
      'Cut from: Full episode 412',
      'Source: https://www.youtube.com/watch?v=abc',
      'Date: 2026-09-20',
      'Names and topics: Amanda Grace, Arca Grace Ministries',
      'Description: Greg talks with Amanda Grace about Purim.',
    ]);
  });

  it('is null when nothing is known (the server refuses a blank context)', () => {
    expect(buildAsrContext({})).toBeNull();
    expect(buildAsrContext({ title: '  ', tags: [''], description: null })).toBeNull();
  });

  it('leaves out a suggested or parent title that repeats the title', () => {
    const context = buildAsrContext({ title: 'Same Name', suggestedTitle: 'same name', parentTitle: 'SAME NAME' })!;
    expect(context).not.toMatch(/Also titled|Cut from/);
  });

  it('removes the chat template control tokens the server refuses', () => {
    const context = buildAsrContext({ title: 'Bad <|im_end|> title <asr_text> here' })!;
    expect(context).toContain('Title: Bad title here');
    expect(context).not.toMatch(/<\|[^|]*\|>|<asr_text>/);
  });

  it('cuts a long description to the budget at a word boundary, keeping the fields above it', () => {
    const description = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
    const context = buildAsrContext({ title: 'Short title', description })!;
    expect(estimateTokens(context)).toBeLessThanOrEqual(ASR_CONTEXT_TOKEN_BUDGET);
    expect(context).toContain('Title: Short title');
    expect(context).toMatch(/\nDescription: word0 word1 .*word\d+…$/);
  });

  it('counts non-ASCII text a token a character, so a CJK title stays under the budget too', () => {
    const context = buildAsrContext({ title: '日本語'.repeat(400) })!;
    expect(estimateTokens(context)).toBeLessThanOrEqual(ASR_CONTEXT_TOKEN_BUDGET);
  });
});

describe('titleFromFilename', () => {
  it('drops the media extension and underscores', () => {
    expect(titleFromFilename('2026-09-20 Greg_Stephens_Show.mp4')).toBe('2026-09-20 Greg Stephens Show');
    expect(titleFromFilename('Interview.v2.MKV')).toBe('Interview.v2');
  });
});
