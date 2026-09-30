/**
 * STORIES: the top level of a video's outline (the user, 2026-09-30: "we're
 * creating a grouping of stories. an outline ... create stories (which might
 * be one) and then create chapters from each story").
 *
 * A STORY is a major subject, the way the next video in a playlist would
 * start; a CHAPTER is a subject change every few minutes inside one story.
 * A video under 10 minutes is one story (no model call). A longer one has its
 * stories found here, by ContentStudio's measured best boundary method
 * (CHAPTERING.md, "the embedding pipeline is REVERSED OUT"): the model reads
 * the WHOLE transcript (plain lines, no timestamps, the runtime stated once)
 * and writes each story's title and its FIRST SENTENCE verbatim; code maps
 * each sentence to the transcript with a forward-only cursor.
 *
 *   read      one generate call on the `chapter` task's model, or, when the
 *             transcript is longer than that model's context, large windows
 *             overlapping by STORY_WINDOW_OVERLAP, each told its own runtime;
 *   map       each quote to a transcript sentence, forward only, fuzzy-tolerant
 *             (flag-generate.ts's anchor matcher). Unmappable and out-of-order
 *             quotes are DROPPED and named, never approximated;
 *   tile      stories start at their sentence's segment start and end where the
 *             next starts; the last ends at the video's end. Two starts closer
 *             than STORY_MIN_GAP_SECONDS are one (the earlier is kept);
 *   pairs     after windowed reading only (windowing inflates counts): every
 *             adjacent pair is asked "is part B the same story as part A?" on
 *             A's tail and B's head, and merged while the model says same.
 *
 * Pure orchestration: every model call goes through `generate`, so a fake
 * drives it in tests. The stage that calls the model is runStoryStage in
 * ai-analysis.service.ts.
 */
import { stopsTheRun } from './cancellation';
import type { RankedSentence } from './flag-windows';
import { anchorWords, chunkWords, findAnchor } from './flag-generate';
import { stripThinkTags } from './model-utils';

// =============================================================================
// CONSTANTS
// =============================================================================

/** A video shorter than this is one story (the user: "if its under 10 minutes, it gets chapters"). */
export const STORIES_MIN_VIDEO_SECONDS = 600;

/** The prompt asks for first sentences at least this long (ContentStudio's measured contract). */
export const STORY_QUOTE_MIN_WORDS = 6;

/** A quote shorter than this (in normalised words) is too short to place and is dropped. */
export const STORY_QUOTE_MAP_MIN_WORDS = 4;

/** How many of a quote's first words are matched (enough to be unique; fewer ASR slips to absorb). */
export const STORY_ANCHOR_WORDS = 12;

/** Two story starts closer than this are one story (overlapping windows report the same start twice). */
export const STORY_MIN_GAP_SECONDS = 60;

/**
 * Output ceiling of one story call. ContentStudio: a 72-minute podcast hit
 * 4,096 on its chapter list and contributed nothing; a story line is ~40
 * tokens, so this holds 200 stories. A model with a small context gets a
 * quarter of its window instead.
 */
export const STORY_MAX_OUTPUT_TOKENS = 8192;

/** Prompt scaffolding reserved in the window, in tokens. */
export const STORY_SCAFFOLD_TOKENS = 1024;

/** Conservative characters per token when sizing a window (as getModelLimits). */
export const STORY_CHARS_PER_TOKEN = 3;

/** Share of each reading window repeated from the end of the one before. */
export const STORY_WINDOW_OVERLAP = 0.15;

/** Characters of part A's tail and of part B's head in a same-story question. */
export const STORY_PAIR_CONTEXT_CHARS = 3000;

/** Output ceiling of a same-story answer (one word; thinking is off). */
export const STORY_PAIR_MAX_OUTPUT_TOKENS = 16;

/** At most this many same-story questions per video (a bound, said in the log when reached). */
export const STORY_PAIR_MAX_QUESTIONS = 80;

// =============================================================================
// TYPES
// =============================================================================

/** One story of the outline: it starts at a sentence and tiles the video with the others. */
export interface StorySpan {
  /** Empty when nothing named it yet (a video under 10 minutes; an unnamed opening). */
  title: string;
  /** Index into assembleSentences(segments) of its first sentence (0 for the first story). */
  startSentence: number;
  startSeconds: number;
  endSeconds: number;
  /** The first sentence the model quoted (absent on the opening story). */
  quote?: string;
}

/** One story line as the model wrote it. */
export interface StoryLine {
  title: string;
  quote: string;
}

export interface StoryAnswer {
  /** The OPENING line's title, or null when the answer has none. */
  opening: string | null;
  stories: StoryLine[];
  /** Lines that were neither an OPENING line nor "title | sentence". */
  unreadable: string[];
}

/** A story start the model gave that was dropped, and why. */
export interface DroppedQuote {
  title: string;
  quote: string;
  reason: 'not found' | 'out of order' | 'too short';
}

/** A quote mapped to its sentence. */
export interface MappedStart {
  sentence: number;
  title: string;
  quote: string;
}

// =============================================================================
// THE PROMPT
// =============================================================================

/** "42 minutes", "1 hour 5 minutes", "2 hours". */
export function runtimePhrase(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}

/**
 * The loose band stated for a runtime. The count is the model's: code
 * computes none. ContentStudio measured that models anchor on counts and
 * ignore rates, so this is a wide count band per runtime rung, and every rung
 * starts at 1 (a video on one subject is one story) except the longest, where
 * a stream of several hours is a run of subjects.
 */
export function storyBand(seconds: number): string {
  if (seconds < 30 * 60) return '1 to 4 stories';
  if (seconds < 90 * 60) return '1 to 8 stories';
  return '3 to 15 stories';
}

/**
 * The story prompt for one call. `part` is set when the transcript is read in
 * windows: that call is told it reads part k of n, and its own runtime.
 */
export function buildStoriesPrompt(transcriptLines: string, runtimeSeconds: number, part?: { index: number; total: number }): string {
  const what = part ? `part ${part.index} of ${part.total} of one video's transcript` : `the complete transcript of one video`;
  const runs = part ? `This part runs ${runtimePhrase(runtimeSeconds)}.` : `The video runs ${runtimePhrase(runtimeSeconds)}.`;
  const subject = part ? 'this part' : 'this video';
  return `Below is ${what}, with no timestamps. ${runs}

TRANSCRIPT:
${transcriptLines}

List the stories ${subject} tells, in order. A story is a completely different subject: a new story starts where the video has finished with one subject and taken up an unrelated one, the way the next video in a playlist would start. Each item of a news broadcast is its own story. A new angle on the same subject, a reaction to it, or a clip about it stays in that story. A sponsor read or a plug belongs to the story around it.

How many stories there are is for the content to decide: ${part ? 'a stretch' : 'a video'} of this length usually holds ${storyBand(runtimeSeconds)}, and one that stays on one subject is one story.

The first line of your answer names the story ${subject} opens with:
OPENING: <a short title for it>

Then one line for each story after it, in the order they occur:
<a short title> | <the FIRST sentence of that story, copied from the transcript above EXACTLY as it appears there, word for word, at least ${STORY_QUOTE_MIN_WORDS} words long>

When ${subject} is one story, answer with the OPENING line alone. Output plain text lines only: no numbering, no commentary, no JSON.`;
}

// =============================================================================
// READING THE ANSWER
// =============================================================================

function unquote(s: string): string {
  return s
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .trim();
}

/**
 * The story lines in one answer, or null when it holds nothing readable (no
 * OPENING line and no story line). Tolerant of numbering, bullets, bold, a
 * code fence and quotes around the sentence; a line that is none of the two
 * forms is kept in `unreadable`, never guessed at.
 */
export function parseStoryAnswer(text: string): StoryAnswer | null {
  if (!text || !text.trim()) return null;
  const answer: StoryAnswer = { opening: null, stories: [], unreadable: [] };
  for (const raw of stripThinkTags(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    line = line.replace(/^(?:\d+\s*[.)]\s+|[-*•]\s+)/, '').trim();
    const opening = /^\**\s*opening\s*\**\s*[:\-–—]\s*(.*)$/i.exec(line);
    if (opening) {
      const title = unquote(opening[1]);
      if (title && answer.opening === null) answer.opening = title;
      continue;
    }
    const bar = line.indexOf('|');
    if (bar > 0) {
      const title = unquote(line.slice(0, bar));
      const quote = unquote(line.slice(bar + 1));
      if (title && quote) {
        answer.stories.push({ title, quote });
        continue;
      }
    }
    answer.unreadable.push(line);
  }
  return answer.opening === null && answer.stories.length === 0 ? null : answer;
}

// =============================================================================
// MAPPING
// =============================================================================

/**
 * Each quoted first sentence to a sentence of `sentences`, in order, with a
 * forward-only cursor: a quote is looked for after the previous story's start.
 * Matching is flag-generate.ts's anchor matcher over the first
 * STORY_ANCHOR_WORDS normalised words (exact first, then fuzzy, tolerant of
 * case, punctuation and a misheard word). The story starts at the sentence the
 * quote's first word is in. A quote not found after the cursor is dropped as
 * 'out of order' when it is found before it, else 'not found'.
 */
export function mapStoryQuotes(
  sentences: Array<Pick<RankedSentence, 'text'>>,
  lines: StoryLine[],
): { starts: MappedStart[]; dropped: DroppedQuote[] } {
  const stream = chunkWords(sentences);
  const starts: MappedStart[] = [];
  const dropped: DroppedQuote[] = [];
  let cursor = 0;
  for (const line of lines) {
    const words = anchorWords(line.quote);
    if (words.length < STORY_QUOTE_MAP_MIN_WORDS) {
      dropped.push({ ...line, reason: 'too short' });
      continue;
    }
    const anchor = words.slice(0, STORY_ANCHOR_WORDS);
    const hit = findAnchor(stream.words, anchor, cursor);
    if (!hit) {
      dropped.push({ ...line, reason: findAnchor(stream.words, anchor, 0) ? 'out of order' : 'not found' });
      continue;
    }
    starts.push({ sentence: stream.sentenceOf[hit.from], title: line.title, quote: line.quote });
    cursor = hit.to + 1;
  }
  return { starts, dropped };
}

/**
 * The stories from the mapped starts: the opening story at 0 (titled by the
 * OPENING line, or untitled), then one per start in order. A start closer than
 * STORY_MIN_GAP_SECONDS to the one before (or on the same sentence) is one
 * story with it: the earlier keeps its place and its title, and an untitled
 * earlier one takes the later one's title. The stories tile [0, totalSeconds].
 */
export function storySpans(
  sentences: Array<Pick<RankedSentence, 'start'>>,
  starts: MappedStart[],
  openingTitle: string | null,
  totalSeconds: number,
): { stories: StorySpan[]; merged: number } {
  const stories: StorySpan[] = [{ title: openingTitle ?? '', startSentence: 0, startSeconds: 0, endSeconds: totalSeconds }];
  let merged = 0;
  for (const start of [...starts].sort((a, b) => a.sentence - b.sentence)) {
    const prev = stories[stories.length - 1];
    const at = start.sentence === 0 ? 0 : sentences[start.sentence].start;
    if (start.sentence <= prev.startSentence || at - prev.startSeconds < STORY_MIN_GAP_SECONDS) {
      if (!prev.title) prev.title = start.title;
      merged++;
      continue;
    }
    stories.push({ title: start.title, startSentence: start.sentence, startSeconds: at, endSeconds: totalSeconds, quote: start.quote });
  }
  for (let k = 0; k + 1 < stories.length; k++) stories[k].endSeconds = stories[k + 1].startSeconds;
  stories[stories.length - 1].endSeconds = Math.max(totalSeconds, stories[stories.length - 1].startSeconds);
  return { stories, merged };
}

/** A video that is one story: [0, totalSeconds], untitled until its chapters name it. */
export function oneStory(totalSeconds: number, title = ''): StorySpan[] {
  return [{ title, startSentence: 0, startSeconds: 0, endSeconds: totalSeconds }];
}

// =============================================================================
// WINDOWS (a transcript longer than the model's context)
// =============================================================================

/** One reading window: an inclusive range of sentence indices. */
export interface StoryWindow {
  from: number;
  to: number;
  chars: number;
}

/**
 * The most transcript one story call may hold, in characters, and its output
 * ceiling, for a model with `contextTokens` of context: the output ceiling is
 * STORY_MAX_OUTPUT_TOKENS or a quarter of the window, whichever is smaller.
 */
export function storyCallBudget(contextTokens: number): { maxChars: number; maxOutputTokens: number } {
  const maxOutputTokens = Math.max(512, Math.min(STORY_MAX_OUTPUT_TOKENS, Math.floor(contextTokens / 4)));
  const inputTokens = Math.max(1024, contextTokens - maxOutputTokens - STORY_SCAFFOLD_TOKENS);
  return { maxChars: inputTokens * STORY_CHARS_PER_TOKEN, maxOutputTokens };
}

/**
 * The sentences in windows of at most `maxChars` (one sentence per line), cut
 * at sentence boundaries; each after the first starts `overlap` of a window
 * before the previous one ended. One window when everything fits.
 */
export function storyWindows(
  sentences: Array<Pick<RankedSentence, 'text'>>,
  maxChars: number,
  overlap: number = STORY_WINDOW_OVERLAP,
): StoryWindow[] {
  const out: StoryWindow[] = [];
  let from = 0;
  while (from < sentences.length) {
    let to = from;
    let chars = sentences[from].text.length;
    while (to + 1 < sentences.length && chars + 1 + sentences[to + 1].text.length <= maxChars) {
      to++;
      chars += 1 + sentences[to].text.length;
    }
    out.push({ from, to, chars });
    if (to === sentences.length - 1) break;
    // Back up about `overlap` of a window, always moving forward.
    let back = to + 1;
    let kept = 0;
    while (back - 1 > from && kept + sentences[back - 1].text.length + 1 <= maxChars * overlap) {
      back--;
      kept += sentences[back].text.length + 1;
    }
    from = Math.max(from + 1, back);
  }
  return out;
}

// =============================================================================
// SAME-STORY PAIRS (after windowed reading)
// =============================================================================

/** The end of `text` (whole sentences where it can), at most `max` characters. */
function tailOf(lines: string[], max: number): string {
  const out: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (chars + lines[i].length + 1 > max && out.length) break;
    out.unshift(lines[i].length > max ? lines[i].slice(-max) : lines[i]);
    chars += lines[i].length + 1;
  }
  return out.join('\n');
}

function headOf(lines: string[], max: number): string {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (chars + line.length + 1 > max && out.length) break;
    out.push(line.length > max ? line.slice(0, max) : line);
    chars += line.length + 1;
  }
  return out.join('\n');
}

export function buildStoryPairPrompt(aTail: string, bHead: string): string {
  return `Below are two consecutive parts of one video's transcript, with no timestamps: the end of part A, then the start of part B, which follows it directly.

PART A (its end):
${aTail}

PART B (its start):
${bHead}

Does part B carry on the same story as part A? The same story includes a new angle on its subject, a reaction to it, a clip about it, and a sponsor read or plug in the middle of it. A different story is a completely different subject, the way the next video in a playlist would start.

Answer with one word: same or different.`;
}

/** 'same', 'different', or null when the answer says neither first. */
export function parsePairAnswer(text: string): 'same' | 'different' | null {
  const m = /\b(same|different)\b/i.exec(stripThinkTags(text || ''));
  return m ? (m[1].toLowerCase() as 'same' | 'different') : null;
}

// =============================================================================
// THE STAGE
// =============================================================================

export interface StoryGenerateResult {
  text: string;
  /** The answer reached the output ceiling. */
  truncated: boolean;
}

export interface FindStoriesOptions {
  /** The model's answer to one prompt. Errors propagate; a cancel or a park stops the stage. */
  generate: (prompt: string, kind: 'stories' | 'pair') => Promise<StoryGenerateResult>;
  /** Most transcript characters one story call holds (storyCallBudget). */
  maxChars: number;
  /** The output ceiling, for the warning when an answer reaches it. */
  maxOutputTokens: number;
  onProgress?: (fraction: number, message: string) => void;
  log?: (message: string) => void;
}

export interface FindStoriesResult {
  stories: StorySpan[];
  /** Named outcomes for the job's warnings. */
  warnings: string[];
  windows: number;
  /** Story calls made (one per window). */
  calls: number;
  /** Same-story questions asked, and how many merged. */
  pairQuestions: number;
  pairMerges: number;
  /** Story lines the model gave, over all windows. */
  given: number;
  dropped: DroppedQuote[];
}

function describeDropped(d: DroppedQuote): string {
  const quote = d.quote.length > 80 ? `${d.quote.slice(0, 80)}…` : d.quote;
  return `"${d.title}" (${d.reason}: "${quote}")`;
}

/**
 * Find a video's stories (see the file header). Throws when no story answer
 * could be read at all (the Chapters part then fails with that reason); a
 * cancel or a park propagates as it is.
 */
export async function findStories(
  sentences: RankedSentence[],
  totalSeconds: number,
  opts: FindStoriesOptions,
): Promise<FindStoriesResult> {
  if (sentences.length === 0) throw new Error('the stories could not be found: the transcript has no sentences');
  const log = opts.log ?? (() => undefined);
  const windows = storyWindows(sentences, opts.maxChars);
  const lines = sentences.map((s) => s.text);
  const warnings: string[] = [];
  const failed: string[] = [];
  const cut: string[] = [];
  const dropped: DroppedQuote[] = [];
  const starts: MappedStart[] = [];
  let opening: string | null = null;
  let given = 0;
  let calls = 0;
  const readShare = windows.length > 1 ? 0.8 : 1;

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    const label = windows.length > 1 ? `part ${w + 1}/${windows.length}` : 'the transcript';
    opts.onProgress?.((w / windows.length) * readShare, windows.length > 1 ? `Finding stories (part ${w + 1}/${windows.length})...` : 'Finding stories...');
    const runtime = w === 0 && windows.length === 1 ? totalSeconds : Math.max(1, sentences[win.to].end - sentences[win.from].start);
    const prompt = buildStoriesPrompt(
      lines.slice(win.from, win.to + 1).join('\n'),
      runtime,
      windows.length > 1 ? { index: w + 1, total: windows.length } : undefined,
    );
    let answerText: string;
    let truncated: boolean;
    try {
      calls++;
      ({ text: answerText, truncated } = await opts.generate(prompt, 'stories'));
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      if (windows.length === 1) throw new Error(`the stories could not be found: ${(error as Error).message}`);
      failed.push(`${label}: ${(error as Error).message}`);
      log(`[Stories] ${label} could not be read: ${(error as Error).message}`);
      continue;
    }
    const answer = parseStoryAnswer(answerText);
    if (!answer) {
      const why = truncated ? 'the answer was cut off at the output limit before a story was written' : 'the answer held no story lines';
      if (windows.length === 1) throw new Error(`the stories could not be found: ${why}`);
      failed.push(`${label}: ${why}`);
      log(`[Stories] ${label}: ${why}: ${answerText.slice(0, 200)}`);
      continue;
    }
    if (truncated) cut.push(label);
    if (w === 0) opening = answer.opening;
    given += answer.stories.length;
    const mapped = mapStoryQuotes(lines.slice(win.from, win.to + 1).map((text) => ({ text })), answer.stories);
    for (const s of mapped.starts) starts.push({ ...s, sentence: s.sentence + win.from });
    dropped.push(...mapped.dropped);
    log(
      `[Stories] ${label} (${win.chars} chars, ${runtimePhrase(runtime)}): opening "${answer.opening ?? '(none)'}", ` +
        `${answer.stories.length} story start(s) given, ${mapped.starts.length} placed` +
        (mapped.dropped.length ? `, ${mapped.dropped.length} dropped (${mapped.dropped.map((d) => d.reason).join(', ')})` : '') +
        (answer.unreadable.length ? `, ${answer.unreadable.length} unreadable line(s) ignored` : '') +
        (truncated ? ' — CUT OFF at the output limit' : ''),
    );
  }
  if (failed.length === windows.length) {
    throw new Error(`the stories could not be found: every part of the transcript failed. Last failure: ${failed[failed.length - 1]}`);
  }

  let { stories, merged } = storySpans(sentences, starts, opening, totalSeconds);
  if (merged) log(`[Stories] ${merged} start(s) within ${STORY_MIN_GAP_SECONDS}s of the one before (or repeated by overlapping parts) joined it`);

  // Windowing inflates counts: ask each adjacent pair whether it is one story.
  let pairQuestions = 0;
  let pairMerges = 0;
  let unreadablePairs = 0;
  if (windows.length > 1 && stories.length > 1) {
    let k = 0;
    while (k + 1 < stories.length) {
      if (pairQuestions >= STORY_PAIR_MAX_QUESTIONS) {
        log(`[Stories] same-story questions stopped at the bound of ${STORY_PAIR_MAX_QUESTIONS}; the remaining ${stories.length - 1 - k} boundaries stand as read`);
        break;
      }
      const a = stories[k];
      const b = stories[k + 1];
      const bEnd = k + 2 < stories.length ? stories[k + 2].startSentence : sentences.length;
      opts.onProgress?.(readShare + (1 - readShare) * (k / Math.max(1, stories.length - 1)), `Checking story ${k + 1}/${stories.length} against the next...`);
      const prompt = buildStoryPairPrompt(
        tailOf(lines.slice(a.startSentence, b.startSentence), STORY_PAIR_CONTEXT_CHARS),
        headOf(lines.slice(b.startSentence, bEnd), STORY_PAIR_CONTEXT_CHARS),
      );
      pairQuestions++;
      let verdict: 'same' | 'different' | null = null;
      try {
        verdict = parsePairAnswer((await opts.generate(prompt, 'pair')).text);
      } catch (error) {
        if (stopsTheRun(error)) throw error;
        log(`[Stories] same-story question ${k + 1}/${stories.length - 1} failed (${(error as Error).message}); the boundary stands`);
      }
      if (verdict === null) unreadablePairs++;
      if (verdict === 'same') {
        log(`[Stories] "${b.title}" is the same story as "${a.title}": merged`);
        a.endSeconds = b.endSeconds;
        if (!a.title) a.title = b.title;
        stories.splice(k + 1, 1);
        pairMerges++;
        continue; // ask the merged story against its new neighbour
      }
      k++;
    }
    log(`[Stories] ${pairQuestions} same-story question(s), ${pairMerges} merge(s), ${unreadablePairs} unanswered (boundary kept)`);
  }

  if (failed.length) {
    warnings.push(
      `Stories: ${failed.length} of ${windows.length} parts of the transcript could not be read, so no story starts were looked for in them: ${failed.join('; ')}`,
    );
  }
  if (cut.length) {
    warnings.push(
      `Stories: the story list reached the model's output limit (${opts.maxOutputTokens} tokens) in ${cut.join(', ')}; stories after the cut were not listed.`,
    );
  }
  if (dropped.length) {
    warnings.push(
      `Stories: ${dropped.length} of the ${given} story starts the model gave could not be placed in the transcript and were dropped: ` +
        dropped.map(describeDropped).join('; '),
    );
  }
  if (given > 0 && stories.length === 1 && starts.length === 0) {
    warnings.push(`Stories: none of the ${given} story starts the model gave could be placed, so the whole video is one story.`);
  }
  opts.onProgress?.(1, `Found ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}`);
  return { stories, warnings, windows: windows.length, calls, pairQuestions, pairMerges, given, dropped };
}

// =============================================================================
// A STORY'S TITLE FROM ITS CHAPTERS (a one-story video)
// =============================================================================

/**
 * The title of a story the story call did not name (a video under 10 minutes,
 * or an opening story without an OPENING line), from its chapters' titles and
 * summaries, on the chapter model.
 */
export function buildStoryTitlePrompt(chapters: Array<{ title: string; summary?: string }>): string {
  const list = chapters.map((c, i) => `${i + 1}. ${c.title}${c.summary ? `: ${c.summary}` : ''}`).join('\n');
  return `Below are the chapters of one story from a video, in order, each with its title and summary.

${list}

Write a title for the story as a whole: one line, up to 12 words, naming its subject through the one or two most important people or claims in it. Output the title alone, as plain text.`;
}

/** The title in a story-title answer: its first non-empty line, unquoted, or null. */
export function parseStoryTitle(text: string): string | null {
  for (const raw of stripThinkTags(text || '').split(/\r?\n/)) {
    const line = unquote(raw.trim().replace(/^\**\s*title\s*\**\s*:\s*\**\s*/i, ''));
    if (line) return line.length > 150 ? `${line.slice(0, 147)}...` : line;
  }
  return null;
}
