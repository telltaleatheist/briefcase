/**
 * Scorer - decisions from text without generating any (a port of snap), read
 * off Crucible's decision door (CrucibleScorerService). Snap is Briefcase's
 * analysis engine: chapters and flag ranking run through it.
 *
 * Usage (inside one scorer lease):
 *   await crucibleScorer.withScorer(async (scorer) => {
 *     const res = await scorer.decide({
 *       state: transcriptWindow,
 *       questions: [{ type: 'yesno', name: 'ad', instructions: 'The speaker reads a sponsor message' }],
 *     });
 *     res.answers.ad  // { type: 'yesno', p, labelMass, logProbs: [lnYes, lnNo], ... }
 *   }, signal);
 */
export * from './scorer.types';
export { validateDecideRequest, MAX_IMAGES } from './decide-request';
export { LETTERS, MAX_OPTIONS } from './scorer-labels';
export type { ScorerHandle } from './scorer-handle';
export { CrucibleScorerService } from './crucible-scorer.service';
export { buildSnapTranscript, chunkTranscript, type SnapTranscript } from './snap-transcript';
export { SnapAnalysisService, SnapEngineError, type SnapStageRequest, type SnapStageResult, type SnapStageProgress } from './snap-analysis.service';
export { SnapAnalysisModule } from './snap-analysis.module';
