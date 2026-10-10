import { describe, expect, it } from '@jest/globals';
import Database = require('better-sqlite3');

import { ensureTitleIndex, searchLibrary, titleOf } from './library-search';
import { ensureMomentSchema, indexPendingTranscripts } from './transcript-moments';

const hms = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
const srtOf = (lines: string[]) => lines.map((t, i) => `${i + 1}\n${hms(i * 5)} --> ${hms(i * 5 + 5)}\n${t}\n`).join('\n');

function library(videos: Array<{ id: string; filename: string; lines?: string[] }>) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE videos (id TEXT PRIMARY KEY, filename TEXT NOT NULL);
    CREATE TABLE transcripts (video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE, srt_format TEXT, transcribed_at TEXT);
  `);
  ensureMomentSchema(db);
  ensureTitleIndex(db);
  for (const v of videos) {
    db.prepare('INSERT INTO videos (id, filename) VALUES (?, ?)').run(v.id, v.filename);
    if (v.lines) db.prepare('INSERT INTO transcripts VALUES (?, ?, ?)').run(v.id, srtOf(v.lines), 'x');
  }
  indexPendingTranscripts(db, 100);
  return db;
}

describe('searchLibrary', () => {
  it('lists title matches first (with their moments), then videos where it is only said', () => {
    const db = library([
      { id: 'debate', filename: '2026-09-15 Bryce Crawford VS Logan Paul (God Debate).mp4', lines: ['Logan Paul walks in.', 'Opening remarks.'] },
      { id: 'other', filename: '2026-01-01 a podcast.mp4', lines: ['Then I watched Logan Paul box.'] },
      { id: 'quiet', filename: '2026-02-02 Logan Paul highlights.mp4' },
      { id: 'none', filename: 'cooking.mp4', lines: ['Nothing here.'] },
    ]);
    const res = searchLibrary(db, 'logan paul');
    expect(res.hits.map((h) => h.videoId)).toEqual(['debate', 'quiet', 'other']);
    const debate = res.hits[0];
    expect(debate.title).toBe('2026-09-15 Bryce Crawford VS Logan Paul (God Debate)');
    expect(debate.titleHighlights.map(([a, b]) => debate.title.slice(a, b))).toEqual(['Logan', 'Paul']);
    expect(debate.moments).toHaveLength(1);
    expect(res.hits[2].titleHighlights).toEqual([]);
    expect(res.hits[2].moments[0].text).toContain('Logan Paul');
  });

  it('follows typing: a partial word finds the titles and moments with words it starts', () => {
    const db = library([
      { id: 'shane', filename: '2026-03-01 Shane Vaughn on the end times.mp4', lines: ['Shane Vaughn speaks.'] },
      { id: 'other', filename: 'cooking.mp4', lines: ['We shall see.'] },
    ]);
    const res = searchLibrary(db, 'sha');
    expect(res.hits.map((h) => h.videoId)).toEqual(['shane', 'other']);
    expect(res.hits[0].titleHighlights.map(([a, b]) => res.hits[0].title.slice(a, b))).toEqual(['Shane']);
    expect(searchLibrary(db, 'shane vau').hits.map((h) => h.videoId)).toEqual(['shane']);
    expect(searchLibrary(db, '"sha"').hits).toEqual([]);
  });

  it('a title must hold every part; phrases, prefixes and exclusions apply to titles too', () => {
    const db = library([
      { id: 'a', filename: 'god debate night.mp4' },
      { id: 'b', filename: 'debate about god.mp4' },
      { id: 'c', filename: 'debating god boxing.mp4' },
    ]);
    expect(searchLibrary(db, 'god debate').hits.map((h) => h.videoId).sort()).toEqual(['a', 'b']);
    expect(searchLibrary(db, '"god debate"').hits.map((h) => h.videoId)).toEqual(['a']);
    expect(searchLibrary(db, 'debat* god -boxing').hits.map((h) => h.videoId).sort()).toEqual(['a', 'b']);
  });

  it('the title index follows renames and deletes, and rebuilds itself when it no longer matches', () => {
    const db = library([{ id: 'a', filename: 'first name.mp4' }, { id: 'b', filename: 'other.mp4' }]);
    db.prepare("UPDATE videos SET filename = 'renamed clip.mp4' WHERE id = 'a'").run();
    expect(searchLibrary(db, 'first').hits).toEqual([]);
    expect(searchLibrary(db, 'renamed').hits.map((h) => h.videoId)).toEqual(['a']);
    db.prepare("DELETE FROM videos WHERE id = 'a'").run();
    expect(searchLibrary(db, 'renamed').hits).toEqual([]);

    // A table rebuild drops the triggers; the next open finds the index stale and rebuilds it.
    db.exec(`DROP TRIGGER video_titles_ai; INSERT INTO videos (id, filename) VALUES ('c', 'added while untracked.mp4');`);
    expect(searchLibrary(db, 'untracked').hits).toEqual([]);
    ensureTitleIndex(db);
    expect(searchLibrary(db, 'untracked').hits.map((h) => h.videoId)).toEqual(['c']);
  });

  it('titleOf drops the extension only', () => {
    expect(titleOf('a.b.mp4')).toBe('a.b');
    expect(titleOf('no extension')).toBe('no extension');
  });
});
