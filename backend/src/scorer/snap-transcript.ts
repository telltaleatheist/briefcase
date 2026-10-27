/**
 * One transcript, prepared once per video for the chapter pass (plan §3.2):
 * the unit list and the chunk plan, so every chunk's transcript text (its
 * units joined with "\n") is the state its questions are asked against.
 * Multi-chunk transcripts (> ~16k tokens) prime each chunk once.
 */

import { Chunk, ChunkPlanOptions, planChunks } from './chapters/chunks';
import { unitTokens } from './chapters/snap-chapter.service';
import { AssembleUnitsOptions, SnapUnit, TranscriptSegment, assembleUnits } from './chapters/units';

export interface SnapTranscript {
  /** assembleUnits(segments): what the chapter pass asks about. */
  units: SnapUnit[];
  /** The chunk plan. */
  chunks: Chunk[];
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
  const units = assembleUnits(segments, opts.units);
  const texts = units.map((u) => u.text);
  const chunks = units.length
    ? planChunks(await unitTokens({ countTokens: opts.countTokens }, texts, opts.signal), opts.chunking)
    : [];
  const last = segments.length ? segments[segments.length - 1].end : 0;
  return {
    units,
    chunks,
    totalSeconds: Math.max(last, units.length ? units[units.length - 1].end : 0),
  };
}

/** The transcript text of chunk `k`: its units, one per line. The chapter pass's state starts with exactly this. */
export function chunkTranscript(t: Pick<SnapTranscript, 'units' | 'chunks'>, k: number): string {
  const c = t.chunks[k];
  return t.units
    .slice(c.start, c.end)
    .map((u) => u.text)
    .join('\n');
}
