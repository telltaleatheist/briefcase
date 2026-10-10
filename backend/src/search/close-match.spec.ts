import { describe, expect, it } from '@jest/globals';

import { closeMatches, type CloseMatchSegment } from './close-match';

const seg = (start: number, text: string): CloseMatchSegment => ({ start, end: start + 5, text });

const transcript: CloseMatchSegment[] = [
  seg(0, 'Welcome back to the show, everybody.'),
  seg(5, 'Today we talk about the protests downtown.'),
  seg(10, 'Black lives matter are demon spawns from hell, she said.'),
  seg(15, 'Black lives matter is a movement that started years ago.'),
  seg(20, 'Then the pastor talked about Satan and spiritual warfare.'),
  seg(25, 'Hell is real, he told the crowd.'),
  seg(30, 'Our sponsor today is a water filter company.'),
];
const texts = (query: string) => closeMatches(transcript, query).map((h) => transcript[h.first].text);

describe('closeMatches', () => {
  it('finds a misremembered quote: small words and one wrong word do not sink it, and it ranks first', () => {
    const hits = closeMatches(transcript, 'black lives matter is demon spawns from satan');
    expect(transcript[hits[0].first].start).toBe(10);
    expect(hits[0].score).toBeGreaterThan(0.7);
    // "black lives matter is a movement" holds too little of the quote to count.
    expect(hits.map((h) => transcript[h.first].start)).not.toContain(15);
  });

  it('highlights the words that matched, per segment', () => {
    const [hit] = closeMatches(transcript, 'demon spawns');
    const text = transcript[hit.first].text;
    expect(hit.highlights.map(([, a, b]) => text.slice(a, b))).toEqual(['demon', 'spawns']);
  });

  it('a single word lists every place it is said, in time order', () => {
    expect(texts('hell')).toEqual([transcript[2].text, transcript[5].text]);
  });

  it('is not hung up on spelling: near spellings and partial words count', () => {
    expect(texts('protestz')).toEqual([transcript[1].text]);
    expect(texts('spons')).toEqual([transcript[6].text]);
  });

  it('a quoted phrase must be there exactly; a -word must not', () => {
    expect(texts('"lives matter is"')).toEqual([transcript[3].text]);
    expect(texts('"demon spawns from satan"')).toEqual([]);
    expect(texts('black lives matter -movement')).toEqual([transcript[2].text]);
  });

  it('one bigger word of several is not a match', () => {
    expect(texts('satan warfare pizza delivery')).toEqual([]);
    expect(texts('satan warfare pastor')).toEqual([transcript[4].text]);
  });
});
