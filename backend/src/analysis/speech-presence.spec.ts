import { describe, expect, it } from '@jest/globals';
import { speechPresence } from './speech-presence';

describe('whether a video has speech worth analyzing', () => {
  it('a transcript with no words is no speech', () => {
    expect(speechPresence([], 31.4)).toEqual({ speech: false, words: 0, spokenSeconds: 0 });
    expect(speechPresence([{ start: 0, end: 30, text: '  ' }], 31.4).speech).toBe(false);
  });

  it('sound tags are not words', () => {
    expect(speechPresence([{ start: 0, end: 30, text: '[Music] ♪ ♪' }], 31.4)).toEqual({ speech: false, words: 0, spokenSeconds: 0 });
  });

  it('the real case: one stray lyric, 6 words in 1.8 s of a 31.4 s clip, is no speech', () => {
    const p = speechPresence([{ start: 0.16, end: 1.996, text: 'I want to be a man' }], 31.4);
    expect(p.speech).toBe(false);
    expect(p.words).toBe(6);
    expect(p.spokenSeconds).toBeCloseTo(1.836, 3);
  });

  it('a 3-second clip with one sentence covers most of its length: speech', () => {
    expect(speechPresence([{ start: 0.2, end: 2.8, text: 'This is the best day of my life.' }], 3).speech).toBe(true);
  });

  it('a normal transcript is speech', () => {
    const cues = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: `This is sentence number ${i} of a long talk.` }));
    expect(speechPresence(cues, 300)).toMatchObject({ speech: true, words: 270 });
  });

  it('twenty words or more are speech however little of the video they cover', () => {
    const text = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(speechPresence([{ start: 0, end: 2, text }], 600).speech).toBe(true);
  });

  it('with no known duration only the no-words rule applies', () => {
    const cue = [{ start: 0.16, end: 1.996, text: 'I want to be a man' }];
    expect(speechPresence(cue).speech).toBe(true);
    expect(speechPresence(cue, null).speech).toBe(true);
    expect(speechPresence(cue, 0).speech).toBe(true);
    expect(speechPresence([], null).speech).toBe(false);
  });
});
