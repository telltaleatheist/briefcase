// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import { FilenameDateUtil, fitNameBytes, MAX_NAME_BYTES } from './filename-date.util';

describe('FilenameDateUtil.sanitizeFilename dashes', () => {
  it.each([
    ['Spider-Man: No Way Home', 'Spider-Man - No Way Home'],
    ['COVID-19 update', 'COVID-19 update'],
    ['Alex Jones Live 2026-11-04 13:38', 'Alex Jones Live 2026-11-04 13-38'],
    ['Title -Part 2', 'Title - Part 2'],
    ['Title- Part 2', 'Title - Part 2'],
    ['Title   -   Part 2', 'Title - Part 2'],
    ['Who? Me', 'Who - Me'],
  ])('%s → %s', (input, expected) => {
    expect(FilenameDateUtil.sanitizeFilename(input)).toBe(expected);
  });
});

describe('fitNameBytes', () => {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

  it('leaves a name that fits unchanged', () => {
    expect(fitNameBytes('2026-11-20 Short title', 200)).toBe('2026-11-20 Short title');
  });

  it('cuts by bytes, not characters, at a word break, without a trailing separator', () => {
    // The clip that failed to export on 2026-11-23: ~260 bytes, three of them one em dash.
    const title = '2026-11-20 Says blockchain will absolutely be the Mark of the Beast, Antichrist will use it — Flatly asserts end-times prophecy as certain the blockchain will be the Mark of the Beast and the Antichrist will use it, while telling viewers not to be scared.';
    const fit = fitNameBytes(title);
    expect(bytes(fit)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(title.startsWith(fit)).toBe(true);
    expect(fit).not.toMatch(/[\s,.\-—]$/);
    expect(title[fit.length]).toBe(' ');
  });

  it('never splits a multi-byte character', () => {
    expect(fitNameBytes('日'.repeat(100), 200)).toBe('日'.repeat(66));
    const fit2 = fitNameBytes('é'.repeat(150), 201);
    expect(bytes(fit2)).toBe(200);
    expect(fit2).toBe('é'.repeat(100));
  });

  it('caps sanitizeFilename by bytes', () => {
    expect(bytes(FilenameDateUtil.sanitizeFilename('ü'.repeat(150)))).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});
