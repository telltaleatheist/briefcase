/**
 * THE ASK CHAT'S PROMPTS (video-chat/): questions about one video, answered
 * from its transcript, with four tools: outline, search, read and add_marker.
 *
 * The transcript is numbered sentences. When it fits the model's context it
 * is in the system prompt, one numbered sentence per line and without a
 * single timestamp; when it does not, the prompt carries none and the model
 * reads the video through the tools (video-chat/transcript-tools.ts), whose
 * lines show each sentence's number and time. Either way a marker is placed
 * by quoting the passage's first and last words, which Briefcase finds in the
 * transcript (analysis/passage-anchor.ts), and the answer never states a time.
 * An answer's markers share a `set`, the marker set they are applied into.
 * Replies are free prose; the tool harness (tool-harness/) sends the tools
 * natively (native-codec.ts) or appends the tools section and reads inline
 * <tool_use> tags (tag-codec.ts).
 */

export const OUTLINE_TOOL_NAME = 'outline';
export const SEARCH_TOOL_NAME = 'search';
export const READ_TOOL_NAME = 'read';
export const ADD_MARKER_TOOL_NAME = 'add_marker';

export const OUTLINE_DESCRIPTION =
  "The video's map: its length, how many sentences its transcript has, and its chapters (title, summary, times and sentence numbers), or, for a video without chapters, its ten-minute parts, each shown by its first sentence.";

export const OUTLINE_PARAMETERS: Record<string, unknown> = { type: 'object', properties: {} };

export const SEARCH_DESCRIPTION =
  'Find every transcript sentence that matches a word, a name or a phrase (case-insensitive), with its sentence number and time, how many match, and how the matches spread over the chapters. Lists up to 50 at a time; use offset for the rest.';

export const SEARCH_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'The text to find, e.g. "Trump" or "minimum wage".' },
    whole_word: { type: 'boolean', description: 'Optional: match whole words only ("art" not finding "start"). Default false.' },
    regex: { type: 'boolean', description: 'Optional: read the pattern as a regular expression, e.g. "Biden|Harris". Default false.' },
    offset: { type: 'integer', description: 'Optional: skip this many matches, to list the ones after the first 50. Default 0.' },
  },
  required: ['pattern'],
};

export const READ_DESCRIPTION =
  'Read the transcript in order: numbered sentences with their times, a page at a time, from a sentence number or a whole chapter. Each page says where to continue.';

export const READ_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    from: { type: 'integer', description: 'The sentence number to start at.' },
    count: { type: 'integer', description: 'Optional: at most this many sentences (a page holds about a hundred).' },
    chapter: { type: 'integer', description: 'Instead of from: a chapter number from outline (a part number, for a video without chapters), read from its start.' },
  },
};

export const ADD_MARKER_DESCRIPTION =
  'Place a marker on a passage of this video, shown on its timeline. Name the passage by quoting its first and last words exactly as the transcript has them (without sentence numbers or times); the app finds them and sets the times.';

/** The tool's arguments, as JSON Schema. */
export const ADD_MARKER_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short name for the passage.' },
    first_words: { type: 'string', description: 'The first 5 to 10 words of the passage, copied exactly from the transcript.' },
    last_words: { type: 'string', description: 'The last 5 to 10 words of the passage, copied exactly from the transcript.' },
    sentence: { type: 'integer', description: 'Optional: the number of the sentence the passage starts in, so a phrase said more than once is found in the right place.' },
    note: { type: 'string', description: 'Optional: one line on why the passage matters.' },
    set: {
      type: 'string',
      description: "Optional: a 1–4 word name for the group of markers this question produces, e.g. 'Trump mentions'; use the same name for every marker in one answer.",
    },
  },
  required: ['title', 'first_words', 'last_words'],
};

/** What the system prompt says about the video, and whether the transcript itself is in it. */
export interface VideoChatPromptVideo {
  title: string;
  /** Seconds. */
  duration: number;
  /** The transcript's sentences; listed in the prompt only when `transcriptInPrompt`. */
  sentences: ReadonlyArray<{ text: string }>;
  /** The whole transcript fits the model's context, and is in the prompt. */
  transcriptInPrompt: boolean;
}

/**
 * The system prompt: what the chat is for, how to work through the video,
 * how markers work, and the transcript when it fits. The set sentence closes
 * the results paragraph: measured on qwen3.5-9b (Oct 25 2026), there it is
 * filled in and the answer takes one round; as a paragraph of its own before
 * the results, the 9B re-sent the same call every round.
 */
export function buildVideoChatSystemPrompt(video: VideoChatPromptVideo): string {
  const count = video.sentences.length;
  const about = `You answer questions about one video from its transcript. The video is "${video.title}", ${spokenDuration(video.duration)} long, and its transcript has ${count} numbered sentences.`;
  const where = video.transcriptInPrompt
    ? `The whole transcript is below, one numbered sentence per line, so you have read all of it. The tools ${SEARCH_TOOL_NAME} and ${READ_TOOL_NAME} show the same sentences with their times; ${SEARCH_TOOL_NAME} is there to be sure you mark every mention of a name or word.`
    : `The transcript is too long to show here: you read it with the tools. ${OUTLINE_TOOL_NAME} shows the video's chapters, ${SEARCH_TOOL_NAME} finds every sentence that mentions something, and ${READ_TOOL_NAME} reads the numbered sentences in order, a page at a time. Begin with ${OUTLINE_TOOL_NAME}, or with ${SEARCH_TOOL_NAME} when the question names something.`;
  const named = `When the question names something (a person, a place, a word, a topic with a clear name), ${SEARCH_TOOL_NAME} for it, mark every relevant match, and search again with other spellings or related words if it finds too little.`;
  const work = video.transcriptInPrompt
    ? `How to work. ${named} Stop when the question is answered.`
    : `How to work. On a long video, call ${OUTLINE_TOOL_NAME} first to see its shape. ${named} When the question needs a stretch of the video or the whole of it (a summary, everything on a theme, the best moments), ${READ_TOOL_NAME} through it in order, page after page, until that stretch is covered. Every tool result ends with what you have read so far. Stop when the question is answered and the parts it needs are covered.`;
  const prompt = `${about}

${where}

The person asking is watching the video in an editor with a timeline. Answer in plain prose. Questions that are not about a place in the video just get an answer.

${work}

Whenever your answer points to a part of the video, and whenever you are asked where something is, call ${ADD_MARKER_TOOL_NAME} for that part, once per part. Quote its first and last words exactly as the transcript has them, and give the number of the sentence it starts in. The app finds those words and puts the marker on the timeline with its times. The app shows the times, so your answer refers to a part by its marker title and never states a time or timestamp, even the ones the tools show.

After you call ${ADD_MARKER_TOOL_NAME} you are sent the results: which markers were placed, and which words could not be found. Call it again for any not found, quoting exactly, then finish your answer for the person. Each marker's set names what all of this answer's markers have in common in 1–4 words, such as "Trump mentions" or "Reaction moments"; use the same set for each of them.`;
  if (!video.transcriptInPrompt) return prompt;
  return `${prompt}

TRANSCRIPT:
${video.sentences.map((s, i) => `[${i + 1}] ${s.text}`).join('\n')}`;
}

/** A length as words ("1 hour 23 minutes"): the prompt states no time in HH:MM:SS, the shape the answer must never use. */
export function spokenDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (hours > 0) return minutes > 0 ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
  if (minutes > 0) return unit(minutes, 'minute');
  return unit(total, 'second');
}

/** What the model is told when a marker is placed. */
export function markerPlacedResult(title: string, start: string, end: string): string {
  return `placed "${title}" at ${start}–${end}`;
}

/** What the model is told when it places a passage it already placed in this answer. */
export function markerAlreadyPlacedResult(title: string, start: string, end: string): string {
  return `"${title}" is already placed at ${start}–${end}; do not place it again — finish your answer`;
}

/** What the model is told when a marker's words are not in the transcript. */
export function markerNotFoundResult(title: string, firstWords: string, lastWords: string): string {
  return `could not find "${firstWords}" … "${lastWords}" (for "${title}") in the transcript — quote again exactly`;
}

/** What replaces a page or a search the conversation outgrew (tool-harness/context.ts). */
export const DROPPED_RESULT_NOTE = '[Earlier pages were dropped to fit; read them again if you need them.]';
