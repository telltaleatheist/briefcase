import { describe, expect, it } from '@jest/globals';

import { assembleUnits } from './units';

describe('assembleUnits', () => {
  it('keeps measured segment times across sentence splits', () => {
    const units = assembleUnits([
      { start: 0, end: 4, text: 'We start with the news today.' },
      { start: 4, end: 9, text: 'The market fell sharply this week. And' },
      { start: 9, end: 12, text: 'then it recovered by Friday afternoon.' },
    ]);
    expect(units).toEqual([
      { start: 0, end: 4, text: 'We start with the news today.' },
      { start: 4, end: 9, text: 'The market fell sharply this week.' },
      { start: 4, end: 12, text: 'And then it recovered by Friday afternoon.' },
    ]);
  });

  it('folds sentences under 4 words into the following one (submap.py)', () => {
    const units = assembleUnits([
      { start: 0, end: 1, text: 'Okay.' },
      { start: 1, end: 2, text: 'Yeah, right.' },
      { start: 2, end: 6, text: 'So here is the actual point.' },
      { start: 6, end: 10, text: 'It has at least four words.' },
      { start: 10, end: 11, text: 'Bye now.' },
    ]);
    expect(units).toEqual([
      { start: 0, end: 6, text: 'Okay. Yeah, right. So here is the actual point.' },
      { start: 6, end: 10, text: 'It has at least four words.' },
      { start: 10, end: 11, text: 'Bye now.' },
    ]);
  });

  it('can disable the fold', () => {
    expect(assembleUnits([{ start: 0, end: 1, text: 'Okay. Fine.' }], { minWords: 0 })).toHaveLength(2);
  });

  it('splits an unpunctuated run-on at segment boundaries into ~30-word pieces', () => {
    const seg = (i: number) => ({ start: i * 5, end: i * 5 + 5, text: Array.from({ length: 10 }, (_, w) => `w${i}x${w}`).join(' ') });
    const segments = Array.from({ length: 10 }, (_, i) => seg(i)); // 100 words, 50 s, no punctuation
    const units = assembleUnits(segments);
    expect(units.map((u) => u.text.split(' ').length)).toEqual([30, 30, 40]);
    expect(units.map((u) => [u.start, u.end])).toEqual([
      [0, 15],
      [15, 30],
      [30, 50],
    ]);
    expect(units.map((u) => u.text).join(' ')).toBe(segments.map((s) => s.text).join(' '));
  });

  it('does not split a long sentence inside one segment', () => {
    const text = Array.from({ length: 80 }, (_, w) => `w${w}`).join(' ') + '.';
    expect(assembleUnits([{ start: 0, end: 40, text }])).toEqual([{ start: 0, end: 40, text }]);
  });

  it('cuts a run-on sentence only where segments overlap it, not the neighbouring sentences', () => {
    const words = (n: number, p: string) => Array.from({ length: n }, (_, w) => `${p}${w}`).join(' ');
    const units = assembleUnits([
      { start: 0, end: 5, text: `Short intro sentence here. ${words(20, 'a')}` },
      { start: 5, end: 10, text: words(20, 'b') },
      { start: 10, end: 15, text: words(20, 'c') + '. Final bit of text here.' },
    ]);
    expect(units[0]).toEqual({ start: 0, end: 5, text: 'Short intro sentence here.' });
    expect(units[1].text.startsWith('a0 ')).toBe(true);
    expect(units[units.length - 1]).toEqual({ start: 10, end: 15, text: 'Final bit of text here.' });
    expect(units.slice(1, -1).map((u) => u.text).join(' ')).toBe(`${words(20, 'a')} ${words(20, 'b')} ${words(20, 'c')}.`);
  });

  it('returns [] for an empty transcript', () => {
    expect(assembleUnits([{ start: 0, end: 1, text: '  ' }])).toEqual([]);
  });
});
