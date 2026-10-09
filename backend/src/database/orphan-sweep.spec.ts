import { describe, expect, it } from '@jest/globals';
import Database = require('better-sqlite3');

import { sweepOrphans } from './orphan-sweep';

describe('sweepOrphans', () => {
  it('removes cascade children of missing videos, unlinks SET NULL ones, and keeps the rest', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF'); // how the orphans got there: a delete that never cascaded
    db.exec(`
      CREATE TABLE videos (id TEXT PRIMARY KEY);
      CREATE TABLE transcripts (video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE, text TEXT);
      CREATE TABLE relationships (a TEXT REFERENCES videos(id) ON DELETE CASCADE, b TEXT REFERENCES videos(id) ON DELETE CASCADE);
      CREATE TABLE saved_links (id TEXT PRIMARY KEY, video_id TEXT REFERENCES videos(id) ON DELETE SET NULL);
      INSERT INTO videos VALUES ('kept');
      INSERT INTO transcripts VALUES ('kept', 'x'), ('gone', 'y');
      INSERT INTO relationships VALUES ('kept', 'kept'), ('kept', 'gone'), ('gone', 'kept');
      INSERT INTO saved_links VALUES ('l1', 'gone'), ('l2', 'kept'), ('l3', NULL);
    `);
    db.pragma('foreign_keys = ON');

    expect(sweepOrphans(db)).toEqual({ transcripts: 1, relationships: 2, saved_links: 1 });
    expect(db.prepare('SELECT video_id FROM transcripts').all()).toEqual([{ video_id: 'kept' }]);
    expect(db.prepare('SELECT a, b FROM relationships').all()).toEqual([{ a: 'kept', b: 'kept' }]);
    expect(db.prepare('SELECT id, video_id FROM saved_links ORDER BY id').all()).toEqual([
      { id: 'l1', video_id: null },
      { id: 'l2', video_id: 'kept' },
      { id: 'l3', video_id: null },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(sweepOrphans(db)).toEqual({});
  });
});
