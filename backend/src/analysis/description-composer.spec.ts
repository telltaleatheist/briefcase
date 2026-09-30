import { describe, expect, it } from '@jest/globals';
import { buildChapterLines, leafComposerChapters } from './description-composer';

describe('the description chapter block on a stories outline', () => {
  const tree = [
    { sequence: 1, start_time: '00:00:00', title: 'The stadium deal', level: 0 },
    { sequence: 2, start_time: '00:00:00', title: 'Stadium vote', level: 1, parent_sequence: 1 },
    { sequence: 3, start_time: '00:05:00', title: 'Stadium cost', level: 1, parent_sequence: 1 },
    { sequence: 4, start_time: '00:10:00', title: 'The storm', level: 0 },
    { sequence: 5, start_time: '00:10:00', title: 'Storm track', level: 1, parent_sequence: 4 },
    { sequence: 6, start_time: '01:02:03', title: 'Storm damage', level: 1, parent_sequence: 4 },
  ];

  it('lists the chapters (the leaves), never the stories', () => {
    expect(buildChapterLines(tree)).toEqual(['00:00 Stadium vote', '05:00 Stadium cost', '10:00 Storm track', '1:02:03 Storm damage']);
  });

  it('a flat list is unchanged', () => {
    const flat = [
      { start_time: '00:00:00', title: 'A' },
      { start_time: '00:01:00', title: 'B' },
    ];
    expect(leafComposerChapters(flat)).toBe(flat);
    expect(buildChapterLines(flat)).toEqual(['00:00 A', '01:00 B']);
  });
});
