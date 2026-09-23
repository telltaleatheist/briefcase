import { describe, expect, it } from '@jest/globals';

import { migrateAnalysisSectionsRanker } from './ranker-migration';

/**
 * Needs a better-sqlite3 built for this Node. The app's own copy is built for
 * Electron's ABI, so under plain Node it does not load and this suite skips;
 * run it with a Node build mapped in (jest --moduleNameMapper) to exercise it.
 */
let Database: any = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  Database = null;
}
const suite = Database ? describe : describe.skip;

function oldLibrary() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE analysis_sections (id TEXT PRIMARY KEY, category TEXT, verdict TEXT, nli_score REAL)`);
  db.prepare('INSERT INTO analysis_sections VALUES (?, ?, ?, ?)').run('a', 'x', 'flag', 0.9);
  db.prepare('INSERT INTO analysis_sections VALUES (?, ?, ?, ?)').run('b', 'x', null, null);
  return db;
}
const columns = (db: any) => db.prepare('PRAGMA table_info(analysis_sections)').all().map((r: any) => r.name);
const rankers = (db: any) => db.prepare('SELECT id, ranker FROM analysis_sections ORDER BY id').all();

suite('migration 26 (analysis_sections.ranker)', () => {
  it('adds the column and backfills scored rows as nli; unscored rows stay NULL; a second run is a no-op', () => {
    const db = oldLibrary();
    expect(migrateAnalysisSectionsRanker(db)).toBe(true);
    expect(rankers(db)).toEqual([{ id: 'a', ranker: 'nli' }, { id: 'b', ranker: null }]);
    expect(migrateAnalysisSectionsRanker(db)).toBe(false);
  });

  it('a backfill that fails rolls the ALTER back, so the next open retries both', () => {
    const db = oldLibrary();
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql.startsWith('UPDATE')) throw new Error('disk I/O error');
      return exec(sql);
    };
    expect(() => migrateAnalysisSectionsRanker(db)).toThrow(/disk I\/O/);
    expect(columns(db)).not.toContain('ranker');

    db.exec = exec;
    expect(migrateAnalysisSectionsRanker(db)).toBe(true);
    expect(rankers(db)).toEqual([{ id: 'a', ranker: 'nli' }, { id: 'b', ranker: null }]);
  });

  it('a brand-new database (no table yet) is left to initializeSchema', () => {
    expect(migrateAnalysisSectionsRanker(new Database(':memory:'))).toBe(false);
  });
});
