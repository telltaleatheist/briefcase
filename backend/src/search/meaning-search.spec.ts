import { describe, expect, it } from '@jest/globals';
import Database = require('better-sqlite3');

import { DIMENSIONS } from './embeddings/embedding-model.service';
import { meaningChunks, searchMeaning, type Embed } from './meaning-search';
import { ensureMomentSchema, indexVideoMoments, removeVideoMoments } from './transcript-moments';

const hms = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
const srtOf = (lines: string[]) => lines.map((t, i) => `${i + 1}\n${hms(i * 5)} --> ${hms(i * 5 + 5)}\n${t}\n`).join('\n');

/** A fake embedder: the vector of a text is which of three topics its words name. */
function fakeEmbed(): { embed: Embed; calls: string[][] } {
  const calls: string[][] = [];
  const topic = (t: string) => {
    const v = new Float32Array(DIMENSIONS);
    v[0] = /iran|sleeper|terror/i.test(t) ? 1 : 0;
    v[1] = /energy|drink|jitter/i.test(t) ? 1 : 0;
    v[2] = v[0] || v[1] ? 0 : 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return { calls, embed: async (texts) => { calls.push(texts); return texts.map(topic); } };
}

function library() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE videos (id TEXT PRIMARY KEY)');
  ensureMomentSchema(db);
  db.prepare("INSERT INTO videos (id) VALUES ('v')").run();
  // Two 5 s lines of 6+ words make one chunk (10 s, 12+ words): one topic per chunk.
  const lines = [
    'Welcome to the broadcast everybody, good morning.', 'There is a lot to cover today folks.',
    'Iran may be activating sleeper cells right now.', 'Terror plots are rising this year, they say.',
    'Now a word about our new energy drink.', 'No jitters at all, just focus all day.',
  ];
  indexVideoMoments(db, 'v', srtOf(lines), 'x');
  return db;
}

describe('meaningChunks', () => {
  it('groups short segments until a chunk holds enough speech, capped at 20 s', () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ idx: i, start: i * 3, end: i * 3 + 3, text: 'one two three four five' }));
    const chunks = meaningChunks(segs);
    expect(chunks.map((c) => [c.first, c.last])).toEqual([[0, 3], [4, 7], [8, 9]]);
  });
});

describe('searchMeaning', () => {
  it('finds the stretch that means what was typed, embeds a video once, and drops its vectors when the transcript changes', async () => {
    const db = library();
    const { embed, calls } = fakeEmbed();

    const first = await searchMeaning(db, 'v', 'could terrorists already be here', embed);
    expect(first.embeddedNow).toBe(true);
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0].start).toBe(10);

    const again = await searchMeaning(db, 'v', 'a drink with no jitters', embed);
    expect(again.embeddedNow).toBe(false);
    expect(again.hits.map((h) => h.start)).toEqual([20]);
    // Documents were embedded once; each search embedded only its query.
    expect(calls.map((c) => c.length)).toEqual([first.chunks, 1, 1]);

    removeVideoMoments(db, 'v');
    expect((db.prepare('SELECT COUNT(*) AS n FROM transcript_meaning_chunks').get() as { n: number }).n).toBe(0);
  });
});
