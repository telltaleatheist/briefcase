/**
 * The parts of an AI analysis the user picks from (backend
 * analysis/analysis-parts.ts). Each is its own set of calls on Crucible, so a
 * 4-hour broadcast only pays for what is wanted:
 *
 *   metadata  suggested title, description and tags, written from the chapters
 *   chapters  the outline: stories, the chapters inside each, their titles and summaries
 *   flags     "Analysis": flag passages ranked, each checked with a reason
 *
 * Stored on the ai-analyze step's config as `parts`; a config from before parts
 * existed has none and means all three (as the backend reads a task without
 * them).
 */
export type AnalysisPart = 'metadata' | 'chapters' | 'flags';

/** Every part, in the order the pickers show them. */
export const ANALYSIS_PARTS: readonly AnalysisPart[] = ['metadata', 'chapters', 'flags'];

export const ANALYSIS_PART_DEFS: ReadonlyArray<{ part: AnalysisPart; label: string; description: string }> = [
  { part: 'metadata', label: 'Metadata', description: 'Suggested title, description and tags' },
  { part: 'chapters', label: 'Chapters', description: 'Stories, the chapters inside them, titles and summaries' },
  { part: 'flags', label: 'Analysis', description: 'Flagged passages, each checked with a reason' },
];

/** The parts an ai-analyze config asks for, in canonical order. Absent (an older config): all three. */
export function analysisPartsOf(config: Record<string, unknown> | null | undefined): AnalysisPart[] {
  const raw = config?.['parts'];
  if (!Array.isArray(raw)) return [...ANALYSIS_PARTS];
  return ANALYSIS_PARTS.filter(part => raw.includes(part));
}

/** "Metadata and Analysis", for summaries. */
export function describeAnalysisParts(parts: readonly AnalysisPart[]): string {
  const labels = ANALYSIS_PART_DEFS.filter(d => parts.includes(d.part)).map(d => d.label);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
