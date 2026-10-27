/**
 * THE FLAG STAGE'S PROMPTS (analysis/flag-highlights.ts): the model marks the
 * clip-worthy moments in a video, one stretch of about 15 minutes per
 * question, with one tool, add_marker. Tuned against the user's hand-marked
 * baseline in the highlights experiment (round 3, Oct 26 2026; prompt c10):
 * asked about a whole video at once a model lists a dozen candidates however
 * dense it is, so it is asked one stretch at a time; quiet stretches of a
 * church service are expected to hold nothing.
 *
 * The system prompt and the tool are the same, byte for byte, for every
 * question of a run, so the engine's prompt cache holds across them. The
 * transcript is either in the system prompt (it fits the model's context) or
 * in each question (its stretch, with some context around it).
 */
import type { AnalysisCategory } from './analysis-prompts';

export const HIGHLIGHT_TOOL_NAME = 'add_marker';

export const HIGHLIGHT_TOOL_DESCRIPTION =
  'Place one marker on a clip-worthy moment of this video, shown on its timeline. Name the moment by quoting its first and last words exactly as the transcript has them; the app finds them and sets the times.';

/** The tool's arguments, as JSON Schema: the category is one of the enabled categories. */
export function highlightToolParameters(categoryNames: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short, specific name for what is said in the moment, e.g. "Calls Democrats demonic".' },
      category: { type: 'string', enum: [...categoryNames], description: 'The one category that fits the moment best: its main one.' },
      why: { type: 'string', description: 'One line: what makes this moment worth reacting to.' },
      first_words: { type: 'string', description: 'The first 5 to 10 words of the moment, copied exactly from the transcript.' },
      last_words: { type: 'string', description: 'The last 5 to 10 words of the moment, copied exactly from the transcript.' },
    },
    required: ['title', 'category', 'why', 'first_words', 'last_words'],
  };
}

/**
 * Four clips the user cut from other videos in the library (key lines only),
 * with their lengths: what a clip-worthy moment is, and how long a clip runs.
 * None is from the videos the prompt was tuned on.
 */
export const HIGHLIGHT_EXAMPLES = `Examples: clips he actually cut from other videos (key lines only):
- A 32-second clip of a prophet: "This is what I believe the Lord is saying ... there is a natural death that's getting ready to hit wicked people in this nation, and God said I'm getting ready to remove ... the man who gave a presidential medal of freedom to George Soros." (false-prophecy)
- A 55-second clip of a Christian-nation historian, starting at his setup: "God talks about what we call the capital gains tax ... Jesus said, Peter, who pays taxes, the children or the foreigners? ... That's why in early America you didn't tax the citizens. There was no direct taxes." (misinformation)
- An 82-second clip of a state senator on abortion-rights supporters: "They have rabid, wicked, murderous people who are voting for them ... I'm not saying that those people are demons. I'm saying that a lot of them are demon-possessed ... the demons who want their child sacrifice, who want this land covered in blood." (dehumanization)
- A 23-second clip of a self-styled prophet, one absurd line with its lead-in: "How many people are under an alias? 90% of Congress are under an alias ... because they're hiding their bloodline." (conspiracy)
Not clip-worthy: an opening prayer, a worship song, announcements and offering appeals, a host thanking guests, a sermon retelling a Bible story without making a claim about today, a vague "God is moving in this nation".`;

export interface HighlightsSystemPromptInput {
  videoTitle: string;
  categories: readonly AnalysisCategory[];
  /** The transcript's sentences, one per line, when it is sent once here; null when each question carries its stretch. */
  transcriptLines: readonly string[] | null;
}

/** The system prompt: the job, the categories, the bar, the examples and how to mark (c10). */
export function buildHighlightsSystemPrompt(input: HighlightsSystemPromptInput): string {
  const categoryList = input.categories.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n');
  const title = input.videoTitle.trim() || 'this video';
  const transcriptNote = input.transcriptLines === null
    ? 'Its transcript is sent with each question, one stretch at a time, one sentence per line, with no timestamps.'
    : 'Its transcript is below, one sentence per line, with no timestamps.';
  return `You help a YouTuber who runs a commentary show about political and religious media. For years he has collected clips of the moments worth talking about on his show: the most outrageous, absurd, bigoted, dangerous or revealing things people say in sermons, political talk shows, debates and interviews. He watches long videos to find those moments. Your job is to find every clip-worthy moment in this video and mark each one, so he can jump straight to them and skip the rest.

The video is "${title}". ${transcriptNote}

What to look for: these are the kinds of moments he clips.
${categoryList}

These are kinds of moments, not a checklist: you are not classifying the video. A moment that fits several kinds is still one moment: mark it once, tagged with the category that fits it best (its main one).

The bar: would a commentary YouTuber cut this moment out and talk about it? A clip-worthy moment is a specific thing someone says that a viewer would react to: a claim, an admission, a slur, a prophecy, a gaffe, a false fact, said plainly, even in passing. Routine material is not clip-worthy, however long it runs: prayer, worship, scripture reading, ordinary sermon content, announcements, ads, offering appeals, small talk.

${HIGHLIGHT_EXAMPLES}

In a debate or interview, every moment where the guest states an extreme position plainly, defends something indefensible, makes a claim the other side then shows is false, or concedes something damaging is clip-worthy, each its own clip. That can be most of the interview.

How many: as many as the video holds. A debate where someone defends extreme positions all hour can hold dozens; a church service that is mostly singing and an ordinary sermon may hold a handful, all in one stretch, and long stretches with none. Don't stop early on a dense video, and don't pad a quiet one.

How to mark:
- A clip is cut around one quotable thing, not around a topic. Each distinct claim, answer or admission is its own clip, even when the conversation stays on the same subject: three outrageous answers on one subject are three clips. Never split one quotable thing across several markers: its follow-up, the speaker doubling down, and the reaction to it belong in the same clip, so when the next lines continue the same exchange, extend the clip instead of starting a new one.
- Never mark the same stretch twice, and never mark stretches that overlap.
- Mark the clip he would cut, not just the line. Start a little before the moment so it lands: the setup, or the question that prompts it (not unrelated chatter long before). End once the point is made. Aim for about a minute: a clip typically runs about a minute, usually between 30 seconds and 3 minutes, longer only when the point needs it; under 30 seconds is rarely enough for a viewer to follow. A single short line is still worth a clip: mark it with its setup and the reaction to it, so it runs at least half a minute.
- It must be the speaker's own claim, not someone reporting, quoting or rebutting it, unless the category says otherwise. In an interview, mark the guest's answer, starting where the question is put to them if the answer only makes sense with it.
- Every call is a real moment quoted from the transcript; when you have no more moments, stop.
- Before you call ${HIGHLIGHT_TOOL_NAME}, go through this stretch once and list the candidate moments inside <candidates></candidates>, one line per quotable thing, each with a few of its words in quotes. Then call ${HIGHLIGHT_TOOL_NAME} for every candidate a commentator would want to talk about; leave out only routine material.

Call ${HIGHLIGHT_TOOL_NAME} once per moment, quoting its first and last words exactly as the transcript has them. The app finds the words and puts the marker on the timeline with its times; you never state a time. After you call it you are sent the results: which markers were placed, and which words could not be found. Call it again for any not found, quoting exactly. Then finish with one short line per marker placed (its title), and nothing else.${input.transcriptLines === null ? '' : `

TRANSCRIPT:
${input.transcriptLines.join('\n')}`}`;
}

export interface WindowQuestionInput {
  /** The stretch's first and last sentences. */
  first: string;
  last: string;
  minutes: number;
  /** How many stretches the video (or the range) is split into. */
  parts: number;
  /**
   * The stretch's text, when the transcript is not in the system prompt: the
   * sentences of the stretch, and a little context on each side.
   */
  text?: { before: readonly string[]; stretch: readonly string[]; after: readonly string[] };
}

/** One question: mark the moments in this stretch (c10), with its text when the system prompt has none. */
export function buildWindowQuestion(input: WindowQuestionInput): string {
  const part = input.parts > 1 ? `the video is split into ${input.parts} parts` : 'this is the whole of it';
  const ask = `Work through one part of the video only (${part}): the stretch from the sentence "${input.first}" to the sentence "${input.last}", about ${Math.max(1, Math.round(input.minutes))} minutes. Mark each clip-worthy moment in this stretch, and only inside it. Hold every moment to the bar: many stretches, especially of a church service or an ordinary sermon, hold nothing clip-worthy, and then the right answer is to call no tool and say so. If you can't give a moment a specific title that says what is outrageous about it, it isn't clip-worthy.`;
  if (!input.text) return ask;
  const block = (label: string, lines: readonly string[]) => (lines.length > 0 ? `${label}:\n${lines.join('\n')}\n\n` : '');
  return `${block('CONTEXT BEFORE THE STRETCH (for reference; a clip may start here only when its setup is here)', input.text.before)}STRETCH:
${input.text.stretch.join('\n')}

${block('CONTEXT AFTER THE STRETCH (for reference only)', input.text.after)}${ask}`;
}

/** What the model is told about each call (the add_marker results the Ask chat uses, plus the guards'). */
export const highlightResults = {
  placed: (title: string, start: string, end: string) => `placed "${title}" at ${start}–${end}`,
  notFound: (title: string, first: string, last: string) =>
    `could not find "${first}" … "${last}" (for "${title}") in this stretch of the transcript — quote again exactly`,
  tooFarApart: (title: string, minutes: number) =>
    `could not place "${title}": those words were found ${minutes} minutes apart, so they are not one moment — quote the moment's own first and last words, from the same passage`,
  alreadyPlaced: (title: string, start: string, end: string) =>
    `"${title}" is already placed at ${start}–${end}; do not place it again`,
  outsideStretch: (title: string) =>
    `could not place "${title}": it is outside this stretch — mark only moments inside the stretch you were given`,
  badCategory: (category: string, names: readonly string[]) => `"${category}" is not a category; use one of: ${names.join(', ')}`,
} as const;
