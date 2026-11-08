// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import { FilenameDateUtil } from './filename-date.util';

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
