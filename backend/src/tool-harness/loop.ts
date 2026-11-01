/**
 * THE TOOL LOOP: a model reply, the tool calls in it run, their results sent
 * back, until a reply makes no call.
 *
 *   reply     the transport sends the conversation (and, in the native
 *             format, the tools as definitions); the codec reads the reply
 *             into prose and calls;
 *   calls     each call is run by the tool it names. A call that could not be
 *             read, names no known tool, or whose tool throws is answered with
 *             why, so the model can call again; it does not end the answer. A
 *             call the model already made in this answer, with the same
 *             arguments, whose result it still has, is not run again: it is
 *             answered that the result is above (a small model stuck on one
 *             call re-sends it every round);
 *   results   one round's results go back in the codec's messages (a user
 *             turn of tags, or one `tool` message per native call), with the
 *             host's note for the round (`resultsNote`) after them, and the
 *             model continues;
 *   end       a reply with no call ends it. The final text is every reply's
 *             prose in order (text written before a call stays). After
 *             `maxRounds` rounds of calls the next reply is the last: the
 *             results say so, and calls it still makes are not run (a native
 *             trace answers them "not run", so it replays as a valid
 *             conversation). The ceiling is a safety net for a stuck model,
 *             not a budget: a working model ends the loop itself.
 *
 * CONTEXT. Given a budget (`context`), every request is kept within it
 * (context.ts): when the next one would not fit, old results of the tools
 * that allow it (Tool.dropOrder) are replaced by a short note, the lowest
 * order and the oldest rounds first, cut well under the budget in one step,
 * so the requests after a cut grow by appending and the prompt prefix stays
 * the same (a server's prompt cache keeps hitting) until the next cut. A
 * dropped result may be fetched again: the identical call then runs.
 *
 * The trace is every message after the user's (the model's raw replies and
 * the results it was sent): stored by the host and replayed in later turns
 * (history.ts, through the codec, which reads a trace stored in either
 * format), so the model remembers its own tool use. Results of tools that
 * allow dropping are in it as the dropped note: they can be fetched again,
 * and replayed whole they would crowd the next question out of the context.
 *
 * The signal is checked before every model call and tool run and handed to
 * both; an abort rejects with ToolLoopAborted.
 */
import { tagCodec } from './tag-codec';
import { DEFAULT_DROPPED_NOTE, fitRounds, requestChars, requestTokens, type ContextBudget, type FitRound, type Measured } from './context';
import type { ChatMessage, ChatTransport, ParsedToolCall, Tool, ToolCallCodec, ToolCallRecord, ToolLoopEvent } from './types';

export const DEFAULT_MAX_ROUNDS = 3;

/** Appended to the last allowed round's results. */
export const LAST_ROUND_NOTE = 'No more tool calls can be made in this answer. Finish your answer now, without tool calls.';

/** What a call identical to one whose result the model still has is answered. */
export function repeatedCallResult(name: string): string {
  return `You already made this exact ${name} call in this answer, and its result is above; it has not changed. Use it, make a different call, or finish your answer.`;
}

export class ToolLoopAborted extends Error {
  readonly code = 'aborted';
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : 'The tool loop was aborted.');
    this.name = 'ToolLoopAborted';
  }
}

/** The conversation outgrew the context budget with nothing left that may be dropped. */
export class ToolLoopContextFull extends Error {
  readonly code = 'context_full';
  constructor(readonly tokens: number, readonly budget: number) {
    super(`The answer needs about ${tokens} tokens, over its ${budget}-token budget, with nothing left to drop.`);
    this.name = 'ToolLoopContextFull';
  }
}

export interface ToolLoopOptions {
  transport: ChatTransport;
  tools: ReadonlyArray<Tool<any, any>>;
  /** The host's system prompt; the codec's tools section (the tag format's) is appended to it. */
  system: string;
  /** Earlier turns, oldest first (history.ts replayHistory, with this loop's codec). */
  history?: ChatMessage[];
  userMessage: string;
  maxRounds?: number;
  signal?: AbortSignal;
  onEvent?: (event: ToolLoopEvent) => void;
  /** The tool-call wire format: tag-codec's plain tags by default, or native-codec's structured calls. */
  codec?: ToolCallCodec;
  /** A line the host puts after every round's results (what the model has covered so far, say), read after the round's calls ran. */
  resultsNote?: () => string;
  /** Keep every request within this many tokens (see CONTEXT above). Absent: requests grow as they will. */
  context?: ContextBudget;
}

export interface ToolLoopResult {
  /** The answer: every round's prose in order, tool-call tags stripped (what a chat UI shows, as a tool-using agent's text blocks are all shown). */
  finalText: string;
  /** Every call made, in order, across all rounds. */
  toolCalls: ToolCallRecord[];
  /** Every message after the user's, for replay. */
  trace: ChatMessage[];
  /** Each model call's usage, as the transport reported it. */
  usage: unknown[];
  /** Rounds of tool calls made. */
  rounds: number;
  /** Times old results were dropped to fit the context budget. */
  cuts: number;
}

/** One round as the loop keeps it: rendered into messages for each request, with whatever has been dropped from it. */
interface Round extends FitRound {
  reply: ChatMessage;
  calls: ParsedToolCall[];
  contents: string[];
  note: string | undefined;
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const codec = options.codec ?? tagCodec;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const { signal, tools, context } = options;
  const droppedNote = context?.droppedNote ?? DEFAULT_DROPPED_NOTE;
  const emit = (event: ToolLoopEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A progress listener never breaks the loop.
    }
  };
  const toolsPrompt = tools.length > 0 ? codec.toolsPrompt(tools) : '';
  const system = toolsPrompt ? `${options.system}\n\n${toolsPrompt}` : options.system;
  const definitions = tools.length > 0 ? codec.definitions?.(tools) : undefined;
  const definitionChars = definitions === undefined ? 0 : JSON.stringify(definitions).length;
  const base: ChatMessage[] = [{ role: 'system', content: system }, ...(options.history ?? []), { role: 'user', content: options.userMessage }];
  const rounds: Round[] = [];
  // A cut round's note goes with its results: it said what was so then, and later rounds say what is so now.
  const render = (round: Round): ChatMessage[] => [
    round.reply,
    ...codec.results(round.calls, round.contents.map((content, i) => (round.dropped[i] ? droppedNote : content)), round.dropped.some(Boolean) ? undefined : round.note),
  ];
  const conversation = (): ChatMessage[] => [...base, ...rounds.flatMap(render)];
  /** The calls made so far whose results the model still has, by name and arguments. */
  const made = new Map<string, { round: Round; index: number }>();
  const toolCalls: ToolCallRecord[] = [];
  const usage: unknown[] = [];
  const prose: string[] = [];
  let measured: Measured | null = null;
  /** The budget, its characters a token lowered to what a measured request came to when that was denser. */
  let fit = context;
  let cuts = 0;
  for (;;) {
    checkAborted(signal);
    let messages = conversation();
    if (fit !== undefined) {
      const tokens = requestTokens(messages, definitionChars, fit, measured);
      if (tokens > fit.tokens) {
        const fitted = fitRounds(rounds, render, base, definitionChars, fit);
        if (fitted.tokens > fit.tokens) throw new ToolLoopContextFull(fitted.tokens, fit.tokens);
        cuts += 1;
        measured = null;
        messages = conversation();
      }
    }
    emit({ type: 'model-call', round: rounds.length });
    const reply = await options.transport(messages, { signal, ...(definitions === undefined ? {} : { tools: definitions }) });
    checkAborted(signal);
    usage.push(reply.usage ?? null);
    const counted = context?.usageTokens?.(reply.usage ?? null) ?? null;
    measured = counted === null ? null : { messages: messages.length, ...counted };
    if (fit !== undefined && counted !== null && counted.prompt > 0) {
      fit = { ...fit, charsPerToken: Math.min(fit.charsPerToken, requestChars(messages, definitionChars) / counted.prompt) };
    }
    const parsed = codec.read(reply);
    const calls = parsed.calls;
    if (parsed.prose) prose.push(parsed.prose);
    if (calls.length === 0 || rounds.length >= maxRounds) {
      const trace = [...rounds.flatMap((round) => render({ ...round, dropped: round.dropped.map((d, i) => d || round.droppable[i] !== undefined) })), parsed.message];
      if (calls.length > 0 && codec.unanswered) trace.push(...codec.unanswered(calls));
      emit({ type: 'done', rounds: rounds.length });
      return { finalText: prose.join('\n\n'), toolCalls, trace, usage, rounds: rounds.length, cuts };
    }
    const round: Round = { reply: parsed.message, calls, contents: [], note: undefined, droppable: [], dropped: [] };
    const number = rounds.length + 1;
    for (const call of calls) {
      checkAborted(signal);
      emit({ type: 'tool-call', round: number, name: call.ok ? call.name : null, args: call.ok ? call.args : null });
      const key = call.ok ? callKey(call.name, call.args) : null;
      const earlier = key === null ? undefined : made.get(key);
      const stillThere = earlier !== undefined && !earlier.round.dropped[earlier.index];
      const record = stillThere && call.ok
        ? { name: call.name, args: call.args, ok: false, content: repeatedCallResult(call.name) }
        : await runCall(call, tools, signal);
      checkAborted(signal);
      if (key !== null && !stillThere) made.set(key, { round, index: round.contents.length });
      toolCalls.push(record);
      round.contents.push(record.content);
      // A repeat's answer is a line: nothing to drop.
      round.droppable.push(stillThere || !call.ok ? undefined : tools.find((t) => t.name === call.name)?.dropOrder);
      round.dropped.push(false);
      emit({ type: 'tool-result', round: number, call: record });
    }
    const notes = [options.resultsNote?.(), number >= maxRounds ? LAST_ROUND_NOTE : undefined].filter((n): n is string => !!n);
    round.note = notes.length > 0 ? notes.join('\n\n') : undefined;
    rounds.push(round);
  }
}

async function runCall(call: ParsedToolCall, tools: ReadonlyArray<Tool<any, any>>, signal: AbortSignal | undefined): Promise<ToolCallRecord> {
  if (!call.ok) return { name: null, args: null, ok: false, content: `couldn't read that tool call: ${call.reason}` };
  const tool = tools.find((t) => t.name === call.name);
  if (tool === undefined) {
    const known = tools.map((t) => t.name).join(', ');
    return { name: call.name, args: call.args, ok: false, content: `there is no tool named "${call.name}"; the tools are: ${known}` };
  }
  try {
    const result = await tool.execute(call.args, { signal });
    return { name: call.name, args: call.args, ok: true, content: result.content, ...(result.data === undefined ? {} : { data: result.data }) };
  } catch (error) {
    if (signal?.aborted) throw new ToolLoopAborted(signal.reason);
    return { name: call.name, args: call.args, ok: false, content: `couldn't run ${call.name}: ${(error as Error)?.message ?? String(error)}` };
  }
}

/** A call's identity: its name and its arguments with the keys in order, so `{a, b}` and `{b, a}` are one call. */
function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}\n${JSON.stringify(args, (_key, value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value)}`;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ToolLoopAborted(signal.reason);
}
