/**
 * THE ASK CHAT'S READING TOOLS: how a model gets through a video whose
 * transcript does not fit its context (and checks one that does).
 *
 *   outline   the video's map: its length and sentence count, and its parts
 *             (chat-transcript.ts): the stored chapters, title, summary,
 *             times and sentence numbers, else ten-minute parts, each shown
 *             by its first sentence;
 *   search    every sentence matching a pattern, case-insensitive (literal
 *             by default; whole words, or a regular expression, when asked),
 *             numbered and timed, with how many match and how they spread
 *             over the parts; a page of up to SEARCH_PAGE_HITS, then offset;
 *   read      numbered, timed sentences in order from a sentence or a
 *             part's start, a page of at most READ_PAGE_CHARS; each page
 *             says where to continue, and is marked read (Coverage).
 *
 * Pages are sized for a 32K-token model (qwen3.8-27b-4bit on a 24 GB card):
 * a read page is about 2,900 tokens at the 3.5 characters a token Ask
 * estimates with (about 2,300 measured on English), so several fit beside
 * the prompt before the oldest are dropped (tool-harness/context.ts). Reads
 * drop first, then searches and the outline; markers are never dropped.
 *
 * A tool that can't run its arguments (no pattern, a regex that does not
 * compile, a sentence that does not exist) throws, and the harness tells the
 * model why.
 */
import type { Tool } from '../tool-harness';
import {
  OUTLINE_DESCRIPTION,
  OUTLINE_PARAMETERS,
  OUTLINE_TOOL_NAME,
  READ_DESCRIPTION,
  READ_PARAMETERS,
  READ_TOOL_NAME,
  SEARCH_DESCRIPTION,
  SEARCH_PARAMETERS,
  SEARCH_TOOL_NAME,
  spokenDuration,
} from '../analysis/prompts/video-chat-prompts';
import { formatHms } from '../analysis/analysis-parts';
import { sentenceLine, spanHms, type ChatTranscript, type Coverage, type TranscriptPart } from './chat-transcript';

/** A read page's most characters (its lines, numbers and times included). */
export const READ_PAGE_CHARS = 10_000;
/** A search page's most matches, and most characters. */
export const SEARCH_PAGE_HITS = 50;
export const SEARCH_PAGE_CHARS = 8_000;
/** A matching sentence longer than this is shown as this much around its match. */
const SEARCH_HIT_CHARS = 300;
/** An outline line's summary, or a part's first sentence, cut to this. */
const OUTLINE_TEXT_CHARS = 240;

/** The order results are dropped in when the conversation outgrows the context (Tool.dropOrder): pages first. */
const READ_DROP_ORDER = 0;
const SEARCH_DROP_ORDER = 1;

/** What a read covered, for the Ask panel's "Reading HH:MM:SS–HH:MM:SS". */
export interface ReadPage {
  from: number;
  to: number;
  start: number;
  end: number;
}

export function outlineTool(transcript: ChatTranscript, videoTitle: string): Tool<Record<string, unknown>> {
  return {
    name: OUTLINE_TOOL_NAME,
    description: OUTLINE_DESCRIPTION,
    parameters: OUTLINE_PARAMETERS,
    dropOrder: SEARCH_DROP_ORDER,
    async execute() {
      return { content: outlineOf(transcript, videoTitle) };
    },
  };
}

export function searchTool(transcript: ChatTranscript): Tool<Record<string, unknown>> {
  return {
    name: SEARCH_TOOL_NAME,
    description: SEARCH_DESCRIPTION,
    parameters: SEARCH_PARAMETERS,
    dropOrder: SEARCH_DROP_ORDER,
    async execute(args) {
      const pattern = typeof args['pattern'] === 'string' ? args['pattern'].trim() : '';
      if (!pattern) throw new Error('the arguments have no pattern');
      const offset = args['offset'] === undefined ? 0 : Number(args['offset']);
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a whole number, 0 or more');
      return { content: searchOf(transcript, pattern, { wholeWord: args['whole_word'] === true, regex: args['regex'] === true, offset }) };
    },
  };
}

export function readTool(transcript: ChatTranscript, coverage: Coverage): Tool<Record<string, unknown>, ReadPage> {
  return {
    name: READ_TOOL_NAME,
    description: READ_DESCRIPTION,
    parameters: READ_PARAMETERS,
    dropOrder: READ_DROP_ORDER,
    async execute(args) {
      const total = transcript.sentences.length;
      const whole = (key: string): number | undefined => {
        if (args[key] === undefined || args[key] === null) return undefined;
        const n = Number(args[key]);
        if (!Number.isInteger(n)) throw new Error(`${key} must be a whole number`);
        return n;
      };
      const chapter = whole('chapter');
      const from = whole('from');
      const count = whole('count');
      if (count !== undefined && count < 1) throw new Error('count must be 1 or more');
      let start: number;
      let limit = total - 1;
      let part: { number: number; part: TranscriptPart } | null = null;
      if (from !== undefined) {
        if (from < 1 || from > total) throw new Error(`there is no sentence ${from}; the sentences are 1–${total}`);
        start = from - 1;
      } else if (chapter !== undefined) {
        const found = transcript.parts[chapter - 1];
        const kind = transcript.chaptered ? 'chapter' : 'part';
        if (found === undefined) throw new Error(`there is no ${kind} ${chapter}; the ${kind}s are 1–${transcript.parts.length}`);
        if (found.sentences === null) return { content: `${capitalised(kind)} ${chapter}${found.title ? ` "${found.title}"` : ''} has no transcript sentences (no speech).` };
        part = { number: chapter, part: found };
        start = found.sentences.from;
        limit = found.sentences.to;
      } else {
        throw new Error('the arguments need from (a sentence number) or chapter (a number from outline)');
      }
      if (count !== undefined) limit = Math.min(limit, start + count - 1);
      const lines: string[] = [];
      let chars = 0;
      let end = start;
      for (let i = start; i <= limit; i++) {
        const line = sentenceLine(transcript, i);
        if (lines.length > 0 && chars + line.length + 1 > READ_PAGE_CHARS) break;
        lines.push(line);
        chars += line.length + 1;
        end = i;
      }
      coverage.mark(start, end);
      const where = part === null ? '' : `, in ${transcript.chaptered ? 'chapter' : 'part'} ${part.number}${part.part.title ? ` "${part.part.title}"` : ''}`;
      const head = `Sentences ${start + 1}–${end + 1} of ${total} (${spanHms(transcript, start, end)})${where}:`;
      let next: string;
      if (end < limit) next = `The page ends here; continue with read from ${end + 2}${part !== null && count === undefined ? ` (this ${transcript.chaptered ? 'chapter' : 'part'} ends at sentence ${limit + 1})` : ''}.`;
      else if (end < total - 1) next = `Next: read from ${end + 2}.`;
      else next = 'This is the end of the transcript.';
      const page: ReadPage = { from: start, to: end, start: transcript.sentences[start].start, end: transcript.sentences[end].end };
      return { content: [head, ...lines, next].join('\n'), data: page };
    },
  };
}

/** The outline's text (see the file header). */
export function outlineOf(transcript: ChatTranscript, videoTitle: string): string {
  const total = transcript.sentences.length;
  const head = `"${videoTitle}": ${spokenDuration(transcript.duration)} (00:00:00–${formatHms(transcript.duration)}), ${total} sentences.`;
  const kind = transcript.chaptered ? 'chapter' : 'part';
  const intro = transcript.chaptered
    ? 'Chapters:'
    : 'This video has no chapters; here it is in ten-minute parts, each shown by its first sentence:';
  const lines = transcript.parts.map((part, i) => {
    const span = `${formatHms(part.start)}–${formatHms(part.end)}`;
    const sentences = part.sentences === null ? 'no speech' : `sentences ${part.sentences.from + 1}–${part.sentences.to + 1}`;
    if (transcript.chaptered) {
      const summary = part.summary?.trim() ? ` — ${clip(part.summary.trim(), OUTLINE_TEXT_CHARS)}` : '';
      return `${i + 1}. ${span}, ${sentences}: "${part.title}"${summary}`;
    }
    return `${i + 1}. ${span}, ${sentences}: "${clip(transcript.sentences[part.sentences!.from].text, OUTLINE_TEXT_CHARS)}"`;
  });
  return [head, intro, ...lines, `Read a ${kind} with ${READ_TOOL_NAME} {"chapter": n}, or a stretch with ${READ_TOOL_NAME} {"from": n}; find names and words with ${SEARCH_TOOL_NAME}.`].join('\n');
}

/** A search's text (see the file header). Throws on a regular expression that does not compile. */
export function searchOf(transcript: ChatTranscript, pattern: string, options: { wholeWord: boolean; regex: boolean; offset: number }): string {
  const matcher = matcherOf(pattern, options);
  const how = [options.regex ? 'regular expression' : null, 'case-insensitive', options.wholeWord ? 'whole words' : null].filter(Boolean).join(', ');
  const hits = transcript.sentences.flatMap((s, i) => (matcher.test(s.text) ? [i] : []));
  if (hits.length === 0) {
    return `No sentence matches "${pattern}" (${how}). Try another spelling, part of the word, or a related word${options.regex ? '' : ', or regex for several at once ("Biden|Harris")'}.`;
  }
  if (options.offset >= hits.length) return `"${pattern}" (${how}) matches ${hits.length} sentences; offset ${options.offset} is past them all.`;

  const kind = transcript.chaptered ? 'chapter' : 'part';
  const perPart = transcript.parts.map((part) => (part.sentences === null ? 0 : hits.filter((h) => h >= part.sentences!.from && h <= part.sentences!.to).length));
  const withHits = perPart.flatMap((n, i) => (n > 0 ? [`${i + 1}${transcript.parts[i].title ? ` "${clip(transcript.parts[i].title!, 60)}"` : ` (${formatHms(transcript.parts[i].start)})`} ×${n}`] : []));
  const without = perPart.flatMap((n, i) => (n === 0 ? [`${i + 1}`] : []));
  const spread = `By ${kind}: ${withHits.join(', ')}.${without.length > 0 ? ` None in ${without.join(', ')}.` : ''}`;

  const lines: string[] = [];
  let chars = 0;
  for (const index of hits.slice(options.offset, options.offset + SEARCH_PAGE_HITS)) {
    const line = sentenceLine(transcript, index, around(transcript.sentences[index].text, matcher));
    if (lines.length > 0 && chars + line.length + 1 > SEARCH_PAGE_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const first = options.offset + 1;
  const last = options.offset + lines.length;
  const rest = hits.length - last;
  const tail = rest > 0 ? `${rest} more: search again with offset ${last}.` : 'That is every match.';
  return [`"${pattern}" (${how}) matches ${hits.length} sentences. ${spread}`, `Matches ${first}–${last}:`, ...lines, tail].join('\n');
}

/** The search's expression. Literal text matches either apostrophe (transcripts have both). */
function matcherOf(pattern: string, options: { wholeWord: boolean; regex: boolean }): RegExp {
  const source = options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’‘]/g, "['’‘]");
  const body = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
  try {
    return new RegExp(body, 'iu');
  } catch (error) {
    throw new Error(`"${pattern}" is not a regular expression this search can read (${(error as Error).message})`);
  }
}

/** A long sentence as the stretch around its first match. */
function around(text: string, matcher: RegExp): string {
  if (text.length <= SEARCH_HIT_CHARS) return text;
  const at = text.search(matcher);
  const from = Math.max(0, Math.min(at - Math.floor(SEARCH_HIT_CHARS / 3), text.length - SEARCH_HIT_CHARS));
  return `${from > 0 ? '…' : ''}${text.slice(from, from + SEARCH_HIT_CHARS).trim()}${from + SEARCH_HIT_CHARS < text.length ? '…' : ''}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
