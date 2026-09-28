/**
 * The parts of an AI analysis the user picks from (2026-09-27: "we'll split it
 * into different calls and let the user choose between them"):
 *
 *   metadata  suggested title, description, tags. Written FROM chapter
 *             summaries, as it always was (see analyzeTranscriptRun).
 *   chapters  the scorer's outline (with sub-chapters) and one LLM summary each.
 *   flags     the "Analysis" in the UI: snap flag ranking, then the LLM check of
 *             every flag section with its written reason.
 *
 * A job carries the parts it asked for in its task options. A job queued before
 * parts existed (and quick-add, and the batch API) carries none and makes all
 * three, exactly as before. A run replaces the stored output of the parts it
 * made and nothing else (media-operations analyzeVideo).
 *
 * A flags-only run may name a RANGE: one chapter's stretch of the real
 * timeline. Only the transcript inside it is ranked and verified, and only the
 * stored flags that start inside it are replaced.
 *
 * Pure: no I/O, no Nest.
 */

export type AnalysisPart = 'metadata' | 'chapters' | 'flags';

/** Every part, in the order the pipeline makes them (chapters, flags, then metadata from chapters). */
export const ANALYSIS_PARTS: readonly AnalysisPart[] = ['chapters', 'flags', 'metadata'];

/** A stretch of the video's real timeline, in seconds: [start, end). */
export interface AnalysisRange {
  start: number;
  end: number;
  /** What the user picked it as (the chapter's title), for the job's messages. */
  label?: string;
}

/** A job asked for something the pipeline cannot do, by name (never run as something else). */
export class AnalysisRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisRequestError';
  }
}

/**
 * The parts a task asked for. Absent means all three (every job from before
 * parts existed). Present must be a non-empty list of known parts: an empty or
 * unknown list is refused, never read as "everything".
 */
export function resolveAnalysisParts(parts: unknown): Set<AnalysisPart> {
  if (parts === undefined || parts === null) return new Set(ANALYSIS_PARTS);
  if (!Array.isArray(parts)) throw new AnalysisRequestError('The analysis parts must be a list');
  const unknown = parts.filter((p) => !ANALYSIS_PARTS.includes(p as AnalysisPart));
  if (unknown.length > 0) {
    throw new AnalysisRequestError(`Unknown analysis part${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
  if (parts.length === 0) throw new AnalysisRequestError('Pick at least one part of the analysis to run');
  return new Set(parts as AnalysisPart[]);
}

/**
 * The task's range, checked. A range belongs to a flags-only run: chapters and
 * metadata describe the whole video, so a chapter-sized slice of either would
 * replace the whole with a part.
 */
export function resolveAnalysisRange(range: unknown, parts: ReadonlySet<AnalysisPart>): AnalysisRange | null {
  if (range === undefined || range === null) return null;
  const r = range as Partial<AnalysisRange>;
  if (typeof r !== 'object' || !Number.isFinite(r.start) || !Number.isFinite(r.end)) {
    throw new AnalysisRequestError('The analysis range needs a start and an end, in seconds');
  }
  if (r.start! < 0 || r.end! <= r.start!) {
    throw new AnalysisRequestError(`The analysis range ${formatHms(r.start!)}-${formatHms(r.end!)} is empty`);
  }
  if (parts.size !== 1 || !parts.has('flags')) {
    throw new AnalysisRequestError('Only the flag analysis can run on part of a video (chapters and metadata describe all of it)');
  }
  return { start: r.start!, end: r.end!, ...(typeof r.label === 'string' && r.label.trim() ? { label: r.label.trim() } : {}) };
}

/**
 * The transcript segments inside a range: those that START in [start, end),
 * the same rule Pass 2 uses to cut a chapter's text. Timestamps are untouched,
 * so everything made from them stays on the video's real timeline.
 */
export function segmentsInRange<S extends { start: number }>(segments: S[], range: AnalysisRange): S[] {
  return segments.filter((s) => s.start >= range.start && s.start < range.end);
}

/** "chapters and flags", for logs and job messages. */
export function describeParts(parts: Iterable<AnalysisPart>): string {
  const names = ANALYSIS_PARTS.filter((p) => [...parts].includes(p));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** HH:MM:SS (the app's timestamp format). */
export function formatHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------- progress bands

export type Band = [number, number];

/** A stage that does not run has no band, and takes no share of the bar. */
export interface AnalysisProgressBands {
  /** The scorer stage (chapter outline and/or flag ranking). */
  engine: Band | null;
  /** Pass 2: one summary per chapter. */
  summaries: Band | null;
  /** Pass 2b: every flag section checked. */
  flags: Band | null;
  /** Tags, description, title. */
  metadata: Band | null;
}

/**
 * Each stage's weight on the 3-98% stretch of the bar. With every stage
 * running these are exactly the bands the pipeline always had: engine 3-70,
 * summaries 71-80, flags 80-92, metadata 92-98.
 */
const STAGE_WEIGHTS = { engine: 67, summaries: 10, flags: 12, metadata: 6 } as const;

/**
 * The flag stage's weight when the model reads the transcript for flags: one
 * generation per ~8,000 characters, then the checks, so it takes over the flag
 * scan's share of the engine's time.
 */
export const GENERATE_FLAGS_STAGE_WEIGHT = 30;
const BAR_START = 3;
const BAR_END = 98;

/**
 * The bands for the stages this run makes. The stages that run share the whole
 * bar in proportion to their usual weights, so a skipped stage takes none of it
 * and the bar never sits still across a stage that is not happening.
 */
export function analysisProgressBands(
  run: { engine: boolean; summaries: boolean; flags: boolean; metadata: boolean },
  /**
   * A stage's weight when it is not its usual share: the flag stage when the
   * model reads the transcript for flags (flag-generate.ts), which is then the
   * flag stage's work rather than the engine's.
   */
  weights: Partial<Record<keyof typeof STAGE_WEIGHTS, number>> = {},
): AnalysisProgressBands {
  const order = ['engine', 'summaries', 'flags', 'metadata'] as const;
  const weight = (stage: (typeof order)[number]) => weights[stage] ?? STAGE_WEIGHTS[stage];
  const total = order.reduce((sum, stage) => sum + (run[stage] ? weight(stage) : 0), 0);
  const bands: AnalysisProgressBands = { engine: null, summaries: null, flags: null, metadata: null };
  if (total === 0) return bands;
  const scale = (BAR_END - BAR_START) / total;
  let at = BAR_START;
  for (const stage of order) {
    if (!run[stage]) continue;
    const end = at + weight(stage) * scale;
    // The summaries start one point past the engine's end, where "Found N
    // chapters" is said (as they always have).
    const start = stage === 'summaries' && run.engine ? at + 1 : at;
    bands[stage] = [Math.round(start), Math.round(end)];
    at = end;
  }
  return bands;
}
