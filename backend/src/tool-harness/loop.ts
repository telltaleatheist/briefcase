/**
 * THE TOOL LOOP: a model reply, the tool calls in it run, their results sent
 * back, until a reply makes no call.
 *
 *   reply     the transport sends the conversation (and, in the native
 *             format, the tools as definitions); the codec reads the reply
 *             into prose and calls;
 *   calls     each call is run by the tool it names. A call that could not be
 *             read, names no known tool, or whose tool throws is answered with
 *             why, so the model can call again; it does not end the answer;
 *   results   one round's results go back in the codec's messages (a user
 *             turn of tags, or one `tool` message per native call), and the
 *             model continues;
 *   end       a reply with no call ends it. The final text is every reply's
 *             prose in order (text written before a call stays). After
 *             `maxRounds` rounds of calls the next reply is the last: the
 *             results say so, and calls it still makes are not run (a native
 *             trace answers them "not run", so it replays as a valid
 *             conversation).
 *
 * The trace is every message after the user's (the model's raw replies and
 * the results it was sent): stored by the host and replayed in later turns
 * (history.ts, through the codec, which reads a trace stored in either
 * format), so the model remembers its own tool use.
 *
 * The signal is checked before every model call and tool run and handed to
 * both; an abort rejects with ToolLoopAborted.
 */
import { tagCodec } from './tag-codec';
import type { ChatMessage, ChatTransport, ParsedToolCall, Tool, ToolCallCodec, ToolCallRecord, ToolLoopEvent } from './types';

export const DEFAULT_MAX_ROUNDS = 3;

/** Appended to the last allowed round's results. */
export const LAST_ROUND_NOTE = 'No more tool calls can be made in this answer. Finish your answer now, without tool calls.';

export class ToolLoopAborted extends Error {
  readonly code = 'aborted';
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : 'The tool loop was aborted.');
    this.name = 'ToolLoopAborted';
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
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const codec = options.codec ?? tagCodec;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const { signal, tools } = options;
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
  const base: ChatMessage[] = [{ role: 'system', content: system }, ...(options.history ?? []), { role: 'user', content: options.userMessage }];
  const trace: ChatMessage[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const usage: unknown[] = [];
  let rounds = 0;
  const prose: string[] = [];
  for (;;) {
    checkAborted(signal);
    emit({ type: 'model-call', round: rounds });
    const reply = await options.transport([...base, ...trace], { signal, ...(definitions === undefined ? {} : { tools: definitions }) });
    checkAborted(signal);
    usage.push(reply.usage ?? null);
    const parsed = codec.read(reply);
    trace.push(parsed.message);
    const calls = parsed.calls;
    if (parsed.prose) prose.push(parsed.prose);
    if (calls.length === 0 || rounds >= maxRounds) {
      if (calls.length > 0 && codec.unanswered) trace.push(...codec.unanswered(calls));
      emit({ type: 'done', rounds });
      return { finalText: prose.join('\n\n'), toolCalls, trace, usage, rounds };
    }
    rounds += 1;
    const contents: string[] = [];
    for (const call of calls) {
      checkAborted(signal);
      emit({ type: 'tool-call', round: rounds, name: call.ok ? call.name : null, args: call.ok ? call.args : null });
      const record = await runCall(call, tools, signal);
      checkAborted(signal);
      toolCalls.push(record);
      contents.push(record.content);
      emit({ type: 'tool-result', round: rounds, call: record });
    }
    trace.push(...codec.results(calls, contents, rounds >= maxRounds ? LAST_ROUND_NOTE : undefined));
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

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ToolLoopAborted(signal.reason);
}
