/**
 * WHAT QWEN3-ASR IS TOLD ABOUT THE VIDEO BEFORE IT HEARS IT.
 *
 * Qwen3-ASR reads a `context` in its system turn (Crucible 1.0.32+, both the
 * official build and the MLX port): an instruction and a vocabulary. Briefcase
 * sends everything it knows about the video that could spell a name, a place
 * or a term the audio alone would guess at (the user, 2026-09-24: "send all
 * potentially useful metadata we have on the file"):
 *
 *   the title (before analysis it is the file name), the suggested title, the
 *   source URL (a news site's slug often names the people), the upload date,
 *   the video it was cut from, its tags, and its description.
 *
 * The instruction says to transcribe only what is said: metadata names people
 * who may never speak their own name, and must not be written into the
 * transcript.
 *
 * LIMITS, the server's (crucible jobs/asr `context`): at most 1,024 tokens of
 * the model's own tokenizer, which only the worker can count, so a context
 * over it fails the job. Here the length is ESTIMATED conservatively (a token
 * per three ASCII characters, one per anything else) against a budget well
 * under that, and the description, the longest and least specific field, is
 * what gets cut. The chat template's control tokens (`<|...|>`, `<asr_text>`)
 * are refused by the server, so they are removed from the metadata here: they
 * are never something a title means.
 */

/** What is known about a video, every field optional. */
export interface AsrVideoFacts {
  readonly title?: string | null;
  readonly suggestedTitle?: string | null;
  readonly sourceUrl?: string | null;
  readonly uploadDate?: string | null;
  readonly parentTitle?: string | null;
  readonly tags?: readonly string[];
  readonly description?: string | null;
}

/** The estimated tokens a context may use: under the server's 1,024 with room for the estimate to be wrong. */
export const ASR_CONTEXT_TOKEN_BUDGET = 700;

const INSTRUCTION =
  'Transcribe the speech in this video. What is known about the video is below: use it only for the spelling of '
  + 'names, places and terms, and write only what is actually said.';

const CHAT_CONTROL = /<\|[^|]*\|>|<asr_text>/g;
const VIDEO_EXTENSION = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|mpg|mpeg|ts|mts|m2ts|3gp|mp3|m4a|wav|aac|flac|ogg|opus)$/i;

/** A conservative token count: a token per three ASCII characters, one per any other character. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other;
}

function clean(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.replace(CHAT_CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** A file name as a title: no extension, separators as spaces. */
export function titleFromFilename(filename: string): string {
  return clean(filename.replace(VIDEO_EXTENSION, '').replace(/[_]+/g, ' '));
}

/** Cut `text` at a word boundary so it fits `tokens`, with an ellipsis when cut. */
function fitTo(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  let cut = text;
  while (cut.length > 0 && estimateTokens(`${cut}…`) > tokens) {
    const space = cut.lastIndexOf(' ', cut.length - 2);
    cut = space > 0 ? cut.slice(0, space) : cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return cut.length > 0 ? `${cut}…` : '';
}

/**
 * The context for a video, or null when nothing is known about it (the server
 * refuses a blank context; null means none).
 */
export function buildAsrContext(facts: AsrVideoFacts): string | null {
  const title = clean(facts.title);
  const suggested = clean(facts.suggestedTitle);
  const lines: string[] = [];
  if (title) lines.push(`Title: ${title}`);
  if (suggested && suggested.toLowerCase() !== title.toLowerCase()) lines.push(`Also titled: ${suggested}`);
  const parent = clean(facts.parentTitle);
  if (parent && parent.toLowerCase() !== title.toLowerCase()) lines.push(`Cut from: ${parent}`);
  const source = clean(facts.sourceUrl);
  if (source) lines.push(`Source: ${source}`);
  const date = clean(facts.uploadDate);
  if (date) lines.push(`Date: ${date}`);
  const tags = [...new Set((facts.tags ?? []).map(clean).filter((tag) => tag !== ''))];
  if (tags.length > 0) lines.push(`Names and topics: ${tags.join(', ')}`);

  let head = [INSTRUCTION, ...lines].join('\n');
  // The fields above the description are short and specific; should they
  // alone overrun (a huge tag list), they are cut too, never sent over.
  head = fitTo(head, ASR_CONTEXT_TOKEN_BUDGET);
  const description = clean(facts.description);
  if (description) {
    const room = ASR_CONTEXT_TOKEN_BUDGET - estimateTokens(`${head}\nDescription: `);
    const fitted = room > 20 ? fitTo(description, room) : '';
    if (fitted) head = `${head}\nDescription: ${fitted}`;
  }
  return head === INSTRUCTION ? null : head;
}
