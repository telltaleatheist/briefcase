/**
 * The tool harness's types. Self-contained: nothing here imports from the app
 * that hosts it, so the folder can be copied into another project as it is.
 */

/**
 * One chat message as a transport sends it. The tag format uses only
 * system/user/assistant text; the native format (native-codec.ts) adds an
 * assistant message's structured calls and a `tool` message per result.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** The text; '' for an assistant message that is only calls (a model API's `content: null`). */
  content: string;
  /** Native, assistant only: the calls the reply made, exactly as the model API returned them. */
  toolCalls?: NativeToolCall[];
  /** Native, `tool` only: the id of the call this message answers. */
  toolCallId?: string;
}

/**
 * A call as a native-tools model API returns it (the OpenAI `tool_calls` entry,
 * flattened). The id is opaque: sent back exactly as it came.
 */
export interface NativeToolCall {
  id: string;
  name: string;
  /** The arguments as the API sent them: a JSON string, read by the codec. */
  arguments: string;
}

/** What a transport returns for one model call. */
export interface TransportReply {
  /** The model's reply as text: tool-call tags and all in the tag format, the prose beside the calls in the native one. */
  text: string;
  /** Native: the structured calls the reply made (absent or empty: none). */
  toolCalls?: NativeToolCall[];
  /** Whatever the host's model API reports; kept per call in the loop's result. */
  usage?: unknown;
}

/** A tool as a native-tools API takes it: the OpenAI `tools` entry (functionDefinition). */
export type ToolDefinition = Record<string, unknown>;

export interface TransportOptions {
  signal?: AbortSignal;
  /** Native: the tools to send as definitions (the API's `tools`). Absent in the tag format, where they are in the prompt. */
  tools?: ToolDefinition[];
}

/** How the loop reaches a model: the host supplies it (an HTTP client, an SDK, a fake in a test). */
export type ChatTransport = (messages: ChatMessage[], opts: TransportOptions) => Promise<TransportReply>;

/** What a tool's execute gets besides its arguments. */
export interface ToolContext {
  signal?: AbortSignal;
}

/**
 * A tool the model may call.
 *
 * `content` is what goes back to the model as the call's result; `data` is the
 * structured result the host keeps (a placed marker, a row id). A tool that
 * can't run its arguments throws: the model is told why and may call again.
 */
export interface Tool<Args = Record<string, unknown>, Result = unknown> {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  execute(args: Args, ctx: ToolContext): Promise<{ content: string; data?: Result }>;
}

/** One tool call as the loop ran it. */
export interface ToolCallRecord<Result = unknown> {
  /** The tool named, or null when the call could not be read. */
  name: string | null;
  args: Record<string, unknown> | null;
  /** True when the call was read and its tool ran without throwing. */
  ok: boolean;
  /** What the model was sent back for it. */
  content: string;
  data?: Result;
}

/** A call found in a reply, read or not. `id` is a native call's, which its result must carry back. */
export type ParsedToolCall =
  | { ok: true; name: string; args: Record<string, unknown>; id?: string }
  | { ok: false; reason: string; id?: string };

/**
 * A tool-call wire format: how tools reach the model, how its calls are read
 * out of a reply, how results go back, and how a stored trace replays. The
 * plain tag format (tag-codec.ts) carries everything as text; the native one
 * (native-codec.ts) sends definitions and reads structured calls.
 */
export interface ToolCallCodec {
  /** The block appended to the system prompt that describes the tools and how to call them; '' when none is. */
  toolsPrompt(tools: ReadonlyArray<Tool<any, any>>): string;
  /** The tools as the transport sends them (TransportOptions.tools); absent when the prompt carries them. */
  definitions?(tools: ReadonlyArray<Tool<any, any>>): ToolDefinition[];
  /** A reply's prose, its calls in order, and the assistant message it is in the trace. */
  read(reply: TransportReply): { prose: string; calls: ParsedToolCall[]; message: ChatMessage };
  /** The messages carrying one round's results, in call order; `note` is appended when given. */
  results(calls: ParsedToolCall[], contents: string[], note?: string): ChatMessage[];
  /**
   * The messages that close calls the loop did not run (the last reply's,
   * past maxRounds), when the format needs every call answered. Absent: none.
   */
  unanswered?(calls: ParsedToolCall[]): ChatMessage[];
  /** A stored turn's trace in this format (either format's trace may have been stored). */
  replay(trace: ReadonlyArray<ChatMessage>, turn: number): ChatMessage[];
}

/** What the loop reports as it goes, for a host's progress display. */
export type ToolLoopEvent =
  | { type: 'model-call'; round: number }
  | { type: 'tool-call'; round: number; name: string | null; args: Record<string, unknown> | null }
  | { type: 'tool-result'; round: number; call: ToolCallRecord }
  | { type: 'done'; rounds: number };
