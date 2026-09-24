/**
 * One transcript, prepared once per video for BOTH snap passes (plan §3.2).
 *
 * Chapters and flags must ask their questions against the same state text, or
 * the engine cannot reuse the primed transcript between them: Qwen3.5 is a
 * hybrid model and rewinds only to a context checkpoint, which priming leaves
 * exactly at the end of `system + "State:\n" + <state>`. So the unit list, the
 * chunk plan and therefore every chunk's transcript text are built here, once,
 * and handed to both:
 *
 *   chapters  state = the chunk's units joined with "\n" (segment.py:106)
 *   flags     state = the same text, plus "\n\n" + the category legend in the
 *             'prefix' layout (or nothing more in the 'inline' layout)
 *
 * so the chapter state is a byte prefix of the flag state (identical in the
 * inline layout), and the flag pass's prime re-reads only the legend.
 *
 * Multi-chunk transcripts (> ~16k tokens) still re-prime each chunk once per
 * pass: the chapter pass walks every chunk before the flag pass starts, and the
 * flag pass walks every chunk for pass 1 and again for pass 2. Only the chunk
 * that was primed last is still cached when the next pass begins.
 */

import { RankedSentence, assembleSentences } from '../analysis/flag-windows';
import { Chunk, ChunkPlanOptions, planChunks } from './chapters/chunks';
import { unitTokens } from './chapters/snap-chapter.service';
import { AssembleUnitsOptions, SnapUnit, TranscriptSegment, assembleUnits } from './chapters/units';
import { FlagChunk, flagChunksFromPlan } from './flags/flag-units';

export interface SnapTranscript {
  /** assembleSentences(segments): what flag windows, passages and sections index. */
  sentences: RankedSentence[];
  /** assembleUnits(segments): what both passes ask about. */
  units: SnapUnit[];
  /** One chunk plan for both passes (chapters' shape). */
  chunks: Chunk[];
  /** The same plan in the flag ranker's shape. */
  flagChunks: FlagChunk[];
  /** End of the media, in seconds (the last segment's end). */
  totalSeconds: number;
}

export interface SnapTranscriptOptions {
  units?: AssembleUnitsOptions;
  chunking?: ChunkPlanOptions;
  /** Real token counts (Crucible's tokenize). Absent: ~4 characters per token. */
  countTokens?: (text: string, signal?: AbortSignal) => Promise<number>;
  signal?: AbortSignal;
}

export async function buildSnapTranscript(
  segments: TranscriptSegment[],
  opts: SnapTranscriptOptions = {},
): Promise<SnapTranscript> {
  const sentences = assembleSentences(segments);
  const units = assembleUnits(segments, opts.units);
  const texts = units.map((u) => u.text);
  const chunks = units.length
    ? planChunks(await unitTokens({ countTokens: opts.countTokens }, texts, opts.signal), opts.chunking)
    : [];
  const last = segments.length ? segments[segments.length - 1].end : 0;
  return {
    sentences,
    units,
    chunks,
    flagChunks: flagChunksFromPlan(chunks),
    totalSeconds: Math.max(last, units.length ? units[units.length - 1].end : 0),
  };
}

/** The transcript text of chunk `k`: its units, one per line. Both passes' state starts with exactly this. */
export function chunkTranscript(t: Pick<SnapTranscript, 'units' | 'chunks'>, k: number): string {
  const c = t.chunks[k];
  return t.units
    .slice(c.start, c.end)
    .map((u) => u.text)
    .join('\n');
}
