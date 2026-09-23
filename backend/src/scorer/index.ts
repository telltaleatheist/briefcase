/**
 * Scorer - decisions from text without generating any (a port of snap).
 *
 * Usage (from a Nest service):
 *   constructor(private readonly scorer: ScorerServerService) {}
 *   const res = await this.scorer.decide({
 *     state: transcriptWindow,
 *     questions: [{ type: 'yesno', name: 'ad', instructions: 'The speaker reads a sponsor message' }],
 *   });
 *   res.answers.ad  // { type: 'yesno', p, labelMass, logProbs: [lnYes, lnNo], ... }
 */
export * from './scorer.types';
export { ScorerEngine, N_PROBS, completionReadTimeoutMs, type ScorerEngineLike, type EngineProps } from './scorer-engine';
export { ScorerDecider, labelDistribution, validateDecideRequest, MAX_IMAGES } from './scorer-decide';
export { ScorerPromptBuilder, SYSTEM_PROMPT } from './scorer-prompt';
export { LETTERS, MAX_OPTIONS } from './scorer-labels';
export { loadScorerConfig, resolveScorerBinary, buildScorerArgs, SCORER_BINARY_ENV } from './scorer-config';
export { ScorerServerService, type ScorerHandle, type ScorerServerStatus } from './scorer-server.service';
export { ScorerModule } from './scorer.module';
export { buildSnapTranscript, chunkTranscript, type SnapTranscript } from './snap-transcript';
export { SnapAnalysisService, type SnapStageRequest, type SnapStageResult, type SnapStageProgress } from './snap-analysis.service';
export { SnapAnalysisModule } from './snap-analysis.module';
export {
  resolveAnalysisEngine,
  snapFallbackMessage,
  wantsScorer,
  engineLabel,
  ANALYSIS_ENGINE_ENV,
  type AnalysisEngineSetting,
} from './analysis-engine';
