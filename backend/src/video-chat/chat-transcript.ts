/**
 * THE TRANSCRIPT AN ASK ANSWER READS: the video's sentences (numbered from 1
 * for the model), their words for finding quotes, and the video's map, its
 * PARTS: the stored chapters (the outline's leaves, with their summaries)
 * when the video has them, else even ten-minute parts. The tools
 * (transcript-tools.ts, add-marker-tool.ts) all read this one object.
 *
 * COVERAGE is what the model has read of it in this answer, tracked here,
 * never left to the model's memory: a page read marks its sentences, and
 * every round's results end with the line saying what is read and what is
 * not (the loop's resultsNote). A page dropped from the conversation to fit
 * the context stays counted as read: the model saw it, and may read it again.
 * When the whole transcript is in the prompt, everything is read from the start.
 */
import type { RankedSentence } from '../analysis/flag-windows';
import { formatHms } from '../analysis/analysis-parts';
import { chunkWords, type ChunkWords } from '../analysis/passage-anchor';

/** A video without stored chapters is mapped in parts of this many seconds. */
export const PART_SECONDS = 600;

/** A stored chapter, as the outline shows it. */
export interface StoredChapter {
  title: string;
  summary: string | null;
  /** Seconds. */
  start: number;
  end: number;
}

/** One entry of the video's map: a chapter, or a ten-minute part. */
export interface TranscriptPart {
  /** The chapter's title; null for a ten-minute part (shown by its first sentence). */
  title: string | null;
  summary: string | null;
  /** Seconds. */
  start: number;
  end: number;
  /** Its sentences, as indices (inclusive); null when none fall in it (no speech). */
  sentences: { from: number; to: number } | null;
}

export interface ChatTranscript {
  sentences: RankedSentence[];
  words: ChunkWords;
  parts: TranscriptPart[];
  /** The parts are the video's stored chapters (else ten-minute parts). */
  chaptered: boolean;
  /** Seconds: the video's, when known, else the last sentence's end. */
  duration: number;
}

export function chatTranscript(sentences: RankedSentence[], options: { chapters?: StoredChapter[]; duration?: number | null } = {}): ChatTranscript {
  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1].end : 0;
  const duration = options.duration && options.duration > 0 ? Math.max(options.duration, lastEnd) : lastEnd;
  const chapters = [...(options.chapters ?? [])].sort((a, b) => a.start - b.start);
  const parts = chapters.length > 0 ? chapterParts(sentences, chapters) : tenMinuteParts(sentences, duration);
  return { sentences, words: chunkWords(sentences), parts, chaptered: chapters.length > 0, duration };
}

/**
 * Each sentence goes to the last chapter that starts at or before it (one
 * before the first chapter, to the first), so the chapters' sentences tile
 * the transcript in order whatever gaps or overlaps their times have.
 */
function chapterParts(sentences: RankedSentence[], chapters: StoredChapter[]): TranscriptPart[] {
  const parts: TranscriptPart[] = chapters.map((c) => ({ title: c.title, summary: c.summary, start: c.start, end: c.end, sentences: null }));
  let chapter = 0;
  sentences.forEach((sentence, index) => {
    while (chapter + 1 < chapters.length && chapters[chapter + 1].start <= sentence.start) chapter += 1;
    const part = parts[chapter];
    part.sentences = part.sentences === null ? { from: index, to: index } : { from: part.sentences.from, to: index };
  });
  return parts;
}

/** Ten-minute parts that hold speech, in order; one with none (a long silence) is left out. */
function tenMinuteParts(sentences: RankedSentence[], duration: number): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  sentences.forEach((sentence, index) => {
    const slot = Math.floor(sentence.start / PART_SECONDS);
    const last = parts[parts.length - 1];
    if (last !== undefined && Math.floor(last.start / PART_SECONDS) === slot) {
      last.sentences = { from: last.sentences!.from, to: index };
      return;
    }
    parts.push({ title: null, summary: null, start: slot * PART_SECONDS, end: Math.min((slot + 1) * PART_SECONDS, Math.max(duration, sentence.end)), sentences: { from: index, to: index } });
  });
  return parts;
}

/** One sentence as the tools show it: `[number] HH:MM:SS text`. */
export function sentenceLine(transcript: ChatTranscript, index: number, text = transcript.sentences[index].text): string {
  return `[${index + 1}] ${formatHms(transcript.sentences[index].start)} ${text}`;
}

/** The time span of sentences `from`–`to` (indices), `HH:MM:SS–HH:MM:SS`. */
export function spanHms(transcript: ChatTranscript, from: number, to: number): string {
  return `${formatHms(transcript.sentences[from].start)}–${formatHms(transcript.sentences[to].end)}`;
}

/** At most this many ranges are listed in a coverage line; the rest are counted. */
const COVERAGE_RANGES_SHOWN = 6;

/** What the model has read of the transcript in this answer (see the file header). */
export class Coverage {
  private readonly read: boolean[];

  constructor(private readonly transcript: ChatTranscript, all: boolean) {
    this.read = transcript.sentences.map(() => all);
  }

  /** Sentences `from`–`to` (indices, inclusive) have been read. */
  mark(from: number, to: number): void {
    for (let i = from; i <= to; i++) this.read[i] = true;
  }

  /** The coverage line every round's results end with. */
  line(): string {
    const total = this.read.length;
    const read = runs(this.read, true);
    if (read.length === 1 && read[0].from === 0 && read[0].to === total - 1) return `Read so far: all ${total} sentences.`;
    const unread = `Unread: ${listRanges(runs(this.read, false), (r) => range(r))}.`;
    if (read.length === 0) return `Read so far: none of the ${total} sentences. ${unread}`;
    return `Read so far: sentences ${listRanges(read, (r) => `${range(r)} (${spanHms(this.transcript, r.from, r.to)})`)} of ${total}. ${unread}`;
  }
}

/** The runs of `value` in `flags`, as index ranges. */
function runs(flags: boolean[], value: boolean): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  flags.forEach((flag, i) => {
    if (flag !== value) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.to === i - 1) last.to = i;
    else out.push({ from: i, to: i });
  });
  return out;
}

/** A range as sentence numbers: `421–1250`, or `421` for one. */
function range(r: { from: number; to: number }): string {
  return r.from === r.to ? `${r.from + 1}` : `${r.from + 1}–${r.to + 1}`;
}

function listRanges(ranges: Array<{ from: number; to: number }>, show: (r: { from: number; to: number }) => string): string {
  const shown = ranges.slice(0, COVERAGE_RANGES_SHOWN).map(show).join(', ');
  return ranges.length > COVERAGE_RANGES_SHOWN ? `${shown} and ${ranges.length - COVERAGE_RANGES_SHOWN} more ranges` : shown;
}
