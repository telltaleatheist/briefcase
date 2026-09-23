import type * as Database from 'better-sqlite3';

/**
 * Migration 26: add analysis_sections.ranker and backfill it.
 *
 * The flag pipeline has two rankers (NLI, and the snap scorer behind the
 * analysisEngine setting), and nli_score means a different scale on each, so a
 * row has to say which one scored it. Additive and nullable, like migration 24.
 *
 * BACKFILL IS FACTUAL, unlike migration 24's deliberate no-backfill: before
 * this migration the NLI ranker was the ONLY writer of nli_score, so every row
 * with a score IS an NLI row. Rows without one (legacy, discovery) stay NULL.
 *
 * The ALTER and the backfill run in ONE transaction. The column's presence is
 * the "already migrated" marker, so an ALTER that committed without its
 * backfill (a failure or crash between the two) would skip the backfill on
 * every later open, leaving old NLI rows unlabelled for good. SQLite rolls the
 * ALTER back with the transaction, so a failed attempt is simply retried.
 *
 * Returns true when it migrated, false when there was nothing to do. Throws on
 * failure; the caller turns that into its "migration failed" load abort.
 */
export function migrateAnalysisSectionsRanker(db: Database.Database): boolean {
  try {
    db.exec('SELECT ranker FROM analysis_sections LIMIT 1');
    return false;
  } catch (error: any) {
    const message: string = error?.message || '';
    // 'no such table': a brand-new database, which initializeSchema has
    // already created with the column present. Anything else propagates.
    if (message.includes('no such table')) return false;
    if (!message.includes('no such column: ranker')) throw error;
  }
  db.transaction(() => {
    db.exec('ALTER TABLE analysis_sections ADD COLUMN ranker TEXT');
    db.exec(`UPDATE analysis_sections SET ranker = 'nli' WHERE ranker IS NULL AND nli_score IS NOT NULL`);
  })();
  return true;
}
