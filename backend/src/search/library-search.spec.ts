import { describe, expect, it } from '@jest/globals';
import Database = require('better-sqlite3');

import { searchLibrary, titleOf } from './library-search';
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
  indexPendingTranscripts(db, 100);
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
