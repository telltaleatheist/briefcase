import { describe, expect, it } from '@jest/globals';
import Database = require('better-sqlite3');

import { boundedDistance, highlightRanges, matchExpression, matcherOf, parseMomentQuery, tokenize } from './moment-query';
import {
  ensureMomentSchema,
  indexPendingTranscripts,
  indexVideoMoments,
  momentWindows,
  parseSrtSegments,
  pendingTranscriptCount,
  removeVideoMoments,
  searchMoments,
  snippetRange,
  spellerFor,
} from './transcript-moments';
import type Db = require('better-sqlite3');

/** Search as the library does: parse, spell from the index, find moments. */
function find(db: Db.Database, query: string, fuzzy = true) {
  const speller = spellerFor(db, fuzzy);
  return { ...searchMoments(db, parseMomentQuery(query), speller.spell), spellings: speller.spellings };
}

const hms = (s: number) => {
  const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return `${p(s / 3600)}:${p((s % 3600) / 60)}:${p(s % 60)},${p((s % 1) * 1000, 3)}`;
};

/** An SRT document with one 5 s segment per line. */
function srtOf(lines: string[]): string {
  return lines.map((text, i) => `${i + 1}\n${hms(i * 5)} --> ${hms(i * 5 + 5)}\n${text}\n`).join('\n');
}

function library() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE videos (id TEXT PRIMARY KEY);
    CREATE TABLE transcripts (video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE, srt_format TEXT, transcribed_at TEXT);
  `);
  ensureMomentSchema(db);
  const add = (id: string, lines: string[], at = '2026-10-01') => {
    db.prepare('INSERT OR IGNORE INTO videos (id) VALUES (?)').run(id);
    db.prepare('INSERT OR REPLACE INTO transcripts (video_id, srt_format, transcribed_at) VALUES (?, ?, ?)').run(id, srtOf(lines), at);
  };
  return { db, add };
}

const filler = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `An ordinary remark about the garden, number ${from + i}.`);

describe('parseSrtSegments', () => {
  it('reads times and joins multi-line text; blocks without a time line are skipped', () => {
    const srt = '1\n00:00:01,500 --> 00:00:04,000\nHello\nthere\n\nnot a block\n\n2\n01:02:03,040 --> 01:02:05,000\nAgain';
    expect(parseSrtSegments(srt)).toEqual([
      { start: 1.5, end: 4, text: 'Hello there' },
      { start: 3723.04, end: 3725, text: 'Again' },
    ]);
  });
});

describe('momentWindows', () => {
  it('30 s windows every 15 s over 5 s segments: each segment in one or two, a long gap skipped', () => {
    const at = (...s: number[]) => s.map((start) => ({ start }));
    expect(momentWindows(at(0, 5, 10, 15, 20, 25, 30, 35, 40))).toEqual([[0, 5], [3, 8]]);
    expect(momentWindows(at(0, 5, 300, 305))).toEqual([[0, 1], [2, 3]]);
    expect(momentWindows([])).toEqual([]);
  });
});

describe('snippetRange', () => {
  it('is the shortest run in time holding every part of the query, else the hits near the first', () => {
    const T = true, F = false;
    const every = (n: number, len: number) => Array.from({ length: n }, (_, i) => ({ start: i * len, end: i * len + len }));
    // groups: [kenneth, copeland, jet]
    expect(snippetRange([[F, F, T], [T, F, F], [F, T, F], [F, F, T]], every(4, 5))).toEqual([0, 2]);
    expect(snippetRange([[F, F, T], [F, F, F], [T, F, F], [F, T, T]], every(4, 5))).toEqual([2, 3]);
    expect(snippetRange([[T, T, T], [T, F, F]], every(2, 5))).toEqual([0, 0]);
    // 1 s segments: the parts 20 s apart still make one snippet; 40 s apart they do not.
    const hits = (gap: number) => Array.from({ length: gap + 1 }, (_, i) => [i === 0, i === gap]);
    expect(snippetRange(hits(20), every(21, 1))).toEqual([0, 20]);
    expect(snippetRange(hits(40), every(41, 1))).toEqual([0, 0]);
    expect(snippetRange([[F], [F]], every(2, 5))).toBeNull();
  });
});

describe('the query', () => {
  it('reads words, phrases, prefixes, OR and exclusions', () => {
    const q = parseMomentQuery('logan "god debate" pray* atheist OR agnostic -boxing');
    expect(q.groups).toEqual([
      [{ kind: 'word', term: 'logan' }],
      [{ kind: 'phrase', terms: ['god', 'debate'] }],
      [{ kind: 'prefix', term: 'pray' }],
      [{ kind: 'word', term: 'atheist' }, { kind: 'word', term: 'agnostic' }],
    ]);
    expect(q.excluded).toEqual([{ kind: 'word', term: 'boxing' }]);
    expect(matchExpression(q, (t) => (t === 'logan' ? ['logan', 'logans'] : [t]))).toBe(
      '("logan" OR "logans") AND "god debate" AND "pray"* AND ("atheist" OR "agnostic") NOT "boxing"',
    );
  });

  it('folds case and accents the way the index does, and splits on apostrophes', () => {
    expect(tokenize("Café DON'T").map((t) => t.term)).toEqual(['cafe', 'don', 't']);
  });

  it('distance is bounded', () => {
    expect(boundedDistance('somalies', 'somalis', 2)).toBe(1);
    expect(boundedDistance('kitten', 'sitting', 1)).toBe(2);
  });

  it('highlights single words, prefixes and whole phrases', () => {
    const m = matcherOf(parseMomentQuery('"god debate" pray*'), (t) => [t]);
    const text = 'The God debate began; they prayed.';
    expect(highlightRanges(text, m).map(([a, b]) => text.slice(a, b))).toEqual(['God debate', 'prayed']);
  });
});

describe('the moment index', () => {
  it('finds where a phrase is said, with its time, and groups moments by video', () => {
    const { db, add } = library();
    add('a', [...filler(20), 'Logan says he believes in God now.', ...filler(20, 20), 'Logan returns to the question of God.', ...filler(5, 40)]);
    add('b', [...filler(10), 'Nothing about him here.']);
    expect(indexPendingTranscripts(db, 10)).toBe(2);

    const res = find(db, 'logan god');
    expect(res.videos.map((v) => v.videoId)).toEqual(['a']);
    expect(res.videos[0].moments.map((m) => m.start)).toEqual([100, 205]);
    const first = res.videos[0].moments[0];
    expect(first.highlights.map(([s, e]) => first.text.slice(s, e))).toEqual(['Logan', 'God']);
  });

  it('every word must be in the same ~30 s window', () => {
    const { db, add } = library();
    add('a', ['Logan arrives.', ...filler(20), 'Then we talk about God.']);
    indexPendingTranscripts(db, 10);
    expect(find(db, 'logan god').videos).toEqual([]);
    expect(find(db, 'logan OR god').videos[0].moments).toHaveLength(2);
  });

  it('a plain word matches a near spelling the index holds; a quoted one does not', () => {
    const { db, add } = library();
    add('a', [...filler(5), 'The Somalis in Minnesota were discussed.']);
    indexPendingTranscripts(db, 10);
    const fuzzy = find(db, 'somalies');
    expect(fuzzy.videos).toHaveLength(1);
    expect(fuzzy.spellings['somalies']).toContain('somalis');
    expect(find(db, '"somalies"').videos).toEqual([]);
    expect(find(db, 'somalies', false).videos).toEqual([]);
  });

  it('a word the index holds often is searched exactly, not widened', () => {
    const { db, add } = library();
    add('a', Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? `Logan spoke, point ${i}.` : `Filler line ${i}.`)));
    add('b', ['Joe Rogan was mentioned once.']);
    indexPendingTranscripts(db, 10);
    const res = find(db, 'logan');
    expect(res.spellings['logan']).toEqual(['logan']);
    expect(res.videos.map((v) => v.videoId)).toEqual(['a']);
  });

  it('exclusions drop the windows that hold them', () => {
    const { db, add } = library();
    add('a', ['Prayer before the boxing match.', ...filler(20), 'Prayer at the church.']);
    indexPendingTranscripts(db, 10);
    const res = find(db, 'prayer -boxing');
    expect(res.videos[0].moments.map((m) => m.start)).toEqual([105]);
  });

  it('re-indexes a new transcription, drops a removed video, and a deleted video takes its rows with it', () => {
    const { db, add } = library();
    add('a', ['First version mentions apples.']);
    add('b', ['Bananas are here.']);
    indexPendingTranscripts(db, 10);
    expect(pendingTranscriptCount(db)).toEqual({ pending: 0, total: 2 });

    add('a', ['Second version mentions pears.'], '2026-10-02');
    expect(pendingTranscriptCount(db).pending).toBe(1);
    indexPendingTranscripts(db, 10);
    expect(find(db, 'apples').videos).toEqual([]);
    expect(find(db, 'pears').videos).toHaveLength(1);

    removeVideoMoments(db, 'a');
    expect(find(db, 'pears').videos).toEqual([]);

    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM videos WHERE id = ?').run('b');
    expect(find(db, 'bananas').videos).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get() as { n: number }).n).toBe(0);
  });

  it('indexVideoMoments joins an open transaction', () => {
    const { db } = library();
    db.prepare("INSERT INTO videos (id) VALUES ('x')").run();
    db.transaction(() => indexVideoMoments(db, 'x', srtOf(['Inside a transaction.']), null))();
    expect(find(db, 'transaction').videos).toHaveLength(1);
  });
});
