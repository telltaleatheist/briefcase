/**
 * Prompt construction. Port of snap/prompt.py.
 *
 * Fixed order: system -> user(state, then question + label legend + "answer
 * with the letter only") -> assistant slot. The state comes FIRST inside the
 * user turn and the question LAST, so every question over one state shares the
 * longest possible token prefix and llama-server's `cache_prompt` reuses it.
 * Images are part of the state: one media marker per image, each on its own
 * line, before the state text.
 *
 * The assistant slot is rendered by the model's OWN chat template (the one
 * GET /props reports), never by hardcoded role strings, with thinking disabled.
 * At construction the builder proves the rendered generation prompt ends where
 * an answer token can be the very next token; otherwise
 * `template_not_answer_ready`.
 *
 * DEVIATION FROM SNAP — where the template is rendered. snap compiles the
 * template locally with Jinja2 (sandboxed, HF-transformers settings). The
 * backend has no Jinja engine, so the template is rendered by the engine itself
 * (POST /apply-template, which applies the same /props chat_template with
 * chat_template_kwargs.enable_thinking=false). To keep that to a handful of
 * calls per server process — and to keep the engine's media marker out of a
 * chat request — the builder renders the conversation ONCE with a sentinel as
 * the user content, splits the result around it, and splices every user
 * message into that frame. The frame is proven at startup: a probe user message
 * rendered by the engine must equal head + probe + tail byte for byte, or
 * `template_not_answer_ready` (the template does not carry the user message
 * verbatim). snap's own checks — the generation render extends the plain
 * render, adds something, and leaves no <think> block open — run unchanged.
 */

import { ChatMessage, ScorerError } from './scorer.types';

export const SYSTEM_PROMPT =
  'You are a precise classifier. You are shown a state and one question about it, with ' +
  'lettered options. Reply with the single letter of the best option and nothing else.';

export const THINK_OPEN = '<think>';
export const THINK_CLOSE = '</think>';

/** Stand-in user content for rendering the frame; plain ASCII so no template filter changes it. */
const USER_SENTINEL = 'SCORERUSERSLOTf3a9c07e51b24d6a';

export type QuestionKind = 'choice' | 'score' | 'yesno';

/** Strings pass through verbatim; any other JSON value becomes compact JSON. */
export function renderState(state: unknown): string {
  if (typeof state === 'string') return state;
  return JSON.stringify(state);
}

/** The question-specific tail of the user message. `legend` is [[letter, text]]. */
export function questionBlock(kind: QuestionKind, instructions: string, legend: Array<[string, string]>): string {
  const head =
    kind === 'yesno'
      ? `Statement: ${instructions}\nIs this statement true of the state above?`
      : `Question: ${instructions}`;
  const lines = legend.map(([letter, text]) => `${letter}. ${text}`).join('\n');
  return `${head}\nOptions:\n${lines}\nAnswer with the letter only.`;
}

/** Everything in the user message before the question block: the part every question over one state shares. */
export function statePart(stateText: string, nImages = 0, mediaMarker?: string): string {
  if (nImages && !mediaMarker) {
    throw new ScorerError('engine_no_vision', 'images were given but the engine reported no media marker');
  }
  const lines = [...Array(nImages).fill(mediaMarker as string), ...(stateText ? [stateText] : [])];
  return 'State:\n' + lines.join('\n');
}

/**
 * `State:`, then one media marker per image (each on its own line), then the
 * state text, then the question block. An empty state text (images only) adds
 * no line of its own; with no images this is exactly `State:\n<state>\n\n<block>`.
 */
export function userMessage(stateText: string, block: string, nImages = 0, mediaMarker?: string): string {
  return statePart(stateText, nImages, mediaMarker) + '\n\n' + block;
}

export function chatMessages(user: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Renders a conversation with the engine's chat template, thinking disabled. */
export interface TemplateRenderer {
  applyTemplate(messages: ChatMessage[], addGenerationPrompt: boolean, signal?: AbortSignal): Promise<string>;
}

async function render(renderer: TemplateRenderer, user: string, addGenerationPrompt: boolean): Promise<string> {
  try {
    return await renderer.applyTemplate(chatMessages(user), addGenerationPrompt);
  } catch (err) {
    if (err instanceof ScorerError && err.code === 'engine_error') {
      throw new ScorerError('template_not_answer_ready', `chat template failed to render: ${err.detail}`);
    }
    throw err;
  }
}

/**
 * What the template appends after the user turn when asked for a generation
 * prompt. Throws template_not_answer_ready unless the answer token can be the
 * very next token. (snap prompt.assistant_prefix_of)
 */
export function assistantPrefixOf(without: string, withGen: string): string {
  if (!withGen.startsWith(without)) {
    throw new ScorerError(
      'template_not_answer_ready',
      'the generation prompt is not an extension of the conversation render; the assistant slot cannot be isolated',
    );
  }
  const prefix = withGen.slice(without.length);
  if (!prefix) {
    throw new ScorerError(
      'template_not_answer_ready',
      'add_generation_prompt added nothing; no assistant turn is opened',
    );
  }
  const lastOpen = withGen.lastIndexOf(THINK_OPEN);
  if (lastOpen !== -1 && withGen.indexOf(THINK_CLOSE, lastOpen) === -1) {
    throw new ScorerError(
      'template_not_answer_ready',
      `the generation prompt leaves a ${THINK_OPEN} block open with enable_thinking=false ` +
        `(assistant prefix ${JSON.stringify(prefix)}); the next token would be reasoning, not an answer`,
    );
  }
  return prefix;
}

export class ScorerPromptBuilder {
  /** What the template emits after the user turn, e.g. `<|im_start|>assistant\n<think>\n\n</think>\n\n`. */
  readonly assistantPrefix: string;

  private constructor(
    readonly mediaMarker: string,
    private readonly head: string,
    private readonly tail: string,
    assistantPrefix: string,
  ) {
    this.assistantPrefix = assistantPrefix;
  }

  /**
   * Render the frame, prove it answer-ready and verbatim. `mediaMarker` is the
   * running engine's GET /props `media_marker` (random per llama-server process).
   */
  static async create(renderer: TemplateRenderer, mediaMarker: string): Promise<ScorerPromptBuilder> {
    if (!mediaMarker) {
      throw new ScorerError('engine_error', 'the engine reported an empty media_marker');
    }

    // snap's proof, on a probe message: generation render extends the plain render,
    // adds something, and leaves no <think> open.
    const probe = userMessage('probe state', 'probe question');
    const probeWith = await render(renderer, probe, true);
    const probeWithout = await render(renderer, probe, false);
    const assistantPrefix = assistantPrefixOf(probeWithout, probeWith);

    // The frame: the same conversation with a sentinel user message, split around it.
    const frame = await render(renderer, USER_SENTINEL, true);
    const at = frame.indexOf(USER_SENTINEL);
    if (at === -1 || frame.indexOf(USER_SENTINEL, at + 1) !== -1) {
      throw new ScorerError(
        'template_not_answer_ready',
        'the chat template does not carry the user message verbatim; the prompt frame cannot be isolated',
      );
    }
    const head = frame.slice(0, at);
    const tail = frame.slice(at + USER_SENTINEL.length);
    if (head + probe + tail !== probeWith) {
      throw new ScorerError(
        'template_not_answer_ready',
        'the chat template does not carry the user message verbatim (a spliced probe differs from the ' +
          'engine render); the shared prefix cannot be isolated',
      );
    }
    if (!tail.endsWith(assistantPrefix)) {
      throw new ScorerError(
        'template_not_answer_ready',
        `the prompt frame does not end with the proven assistant prefix ${JSON.stringify(assistantPrefix)}`,
      );
    }
    return new ScorerPromptBuilder(mediaMarker, head, tail, assistantPrefix);
  }

  private frame(user: string, nImages: number): string {
    const prompt = this.head + user + this.tail;
    // The engine substitutes the images for the markers in order and refuses a
    // count mismatch; a marker inside the caller's own text would shift every
    // image by one. Refused here, by name, before anything is sent.
    const found = prompt.split(this.mediaMarker).length - 1;
    if (found !== nImages) {
      throw new ScorerError(
        'bad_request',
        `the prompt carries ${found} media marker(s) for ${nImages} image(s): the state or question text ` +
          `contains the engine's media marker ${JSON.stringify(this.mediaMarker)}`,
      );
    }
    return prompt;
  }

  /** The full prompt for one question, ending exactly at the answer position. */
  build(
    stateText: string,
    kind: QuestionKind,
    instructions: string,
    legend: Array<[string, string]>,
    nImages = 0,
  ): string {
    const prompt = this.frame(
      userMessage(stateText, questionBlock(kind, instructions, legend), nImages, this.mediaMarker),
      nImages,
    );
    if (!prompt.endsWith(this.assistantPrefix)) {
      throw new ScorerError(
        'template_not_answer_ready',
        `a rendered prompt does not end with the proven assistant prefix ${JSON.stringify(this.assistantPrefix)}`,
      );
    }
    return prompt;
  }

  /**
   * The rendered prompt up to, not including, the "\n\n" + question block: the
   * part every question over one state shares (system, images, state text). Sent
   * alone first ("priming"), it leaves the engine's context checkpoint exactly at
   * its end, so each question then prefills only its own block.
   */
  sharedPrefix(stateText: string, nImages = 0): string {
    const prefix = this.head + statePart(stateText, nImages, this.mediaMarker);
    const found = prefix.split(this.mediaMarker).length - 1;
    if (found !== nImages) {
      throw new ScorerError(
        'bad_request',
        `the prompt carries ${found} media marker(s) for ${nImages} image(s): the state text contains the ` +
          `engine's media marker ${JSON.stringify(this.mediaMarker)}`,
      );
    }
    return prefix;
  }
}
