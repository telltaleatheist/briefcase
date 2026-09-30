/**
 * STORIES: the top level of a video's outline, as GROUPS OF CONSECUTIVE
 * CHAPTERS (the user, 2026-09-30: "create stories (which might be one) and
 * then create chapters from each story").
 *
 * A STORY is one subject; a CHAPTER is a subject change every few minutes. The
 * first build found stories by having the model read the transcript and quote
 * each story's first sentence, with a count band per runtime. The user's review
 * of it: the whole-video chapters were already near story-level ("the amanda
 * grace video's current chapters are actually pretty accurate for stories"),
 * and the stories should be found without counts ("id like to find a way to
 * make it make sense"). So stories are made bottom-up:
 *
 *   chapters  the whole video's chapters, as always (scorer), with their Pass 2
 *             summaries;
 *   group     ONE call on the `chapter` task's model reads the numbered chapter
 *             list (times, titles, summaries, sponsor marks) and says where each
 *             story starts, with its title and a summary. No count is asked for
 *             or suggested (models anchor on counts);
 *   ads       code then makes every sponsor chapter its own story, and the
 *             subject after it a new one ("ad → story about ai → ad → story
 *             about trump"), whatever the model grouped;
 *   one       a video under 10 minutes, or one the model finds to be one
 *             subject, is one story: the outline stays flat (no story level).
 *
 * Story edges are chapter edges by construction. An unreadable grouping is
 * asked again once with its problem named, then fails the Chapters part (no AI
 * fallbacks). Pure orchestration: the model call is `generate`, so a fake
 * drives it in tests; ai-analysis.service.ts's groupStories stage calls it.
 */
import { stopsTheRun } from './cancellation';
import { stripThinkTags } from './model-utils';

/** A video shorter than this is one story (the user: "if its under 10 minutes, it gets chapters"). */
export const STORIES_MIN_VIDEO_SECONDS = 600;

/**
 * Output ceiling of the grouping call. A story line is ~60 tokens with its
 * summary, so this holds well over 100 stories.
 */
export const STORY_GROUP_MAX_OUTPUT_TOKENS = 8192;

/** One chapter as the grouping call sees it. */
export interface StoryChapter {
  startSeconds: number;
  endSeconds: number;
  title: string;
  /** Pass 2's summary; empty when that chapter's call failed. */
  summary: string;
  /** The scorer's ad check marked it a sponsor read / self-promotion. */
  isAd: boolean;
}

/** One story line as the model wrote it: its first chapter (1-based), title and summary. */
export interface StoryGroupLine {
  firstChapter: number;
  title: string;
  summary: string;
}

/** A story: a run of consecutive chapters [firstChapter, lastChapter] (0-based, inclusive). */
export interface Story {
  title: string;
  summary: string;
  firstChapter: number;
  lastChapter: number;
  startSeconds: number;
  endSeconds: number;
  /** A sponsor read or self-promotion, split out as its own story. */
  isAd: boolean;
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

function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** The numbered chapter list the grouping call reads. */
export function storyChapterList(chapters: StoryChapter[]): string {
  return chapters
    .map((c, i) => {
      const head = `${i + 1}. [${hms(c.startSeconds)}-${hms(c.endSeconds)}] ${c.isAd ? '[SPONSOR] ' : ''}${c.title.trim()}`;
      return c.summary.trim() ? `${head}\n   ${c.summary.trim().replace(/\s*\n\s*/g, ' ')}` : head;
    })
    .join('\n');
}

export function buildStoryGroupingPrompt(chapters: StoryChapter[], runtimeSeconds: number): string {
  return `Below are the chapters of one video, in order, each with its time range, title and summary. The video runs ${runtimePhrase(runtimeSeconds)}.

CHAPTERS:
${storyChapterList(chapters)}

Group the chapters into the video's stories. A story is one subject, made of one or more consecutive chapters.

- Chapters that are different angles, examples, background, evidence or reactions for the same subject belong to one story. When several chapters build one argument, they are one story.
- An introduction or welcome belongs to the story that follows it.
- A new story starts where the video takes up a clearly different subject, even a short one.
- A chapter marked [SPONSOR] (a sponsor read, an ad break, or the speaker promoting their own product or book) is a story of its own.
- A subject the video returns to after a sponsor chapter starts a new story.
- There is no expected number of stories: a video that stays on one subject is one story, and a show that moves through many subjects has many.

Answer with one line per story, in order:
<number of its first chapter> | <a short title for the story> | <one or two sentences on what the story covers>

The first story starts at chapter 1. Output those lines only: no commentary, no JSON.`;
}

/** The prompt again, with the problem in the last answer named, for the one retry. */
export function buildStoryGroupingRetry(prompt: string, problem: string): string {
  return `${prompt}

Your previous answer could not be used: ${problem}. Answer again in exactly the format asked.`;
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
 * The story lines of an answer, checked against `chapterCount` chapters, or
 * the problem that makes it unusable (said to the model on the retry).
 * Tolerant of bullets, bold, a code fence and "Chapter 3" for "3"; strict on
 * the numbers: the first story starts at chapter 1, starts rise, every start
 * is a chapter.
 */
export function parseStoryGrouping(text: string, chapterCount: number): { lines: StoryGroupLine[] } | { problem: string } {
  const lines: StoryGroupLine[] = [];
  const unreadable: string[] = [];
  for (const raw of stripThinkTags(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    line = line.replace(/^[-*•]\s+/, '').replace(/^\*\*|\*\*$/g, '').trim();
    const parts = line.split('|').map(unquote);
    const first = /^(?:chapters?\s*)?(\d+)\b/i.exec(parts[0] ?? '');
    if (parts.length < 2 || !first || !parts[1]) {
      unreadable.push(line);
      continue;
    }
    lines.push({ firstChapter: Number(first[1]), title: parts[1], summary: parts.slice(2).join(' | ').trim() });
  }
  if (lines.length === 0) {
    return { problem: unreadable.length ? `no line had the form "<first chapter> | <title> | <summary>" (for example "${unreadable[0].slice(0, 80)}")` : 'it was empty' };
  }
  if (lines[0].firstChapter !== 1) return { problem: `the first story must start at chapter 1, not ${lines[0].firstChapter}` };
  for (let k = 1; k < lines.length; k++) {
    const n = lines[k].firstChapter;
    if (n > chapterCount) return { problem: `story "${lines[k].title}" starts at chapter ${n}, but there are only ${chapterCount} chapters` };
    if (n <= lines[k - 1].firstChapter) {
      return { problem: `the stories must be in order: "${lines[k].title}" starts at chapter ${n}, after a story starting at chapter ${lines[k - 1].firstChapter}` };
    }
  }
  return { lines };
}

// =============================================================================
// STORIES FROM THE LINES
// =============================================================================

/**
 * The stories from the model's lines, with every sponsor chapter split out as
 * a story of its own (titled and summarised by that chapter) and the chapters
 * after it, still inside the model's group, a new story carrying the group's
 * title and summary. The stories tile the chapters, so they tile the video.
 */
export function storiesFromGrouping(chapters: StoryChapter[], lines: StoryGroupLine[]): Story[] {
  const out: Story[] = [];
  const push = (first: number, last: number, title: string, summary: string, isAd: boolean) =>
    out.push({
      title,
      summary,
      firstChapter: first,
      lastChapter: last,
      startSeconds: chapters[first].startSeconds,
      endSeconds: chapters[last].endSeconds,
      isAd,
    });
  lines.forEach((line, k) => {
    const from = line.firstChapter - 1;
    const to = k + 1 < lines.length ? lines[k + 1].firstChapter - 2 : chapters.length - 1;
    let runStart = -1;
    for (let i = from; i <= to; i++) {
      if (chapters[i].isAd) {
        if (runStart >= 0) push(runStart, i - 1, line.title, line.summary, false);
        runStart = -1;
        push(i, i, chapters[i].title, chapters[i].summary, true);
      } else if (runStart < 0) runStart = i;
    }
    if (runStart >= 0) push(runStart, to, line.title, line.summary, false);
  });
  return out;
}

// =============================================================================
// THE STAGE
// =============================================================================

export interface GroupStoriesOptions {
  /** The model's answer to one prompt. Errors propagate; a cancel or a park stops the stage. */
  generate: (prompt: string) => Promise<{ text: string; truncated: boolean }>;
  log?: (message: string) => void;
}

export interface GroupStoriesResult {
  stories: Story[];
  /** Grouping calls made (1, or 2 after a retry). */
  calls: number;
}

/**
 * Group a video's chapters into stories (see the file header). Under 10
 * minutes, or with one chapter, the video is one story and no call is made.
 * Throws with the reason when the grouping cannot be read after one retry.
 */
export async function groupStories(chapters: StoryChapter[], totalSeconds: number, opts: GroupStoriesOptions): Promise<GroupStoriesResult> {
  const log = opts.log ?? (() => undefined);
  if (chapters.length === 0) throw new Error('the stories could not be found: there are no chapters to group');
  const whole = (): Story[] => [
    {
      title: '',
      summary: '',
      firstChapter: 0,
      lastChapter: chapters.length - 1,
      startSeconds: chapters[0].startSeconds,
      endSeconds: chapters[chapters.length - 1].endSeconds,
      isAd: false,
    },
  ];
  if (totalSeconds < STORIES_MIN_VIDEO_SECONDS || chapters.length === 1) return { stories: whole(), calls: 0 };

  const prompt = buildStoryGroupingPrompt(chapters, totalSeconds);
  let ask = prompt;
  let problem = '';
  for (let call = 1; call <= 2; call++) {
    let answer: { text: string; truncated: boolean };
    try {
      answer = await opts.generate(ask);
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      throw new Error(`the stories could not be found: ${(error as Error).message}`);
    }
    const read = parseStoryGrouping(answer.text, chapters.length);
    if ('lines' in read) {
      if (answer.truncated) log(`[Stories] the grouping reached the output limit; the last story runs to the end of the video`);
      return { stories: storiesFromGrouping(chapters, read.lines), calls: call };
    }
    problem = answer.truncated ? `${read.problem} (the answer was cut off at the output limit)` : read.problem;
    log(`[Stories] grouping answer ${call} unusable (${problem}): ${answer.text.slice(0, 200)}`);
    ask = buildStoryGroupingRetry(prompt, problem);
  }
  throw new Error(`the stories could not be found: the chapter model's grouping could not be used twice. Last problem: ${problem}`);
}
