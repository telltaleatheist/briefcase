/**
 * The scoring columns of an analysis_sections row, in insertAnalysisSection's
 * shape, for code that re-inserts an EXISTING row (library transfer, delete
 * undo).
 *
 * Dropping them is not harmless: a NULL verdict reads as a legacy, confirmed
 * flag, so a 'skip' (the verifier rejected it) or 'candidate' (never verified)
 * row copied without its verdict comes back as a flag. NULLs stay undefined,
 * which insertAnalysisSection writes as NULL again, so legacy rows stay legacy.
 *
 * The columns exist on every library a row can be inserted into: they come from
 * runSchemaMigrations (24 and 26), which initializeDatabase runs on every open,
 * and insertAnalysisSection already writes all three unconditionally.
 */
export interface SectionScoringRow {
  verdict?: string | null;
  nli_score?: number | null;
  ranker?: string | null;
}

export function sectionScoringFields(row: SectionScoringRow): {
  verdict?: 'flag' | 'skip' | 'candidate';
  nliScore?: number;
  ranker?: string;
} {
  const verdict =
    row.verdict === 'flag' || row.verdict === 'skip' || row.verdict === 'candidate' ? row.verdict : undefined;
  const nliScore = typeof row.nli_score === 'number' && Number.isFinite(row.nli_score) ? row.nli_score : undefined;
  const ranker = typeof row.ranker === 'string' && row.ranker ? row.ranker : undefined;
  return { verdict, nliScore, ranker };
}
