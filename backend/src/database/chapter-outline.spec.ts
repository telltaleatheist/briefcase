import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { chapterPlace, migrateChaptersOutline } from './chapter-outline';

/**
 * Needs a better-sqlite3 built for this Node (see ranker-migration.spec.ts);
 * without one the SQLite suites skip and only the pure mapping runs.
 */
let Database: any = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  Database = null;
}
const suite = Database ? describe : describe.skip;

describe('chapterPlace', () => {
  it('a flat analysis row gets nothing (the record it always wrote)', () => {
    expect(chapterPlace({ sequence: 1 }, 'id1', new Map())).toEqual({});
  });

  it('resolves parent_sequence to the parent row id, parents first', () => {
    const ids = new Map<number, string>();
    expect(chapterPlace({ sequence: 1, level: 0 }, 'p', ids)).toEqual({ level: 0 });
    expect(chapterPlace({ sequence: 2, level: 1, parent_sequence: 1 }, 'c', ids)).toEqual({ level: 1, parentId: 'p' });
    expect(chapterPlace({ sequence: 3, level: 2, parent_sequence: 2 }, 'g', ids)).toEqual({ level: 2, parentId: 'c' });
  });

  it('a child whose parent is missing is stored at top level', () => {
    expect(chapterPlace({ sequence: 5, level: 1, parent_sequence: 4 }, 'x', new Map())).toEqual({ level: 0 });
  });
});

suite('migration 27 (chapters.level, chapters.parent_id)', () => {
  const columns = (db: any) => db.prepare('PRAGMA table_info(chapters)').all().map((r: any) => r.name);

  it('adds both columns to an old library, keeps its rows top level, and a second run is a no-op', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chapters (id TEXT PRIMARY KEY, video_id TEXT, sequence INTEGER, start_seconds REAL,
      end_seconds REAL, title TEXT, description TEXT, source TEXT, created_at TEXT)`);
    db.prepare(`INSERT INTO chapters VALUES ('a', 'v', 1, 0, 60, 'Intro', NULL, 'ai', 'now')`).run();
    expect(migrateChaptersOutline(db)).toBe(true);
    expect(columns(db)).toEqual(expect.arrayContaining(['level', 'parent_id']));
    expect(db.prepare('SELECT level, parent_id FROM chapters').get()).toEqual({ level: null, parent_id: null });
    expect(migrateChaptersOutline(db)).toBe(false);
  });

  it('a brand-new database (no table yet) is left to initializeSchema', () => {
    expect(migrateChaptersOutline(new Database(':memory:'))).toBe(false);
  });
});

suite('DatabaseService chapter outline round-trip', () => {
  let dir = '';
  beforeAll(() => Logger.overrideLogger(false));
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores a nested analysis parents-first and reads it back; deleting a parent deletes its subtree', async () => {
    const { DatabaseService } = await import('./database.service');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-chapters-'));
    const svc = new DatabaseService({ setLibraryPath: () => undefined } as any);
    svc.initializeDatabase(path.join(dir, 'library.db'));
    for (const id of ['v1', 'v2']) {
      svc.insertVideo({ id, filename: `${id}.mp4`, fileHash: `hash-${id}`, currentPath: path.join(dir, `${id}.mp4`) });
    }

    // As nestAnalysisChapters emits them (see chapter-tree.spec.ts).
    const analysis = [
      { sequence: 1, start: 0, end: 60, title: 'A', level: 0 },
      { sequence: 2, start: 0, end: 30, title: 'A1', level: 1, parent_sequence: 1 },
      { sequence: 3, start: 30, end: 60, title: 'A2', level: 1, parent_sequence: 1 },
      { sequence: 4, start: 60, end: 90, title: 'B', level: 0 },
    ];
    const ids = new Map<number, string>();
    for (const c of analysis) {
      const id = `ch${c.sequence}`;
      svc.insertChapter({
        id, videoId: 'v1', sequence: c.sequence, startSeconds: c.start, endSeconds: c.end, title: c.title, source: 'ai',
        ...chapterPlace(c, id, ids),
      });
    }
    // A flat analysis on another video: NULL level and parent.
    svc.insertChapter({ id: 'flat1', videoId: 'v2', sequence: 1, startSeconds: 0, endSeconds: 10, title: 'Flat' });

    expect(svc.getChapters('v1').map((r) => [r.id, r.title, r.level, r.parent_id])).toEqual([
      ['ch1', 'A', 0, null],
      ['ch2', 'A1', 1, 'ch1'],
      ['ch3', 'A2', 1, 'ch1'],
      ['ch4', 'B', 0, null],
    ]);
    expect(svc.getChapters('v2').map((r) => [r.level, r.parent_id])).toEqual([[null, null]]);

    svc.deleteChapter('ch1');
    expect(svc.getChapters('v1').map((r) => r.id)).toEqual(['ch4']);
  });
});
