/**
 * THE ASK CHAT'S PROMPTS (video-chat/): questions about one video, answered
 * from its transcript, with one tool, add_marker.
 *
 * The model never sees a timestamp. The transcript is its sentences, one per
 * line; a marker is placed by quoting the passage's first and last words,
 * which Briefcase finds in the transcript (analysis/passage-anchor.ts).
 * Replies are free prose; the tool harness (tool-harness/) appends the tools
 * section and reads the calls (inline <tool_use> tags, tool-harness/tag-codec.ts).
 */

export const ADD_MARKER_TOOL_NAME = 'add_marker';

export const ADD_MARKER_DESCRIPTION =
  'Place a marker on a passage of this video, shown on its timeline. Name the passage by quoting its first and last words exactly as the transcript has them; the app finds them and sets the times.';

/** The tool's arguments, as JSON Schema. */
export const ADD_MARKER_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short name for the passage.' },
    first_words: { type: 'string', description: 'The first 5 to 10 words of the passage, copied exactly from the transcript.' },
    last_words: { type: 'string', description: 'The last 5 to 10 words of the passage, copied exactly from the transcript.' },
    note: { type: 'string', description: 'Optional: one line on why the passage matters.' },
  },
  required: ['title', 'first_words', 'last_words'],
};

/** The system prompt: what the chat is for, how markers work, and the transcript. */
export function buildVideoChatSystemPrompt(videoTitle: string, sentences: ReadonlyArray<{ text: string }>): string {
  return `You answer questions about one video from its transcript, which is below. The video is "${videoTitle}".

The person asking is watching the video in an editor with a timeline. Answer in plain prose. Questions that are not about a place in the video just get an answer.

Whenever your answer points to a part of the video, and whenever you are asked where something is, call ${ADD_MARKER_TOOL_NAME} for that part, once per part. Quote its first and last words exactly as the transcript has them. The app finds those words and puts the marker on the timeline with its times. The app shows the times, so your answer refers to a part by its marker title and never states a time or timestamp.

After you call ${ADD_MARKER_TOOL_NAME} you are sent the results: which markers were placed, and which words could not be found. Call it again for any not found, quoting exactly, then finish your answer for the person.

TRANSCRIPT:
${sentences.map((s) => s.text).join('\n')}`;
}

/** What the model is told when a marker is placed. */
export function markerPlacedResult(title: string, start: string, end: string): string {
  return `placed "${title}" at ${start}–${end}`;
}

/** What the model is told when a marker's words are not in the transcript. */
export function markerNotFoundResult(title: string, firstWords: string, lastWords: string): string {
  return `could not find "${firstWords}" … "${lastWords}" (for "${title}") in the transcript — quote again exactly`;
}
