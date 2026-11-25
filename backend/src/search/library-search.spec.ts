import { describe, expect, it } from '@jest/globals';
import Database = require('better-sqlite3');

import { MAX_PARTIAL_VIDEOS, searchLibrary, titleOf } from './library-search';
import { DIMENSIONS } from './embeddings/embedding-model.service';
import { indexVideoMeaning, searchLibraryMeaning, type Embed } from './meaning-search';
import { ensureMomentSchema, indexPendingTranscripts, removeVideoMoments } from './transcript-moments';

const hms = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
const srtOf = (lines: string[]) => lines.map((t, i) => `${i + 1}\n${hms(i * 5)} --> ${hms(i * 5 + 5)}\n${t}\n`).join('\n');

function library(videos: Array<{ id: string; filename: string; downloaded?: string; lines?: string[] }>) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE videos (id TEXT PRIMARY KEY, filename TEXT NOT NULL, download_date TEXT, added_at TEXT);
    CREATE TABLE transcripts (video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE, srt_format TEXT, transcribed_at TEXT);
  `);
  ensureMomentSchema(db);
  for (const v of videos) {
    db.prepare('INSERT INTO videos (id, filename, download_date) VALUES (?, ?, ?)').run(v.id, v.filename, v.downloaded ?? null);
    if (v.lines) db.prepare('INSERT INTO transcripts VALUES (?, ?, ?)').run(v.id, srtOf(v.lines), 'x');
  }
  indexPendingTranscripts(db, 1000);
  return db;
}

const ids = (res: ReturnType<typeof searchLibrary>) => res.hits.map((h) => h.videoId);
const marked = (hit: { title: string; titleHighlights: Array<[number, number]> }) => hit.titleHighlights.map(([a, b]) => hit.title.slice(a, b));

describe('searchLibrary', () => {
  it('matches file names ignoring word breaks: "pastor props" finds pastorswithprops', () => {
    const db = library([
      { id: 'joined', filename: '2026-05-01 pastorswithprops.mp4' },
      { id: 'spaced', filename: '2026-05-02 Pastors With Props.mp4' },
      { id: 'under', filename: 'pastor_props.mp4' },
      { id: 'accent', filename: 'Pâstor and his próps.mp4' },
      { id: 'half', filename: 'pastor sermon.mp4' },
    ]);
    const res = searchLibrary(db, 'pastor props');
    expect(ids(res).sort()).toEqual(['accent', 'joined', 'spaced', 'under']);
    const joined = res.hits.find((h) => h.videoId === 'joined')!;
    expect(marked(joined)).toEqual(['pastor', 'props']);
    const accent = res.hits.find((h) => h.videoId === 'accent')!;
    expect(marked(accent)).toEqual(['Pâstor', 'próps']);
    // The file name is all that is read by default: no moments, no transcript index.
    expect(res.hits.every((h) => h.moments.length === 0)).toBe(true);
  });

  it('exclusion, OR and the extension: -word leaves a name out, either side of OR will do, ".mp4" is not the name', () => {
    const db = library([
      { id: 'a', filename: 'god debate night.mp4' },
      { id: 'b', filename: 'debate about god reaction.mp4' },
      { id: 'c', filename: 'boxing night.mp4' },
    ]);
    expect(ids(searchLibrary(db, 'debate -reaction'))).toEqual(['a']);
    expect(ids(searchLibrary(db, 'debate -"about god"'))).toEqual(['a']);
    expect(ids(searchLibrary(db, 'boxing OR reaction')).sort()).toEqual(['b', 'c']);
    expect(ids(searchLibrary(db, 'debat* god')).sort()).toEqual(['a', 'b']);
    expect(searchLibrary(db, 'mp4').hits).toEqual([]);
  });

  it('a repeated word must appear that many times, and the closest match ranks first whatever its date', () => {
    const db = library([
      { id: 'strike', filename: '2024-03-01 Paula White - Strike And Strike.mp4', downloaded: '2024-03-02' },
      { id: 'once', filename: '2026-10-01 a strike and a rally.mp4', downloaded: '2026-10-02' },
      { id: 'apart', filename: '2026-09-01 strike, and then strike again.mp4', downloaded: '2026-09-02' },
      { id: 'joined', filename: '2025-01-01 strikeandstrikeagain.mp4', downloaded: '2025-01-02' },
      { id: 'jumbled', filename: '2026-08-01 strikers and strikes.mp4', downloaded: '2026-08-02' },
    ]);
    const res = searchLibrary(db, 'strike and strike');
    // "once" has one strike: no match. Then by how closely the name holds the query, not by date.
    expect(ids(res)).toEqual(['strike', 'joined', 'apart', 'jumbled']);
    expect(res.hits.map((h) => h.titleRank)).toEqual([0, 1, 2, 3]);
    expect(marked(res.hits[0])).toEqual(['Strike And Strike']);
    // Within a rank, newest download first.
    const tie = library([
      { id: 'old', filename: 'strike one.mp4', downloaded: '2020-01-01' },
      { id: 'new', filename: 'strike two.mp4', downloaded: '2026-01-01' },
    ]);
    expect(ids(searchLibrary(tie, 'strike'))).toEqual(['new', 'old']);
  });

  it('a quoted phrase must appear run together, word breaks ignored, and mixes with loose words', () => {
    const db = library([
      { id: 'exact', filename: 'Paula White strike-and-strike.mp4' },
      { id: 'apart', filename: 'strike and then strike.mp4' },
      { id: 'props', filename: 'Pastors with Props (full).mp4' },
      { id: 'react', filename: 'pastorswithprops reaction.mp4' },
    ]);
    expect(ids(searchLibrary(db, '"strike and strike"'))).toEqual(['exact']);
    expect(ids(searchLibrary(db, '"pastors with props" -reaction'))).toEqual(['props']);
    expect(ids(searchLibrary(db, 'white "strike and strike"'))).toEqual(['exact']);
  });

  it('Deep search adds where it is said: file name matches first as a group, then videos where it is only said', () => {
    const db = library([
      { id: 'debate', filename: '2026-09-15 Bryce Crawford VS Logan Paul (God Debate).mp4', lines: ['Logan Paul walks in.', 'Opening remarks.'] },
      { id: 'other', filename: '2026-01-01 a podcast.mp4', downloaded: '2026-10-01', lines: ['Then I watched Logan Paul box.'] },
      { id: 'quiet', filename: '2026-02-02 LoganPaul highlights.mp4', downloaded: '2026-02-03' },
      { id: 'none', filename: 'cooking.mp4', lines: ['Nothing here.'] },
    ]);
    // Without Deep search the transcripts are not read.
    expect(ids(searchLibrary(db, 'logan paul'))).toEqual(['quiet', 'debate']);

    const res = searchLibrary(db, 'logan paul', { deep: true });
    expect(ids(res)).toEqual(['debate', 'quiet', 'other']);
    const debate = res.hits[0];
    expect(debate.title).toBe('2026-09-15 Bryce Crawford VS Logan Paul (God Debate)');
    expect(marked(debate)).toEqual(['Logan Paul']);
    expect(debate.moments).toHaveLength(1);
    expect(res.hits[2].titleHighlights).toEqual([]);
    expect(res.hits[2].titleRank).toBeUndefined();
    expect(res.hits[2].moments[0].text).toContain('Logan Paul');
  });

  it('Deep search follows typing in the transcripts: a partial word finds moments with words it starts', () => {
    const db = library([
      { id: 'shane', filename: '2026-03-01 Shane Vaughn on the end times.mp4', lines: ['Shane Vaughn speaks.'] },
      { id: 'other', filename: 'cooking.mp4', lines: ['We shall see.'] },
    ]);
    expect(ids(searchLibrary(db, 'sha', { deep: true }))).toEqual(['shane', 'other']);
    expect(ids(searchLibrary(db, 'sha'))).toEqual(['shane']);
  });

  it('follows renames and deletes: the names are read as they are', () => {
    const db = library([{ id: 'a', filename: 'first name.mp4' }, { id: 'b', filename: 'other.mp4' }]);
    db.prepare("UPDATE videos SET filename = 'renamed clip.mp4' WHERE id = 'a'").run();
    expect(searchLibrary(db, 'first').hits).toEqual([]);
    expect(ids(searchLibrary(db, 'renamed'))).toEqual(['a']);
    db.prepare("DELETE FROM videos WHERE id = 'a'").run();
    expect(searchLibrary(db, 'renamed').hits).toEqual([]);
  });

  // Speech that says none of the words searched for, so the words below are rare, as in a real library.
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `The weather was mild and the garden grew, day ${i}.`);
  // The clip the user could not find (2026-11-23), told much as its transcript tells it.
  const kunneman = {
    id: 'clip',
    filename: '2021-05-10 kunneman explains why you cant call him a false prophet.mov',
    downloaded: '2022-04-24',
    lines: [
      "There's been a lot of signing of petitions",
      "and accountability that they're calling for for the profits.",
      ...filler(10),
      'Do they stand in a fivefold office of a prophet?',
    ],
  };

  it('Deep search pairs the name with what is said: part of the query in the name, the rest said in one window', () => {
    const db = library([
      kunneman,
      { id: 'said', filename: 'a podcast.mp4', lines: ['Kunneman never spoke of accountability.', ...filler(5)] },
      { id: 'named', filename: 'kunneman on accountability.mp4', lines: filler(5) },
      { id: 'apart', filename: 'kunneman again.mp4', lines: ['accountability', ...filler(10), 'more'] },
      { id: 'excluded', filename: 'kunneman reaction.mp4', lines: ['accountability now'] },
      { id: 'none', filename: 'other.mp4', lines: ['accountability matters.'] },
      { id: 'filler', filename: 'weather.mp4', lines: filler(200) },
    ]);
    const res = searchLibrary(db, 'kunneman accountability -reaction', { deep: true });
    // The whole name first, then the name with the rest said, then all of it said.
    expect(ids(res)).toEqual(['named', 'clip', 'apart', 'said']);
    const clip = res.hits[1];
    expect(clip.titleRank).toBeUndefined();
    expect(marked(clip)).toEqual(['kunneman']);
    expect(clip.moments[0].text).toContain('accountability');
    // Without Deep search only the whole name counts.
    expect(ids(searchLibrary(db, 'kunneman accountability'))).toEqual(['named']);
  });

  it('Deep search finds words typed apart that the transcript wrote together ("five fold" is "fivefold")', () => {
    const db = library([kunneman, { id: 'filler', filename: 'weather.mp4', lines: filler(200) }]);
    const res = searchLibrary(db, 'five fold prophet', { deep: true });
    expect(ids(res)).toEqual(['clip']);
    expect(res.hits[0].moments[0].highlights.map(([a, b]) => res.hits[0].moments[0].text.slice(a, b))).toEqual(['fivefold', 'prophet']);
    expect(res.spellings.fold).toEqual(['fold', 'fivefold']);
  });

  it('Deep search lists partial matches after every full one: most of the telling words, by name and one window', () => {
    const db = library([
      kunneman,
      { id: 'full', filename: 'a sermon.mp4', lines: ['Resignations, accountability, a prophet.', ...filler(5)] },
      { id: 'two', filename: 'a talk.mp4', lines: ['A prophet on accountability.', ...filler(5)] },
      { id: 'one', filename: 'a prophet speaks.mp4', lines: filler(5) },
      { id: 'filler', filename: 'weather.mp4', lines: filler(200) },
    ]);
    // "resignations" was misheard in the clip: it holds the other two, prophet by name.
    const res = searchLibrary(db, 'resignations accountability prophet', { deep: true });
    // As many words, as rare: newest download first.
    expect(ids(res)).toEqual(['full', 'clip', 'two']);
    expect(res.hits[0].partial).toBeUndefined();
    expect(res.hits.slice(1).map((h) => h.partial)).toEqual([{ found: 2, of: 3 }, { found: 2, of: 3 }]);
    const clip = res.hits[1];
    expect(marked(clip)).toEqual(['prophet']);
    expect(clip.moments.every((m) => m.partial)).toBe(true);
    expect(clip.moments[0].text).toContain('accountability');

    // Words said nearly everywhere neither count nor are required ("the", "and", "was" are in every filler window).
    expect(ids(searchLibrary(db, 'resignations the accountability was the prophet', { deep: true }))).toEqual(['full', 'clip', 'two']);
    // Two words are not enough to go on: no partial matches.
    expect(ids(searchLibrary(db, 'resignations prophet', { deep: true }))).toEqual(['full']);
  });

  // The clip the user could not find (2026-11-25), as its transcript tells it: it never says "never".
  const trump = {
    id: 'clip',
    filename: '2024-07-27 trump says people wont have to vote in 4 years because hell fix it.mp4',
    lines: ['get out and vote in four years you don\'t', "have to vote again we'll have it fixed so good you're not gonna have to vote"],
  };
  // All six words within 30 s, none of them together.
  const scattered = (id: string) => ({
    id,
    filename: `a podcast ${id}.mp4`,
    lines: ['Trump, I have never said so.', ...filler(1), 'Again, they went to see who can vote.', ...filler(5)],
  });

  it('Deep search lists the closest matches first: words said side by side outweigh every word scattered', () => {
    const db = library([trump, scattered('one'), scattered('two'), { id: 'filler', filename: 'weather.mp4', lines: filler(400) }]);
    const res = searchLibrary(db, 'trump never have to vote again', { deep: true });
    expect(ids(res)).toEqual(['clip', 'one', 'two']);
    expect(res.hits.map((h) => h.closest)).toEqual([0, 1, 2]);
    const clip = res.hits[0];
    expect(clip.partial).toBeDefined();
    expect(marked(clip)).toContain('vote');
    expect(clip.moments[0].text).toContain('have to vote again');
    // The others hold every word: no partial mark.
    expect(res.hits[1].partial).toBeUndefined();
    // Two words list as they did, and a name holding the whole query stays first.
    expect(searchLibrary(db, 'vote again', { deep: true }).hits.every((h) => h.closest === undefined)).toBe(true);
    const named = library([trump, scattered('one'), { id: 'named', filename: 'trump never have to vote again.mp4' }, { id: 'filler', filename: 'weather.mp4', lines: filler(400) }]);
    const first = searchLibrary(named, 'trump never have to vote again', { deep: true });
    expect(ids(first)).toEqual(['named', 'clip', 'one']);
    expect(first.hits[0].closest).toBeUndefined();
  });

  it('a closest match is found past the cap on partial matches, and never by an excluded name', () => {
    const many = Array.from({ length: MAX_PARTIAL_VIDEOS + 20 }, (_, i) => ({
      id: `p${i}`, filename: `show ${i}.mp4`, lines: ['Trump would never vote.', ...filler(6)],
    }));
    const db = library([...many, trump, { id: 'filler', filename: 'weather.mp4', lines: filler(4000) }]);
    expect(ids(searchLibrary(db, 'trump never have to vote again', { deep: true }))[0]).toBe('clip');
    expect(searchLibrary(db, 'trump never have to vote again -fix', { deep: true }).hits.find((h) => h.videoId === 'clip')?.closest).toBeUndefined();
  });

  it('a word said elsewhere in a short video counts, outside the best 30 seconds', () => {
    const line = 'A prophet speaks of resignations.';
    const db = library([
      { id: 'without', filename: 'a talk.mp4', downloaded: '2026-01-01', lines: [line, ...filler(20)] },
      { id: 'with', filename: 'another talk.mp4', downloaded: '2020-01-01', lines: [line, ...filler(14), 'Accountability matters.', ...filler(5)] },
      { id: 'filler', filename: 'weather.mp4', lines: filler(400) },
    ]);
    expect(ids(searchLibrary(db, 'prophet resignations accountability', { deep: true }))).toEqual(['with', 'without']);
  });

  it('titleOf drops the extension only', () => {
    expect(titleOf('a.b.mp4')).toBe('a.b');
    expect(titleOf('no extension')).toBe('no extension');
  });

  it('Deep search adds what was meant: under a word hit without repeating its moment, and videos found only by meaning after', async () => {
    const lines = (topic: string) => [`${topic} is what we talk about today, friends.`, `More about ${topic} for the next while here.`];
    const db = library([
      { id: 'words', filename: 'sleeper cells update.mp4', lines: [...lines('sleeper cells'), ...lines('the weather')] },
      { id: 'meaning', filename: 'a podcast.mp4', lines: lines('hidden enemy agents') },
      { id: 'other', filename: 'cooking.mp4', lines: lines('pasta sauce') },
    ]);
    // Axis 0: "hidden agents"; everything else points elsewhere.
    const embed: Embed = async (texts) => texts.map((t) => {
      const v = new Float32Array(DIMENSIONS);
      if (/sleeper|agents/i.test(t)) v[0] = 1; else v[1] = 1;
      return v;
    });
    for (const id of ['words', 'meaning', 'other']) await indexVideoMeaning(db, id, embed);
    const [qv] = await embed(['sleeper cells'], 'search_query');

    const res = searchLibrary(db, 'sleeper cells', { deep: true, meaningQuery: qv });
    expect(res.hits.map((h) => h.videoId)).toEqual(['words', 'meaning']);
    // The word moment is not repeated as a meaning moment; the other video's moment is marked as meaning.
    expect(res.hits[0].moments.filter((m) => m.meaning)).toEqual([]);
    expect(res.hits[1].moments.every((m) => m.meaning)).toBe(true);
    expect(res.meaning).toEqual({ indexed: 3, total: 3 });

    // The cached vectors follow changes: a video's vectors removed with its transcript are gone from the search.
    removeVideoMoments(db, 'meaning');
    expect(searchLibraryMeaning(db, qv).videos.map((v) => v.videoId)).toEqual(['words']);
  });
});
